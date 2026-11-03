// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createPlaybackStore, PlaybackContext } from "../../src/workspace/playback";
import { useSceneFrame } from "../../src/views/Scene3D";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../src/data/sources", async (original) => ({
  ...(await original<typeof import("../../src/data/sources")>()),
  get: mocks.get,
}));

it("keeps the old frame until the requested transform arrives and ignores stale responses", async () => {
  const pending: ((value: unknown) => void)[] = [];
  mocks.get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const stage = { reframe: vi.fn(), resetView: vi.fn() } as any;
  const info = { start_ns: "0", end_ns: "10", message_count: 1 };
  const store = createPlaybackStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PlaybackContext.Provider value={store}>{children}</PlaybackContext.Provider>
  );
  const { result, rerender } = renderHook(({ frame }) => useSceneFrame(stage, "r/0", frame, info), {
    initialProps: { frame: "a" },
    wrapper,
  });
  await waitFor(() => expect(result.current.target).toBe("a"));
  rerender({ frame: "b" });
  await waitFor(() => expect(pending.length).toBe(1));
  expect(result.current.target).toBe("a");
  rerender({ frame: "c" });
  await waitFor(() => expect(pending.length).toBe(2));
  const transform = { translation: [1, 2, 3], rotation: [0, 0, 0, 1] };
  await act(async () => {
    pending[0]({ frames: { a: transform } });
  });
  expect(stage.reframe).not.toHaveBeenCalled();
  await act(async () => {
    pending[1]({ frames: { a: transform } });
  });
  expect(stage.reframe).toHaveBeenCalledWith(transform);
  expect(result.current.target).toBe("c");
  rerender({ frame: "d" });
  await waitFor(() => expect(pending.length).toBe(3));
  await act(async () => {
    pending[2]({ frames: {} });
  });
  // No sample at this time to carry the view over with: the frame still changes.
  await waitFor(() => expect(result.current.target).toBe("d"));
  expect(result.current.error).toBe("");
  expect(stage.reframe).toHaveBeenCalledTimes(1);
  expect(stage.resetView).toHaveBeenCalledTimes(1);
});
