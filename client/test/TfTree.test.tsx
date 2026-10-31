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

