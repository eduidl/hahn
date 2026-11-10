// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createPlaybackStore, PlaybackContext } from "../../src/workspace/playback";
import { useSceneFrame } from "../../src/views/Scene3D";
import { withStore } from "../dataStore";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../src/data/request", async (original) => ({
  ...(await original<typeof import("../../src/data/request")>()),
  get: mocks.get,
}));

it("keeps the old frame until the transforms arrive and ignores a superseded change", async () => {
  const pending: [string, (value: unknown) => void][] = [];
  mocks.get.mockImplementation(
    (url: string) => new Promise((resolve) => pending.push([url, resolve])),
  );
  const stage = { reframe: vi.fn(), resetView: vi.fn() } as any;
  const info = { start_ns: "0", end_ns: "10", message_count: 1 };
  const store = createPlaybackStore();
  const data = withStore("r");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <data.wrapper>
      <PlaybackContext.Provider value={store}>{children}</PlaybackContext.Provider>
    </data.wrapper>
  );
  const { result, rerender } = renderHook(({ frame }) => useSceneFrame(stage, "r/0", frame, info), {
    initialProps: { frame: "a" },
    wrapper,
  });
  await waitFor(() => expect(result.current.target).toBe("a"));
  rerender({ frame: "b" });
  // The static transforms and the samples around the playback position.
  await waitFor(() => expect(pending.length).toBe(3));
  expect(result.current.target).toBe("a");
  rerender({ frame: "c" });
  const transform = { translation: [1, 2, 3], rotation: [0, 0, 0, 1] };
  await act(async () => {
    for (const [url, resolve] of pending)
      resolve(
        url.endsWith("/static")
          ? { transforms: [{ child: "a", parent: "c", ...transform }] }
          : { samples: [] },
      );
  });
  // Only the latest change carries the view over, and nothing more was requested.
  expect(pending.length).toBe(3);
  expect(stage.reframe).toHaveBeenCalledTimes(1);
  expect(stage.reframe).toHaveBeenCalledWith(transform);
  expect(result.current.target).toBe("c");
  rerender({ frame: "d" });
  // No transform at this time to carry the view over with: the frame still changes.
  await waitFor(() => expect(result.current.target).toBe("d"));
  expect(result.current.error).toBe("");
  expect(stage.reframe).toHaveBeenCalledTimes(1);
  expect(stage.resetView).toHaveBeenCalledTimes(1);
});
