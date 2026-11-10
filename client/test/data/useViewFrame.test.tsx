// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { PlaybackContext, createPlaybackStore } from "../../src/workspace/playback";
import { DataStore, DataStoreContext } from "../../src/data/store";
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
  const store = new DataStore("r");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      DataStoreContext.Provider,
      { value: store },
      createElement(PlaybackContext.Provider, { value: playback }, children),
    );
  return { playback, wrapper };
}

/** Requests for the window starting at `start`. */
const reads = (start: string) =>
  vi.mocked(fetchViewHistory).mock.calls.filter(([, , range]) => range?.start_ns === start).length;

it("uses the preceding frame and advances within a loaded window without requests", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(frame("500000000"));
  vi.mocked(fetchViewHistory).mockResolvedValue([frame("1500000000")]);
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("500000000"));
  act(() => playback.seek(0.6));
  expect(result.current.frame?.time_ns).toBe("1500000000");
  const requests = vi.mocked(fetchViewHistory).mock.calls.length;
  act(() => playback.seek(0.9));
  expect(fetchViewHistory).toHaveBeenCalledTimes(requests);
  expect(reads("1000000000")).toBe(1);
});

it("falls back to latest requests when a window exceeds its size limit", async () => {
  vi.mocked(fetchViewHistory).mockRejectedValue(new ViewWindowTooLarge());
  vi.mocked(fetchLatestFrame).mockResolvedValue(frame("1000000000"));
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1000000000"));
  // The windows read ahead at the same time are the only others read.
  const histories = vi.mocked(fetchViewHistory).mock.calls.length;
  expect(histories).toBeLessThanOrEqual(5);
  const latest = vi.mocked(fetchLatestFrame).mock.calls.length;
  act(() => playback.seek(0.5));
  await waitFor(() => expect(fetchLatestFrame).toHaveBeenCalledTimes(latest + 1));
  act(() => playback.seek(1.5));
  await waitFor(() => expect(fetchLatestFrame).toHaveBeenCalledTimes(latest + 2));
  expect(fetchViewHistory).toHaveBeenCalledTimes(histories);
});

it("seeds each window read ahead with the last frame of the window before", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(frame("1000000000"));
  vi.mocked(fetchViewHistory).mockImplementation(async (_target, _signal, range) =>
    range?.start_ns === "1000000000" ? [frame("1500000000")] : [],
  );
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1000000000"));
  await waitFor(() => expect(reads("8000000000")).toBe(1));
  // The frame before the first window, and the frame shown while it loaded.
  expect(fetchLatestFrame).toHaveBeenCalledTimes(2);
  act(() => playback.seek(3.1));
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1500000000"));
  expect(fetchLatestFrame).toHaveBeenCalledTimes(2);
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

it("reads a window once for views showing the same topic, and keeps it for seeking back", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(frame("500000000"));
  vi.mocked(fetchViewHistory).mockImplementation(async (_target, _signal, range) => [
    frame(range!.start_ns),
  ]);
  const { playback, wrapper } = setup();
  const { result } = renderHook(
    () => [useViewFrame(selected, info), useViewFrame({ ...selected, key: "other" }, info)],
    { wrapper },
  );
  await waitFor(() => expect(result.current[1].frame?.time_ns).toBe("1000000000"));
  expect(result.current[0].frame?.time_ns).toBe("1000000000");
  await waitFor(() => expect(reads("8000000000")).toBe(1));
  act(() => playback.seek(1));
  expect(result.current[0].frame?.time_ns).toBe("2000000000");
  act(() => playback.seek(0));
  await waitFor(() => expect(result.current[0].frame?.time_ns).toBe("1000000000"));
  for (let start = 1; start <= 8; start++) expect(reads(`${start}000000000`)).toBe(1);
});

const long = { ...info, end_ns: "60000000000" };

it("reads ten seconds ahead, further when playing faster, and not past the end", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(null);
  vi.mocked(fetchViewHistory).mockResolvedValue([]);
  const { playback, wrapper } = setup();
  playback.reset(59);
  renderHook(() => useViewFrame(selected, long), { wrapper });
  await waitFor(() => expect(reads("11000000000")).toBe(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(reads("12000000000")).toBe(0);
  act(() => playback.setSpeed(2));
  await waitFor(() => expect(reads("21000000000")).toBe(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(reads("22000000000")).toBe(0);
  act(() => playback.seek(55));
  await waitFor(() => expect(reads("60000000000")).toBe(1));
  expect(reads("61000000000")).toBe(0);
});

it("goes on into a window read ahead without buffering", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(frame("500000000"));
  vi.mocked(fetchViewHistory).mockImplementation(async (_target, _signal, range) => [
    frame(range!.start_ns),
  ]);
  const { playback, wrapper } = setup();
  const { result } = renderHook(() => useViewFrame(selected, info), { wrapper });
  await waitFor(() => expect(result.current.frame?.time_ns).toBe("1000000000"));
  await waitFor(() => expect(reads("3000000000")).toBe(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  act(() => playback.seek(1.2));
  expect(result.current.frame?.time_ns).toBe("2000000000");
  expect(playback.isBuffering()).toBe(false);
  act(() => playback.seek(2.2));
  expect(result.current.frame?.time_ns).toBe("3000000000");
  expect(playback.isBuffering()).toBe(false);
  expect(reads("2000000000")).toBe(1);
  expect(reads("3000000000")).toBe(1);
});

it("reads at most four windows ahead at once, and stops them when seeking away", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(null);
  const signals = new Map<string, AbortSignal>();
  vi.mocked(fetchViewHistory).mockImplementation((_target, signal, range) => {
    signals.set(range!.start_ns, signal!);
    return new Promise(() => {});
  });
  const { playback, wrapper } = setup();
  playback.reset(59);
  renderHook(() => useViewFrame(selected, long), { wrapper });
  await waitFor(() => expect(signals.size).toBe(5));
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect([...signals.keys()].sort()).toEqual(
    ["1000000000", "2000000000", "3000000000", "4000000000", "5000000000"].sort(),
  );
  act(() => playback.seek(30));
  await waitFor(() => expect(signals.get("2000000000")?.aborted).toBe(true));
  expect(signals.get("5000000000")?.aborted).toBe(true);
  // Reading ahead of the new position starts as the reads stopped make way.
  await waitFor(() => expect(signals.get("32000000000")?.aborted).toBe(false));
});
