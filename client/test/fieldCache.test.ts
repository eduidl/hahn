import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldCache, holdHistories, type FieldTarget } from "../src/data/fieldCache";
import type { MessageRow } from "../src/views/table";
const root: FieldTarget = { source: "r/0", topic: "/t", path: [] };
const child = { ...root, path: ["pose", "x"] };
const rows: MessageRow[] = [
  { time_ns: "1000000000", value: { pose: { x: 1 }, text: "a" } },
  { time_ns: "1000000000", value: { pose: { x: 2 }, text: "b" } },
  { time_ns: "2000000000", value: { pose: null, text: "c" } },
];
const stream = (values = rows) =>
  new Response(
    JSON.stringify({ type: "batch", rows: values, scanned_messages: values.length }) +
      "\n" +
      JSON.stringify({ type: "complete", scanned_messages: values.length }) +
      "\n",
  );
afterEach(() => vi.unstubAllGlobals());
const load = (cache: FieldCache, target = root) =>
  cache.load(target, new AbortController().signal, () => {});

describe("shared field cache", () => {
  it("reuses parent histories for nested fields, retaining ties and known missing values", async () => {
    const fetch = vi.fn(async () => stream());
    vi.stubGlobal("fetch", fetch);
    const cache = new FieldCache();
    await load(cache);
    await load(cache, child);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.read(child)).toEqual(
      rows.map((r, i) => ({ time_ns: r.time_ns, value: [1, 2, null][i] })),
    );
    expect(cache.readScalar(child, "float64")?.map((r) => r.value)).toEqual([1, 2, null]);
    expect(cache.read({ ...child, source: "r/1" })).toBeUndefined();
    expect(cache.read({ ...child, topic: "/other" })).toBeUndefined();
  });

  it("shares in-flight parent/child decoding and does not cancel another consumer", async () => {
    let send!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              send = controller;
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const cache = new FieldCache(),
      parent = new AbortController(),
      nested = new AbortController();
    const first = cache.load(root, parent.signal, () => {});
    const values: MessageRow[] = [];
    const second = cache.load(child, nested.signal, (event) => {
      if (event.type === "batch") values.push(...event.rows);
    });
    parent.abort();
    await Promise.resolve();
    await Promise.resolve();
    send.enqueue(new TextEncoder().encode(await stream().text()));
    send.close();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(values.map((r) => r.value)).toEqual([1, 2, null]);
    expect(cache.read(child)).toHaveLength(3);
  });

  it("shares exact leaf references with the root without overwriting them with previews", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream()),
    );
    const cache = new FieldCache();
    await load(cache);
    const text = { ...root, path: ["text"] };
    expect(cache.readScalar(text, "string")).toBeUndefined();
    cache.putScalar(
      text,
      rows.map((r, i) => ({ time_ns: r.time_ns, value: `exact-${i}` })),
    );
    expect(cache.read(root)?.map((r) => (r.value as { text: string }).text)).toEqual([
      "exact-0",
      "exact-1",
      "exact-2",
    ]);
    expect(cache.readScalar(text, "string")?.map((r) => r.value)).toEqual([
      "exact-0",
      "exact-1",
      "exact-2",
    ]);
  });

  it("does not read a meta field from the message's history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream()),
    );
    const cache = new FieldCache();
    await load(cache);
    expect(cache.read({ ...root, path: ["$meta", "publish_time"] })).toBeUndefined();
  });

  it("selects a small playback range from a history with its predecessor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream()),
    );
    const cache = new FieldCache();
    await load(cache);
    expect(cache.read(child, "1500000000:2500000000")?.map((r) => r.value)).toEqual([2, null]);
    expect(cache.read(child, "0:500000000")).toEqual([]);
  });

  it("evicts old playback windows and clears all recording data", async () => {
    const fetch = vi.fn(async (url: string) => {
      const start_ns = new URL(url, "http://x").searchParams.get("start_ns")!;
      return stream([{ time_ns: start_ns, value: { pose: { x: 1 } } }]);
    });
    vi.stubGlobal("fetch", fetch);
    const cache = new FieldCache();
    for (let i = 0; i < 15; i++)
      await cache.load(root, new AbortController().signal, () => {}, {
        start_ns: String(i * 10),
        end_ns: String(i * 10 + 10),
      });
    expect(cache.read(root, "0:10")).toBeUndefined();
    expect(cache.read(root, "140:150")).toHaveLength(1);
    cache.clear();
    expect(cache.read(root, "140:150")).toBeUndefined();
  });

  it("shares sparse-topic predecessor lookups", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(rows[0])));
    vi.stubGlobal("fetch", fetch);
    const cache = new FieldCache();
    const [a, b] = await Promise.all([cache.seed(root, "1"), cache.seed(root, "1")]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("keeps displayed windows pinned while evicting unused lookahead", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const start_ns = new URL(url, "http://x").searchParams.get("start_ns")!;
      return stream([{ time_ns: start_ns, value: { pose: { x: 1 } } }]);
    }),
  );
  const cache = new FieldCache();
  const release = cache.retain(child, "0:10");
  for (let i = 0; i < 14; i++)
    await cache.load(root, new AbortController().signal, () => {}, {
      start_ns: String(i * 10),
      end_ns: String(i * 10 + 10),
    });
  expect(cache.read(child, "0:10")).toEqual([{ time_ns: "0", value: 1 }]);
  expect(cache.read(root, "10:20")).toBeUndefined();
  release();
  await cache.load(root, new AbortController().signal, () => {}, {
    start_ns: "140",
    end_ns: "150",
  });
  expect(cache.read(child, "0:10")).toBeUndefined();
});

it("sorts reversed times without colliding non-consecutive equal-time messages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      stream([
        { time_ns: "20", value: { pose: { x: 1 } } },
        { time_ns: "10", value: { pose: null } },
        { time_ns: "20", value: { pose: { x: 2 } } },
      ]),
    ),
  );
  const cache = new FieldCache();
  await load(cache);
  expect(cache.read(child)?.map((r) => r.value)).toEqual([null, 1, 2]);
  cache.putScalar(child, [
    { time_ns: "10", value: null },
    { time_ns: "20", value: 11 },
    { time_ns: "20", value: 22 },
  ]);
  expect(
    cache.read(root)?.map((r) => (r.value as { pose: { x: number } | null }).pose?.x ?? null),
  ).toEqual([null, 11, 22]);
  cache.clear();
});

it("lets go of a full history once nothing holds it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => stream()),
  );
  const cache = new FieldCache();
  const other = { ...root, topic: "/other" };
  await load(cache, other);
  const held = new Map<string, () => void>();
  holdHistories(cache, held, [
    { ...root, key: "root" },
    { ...child, key: "child" },
  ]);
  await load(cache);
  // The parent's history also serves the child, so it stays while the child is held.
  holdHistories(cache, held, [{ ...child, key: "child" }]);
  expect(cache.read(child)).toHaveLength(3);
  holdHistories(cache, held, []);
  expect(held.size).toBe(0);
  expect(cache.read(root)).toBeUndefined();
  // A history nobody held is left alone.
  expect(cache.read(other)).toHaveLength(3);
});
