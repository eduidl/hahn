import { afterEach, expect, it, vi } from "vitest";
import { DataStore } from "../../src/data/store";

afterEach(() => vi.unstubAllGlobals());

/** Requests that never answer, keeping each one's signal. */
function hang() {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => {});
    }),
  );
  return signals;
}

it("gives the transforms of its own run only", () => {
  const store = new DataStore("r");
  expect(store.transforms("/api/runs/r")?.run).toBe("/api/runs/r");
  expect(store.transforms("/api/runs/other")).toBeUndefined();
  expect(new DataStore(null).transforms("/api/runs/r")).toBeUndefined();
});

it("stops the requests under way when cleared, and reads again afterwards", async () => {
  const signals = hang();
  const store = new DataStore("r");
  void store.transforms("/api/runs/r")!.ensure(0n);
  void store.fields.load(
    { source: "r/0", topic: "/t", path: [] },
    new AbortController().signal,
    () => {},
  );
  expect(signals.length).toBeGreaterThan(1);
  store.clear();
  expect(signals.every((signal) => signal.aborted)).toBe(true);

  void store.transforms("/api/runs/r")!.ensure(0n);
  expect(signals.at(-1)!.aborted).toBe(false);
});

it("keeps reading a view's window while one of the views showing it remains", async () => {
  const signals = hang();
  const views = new DataStore("r").views;
  const target = { source: "r/0", topic: "/t", view: "pose" };
  const first = new AbortController();
  const second = new AbortController();
  const a = views.window(target, 0n, first.signal);
  const b = views.window(target, 0n, second.signal);
  // The frame before the window and the window itself, once for both.
  expect(signals).toHaveLength(2);
  first.abort();
  await expect(a).rejects.toMatchObject({ name: "AbortError" });
  expect(signals.some((signal) => signal.aborted)).toBe(false);
  second.abort();
  await expect(b).rejects.toMatchObject({ name: "AbortError" });
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
