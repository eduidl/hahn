import { expect, it } from "vitest";
import { rawPixels } from "../src/data/imagePixels";
import type { ImageValue } from "../src/data/viewFrames";

const raw = (
  encoding: NonNullable<ImageValue["encoding"]>,
  width: number,
  height: number,
  step: number,
): ImageValue => ({
  kind: "image",
  frame_id: "camera",
  format: "raw",
  encoding,
  width,
  height,
  step,
  data: { $blob: { offset: 0, length: 0 } },
});
it("reads RGB rows with padding and BGR with alpha", () => {
  expect([
    ...rawPixels(
      raw("rgb8", 2, 2, 8),
      Uint8Array.from([255, 0, 0, 0, 255, 0, 9, 9, 0, 0, 255, 255, 255, 255, 8, 8]),
    ),
  ]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  expect([...rawPixels(raw("bgra8", 1, 1, 4), Uint8Array.from([1, 2, 3, 4]))]).toEqual([
    3, 2, 1, 4,
  ]);
});
it("reads grayscale numeric formats and unaligned little-endian pixels", () => {
  const data = Uint8Array.from([9, 0, 0, 255, 255]);
  expect([...rawPixels(raw("mono16", 2, 1, 4), data.subarray(1))]).toEqual([
    0, 0, 0, 255, 255, 255, 255, 255,
  ]);
  const floats = new Uint8Array(8);
  const view = new DataView(floats.buffer);
  view.setFloat32(0, 0.5, true);
  view.setFloat32(4, NaN, true);
  expect([...rawPixels(raw("32FC1", 2, 1, 8), floats)]).toEqual([128, 128, 128, 255, 0, 0, 0, 255]);
});
it("reads YUV pairs and NV12 planes", () => {
  const expected = [0, 0, 0, 255, 255, 255, 255, 255];
  expect([...rawPixels(raw("uyvy", 2, 1, 4), Uint8Array.from([128, 16, 128, 235]))]).toEqual(
    expected,
  );
  expect([...rawPixels(raw("yuyv", 2, 1, 4), Uint8Array.from([16, 128, 235, 128]))]).toEqual(
    expected,
  );
  expect([
    ...rawPixels(raw("nv12", 2, 2, 2), Uint8Array.from([16, 235, 16, 235, 128, 128])),
  ]).toEqual([...expected, ...expected]);
});
it("interpolates Bayer colors and rejects malformed rows", () => {
  expect([...rawPixels(raw("bayer_rggb8", 2, 2, 2), Uint8Array.from([100, 50, 50, 10]))]).toEqual([
    100, 50, 10, 255, 100, 50, 10, 255, 100, 50, 10, 255, 100, 50, 10, 255,
  ]);
  expect(() => rawPixels(raw("rgb8", 2, 1, 5), new Uint8Array(5))).toThrow("Invalid raw image");
  expect(() => rawPixels(raw("nv12", 2, 1, 2), new Uint8Array(2))).toThrow("Invalid raw image");
});
