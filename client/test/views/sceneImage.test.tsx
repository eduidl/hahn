// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { CameraLayer } from "../../src/views/sceneLayers";
import { buildFieldIndex } from "../../src/workspace/fieldIndex";

const mocks = vi.hoisted(() => ({ frame: undefined as any }));
vi.mock("../../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../../src/data/useViewData")>()),
  useViewFrame: () => ({ frame: mocks.frame, error: "" }),
  useTransforms: () => ({ transforms: undefined, error: "" }),
}));
vi.mock("../../src/views/useCameraCalibration", () => ({
  useCameraCalibration: () => ({
    calibration: {
      kind: "camera_calibration",
      frame_id: "camera",
      width: 640,
      height: 480,
      intrinsics: [400, 0, 320, 0, 400, 240, 0, 0, 1],
      distortion: [],
      distortion_model: "",
    },
    error: "",
  }),
}));
afterEach(() => vi.unstubAllGlobals());

it("keeps the displayed texture while the next image is decoding", async () => {
  const pending: ((bitmap: any) => void)[] = [];
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(() => new Promise((resolve) => pending.push(resolve))),
  );
  const value = {
    kind: "image",
    frame_id: "camera",
    format: "png",
    data: { $blob: { offset: 0, length: 1 } },
  };
  const frame = (time: string) => ({ time_ns: time, value, blob: () => new Uint8Array([1]) });
  const stage = {
    scene: new THREE.Scene(),
    invalidate: vi.fn(),
    fit: vi.fn(),
    reframe: vi.fn(),
    resetView: vi.fn(),
    setOrigin: vi.fn(),
  };
  const series = {
    key: "camera",
    source: "r/0",
    topic: "/camera",
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view: "image",
  };
  const index = buildFieldIndex([]);
  mocks.frame = frame("1");
  const view = render(
    <CameraLayer series={series} info={null} target={null} stage={stage} index={index} />,
  );
  await waitFor(() => expect(pending).toHaveLength(1));
  const first = { close: vi.fn() };
  await act(async () => pending[0](first));
  const group = stage.scene.children[0];
  const plane = group.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >;
  const oldTexture = plane.material.map;
  expect(plane.visible).toBe(true);
  expect(plane.scale.toArray()).toEqual([1, 1, 1]);
  view.rerender(
    <CameraLayer
      series={{ ...series, imageDistance: 5 }}
      info={null}
      target={null}
      stage={stage}
      index={index}
    />,
  );
  expect(plane.scale.toArray()).toEqual([5, 5, 5]);
  expect(plane.material.map).toBe(oldTexture);
  expect(pending).toHaveLength(1);
  mocks.frame = frame("2");
  view.rerender(
    <CameraLayer series={series} info={null} target={null} stage={stage} index={index} />,
  );
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(group.children).toContain(plane);
  expect(plane.material.map).toBe(oldTexture);
  expect(first.close).not.toHaveBeenCalled();
  const second = { close: vi.fn() };
  await act(async () => pending[1](second));
  expect(plane.material.map).not.toBe(oldTexture);
  expect(first.close).toHaveBeenCalledOnce();
  view.unmount();
  expect(second.close).toHaveBeenCalledOnce();
});

it("uses raw pixels as a 3D camera texture", async () => {
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  const bitmap = { width: 2, height: 1, close: vi.fn() };
  const decode = vi.fn(async (_source: ImageBitmapSource) => bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  mocks.frame = {
    time_ns: "1",
    value: {
      kind: "image",
      frame_id: "camera",
      format: "raw",
      width: 2,
      height: 1,
      step: 6,
      encoding: "rgb8",
      data: { $blob: { offset: 0, length: 6 } },
    },
    blob: () => Uint8Array.from([255, 0, 0, 0, 255, 0]),
  };
  const stage = {
    scene: new THREE.Scene(),
    invalidate: vi.fn(),
    fit: vi.fn(),
    reframe: vi.fn(),
    resetView: vi.fn(),
    setOrigin: vi.fn(),
  };
  const series = {
    key: "camera",
    source: "r/0",
    topic: "/camera",
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view: "raw_image",
  };
  const view = render(
    <CameraLayer
      series={series}
      info={null}
      target={null}
      stage={stage}
      index={buildFieldIndex([])}
    />,
  );
  await waitFor(() => expect(decode).toHaveBeenCalled());
  const source = decode.mock.calls[0][0] as any;
  expect([...source.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  await waitFor(() =>
    expect(
      (stage.scene.children[0].children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh)
        .visible,
    ).toBe(true),
  );
  view.unmount();
  expect(bitmap.close).toHaveBeenCalledOnce();
});
