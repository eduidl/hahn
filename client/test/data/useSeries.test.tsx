// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldCache } from "../../src/data/fieldCache";
import { useSeries } from "../../src/data/useSeries";
import { keyOf, type Info, type Selected } from "../../src/types";

const info: Info = {
  start_ns: "1000000000",
  end_ns: "2000000000",
  message_count: 2,
};
const field = (name: string): Selected => ({
  key: keyOf("r/0", "/pose", [name]),
  source: "r/0",
  topic: "/pose",
  path: [name],
  color: "#91b8ff",
  lineWidth: 1.5,
  hidden: false,
});

// The cache of a run, as the store gives each widget.
let cache: FieldCache;
beforeEach(() => {
  cache = new FieldCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetch() {
  const fetch = vi.fn((_url: string, _options: RequestInit) => {
    return Promise.resolve(
      new Response(
        [
          JSON.stringify({
            type: "batch",
            rows: [{ time_ns: "1000000000", value: 1 }],
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
      ({ selected }) => useSeries(info.start_ns, selected, cache),
      {
        initialProps: { selected: [field("x")] },
        wrapper: StrictMode,
      },
    );
    await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
    const originalPoints = result.current.plotted[0].points;
    rerender({ selected: [field("x"), field("y")] });
    await waitFor(() => expect(result.current.records[1]?.status).toBe("complete"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(
      `/api/runs/r/groups/0/messages?topic=%2Fpose&path=${encodeURIComponent('["y"]')}&preview=false`,
    );
    expect(result.current.plotted[0].points).toBe(originalPoints);
    expect(result.current.plotted[0].points).toHaveLength(1);
    // A removed field is let go, so adding it again fetches it again.
    rerender({ selected: [field("y")] });
    rerender({ selected: [field("x"), field("y")] });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2][0]).toContain(encodeURIComponent('["x"]'));
  });

  it("does not fetch on display-only rerenders, visibility, or style changes", async () => {
    const fetch = mockFetch();
    const { result, rerender } = renderHook(
      ({ selected, viewport }) => {
        void viewport;
        return useSeries(info.start_ns, selected, cache);
      },
      { initialProps: { selected: [field("x")], viewport: [0, 1] } },
    );
    await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
    const points = result.current.plotted[0].points;
    rerender({
      selected: [{ ...field("x"), hidden: true, color: "#ff0000", lineWidth: 4 }],
      viewport: [0.2, 0.6],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.plotted[0].points).toBe(points);
    expect(result.current.plotted[0].hidden).toBe(true);
    expect(result.current.plotted[0].color).toBe("#ff0000");
    expect(result.current.plotted[0].lineWidth).toBe(4);
    expect(fetch.mock.calls[0][0]).not.toContain("start_ns");
    expect(fetch.mock.calls[0][0]).not.toContain("end_ns");
  });

  it("requests each field separately", async () => {
    const fetch = mockFetch();
    const selected = Array.from({ length: 70 }, (_, i) => field(`field${i}`));
    const { result } = renderHook(() => useSeries(info.start_ns, selected, cache));
    await waitFor(() =>
      expect(result.current.records.filter((r) => r.status === "complete")).toHaveLength(70),
    );
    expect(fetch).toHaveBeenCalledTimes(70);
  });

  it("requests each field from its own recording", async () => {
    const fetch = mockFetch();
    const other: Selected = { ...field("x"), key: keyOf("r/1", "/pose", ["x"]), source: "r/1" };
    const { result } = renderHook(() =>
      useSeries(info.start_ns, [field("x"), field("y"), other], cache),
    );
    await waitFor(() =>
      expect(result.current.records.map((r) => r.status)).toEqual([
        "complete",
        "complete",
        "complete",
      ]),
    );
    const calls = fetch.mock.calls.map(([url]) => {
      const { pathname, searchParams } = new URL(url, "http://x");
      return [pathname, searchParams.get("path")];
    });
    expect(calls).toEqual([
      ["/api/runs/r/groups/0/messages", '["x"]'],
      ["/api/runs/r/groups/0/messages", '["y"]'],
      ["/api/runs/r/groups/1/messages", '["x"]'],
    ]);
  });

  it("aborts a stream when its field is removed", async () => {
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
    const { result, rerender } = renderHook(
      ({ fields }) => useSeries(info.start_ns, fields, cache),
      {
        initialProps: { fields: [field("x")] },
      },
    );
    await waitFor(() => expect(result.current.busy).toBe(true));
    rerender({ fields: [] });
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.busy).toBe(false));

    // Adding it back must not leave a partial series behind: it fetches again.
    const fetches = vi.mocked(fetch).mock.calls.length;
    rerender({ fields: [field("x")] });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBe(fetches + 1));
    await waitFor(() => expect(result.current.records[0]?.status).toBe("loading"));
  });
  it("plots enums by their number, keeping it as the raw value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            [
              JSON.stringify({
                type: "batch",
                rows: [{ time_ns: "1000000000", value: 1 }],
                scanned_messages: 1,
              }),
              JSON.stringify({ type: "complete", scanned_messages: 1 }),
              "",
            ].join("\n"),
          ),
        ),
      ),
    );
    const mode: Selected = {
      ...field("mode"),
      dataType: "enum",
      enumValues: [
        { name: "IDLE", value: "0" },
        { name: "RUN", value: "1" },
      ],
    };
    const { result } = renderHook(() => useSeries(info.start_ns, [mode], cache));
    await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
    expect(result.current.plotted[0].points[0]).toMatchObject({ y: 1, raw: 1 });
  });
});

it("uses a shared parent history instead of decoding a numerical field again", async () => {
  const shared = new FieldCache();
  const fetch = vi.fn(
    async () =>
      new Response(
        '{"type":"batch","rows":[{"time_ns":"1000000000","value":{"x":42}}],"scanned_messages":1}\n{"type":"complete","scanned_messages":1}\n',
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await shared.load(
    { source: "r/0", topic: "/pose", path: [] },
    new AbortController().signal,
    () => {},
  );
  const { result } = renderHook(() => useSeries(info.start_ns, [field("x")], shared));
  await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
  expect(result.current.plotted[0].points[0].raw).toBe(42);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps the histories of a shared cache when the origin moves", async () => {
  const shared = new FieldCache();
  const fetch = mockFetch();
  const { result, rerender } = renderHook(
    ({ origin, selected }) => useSeries(origin, selected, shared),
    { initialProps: { origin: info.start_ns, selected: [field("x")] } },
  );
  await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
  // Opening a group that starts earlier moves the origin back by a second.
  rerender({ origin: "0", selected: [field("x")] });
  await waitFor(() => expect(result.current.plotted[0]?.points[0]?.x).toBe(1));
  expect(fetch).toHaveBeenCalledTimes(1);
  // The history is still let go once no widget shows it.
  rerender({ origin: "0", selected: [] });
  await waitFor(() => expect(shared.hasHistory(field("x"))).toBe(false));
});
