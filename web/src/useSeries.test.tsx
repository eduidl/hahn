// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSeries } from "./useSeries";
import { keyOf, type Info, type Selected } from "./types";

const info: Info = {
  start_ns: "1000000000",
  end_ns: "2000000000",
  message_count: 2,
};
const field = (name: string): Selected => ({
  key: keyOf(0, "/pose", [name]),
  source: 0,
  topic: "/pose",
  path: [name],
  color: "#91b8ff",
  lineWidth: 1.5,
  hidden: false,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetch() {
  const fetch = vi.fn((_url: string, options: RequestInit) => {
    const fields = JSON.parse(options.body as string).fields as string[][];
    return Promise.resolve(
      new Response(
        [
          JSON.stringify({
            type: "batch",
            rows: [
              { time_ns: "1000000000", values: fields.map((_, i) => i + 1) },
            ],
            scanned_messages: 1,
          }),
          JSON.stringify({ type: "complete", scanned_messages: 1 }),
          "",
        ].join("\n"),
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("full-recording series cache", () => {
  it("retains existing samples and requests only newly added fields", async () => {
    const fetch = mockFetch();
    const { result, rerender } = renderHook(
      ({ selected }) => useSeries(info.start_ns, selected),
      { initialProps: { selected: [field("x")] }, wrapper: StrictMode },
    );
    await waitFor(() =>
      expect(result.current.records[0]?.status).toBe("complete"),
    );
    const originalPoints = result.current.plotted[0].points;
    rerender({ selected: [field("x"), field("y")] });
    await waitFor(() =>
      expect(result.current.records[1]?.status).toBe("complete"),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body as string)).toEqual({
      topic: "/pose",
      fields: [["y"]],
    });
    expect(result.current.plotted[0].points).toBe(originalPoints);
    expect(result.current.plotted[0].points).toHaveLength(1);
    // Removing and adding an already loaded field also uses the cache.
    rerender({ selected: [field("y")] });
    rerender({ selected: [field("x"), field("y")] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not fetch on display-only rerenders, visibility, or style changes", async () => {
    const fetch = mockFetch();
    const { result, rerender } = renderHook(
      ({ selected, viewport }) => {
        void viewport;
        return useSeries(info.start_ns, selected);
      },
      { initialProps: { selected: [field("x")], viewport: [0, 1] } },
    );
    await waitFor(() =>
      expect(result.current.records[0]?.status).toBe("complete"),
    );
    const points = result.current.plotted[0].points;
    rerender({
      selected: [
        { ...field("x"), hidden: true, color: "#ff0000", lineWidth: 4 },
      ],
      viewport: [0.2, 0.6],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.plotted[0].points).toBe(points);
    expect(result.current.plotted[0].hidden).toBe(true);
    expect(result.current.plotted[0].color).toBe("#ff0000");
    expect(result.current.plotted[0].lineWidth).toBe(4);
    expect(
      JSON.parse(fetch.mock.calls[0][1].body as string),
    ).not.toHaveProperty("start_ns");
    expect(
      JSON.parse(fetch.mock.calls[0][1].body as string),
    ).not.toHaveProperty("end_ns");
  });

  it("batches shared requests at the API field limit", async () => {
    const fetch = mockFetch();
    const selected = Array.from({ length: 70 }, (_, i) => field(`field${i}`));
    const { result } = renderHook(() => useSeries(info.start_ns, selected));
    await waitFor(() =>
      expect(
        result.current.records.filter((r) => r.status === "complete"),
      ).toHaveLength(70),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(
        (call) => JSON.parse(call[1].body as string).fields.length,
      ),
    ).toEqual([64, 6]);
  });

  it("invalidates cached data only when the time origin moves", async () => {
    const fetch = mockFetch();
    const { result, rerender } = renderHook(
      ({ origin, selected }) => useSeries(origin, selected),
      { initialProps: { origin: info.start_ns, selected: [field("x")] } },
    );
    await waitFor(() =>
      expect(result.current.records[0]?.status).toBe("complete"),
    );
    expect(result.current.plotted[0].points[0].x).toBe(0);
    rerender({ origin: info.start_ns, selected: [field("x")] });
    rerender({ origin: "0", selected: [field("x")] });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.plotted[0]?.points[0]?.x).toBe(1),
    );
  });

  it("requests each field from its own recording", async () => {
    const fetch = mockFetch();
    const other: Selected = { ...field("x"), key: keyOf(1, "/pose", ["x"]), source: 1 };
    const { result } = renderHook(() =>
      useSeries(info.start_ns, [field("x"), field("y"), other]),
    );
    await waitFor(() =>
      expect(result.current.records.map((r) => r.status)).toEqual([
        "complete",
        "complete",
        "complete",
      ]),
    );
    const calls = fetch.mock.calls.map(([url, options]) => [
      url,
      JSON.parse(options.body as string).fields,
    ]);
    expect(calls).toEqual([
      ["/api/files/0/series", [["x"], ["y"]]],
      ["/api/files/1/series", [["x"]]],
    ]);
  });

  it("aborts active streams when stopped and retains partial data", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options: RequestInit) => {
        signal = options.signal as AbortSignal;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        );
      }),
    );
    const { result } = renderHook(() => useSeries(info.start_ns, [field("x")]));
    await waitFor(() => expect(result.current.busy).toBe(true));
    act(() => result.current.stop());
    expect(signal?.aborted).toBe(true);
    await waitFor(() =>
      expect(result.current.records[0]?.status).toBe("stopped"),
    );
    expect(result.current.plotted[0].points).toEqual([]);
  });
  it("decodes enum labels with the definition carried by the selection", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(new Response([
        JSON.stringify({ type: "batch", rows: [{ time_ns: "1000000000", values: ["RUN"] }], scanned_messages: 1 }),
        JSON.stringify({ type: "complete", scanned_messages: 1 }),
        "",
      ].join("\n"))),
    ));
    const mode: Selected = {
      ...field("mode"),
      dataType: "enum",
      enumValues: [{ name: "IDLE", value: 0 }, { name: "RUN", value: 1 }],
    };
    const { result } = renderHook(() => useSeries(info.start_ns, [mode]));
    await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
    expect(result.current.plotted[0].points[0]).toMatchObject({ y: 1, raw: "RUN" });
  });
});

it("uses a shared parent history instead of decoding a numerical field again", async () => {
  const { FieldCache } = await import("./fieldCache");
  const shared = new FieldCache();
  const fetch = vi.fn(async () => new Response(
    '{"type":"batch","rows":[{"time_ns":"1000000000","value":{"x":42}}],"scanned_messages":1}\n{"type":"complete","scanned_messages":1}\n',
  ));
  vi.stubGlobal("fetch", fetch);
  await shared.load({ source: 0, topic: "/pose", path: [] }, new AbortController().signal, () => {});
  const { result } = renderHook(() => useSeries(info.start_ns, [field("x")], shared));
  await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
  expect(result.current.plotted[0].points[0].raw).toBe(42);
  expect(fetch).toHaveBeenCalledTimes(1);
});
