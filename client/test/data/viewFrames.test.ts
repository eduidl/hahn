import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchViewHistory,
  ViewBatches,
  frameIndexAt,
  parseFrames,
  pointBuffers,
  ViewWindowTooLarge,
  type PointCloudValue,
} from "../../src/data/viewFrames";

function frame(header: object, payload: number[] = []) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const start = (8 + json.length + 7) & ~7;
  const bytes = new Uint8Array(start + ((payload.length + 7) & ~7));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, json.length, true);
  view.setUint32(4, bytes.length - start, true);
  bytes.set(json, 8);
  bytes.set(payload, start);
  return bytes;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
};
const complete = frame({ type: "complete", scanned_messages: 1 });

afterEach(() => vi.unstubAllGlobals());

it("cancels an oversized window without buffering the rest", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
    },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  await expect(
    fetchViewHistory({ source: "r/0", topic: "/t", view: "pose" }, undefined, undefined, 8),
  ).rejects.toBeInstanceOf(ViewWindowTooLarge);
  expect(cancel).toHaveBeenCalledOnce();
});

it("batches views for one group and reports each stream independently", async () => {
  const body = concat(
    frame({ type: "frame", stream: 0, time_ns: "20", error: "bad value" }),
    frame({ type: "error", stream: 1, code: "unknown_view", message: "bad view" }),
    frame({ type: "frame", stream: 0, time_ns: "10", error: "earlier" }),
    frame({ type: "complete", stream: 0, scanned_messages: 2 }),
  );
  const fetch = vi.fn().mockResolvedValue(new Response(body));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  const range = { start_ns: "0", end_ns: "30" };
  const batches = new ViewBatches();
  const first = batches.fetch({ source: "r/0", topic: "/a", view: "pose" }, signal, range);
  const second = batches.fetch({ source: "r/0", topic: "/b", view: "pose" }, signal, range);
  const [ok, error] = await Promise.allSettled([first, second]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(ok.status).toBe("fulfilled");
  if (ok.status === "fulfilled") expect(ok.value.map((item) => item.time_ns)).toEqual(["10", "20"]);
  expect(error.status).toBe("rejected");
  if (error.status === "rejected") expect(error.reason.message).toBe("bad view");
});

it("keeps a batch running when only one consumer cancels", async () => {
  let complete: ((response: Response) => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, options: RequestInit) => {
      requestSignal = options.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  const first = new AbortController();
  const second = new AbortController();
  const range = { start_ns: "0", end_ns: "30" };
  const batches = new ViewBatches();
  const a = batches.fetch({ source: "r/0", topic: "/a", view: "pose" }, first.signal, range);
  const b = batches.fetch({ source: "r/0", topic: "/b", view: "pose" }, second.signal, range);
  const cancelled = expect(a).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  first.abort();
  expect(requestSignal?.aborted).toBe(false);
  complete!(new Response(concat(frame({ type: "complete", stream: 1, scanned_messages: 0 }))));
  await cancelled;
  await expect(b).resolves.toEqual([]);
});

describe("parseFrames", () => {
  it("resolves blobs per frame and keeps them aligned", () => {
    const data = { $blob: { offset: 8, length: 2 } };
    const { frames } = parseFrames(
      concat(
        frame(
          { type: "frame", time_ns: "1", value: { kind: "image", data } },
          [0, 0, 0, 0, 0, 0, 0, 0, 7, 9],
        ),
        frame({ type: "frame", time_ns: "2", error: "bad" }),
        complete,
      ),
    );
    expect(frames[1]).toMatchObject({ time_ns: "2", error: "bad" });
    const blob = frames[0].blob(data);
    expect([...blob]).toEqual([7, 9]);
    expect(blob.byteOffset % 8).toBe(0);
  });
  it("reports unchanged", () => {
    expect(parseFrames(concat(frame({ type: "unchanged" }), complete))).toMatchObject({
      frames: [],
      unchanged: true,
    });
  });
  it("fails on an error event and on a response cut off", () => {
    expect(() =>
      parseFrames(concat(frame({ type: "error", code: "recording_unreadable", message: "boom" }))),
    ).toThrow(expect.objectContaining({ message: "boom", code: "recording_unreadable" }));
    expect(() => parseFrames(concat(frame({ type: "frame", time_ns: "1", error: "x" })))).toThrow(
      "ended prematurely",
    );
    expect(() => parseFrames(concat(complete).slice(0, 4))).toThrow("ended prematurely");
    expect(() =>
      parseFrames(frame({ type: "frame", time_ns: "1" }, [1, 2]).buffer.slice(0, -8)),
    ).toThrow("ended prematurely");
  });
});

describe("frameIndexAt", () => {
  const frames = [{ time_ns: "10" }, { time_ns: "20" }, { time_ns: "20" }, { time_ns: "30" }];
  it("finds the last frame at or before a time, beyond double precision", () => {
    expect(frameIndexAt(frames, 9n)).toBe(-1);
    expect(frameIndexAt(frames, 20n)).toBe(2);
    expect(frameIndexAt(frames, 99n)).toBe(3);
    const close = [{ time_ns: "1760000000123456789" }, { time_ns: "1760000000123456790" }];
    expect(frameIndexAt(close, 1760000000123456789n)).toBe(0);
  });
});

describe("pointBuffers", () => {
  const ref = (offset: number, length: number) => ({ $blob: { offset, length } });
  const pose = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };
  const buffer = new ArrayBuffer(32);
  new Float32Array(buffer, 0, 6).set([1, 2, 0, 3, 4, 0]);
  new Uint16Array(buffer, 24, 2).set([10, 20]);
  const blob = ({ $blob }: { $blob: { offset: number; length: number } }) =>
    new Uint8Array(buffer, $blob.offset, $blob.length);
  it("views positions without copying", () => {
    const value: PointCloudValue = {
      kind: "pointcloud",
      omitted: 0,
      frame_id: null,
      count: 2,
      pose,
      positions: ref(0, 24),
      fields: [],
    };
    const { positions, intensities } = pointBuffers(value, blob);
    expect([...positions]).toEqual([1, 2, 0, 3, 4, 0]);
    expect(positions.buffer).toBe(buffer);
    expect(intensities).toBeNull();
  });
  it("scales an intensity of any type over the frame's range", () => {
    const value: PointCloudValue = {
      kind: "pointcloud",
      omitted: 0,
      frame_id: null,
      count: 2,
      pose,
      positions: ref(0, 24),
      fields: [{ name: "intensity", type: "u16", data: ref(24, 4) }],
    };
    expect([...pointBuffers(value, blob).intensities!]).toEqual([0, 1]);
  });
});
