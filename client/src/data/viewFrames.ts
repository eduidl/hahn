import { ServerError } from "./errors";
import { request } from "./request";
import { sourceUrl } from "./sources";
import type { Schemas, Selected } from "../types";

export type ViewValue = Schemas["ViewValue"];
export type ImageValue = Schemas["ImageValue"];
export type PointCloudValue = Schemas["PointCloudValue"];
export type GeoValue = Schemas["GeoValue"];
export type GeoLocationValue = Schemas["GeoLocationValue"];
export type Transform = Schemas["Transform"];
export type BlobRef = Schemas["BlobRef"];
type Header = Schemas["ViewEvent"];

/** One message of a view: its value, or why it could not be converted. */
export type ViewFrame = {
  time_ns: string;
  value?: ViewValue;
  error?: string;
  /** Resolves the value's blob references. */
  blob: (ref: BlobRef) => Uint8Array;
};
export type ViewResponse = { frames: ViewFrame[]; unchanged: boolean };

const lengths = 8;

/**
 * Frames are padded to 8 bytes, so typed views of a whole response stay aligned.
 * A response without `complete` or `error` was cut off, which is a failure.
 */
export function parseFrames(buffer: ArrayBuffer, stream?: number): ViewResponse {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const frames: ViewFrame[] = [];
  let unchanged = false;
  let ended = false;
  for (let at = 0; at < buffer.byteLength; ) {
    if (at + lengths > buffer.byteLength) throw new Error("The response ended prematurely");
    const headerLength = view.getUint32(at, true);
    const payloadLength = view.getUint32(at + 4, true);
    const payload = (at + lengths + headerLength + 7) & ~7;
    if (payload + payloadLength > buffer.byteLength)
      throw new Error("The response ended prematurely");
    const header = JSON.parse(
      decoder.decode(new Uint8Array(buffer, at + lengths, headerLength)),
    ) as Header & { stream?: number };
    if (header.stream !== stream) {
      at = payload + payloadLength;
      continue;
    }
    if (header.type === "error") throw new ServerError(header.message, header.code);
    if (header.type === "complete") ended = true;
    if (header.type === "unchanged") unchanged = true;
    if (header.type === "frame")
      frames.push({
        time_ns: header.time_ns,
        value: "value" in header ? header.value : undefined,
        error: "error" in header ? header.error : undefined,
        blob: ({ $blob }) => new Uint8Array(buffer, payload + $blob.offset, $blob.length),
      });
    at = payload + payloadLength;
  }
  if (!ended) throw new Error("The response ended prematurely");
  return { frames, unchanged };
}

export class ViewWindowTooLarge extends Error {}

async function fetchBuffer(
  url: string,
  signal?: AbortSignal,
  maxBytes?: number,
  init?: RequestInit,
) {
  const response = await request(url, { ...init, signal });
  if (maxBytes !== undefined && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new ViewWindowTooLarge();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes.buffer;
  }
  return response.arrayBuffer();
}

type ViewTarget = Pick<Selected, "source" | "topic" | "view">;

/** The frame current at `ns`; `known` when the client's frame still is, null with none. */
export async function fetchLatestFrame(
  target: ViewTarget,
  ns: string,
  known: ViewFrame | null | undefined,
  signal?: AbortSignal,
): Promise<ViewFrame | null> {
  const params = new URLSearchParams({ topic: target.topic, view: target.view ?? "", time_ns: ns });
  if (known) params.set("known_time_ns", known.time_ns);
  const { frames, unchanged } = parseFrames(
    await fetchBuffer(`${sourceUrl(target.source)}/views/latest?${params}`, signal),
  );
  return unchanged && known ? known : (frames[0] ?? null);
}

/** Every frame of a view, ordered by time: recordings need not be. */
export async function fetchViewHistory(
  target: ViewTarget,
  signal?: AbortSignal,
  /** Recording time, the end excluded; the whole recording when left out. */
  range?: { start_ns: string; end_ns: string },
  maxBytes?: number,
) {
  const params = new URLSearchParams({ topic: target.topic, view: target.view ?? "", ...range });
  const { frames } = parseFrames(
    await fetchBuffer(`${sourceUrl(target.source)}/views?${params}`, signal, maxBytes),
  );
  const time = (frame: ViewFrame) => BigInt(frame.time_ns);
  return frames.sort((a, b) => (time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : 0));
}

