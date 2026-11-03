// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTransforms } from "../../src/data/useViewData";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const transform = (x: number) => ({ translation: [x, 0, 0], rotation: [0, 0, 0, 1] });

function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const params = new URL(url, "http://x").searchParams;
      const time = params.get("time_ns")!;
      // The frame "a" has no samples after time 1.
      const frames = time === "1" ? { a: transform(1), b: transform(1) } : { b: transform(2) };
      return Response.json({ time_ns: time, target: params.get("target"), frames });
    }),
  );
}

it("keeps a frame at its last place when asked to, and says so by leaving no gap", async () => {
  serve();
  const { result, rerender } = renderHook(({ ns }) => useTransforms("run/group", "map", ns, true), {
    initialProps: { ns: "1" },
  });
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("1"));
  rerender({ ns: "2" });
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("2"));
  expect(result.current.transforms?.frames.a).toEqual(transform(1));
  expect(result.current.transforms?.frames.b).toEqual(transform(2));
});

it("reports only what the server knows otherwise", async () => {
  serve();
  const { result, rerender } = renderHook(({ ns }) => useTransforms("run/group", "map", ns), {
    initialProps: { ns: "1" },
  });
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("1"));
  rerender({ ns: "2" });
  await waitFor(() => expect(result.current.transforms?.time_ns).toBe("2"));
  expect(result.current.transforms?.frames.a).toBeUndefined();
});
