// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { DataStore, DataStoreContext } from "../../src/data/store";
import { PlaybackContext, createPlaybackStore } from "../../src/workspace/playback";
import { useCurrentMessage } from "../../src/data/useCurrentMessage";
import { keyOf, type Selected } from "../../src/types";
const selected: Selected = {
  source: "r/0",
  topic: "/t",
  path: ["x"],
  key: keyOf("r/0", "/t", ["x"]),
  color: "red",
  lineWidth: 1,
  hidden: false,
};
const info = { start_ns: "1000000000", end_ns: "8000000000", message_count: 4 };
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const store = new DataStore("r");
  const cache = store.fields;
  const playback = createPlaybackStore(
    () => 1,
    () => {},
  );
  playback.reset(7);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      DataStoreContext.Provider,
      { value: store },
      createElement(PlaybackContext.Provider, { value: playback }, children),
    );
  return { cache, playback, wrapper };
}
it("advances from prefetched fields without a request on each playhead update", async () => {
  const fetch = vi.fn(async (url: string) => {
    const start_ns = new URL(url, "http://x").searchParams.get("start_ns")!;
    const start = BigInt(start_ns);
    const rows = [0n, 500_000_000n, 1_000_000_000n, 1_500_000_000n].map((offset) => ({
      time_ns: String(start + offset),
      value: String(start + offset),
    }));
    return new Response(
      JSON.stringify({ type: "batch", rows, scanned_messages: 4 }) +
        "\n" +
        JSON.stringify({ type: "complete", scanned_messages: 4 }) +
        "\n",
    );
  });
  vi.stubGlobal("fetch", fetch);
  const { wrapper, playback } = setup();
  const { result } = renderHook(() => useCurrentMessage(selected, info), { wrapper });
  await waitFor(() => expect(result.current.message?.time_ns).toBe("1000000000"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  act(() => playback.seek(0.6));
  expect(result.current.message?.time_ns).toBe("1500000000");
  act(() => playback.seek(0.9));
  expect(result.current.message?.time_ns).toBe("1500000000");
  expect(fetch).toHaveBeenCalledTimes(3);
  act(() => playback.seek(1.1));
  await waitFor(() => expect(result.current.message?.time_ns).toBe("2000000000"));
});
it("uses a plot's full field cache, including the last equal-time message", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { cache, playback, wrapper } = setup();
  cache.putScalar(selected, [
    { time_ns: "1000000000", value: 1 },
    { time_ns: "1000000000", value: 2 },
    { time_ns: "2000000000", value: 3 },
  ]);
  const { result } = renderHook(() => useCurrentMessage(selected, info), { wrapper });
  expect(result.current.message?.value).toBe(2);
  act(() => playback.seek(1));
  expect(result.current.message?.value).toBe(3);
  expect(fetch).not.toHaveBeenCalled();
});
it("uses a cached preceding window at a boundary without buffering", async () => {
  const fetch = vi.fn(async (url: string) => {
    const params = new URL(url, "http://x").searchParams;
    if (!params.has("start_ns")) throw new Error("Unexpected predecessor lookup");
    const start = BigInt(params.get("start_ns")!);
    const time = String(start + 100_000_000n);
    return new Response(
      JSON.stringify({
        type: "batch",
        rows: [{ time_ns: time, value: time }],
        scanned_messages: 1,
      }) +
        "\n" +
        JSON.stringify({ type: "complete", scanned_messages: 1 }) +
        "\n",
    );
  });
  vi.stubGlobal("fetch", fetch);
  const { wrapper, playback } = setup();
  act(() => playback.seek(0.2));
  const recording = { ...info, start_ns: "0" };
  const { result } = renderHook(() => useCurrentMessage(selected, recording), { wrapper });
  await waitFor(() => expect(result.current.message?.time_ns).toBe("100000000"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  act(() => playback.seek(2));
  expect(result.current.message?.time_ns).toBe("100000000");
  expect(playback.isBuffering()).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("uses the predecessor for a sparse topic and reports an empty topic", async () => {
  const fetch = vi.fn(async (url) =>
    String(url).includes("/messages/latest?")
      ? new Response(JSON.stringify({ time_ns: "1500000000", value: 7 }))
      : new Response('{"type":"complete","scanned_messages":0}\n'),
  );
  vi.stubGlobal("fetch", fetch);
  const { wrapper, playback } = setup();
  act(() => playback.seek(1.1));
  const { result } = renderHook(() => useCurrentMessage(selected, info), { wrapper });
  await waitFor(() => expect(result.current.message?.value).toBe(7));
});
it("keeps an empty topic distinct from buffering across prefetched windows", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("/messages/latest?")) throw new Error("Unexpected predecessor lookup");
    return new Response('{"type":"complete","scanned_messages":0}\n');
  });
  vi.stubGlobal("fetch", fetch);
  const { wrapper, playback } = setup();
  const recording = { ...info, start_ns: "0" };
  const { result } = renderHook(() => useCurrentMessage(selected, recording), { wrapper });
  await waitFor(() => expect(result.current.message).toBeNull());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  act(() => playback.seek(2));
  expect(result.current.message).toBeNull();
  expect(playback.isBuffering()).toBe(false);
  act(() => playback.seek(4));
  expect(result.current.message).toBeNull();
  expect(playback.isBuffering()).toBe(false);
});
it("shows nothing before a loaded field's first message", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const { cache, playback, wrapper } = setup();
  cache.putScalar(selected, [{ time_ns: "2000000000", value: 3 }]);
  const { result } = renderHook(() => useCurrentMessage(selected, info), { wrapper });
  expect(result.current.message).toBeNull();
  act(() => playback.seek(1));
  expect(result.current.message?.value).toBe(3);
});
it("keeps the last known message while fetching a later window", async () => {
  let finish: ((response: Response) => void) | undefined;
  const batch = (time: string, value: number) =>
    new Response(
      JSON.stringify({ type: "batch", rows: [{ time_ns: time, value }], scanned_messages: 1 }) +
        "\n" +
        JSON.stringify({ type: "complete", scanned_messages: 1 }) +
        "\n",
    );
  const fetch = vi.fn(async (url: string) => {
    const start = new URL(url, "http://x").searchParams.get("start_ns");
    if (start === "6000000000")
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    if (start === "0") return batch("1000000000", 1);
    return batch(start!, 2);
  });
  vi.stubGlobal("fetch", fetch);
  const { wrapper, playback } = setup();
  const { result } = renderHook(() => useCurrentMessage(selected, info), { wrapper });
  await waitFor(() => expect(result.current.message?.value).toBe(1));
  act(() => playback.seek(6));
  expect(result.current.message?.value).toBe(1);
  expect(playback.isBuffering()).toBe(true);
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => finish!(batch("6500000000", 3)));
  await waitFor(() => expect(result.current.message?.value).toBe(3));
  expect(playback.isBuffering()).toBe(false);
});

it("does not keep a later message when seeking before the first message", () => {
  const { cache, playback, wrapper } = setup();
  cache.putScalar(selected, [{ time_ns: "2000000000", value: 3 }]);
  act(() => playback.seek(1));
  const { result } = renderHook(() => useCurrentMessage(selected, info), { wrapper });
  expect(result.current.message?.value).toBe(3);
  act(() => playback.seek(0));
  expect(result.current.message).toBeNull();
});
it("releases a buffering consumer when its widget is removed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ),
  );
  const { wrapper, playback } = setup();
  const { unmount } = renderHook(() => useCurrentMessage(selected, info), { wrapper });
  expect(playback.isBuffering()).toBe(true);
  unmount();
  expect(playback.isBuffering()).toBe(false);
});
