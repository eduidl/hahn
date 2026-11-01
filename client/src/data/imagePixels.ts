import type { ImageValue, ViewFrame } from "./viewFrames";

/** Decode the protocol's raw pixel encodings to browser RGBA pixels. */
export function rawPixels(value: ImageValue, data: Uint8Array): Uint8ClampedArray {
  const { width, height, step, encoding } = value;
  if (!width || !height || !step || !encoding)
    throw new Error("Missing raw image dimensions or encoding");
  const bytesPerPixel: Record<string, number> = {
    rgb8: 3,
    bgr8: 3,
    "8UC3": 3,
    rgba8: 4,
    bgra8: 4,
    mono8: 1,
    "8UC1": 1,
    mono16: 2,
    "16UC1": 2,
    "32FC1": 4,
    yuv422: 2,
    uyvy: 2,
    yuv422_yuy2: 2,
    yuyv: 2,
    nv12: 1,
    bayer_rggb8: 1,
    bayer_bggr8: 1,
    bayer_gbrg8: 1,
    bayer_grbg8: 1,
  };
  const bpp = bytesPerPixel[encoding];
  if (!bpp) throw new Error(`Unsupported raw image encoding: ${encoding}`);
  const yuv422 = ["yuv422", "uyvy", "yuv422_yuy2", "yuyv"].includes(encoding);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(step) ||
    width < 1 ||
    height < 1 ||
    step < width * bpp ||
    ((yuv422 || encoding === "nv12") && width % 2 !== 0) ||
    (encoding === "nv12" && height % 2 !== 0) ||
    data.length !== step * (height + (encoding === "nv12" ? height / 2 : 0))
  )
    throw new Error("Invalid raw image dimensions or data length");
  const out = new Uint8ClampedArray(width * height * 4);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bgr = ["bgr8", "8UC3", "bgra8"].includes(encoding);
  const bayer = encoding.startsWith("bayer_") ? encoding.slice(6, 10) : "";
  const colorAt = (x: number, y: number) => bayer[(y % 2) * 2 + (x % 2)];
  const interpolate = (x: number, y: number, channel: string) => {
    if (colorAt(x, y) === channel) return data[y * step + x];
    let sum = 0,
      count = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && colorAt(xx, yy) === channel) {
          sum += data[yy * step + xx];
          count++;
        }
      }
    return count ? sum / count : data[y * step + x];
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * step + x * bpp,
        o = (y * width + x) * 4;
      let r = 0,
        g = 0,
        b = 0,
        a = 255;
      if (bayer) {
        r = interpolate(x, y, "r");
        g = interpolate(x, y, "g");
        b = interpolate(x, y, "b");
      } else if (encoding === "rgb8" || encoding === "rgba8") {
        r = data[i];
        g = data[i + 1];
        b = data[i + 2];
        if (bpp === 4) a = data[i + 3];
      } else if (bgr) {
        b = data[i];
        g = data[i + 1];
        r = data[i + 2];
        if (bpp === 4) a = data[i + 3];
      } else if (yuv422 || encoding === "nv12") {
        let yy: number, u: number, v: number;
        if (encoding === "nv12") {
          yy = data[y * step + x];
          const uv = step * height + Math.floor(y / 2) * step + (x & ~1);
          u = data[uv];
          v = data[uv + 1];
        } else {
          const pair = y * step + (x & ~1) * 2;
          if (encoding === "yuv422" || encoding === "uyvy") {
            u = data[pair];
            yy = data[pair + 1 + (x % 2) * 2];
            v = data[pair + 2];
          } else {
            yy = data[pair + (x % 2) * 2];
            u = data[pair + 1];
            v = data[pair + 3];
          }
        }
        // shortcut: raw YUV has no color-range metadata; use BT.601 limited range until a color-space field exists.
        const c = 1.164 * (yy - 16),
          du = u - 128,
          dv = v - 128;
        r = c + 1.596 * dv;
        g = c - 0.392 * du - 0.813 * dv;
        b = c + 2.017 * du;
      } else {
        const gray =
          bpp === 1
            ? data[i]
            : encoding === "32FC1"
              ? view.getFloat32(i, true) * 255
              : view.getUint16(i, true) / 257;
        r = g = b = Number.isFinite(gray) ? gray : 0;
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  return out;
}

/** Decode either a browser image file or the protocol's raw pixels. */
export async function decodeImage(frame: ViewFrame, value: ImageValue, flipY = false) {
  const bytes = frame.blob(value.data);
  const source =
    value.format === "raw"
      ? new ImageData(rawPixels(value, bytes), value.width!, value.height!)
      : new Blob([bytes.slice().buffer], { type: `image/${value.format}` });
  return createImageBitmap(source, { imageOrientation: flipY ? "flipY" : "none" });
}
