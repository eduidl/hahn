import { describe, expect, it } from "vitest";
import { frameIndexAt, geoPoints, parseFrames, pointBuffers, type GeoValue, type PointCloudValue } from "./viewFrames";

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

describe("parseFrames", () => {
  it("resolves blobs per frame and keeps them aligned", () => {
    const data = { $blob: { offset: 8, length: 2 } };
    const { frames } = parseFrames(concat(
      frame({ type: "frame", time_ns: "1", value: { kind: "image", data } }, [0, 0, 0, 0, 0, 0, 0, 0, 7, 9]),
      frame({ type: "frame", time_ns: "2", error: "bad" }),
      complete,
    ));
    expect(frames[1]).toMatchObject({ time_ns: "2", error: "bad" });
    const blob = frames[0].blob(data);
    expect([...blob]).toEqual([7, 9]);
    expect(blob.byteOffset % 8).toBe(0);
  });
  it("reports unchanged", () => {
    expect(parseFrames(concat(frame({ type: "unchanged" }), complete))).toMatchObject({ frames: [], unchanged: true });
  });
  it("fails on an error event and on a response cut off", () => {
    expect(() => parseFrames(concat(frame({ type: "error", message: "boom" })))).toThrow("boom");
    expect(() => parseFrames(concat(frame({ type: "frame", time_ns: "1", error: "x" })))).toThrow("切れました");
    expect(() => parseFrames(concat(complete).slice(0, 4))).toThrow("切れました");
    expect(() => parseFrames(frame({ type: "frame", time_ns: "1" }, [1, 2]).buffer.slice(0, -8))).toThrow("切れました");
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
    const value: PointCloudValue = { kind: "pointcloud", frame_id: null, count: 2, pose, positions: ref(0, 24), fields: [] };
    const { positions, intensities } = pointBuffers(value, blob);
    expect([...positions]).toEqual([1, 2, 0, 3, 4, 0]);
    expect(positions.buffer).toBe(buffer);
    expect(intensities).toBeNull();
  });
  it("scales an intensity of any type over the frame's range", () => {
    const value: PointCloudValue = {
      kind: "pointcloud", frame_id: null, count: 2, pose, positions: ref(0, 24),
      fields: [{ name: "intensity", type: "u16", data: ref(24, 4) }],
    };
    expect([...pointBuffers(value, blob).intensities!]).toEqual([0, 1]);
  });
});

describe("geoPoints", () => {
  it("swaps GeoJSON's longitude first order and skips other geometries", () => {
    const value: GeoValue = { kind: "geo", features: [
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [139, 35, 40] } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
    ] };
    expect(geoPoints(value)).toEqual([[35, 139]]);
  });
});
