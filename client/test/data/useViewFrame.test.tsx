// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { PlaybackContext, createPlaybackStore } from "../../src/workspace/playback";
import { useViewFrame } from "../../src/data/useViewData";
import { ViewWindowTooLarge, type ViewFrame } from "../../src/data/viewFrames";
import { keyOf, type Selected } from "../../src/types";

vi.mock("../../src/data/viewFrames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/data/viewFrames")>()),
  fetchLatestFrame: vi.fn(),
  fetchViewHistory: vi.fn(),
}));
import { fetchLatestFrame, fetchViewHistory } from "../../src/data/viewFrames";

const selected: Selected = {
  source: "r/0",
  topic: "/t",
  path: [],
  key: keyOf("r/0", "/t", []),
  color: "red",
  lineWidth: 1,
  hidden: false,
  view: "pose",
};
const info = { start_ns: "1000000000", end_ns: "8000000000", message_count: 4 };
const frame = (time: string): ViewFrame => ({ time_ns: time, blob: () => new Uint8Array() });
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup() {
  const playback = createPlaybackStore(
    () => 1,
    () => {},
  );
  playback.reset(7);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(PlaybackContext.Provider, { value: playback }, children);
  return { playback, wrapper };
}

it("uses the preceding frame and advances within a loaded window without requests", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(frame("500000000"));
  vi.mocked(fetchViewHistory).mockResolvedValue([frame("1500000000")]);
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("500000000"));
  act(() => playback.seek(0.6));
  expect(result.current.frame?.time_ns).toBe("1500000000");
  act(() => playback.seek(0.9));
  expect(fetchLatestFrame).toHaveBeenCalledTimes(2);
  expect(fetchViewHistory).toHaveBeenCalledTimes(1);
  act(() => playback.seek(2));
  await waitFor(() => expect(fetchViewHistory).toHaveBeenCalledTimes(2));
});

it("falls back to latest requests when a window exceeds its size limit", async () => {
  vi.mocked(fetchViewHistory).mockRejectedValue(new ViewWindowTooLarge());
  vi.mocked(fetchLatestFrame).mockResolvedValue(frame("1000000000"));
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1000000000"));
  expect(fetchLatestFrame).toHaveBeenCalledTimes(2);
  act(() => playback.seek(0.5));
  await waitFor(() => expect(fetchLatestFrame).toHaveBeenCalledTimes(3));
  act(() => playback.seek(1.5));
  await waitFor(() => expect(fetchLatestFrame).toHaveBeenCalledTimes(4));
  expect(fetchViewHistory).toHaveBeenCalledTimes(1);
});

it("reuses the previous window's last frame when advancing to an empty window", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(frame("1000000000"));
  vi.mocked(fetchViewHistory).mockImplementation(async (_target, _signal, range) =>
    range?.start_ns === "1000000000" ? [frame("1500000000")] : [],
  );
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(fetchViewHistory).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1000000000"));
  act(() => playback.seek(1.1));
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1500000000"));
  expect(fetchViewHistory).toHaveBeenCalledTimes(2);
  expect(fetchLatestFrame).toHaveBeenCalledTimes(3);
  act(() => playback.seek(3.1));
  await waitFor(() => expect(fetchViewHistory).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(fetchLatestFrame).toHaveBeenCalledTimes(5));
});

it("shows the sought frame while the window is still loading", async () => {
  vi.mocked(fetchLatestFrame).mockImplementation(async (_target, time) => frame(time));
  vi.mocked(fetchViewHistory).mockImplementation(() => new Promise(() => {}));
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1000000000"));
  act(() => playback.seek(2.5));
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("3500000000"));
});

it("keeps the last frame while loading the next window, but not after seeking before it", async () => {
  vi.mocked(fetchLatestFrame).mockImplementation(async (_target, time) => {
    if (time === "1000000000") return frame("1000000000");
    return new Promise(() => {});
  });
  vi.mocked(fetchViewHistory).mockImplementation(async (_target, _signal, range) => {
    if (range?.start_ns === "1000000000") return [frame("1500000000")];
    return new Promise(() => {});
  });
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1000000000"));
  act(() => playback.seek(0.6));
  expect(result.current.frame?.time_ns).toBe("1500000000");
  act(() => playback.seek(1));
  expect(result.current.frame?.time_ns).toBe("1500000000");
  act(() => playback.seek(0.2));
  expect(result.current.frame?.time_ns).toBe("1000000000");
});
