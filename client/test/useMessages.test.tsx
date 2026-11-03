// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMessages } from "../src/data/useMessages";
import { initialWorkspace, workspaceReducer, type Widget } from "../src/workspace/widgets";
import { keyOf, type Selected } from "../src/types";

const target = (path: string[] = []): Selected => ({
  key: keyOf("r/0", "/t", path),
  source: "r/0",
  topic: "/t",
  path,
  color: "#fff",
  lineWidth: 1,
  hidden: false,
});
function widgets(path: string[] = []): Record<string, Widget> {
  const state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "table" });
  state.widgets["widget-2"].series = [target(path)];
  return state.widgets;
}
const batch = `${JSON.stringify({
  type: "batch",
  rows: [{ time_ns: "1000000000", value: { x: 1 } }],
  scanned_messages: 1,
})}\n`;
const complete = `${JSON.stringify({ type: "complete", scanned_messages: 1 })}\n`;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("message history loading", () => {
  it("shares duplicate demands and does not fetch on display or playback rerenders", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(batch + complete)));
    vi.stubGlobal("fetch", fetch);
    const initial = widgets();
    initial.copy = { ...initial["widget-2"], id: "copy" };
    const { result, rerender } = renderHook(({ items }) => useMessages("1000000000", items), {
      initialProps: { items: initial },
    });
    await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.records[0].rows).toHaveLength(1);
    rerender({
      items: {
        ...initial,
        copy: {
          ...initial.copy,
          hiddenColumns: [JSON.stringify(["x"])],
          columnWidths: { time: 300 },
        },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const withoutOriginal = { copy: initial.copy };
    rerender({ items: withoutOriginal });
    expect(result.current.records[0].rows).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("aborts obsolete selections and ignores late data from them", async () => {
    const pending: { options: RequestInit; resolve: (r: Response) => void }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options) => new Promise<Response>((resolve) => pending.push({ options, resolve })),
      ),
    );
    const { result, rerender } = renderHook(({ items }) => useMessages("1000000000", items), {
      initialProps: { items: widgets() },
    });
    rerender({ items: widgets(["x"]) });
    expect((pending[0].options.signal as AbortSignal).aborted).toBe(true);
    await act(async () => {
      pending[0].resolve(new Response(batch + complete));
      pending[1].resolve(new Response(complete));
    });
    await waitFor(() => expect(result.current.records[0]?.status).toBe("complete"));
    expect(result.current.records[0].key).toBe(target(["x"]).key);
    expect(result.current.records[0].rows).toEqual([]);
    rerender({ items: {} });
    expect(result.current.records).toEqual([]);
  });
  it("releases an active stream and its rows when the selection goes away", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(batch));
              },
            }),
          ),
        ),
      ),
    );
    const { result, rerender } = renderHook(({ selected }) => useMessages("1000000000", selected), {
      initialProps: { selected: widgets() },
    });
    await waitFor(() => expect(result.current.records[0]?.rows).toHaveLength(1));
    rerender({ selected: {} });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.records).toEqual([]);
  });
  it("reports premature EOF and works under StrictMode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(batch))),
    );
    const { result } = renderHook(() => useMessages("1000000000", widgets()), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.records[0]?.status).toBe("error"));
    expect(result.current.records[0].error).toMatch("before completion");
  });
});
