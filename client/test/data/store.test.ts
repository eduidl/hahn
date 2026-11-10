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

it("reads a view's history once while widgets hold it, and lets it go after", async () => {
  // A view response that ends at once: a header padded to 8 bytes, and no payload.
  const header = new TextEncoder().encode('{"type":"complete","scanned_messages":0}');
  const empty = () => {
    const bytes = new Uint8Array(8 + Math.ceil(header.length / 8) * 8);
    new DataView(bytes.buffer).setUint32(0, header.length, true);
    bytes.set(header, 8);
    return new Response(bytes);
  };
  const fetch = vi.fn(async () => empty());
  vi.stubGlobal("fetch", fetch);
  const views = new DataStore("r").views;
  const target = { source: "r/0", topic: "/gps", view: "geo_location" };
  const release = [views.retainHistory(target), views.retainHistory(target)];
  const signal = new AbortController().signal;
  await Promise.all([views.history(target, signal), views.history(target, signal)]);
  await views.history(target, signal);
  expect(fetch).toHaveBeenCalledTimes(1);
  release[0]();
  await views.history(target, signal);
  expect(fetch).toHaveBeenCalledTimes(1);
  release[1]();
  await views.history(target, signal);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("places a whole history with the static transforms already read", async () => {
  const fetch = vi.fn(async (url: string) =>
    Response.json(url.endsWith("/static") ? { transforms: [] } : { samples: [] }),
  );
  vi.stubGlobal("fetch", fetch);
  const transforms = new DataStore("r").transforms("/api/runs/r")!;
  await transforms.ensure(0n);
  const statics = () => fetch.mock.calls.filter(([url]) => url.endsWith("/static")).length;
  expect(statics()).toBe(1);
  await transforms.over(0n, 10n);
  expect(statics()).toBe(1);
});

it("reads ahead the small views of a group together, a window at a time", async () => {
  const signals = hang();
  const fetch = vi.mocked(globalThis.fetch);
  const views = new DataStore("r").views;
  const pose = { source: "r/0", topic: "/pose", view: "pose" };
  const boxes = { source: "r/0", topic: "/boxes", view: "bbox3d" };
  const release = [views.ahead(pose, 0n, 2, true), views.ahead(boxes, 0n, 2, true)];
  await new Promise((resolve) => setTimeout(resolve, 0));
  const batches = fetch.mock.calls.filter(([url]) => String(url).endsWith("/views/batch"));
  expect(batches.map(([, init]) => JSON.parse(String(init!.body)).start_ns)).toEqual([
    "1000000000",
    "2000000000",
  ]);
  for (const done of release) done();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
