import { ServerError, responseError } from "./errors";
import { sourceUrl } from "./sources";
import type { Schemas, Selected } from "../types";

export type ViewValue = Schemas["ViewValue"];
export type ImageValue = Schemas["ImageValue"];
export type PointCloudValue = Schemas["PointCloudValue"];
export type GeoValue = Schemas["GeoValue"];
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
export function parseFrames(buffer: ArrayBuffer): ViewResponse {
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
    ) as Header;
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

async function fetchBuffer(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw await responseError(response);
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
  targetFrame?: string,
) {
  const params = new URLSearchParams({ topic: target.topic, view: target.view ?? "" });
  if (targetFrame) params.set("target_frame", targetFrame);
  const { frames } = parseFrames(
    await fetchBuffer(`${sourceUrl(target.source)}/views?${params}`, signal),
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

/** The position of each `Point` of a geo value, as `[latitude, longitude]`. */
export function geoPoints(value: GeoValue): [number, number][] {
  return value.features.flatMap((feature) => {
    const geometry = feature.geometry as { type?: string; coordinates?: number[] };
    const [longitude, latitude] = geometry.coordinates ?? [];
    return geometry.type === "Point" && longitude !== undefined && latitude !== undefined
      ? [[latitude, longitude] as [number, number]]
      : [];
  });
}
