// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitViewport, layoutFrames, TfTree, zoomViewport } from "../src/views/TfTree";
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
  expect(screen.getByText(/^Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \(/)).toBeTruthy();
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

describe("fitViewport", () => {
  const bounds = { x: 0, y: 0, width: 220, height: 80 };
  it("keeps one unit per pixel and centers a tree smaller than the widget", () => {
    expect(fitViewport(bounds, { width: 1000, height: 600 })).toEqual({
      x: -390,
      y: -260,
      width: 1000,
      height: 600,
    });
  });
  it("shrinks a tree larger than the widget until all of it fits", () => {
    const view = fitViewport(bounds, { width: 110, height: 200 });
    expect(view.width).toBe(220);
    expect(view.height).toBe(400);
    expect(view.x).toBe(0);
    expect(view.y).toBe(-160);
  });
  it("falls back to the bounds before the element is measured", () => {
    expect(fitViewport(bounds, { width: 0, height: 0 })).toEqual(bounds);
  });
});

it("zooms from the fitted view and returns to it on reset", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ frames: [{ id: "world", parent: null }] })),
  );
  const rect = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: 1000, height: 500 } as DOMRect);
  const onCanReset = vi.fn();
  const tree = (resetCount: number) => (
    <PlaybackContext.Provider value={store}>
      <TfTree runId="run" info={null} resetCount={resetCount} onCanReset={onCanReset} />
    </PlaybackContext.Provider>
  );
  const store = createPlaybackStore();
  const { container, rerender } = render(tree(0));
  await screen.findByRole("button", { name: "world" });
  expect(onCanReset).toHaveBeenLastCalledWith(false);
  const box = () => container.querySelector("svg")!.getAttribute("viewBox");
  await waitFor(() => expect(box()).toBe("-390 -210 1000 500"));
  act(() => {
    container
      .querySelector("svg")!
      .dispatchEvent(new WheelEvent("wheel", { deltaY: -1, clientX: 500, clientY: 250 }));
  });
  expect(box()).not.toBe("-390 -210 1000 500");
  expect(onCanReset).toHaveBeenLastCalledWith(true);
  rerender(tree(1));
  expect(box()).toBe("-390 -210 1000 500");
  expect(onCanReset).toHaveBeenLastCalledWith(false);
  rect.mockRestore();
});

describe("zoomViewport", () => {
  const size = { width: 400, height: 200 };
  const limits: [number, number] = [100, 4000];
  /** The unit shown at a pixel, for a view letterboxed and centered in `size`. */
  const unitAt = (view: ReturnType<typeof fitViewport>, x: number, y: number) => {
    const scale = Math.max(view.width / size.width, view.height / size.height);
    return {
      x: view.x + view.width / 2 + (x - size.width / 2) * scale,
      y: view.y + view.height / 2 + (y - size.height / 2) * scale,
    };
  };
  it.each([
    ["matching", { x: 10, y: 20, width: 400, height: 200 }],
    ["letterboxed", { x: 10, y: 20, width: 200, height: 200 }],
  ])("keeps the unit under the pointer on a %s view", (_name, view) => {
    const zoomed = zoomViewport(view, 0.8, { x: 50, y: 150 }, size, limits);
    expect(zoomed.width).toBeCloseTo(view.width * 0.8);
    expect(unitAt(zoomed, 50, 150).x).toBeCloseTo(unitAt(view, 50, 150).x);
    expect(unitAt(zoomed, 50, 150).y).toBeCloseTo(unitAt(view, 50, 150).y);
  });
  it("does not move at the width limit", () => {
    const view = { x: 10, y: 20, width: 100, height: 50 };
    expect(zoomViewport(view, 0.8, { x: 50, y: 150 }, size, limits)).toEqual(view);
  });
});

it("zooms at the pointer with the wheel and stops the page from scrolling", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ frames: [{ id: "world", parent: null }] })),
  );
  const rect = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
  const { container } = render(
    <PlaybackContext.Provider value={createPlaybackStore()}>
      <TfTree runId="run" info={null} />
    </PlaybackContext.Provider>,
  );
  await screen.findByRole("button", { name: "world" });
  const svg = container.querySelector("svg")!;
  await waitFor(() => expect(svg.getAttribute("viewBox")).toBe("-390 -210 1000 500"));
  const wheel = new WheelEvent("wheel", { deltaY: -1, clientX: 0, clientY: 0, cancelable: true });
  act(() => {
    svg.dispatchEvent(wheel);
  });
  expect(wheel.defaultPrevented).toBe(true);
  // The top left pixel still shows the unit (-390, -210).
  expect(svg.getAttribute("viewBox")).toBe("-390 -210 800 400");
  rect.mockRestore();
});
