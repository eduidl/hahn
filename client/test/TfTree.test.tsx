// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { layoutFrames, TfTree } from "../src/views/TfTree";
import { createPlaybackStore, PlaybackContext } from "../src/workspace/playback";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lays out disconnected roots, missing parents and cycles without dropping frames", () => {
  const nodes = layoutFrames([
    { id: "root", parent: null },
    { id: "child", parent: "root" },
    { id: "orphan", parent: "missing" },
    { id: "a", parent: "b" },
    { id: "b", parent: "a" },
  ]);
  expect(nodes).toHaveLength(5);
  expect(nodes.find((n) => n.id === "child")!.y).toBeGreaterThan(
    nodes.find((n) => n.id === "root")!.y,
  );
  expect(nodes.find((n) => n.id === "orphan")!.parent).toBeNull();
  expect(nodes.find((n) => n.id === "a")!.parent).toBeNull();
});

it("loads the current run and distinguishes empty results from errors", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("/bad/"))
      return new Response(JSON.stringify({ error: "Unavailable" }), { status: 422 });
    return new Response(
      JSON.stringify({
        frames: url.includes("/empty/")
          ? []
          : [
              { id: "world", parent: null },
              { id: "base", parent: "world" },
            ],
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const store = createPlaybackStore(
    () => 1,
    () => {},
  );
  const tree = (runId: string) => (
    <PlaybackContext.Provider value={store}>
      <TfTree runId={runId} info={null} />
    </PlaybackContext.Provider>
  );
  const { rerender } = render(tree("first"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "base, parent world" })).toBeTruthy(),
  );
  expect(fetch).toHaveBeenCalledWith("/api/runs/first/frames", { signal: expect.any(AbortSignal) });
  rerender(tree("empty"));
  await waitFor(() => expect(screen.getByText("No frames")).toBeTruthy());
  rerender(tree("bad"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Unavailable"));
});

it("shows the selected frame relative to its last recorded parent at playback time", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/frames"))
      return new Response(
        JSON.stringify({
          frames: [
            { id: "world", parent: null },
            { id: "base", parent: "world" },
          ],
        }),
      );
    const params = new URL(url, "http://x").searchParams;
    return new Response(
      JSON.stringify({
        target: params.get("target"),
        time_ns: params.get("time_ns"),
        frames:
          params.get("time_ns") === "3000000000"
            ? {}
            : {
                base: {
                  translation: [Number(params.get("time_ns")) / 1e9, 2, 3],
                  rotation: [0, 0, 0, 1],
                },
              },
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const store = createPlaybackStore(
    () => 1,
    () => {},
  );
  store.reset(10);
  render(
    <PlaybackContext.Provider value={store}>
      <TfTree
        runId="run"
        info={{ start_ns: "1000000000", end_ns: "11000000000", message_count: 1 }}
      />
    </PlaybackContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "base, parent world" }));
  expect(await screen.findByText("Parent Frame: world")).toBeTruthy();
  expect(await screen.findByText("x: 1")).toBeTruthy();
  const handle = screen.getByRole("button", { name: "Move details for base" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle.parentElement?.style.transform).toBe("translate(10px, 0px)");
  act(() => store.seek(1));
  expect(await screen.findByText("x: 2")).toBeTruthy();
  act(() => store.seek(2));
  expect(await screen.findByText("Transform unavailable at this time")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("button", { name: "world" }), { key: "Enter" });
  expect(screen.getByText("Root frame")).toBeTruthy();
});

it("pans by the same amount on both axes when the tree is letterboxed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        frames: [{ id: "world", parent: null, children: [] }],
      }),
    ),
  );
  const { container } = render(
    <PlaybackContext.Provider value={createPlaybackStore()}>
      <TfTree
        runId="run"
        info={{ start_ns: "1000000000", end_ns: "11000000000", message_count: 1 }}
      />
    </PlaybackContext.Provider>,
  );
  await screen.findByRole("button", { name: "world" });
  const svg = container.querySelector("svg")!;
  svg.setPointerCapture = () => {};
  // Much wider than the tree, so that the height decides the scale.
  svg.getBoundingClientRect = () => ({ width: 1000, height: 100 }) as DOMRect;
  const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  const unitsPerPixel = Math.max(width / 1000, height / 100);
  const pointer = (type: string, clientX: number, clientY: number) =>
    fireEvent(svg, new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }));
  pointer("pointerdown", 100, 50);
  pointer("pointermove", 110, 60);
  const [x, y] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  expect(x).toBeCloseTo(-10 * unitsPerPixel);
  expect(y).toBeCloseTo(-10 * unitsPerPixel);
});