/** The index of the last frame at or before `ns`, or -1. */
export function frameIndexAt(frames: Pick<ViewFrame, "time_ns">[], ns: bigint) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (BigInt(frames[middle].time_ns) <= ns) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

const columns = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

export type PointBuffers = {
  /** x, y, z per point. */
  positions: Float32Array;
  /** Per point, from 0 to 1 over the frame's range, when the cloud has an intensity. */
  intensities: Float32Array | null;
};

/** Blobs are aligned, so columns are views of the response rather than copies. */
export function pointBuffers(value: PointCloudValue, blob: ViewFrame["blob"]): PointBuffers {
  const bytes = blob(value.positions);
  const positions = new Float32Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength / 4,
  );
  const intensity = value.fields.find((field) => field.name === "intensity");
  if (!intensity) return { positions, intensities: null };
  const Column = columns[intensity.type];
  const data = blob(intensity.data);
  const raw = new Column(
    data.buffer as ArrayBuffer,
    data.byteOffset,
    data.byteLength / Column.BYTES_PER_ELEMENT,
  );
  let min = Infinity;
  let max = -Infinity;
  for (const v of raw) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  return { positions, intensities: Float32Array.from(raw, (v) => (v - min) / span) };
}

type BatchPending = {
  target: ViewTarget;
  signal: AbortSignal;
  resolve: (frames: ViewFrame[]) => void;
  reject: (error: unknown) => void;
  active: boolean;
  abort: () => void;
};
/** Coalesces small views requested together for the same group and time range. */
export class ViewBatches {
  private pending = new Map<string, BatchPending[]>();

  fetch(
    target: ViewTarget,
    signal: AbortSignal,
    range: { start_ns: string; end_ns: string },
  ): Promise<ViewFrame[]> {
    const key = JSON.stringify([target.source, range.start_ns, range.end_ns]);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const entry: BatchPending = {
        target,
        signal,
        active: true,
        resolve: (frames) => {
          entry.active = false;
          signal.removeEventListener("abort", entry.abort);
          resolve(frames);
        },
        reject: (error) => {
          entry.active = false;
          signal.removeEventListener("abort", entry.abort);
          reject(error);
        },
        abort: () => entry.reject(new DOMException("Aborted", "AbortError")),
      };
      let pending = this.pending.get(key);
      if (!pending) {
        const queued: BatchPending[] = [];
        pending = queued;
        this.pending.set(key, queued);
        setTimeout(() => {
          this.pending.delete(key);
          const active = queued.filter((item) => item.active);
          for (let i = 0; i < active.length; i += 32) {
            void sendBatch(active.slice(i, i + 32), range);
          }
        }, 0);
      }
      pending.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
    });
  }
}

async function sendBatch(entries: BatchPending[], range: { start_ns: string; end_ns: string }) {
  if (!entries.length) return;
  if (entries.length === 1) {
    const item = entries[0];
    try {
      item.resolve(await fetchViewHistory(item.target, item.signal, range, 8 * 1024 * 1024));
    } catch (error) {
      item.reject(error);
    }
    return;
  }
  const controller = new AbortController();
  const cancel = () => {
    if (entries.every((item) => !item.active)) controller.abort();
  };
  for (const item of entries) item.signal.addEventListener("abort", cancel, { once: true });
  try {
    const buffer = await fetchBuffer(
      `${sourceUrl(entries[0].target.source)}/views/batch`,
      controller.signal,
      8 * 1024 * 1024,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...range,
          views: entries.map(({ target }) => ({ topic: target.topic, view: target.view ?? "" })),
        }),
      },
    );
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].active) continue;
      try {
        const { frames } = parseFrames(buffer, i);
        frames.sort((a, b) =>
          BigInt(a.time_ns) < BigInt(b.time_ns)
            ? -1
            : BigInt(a.time_ns) > BigInt(b.time_ns)
              ? 1
              : 0,
        );
        entries[i].resolve(frames);
      } catch (error) {
        entries[i].reject(error);
      }
    }
  } catch (error) {
    for (const item of entries) {
      if (!item.active) continue;
      if (error instanceof ViewWindowTooLarge) {
        try {
          item.resolve(await fetchViewHistory(item.target, item.signal, range, 8 * 1024 * 1024));
        } catch (individualError) {
          item.reject(individualError);
        }
      } else item.reject(error);
    }
  } finally {
    for (const item of entries) item.signal.removeEventListener("abort", cancel);
  }
}
