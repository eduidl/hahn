// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTransforms } from "../../src/data/useViewData";
import { withStore } from "../dataStore";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const still = [0, 0, 0, 1];
const sample = (child: string, x: number, time: number) => ({
  child,
  parent: "map",
  translation: [x, 0, 0],
  rotation: still,
  time_ns: String(time),
  stamp_ns: String(time - 1),
});

/** Frame "a" has samples only until time 2; "b" until 10. */
function serve() {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/transforms/static")) return Response.json({ transforms: [] });
    const start = BigInt(new URL(url, "http://x").searchParams.get("start_ns")!);
    return Response.json({
      samples:
        start === 0n
          ? [sample("a", 1, 1), sample("b", 1, 1), sample("a", 2, 2), sample("b", 10, 10)]
          : [],
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("keeps a frame at its last place when asked to, and says so by leaving no gap", async () => {
  serve();
  const { result, rerender } = renderHook(
    ({ ns }) => useTransforms("hold/group", "map", ns, true),
    {
      initialProps: { ns: "1" },
      wrapper: withStore("hold").wrapper,
    },
  );
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("1"));
  rerender({ ns: "2" });
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("2"));
  rerender({ ns: "4" });
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("4"));
  // Where it was last seen, at 2.
  expect(result.current.transforms?.frames.a.translation).toEqual([2, 0, 0]);
  expect(result.current.transforms?.frames.b.translation[0]).toBeCloseTo(4);
});

it("resolves only what the samples cover otherwise, loading them once", async () => {
  const fetch = serve();
  const { result, rerender } = renderHook(({ ns }) => useTransforms("once/group", "map", ns), {
    initialProps: { ns: "1" },
    wrapper: withStore("once").wrapper,
  });
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("1"));
  rerender({ ns: "4" });
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("4"));
  expect(result.current.transforms?.frames.a).toBeUndefined();
  // The static transforms and the chunks around the time, each requested once.
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/runs/once/transforms/static",
    "/api/runs/once/transforms/dynamic?start_ns=0&end_ns=5000000000",
    "/api/runs/once/transforms/dynamic?start_ns=5000000000&end_ns=10000000000",
  ]);
});

it("resolves on the measurement axis and without interpolation when asked", async () => {
  serve();
  const { result } = renderHook(
    () => useTransforms("axis/group", "map", "5", false, { axis: "stamp", interpolate: false }),
    { wrapper: withStore("axis").wrapper },
  );
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("5"));
  // By stamp, b's samples are at 0 and 9; without interpolation the first holds.
  expect(result.current.transforms?.frames.b.translation).toEqual([1, 0, 0]);
});
