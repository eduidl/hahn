// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fullImage, ImageView, panImage, zoomImage } from "../../src/views/ImageView";
import { buildFieldIndex } from "../../src/workspace/fieldIndex";
import { initialWorkspace, workspaceReducer } from "../../src/workspace/widgets";
import type { Topic } from "../../src/types";
import { withStore } from "../dataStore";

const mocks = vi.hoisted(() => ({ frame: null as any, fetch: vi.fn(), history: vi.fn() }));
vi.mock("../../src/data/useViewData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/data/useViewData")>()),
  useViewFrame: () => ({ frame: mocks.frame, error: "" }),
}));
vi.mock("../../src/data/viewFrames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/data/viewFrames")>()),
  fetchLatestFrame: mocks.fetch,
  fetchViewHistory: mocks.history,
  pointBuffers: () => ({ positions: new Float32Array([0, 0, 2]), intensities: null }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the previous image and points visible while the next projection loads", async () => {
  let count = 0;
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 640;
      naturalHeight = 480;
      onload: (() => void) | null = null;
      onerror = null;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.stubGlobal("URL", { createObjectURL: () => `blob:${++count}`, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
  } as any);
  const imageValue = {
    kind: "image",
    frame_id: "camera",
    format: "png",
    data: { $blob: { offset: 0, length: 1 } },
  };
  const image = (time: string) => ({
    time_ns: time,
    value: imageValue,
    blob: () => new Uint8Array([1]),
  });
  const calibration = {
    time_ns: "1",
    value: {
      kind: "camera_calibration",
      frame_id: "camera",
      width: 640,
      height: 480,
      intrinsics: [400, 0, 320, 0, 400, 240, 0, 0, 1],
      distortion: [],
      distortion_model: "",
    },
    blob: () => new Uint8Array(),
  };
  const cloud = {
    time_ns: "1",
    value: {
      kind: "pointcloud",
      frame_id: "camera",
      pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
    },
    blob: () => new Uint8Array(),
  };
  let resolveCloud!: (value: any) => void;
  const pending = new Promise((resolve) => {
    resolveCloud = resolve;
  });
  mocks.fetch.mockImplementation((target: { topic: string }, time: string) =>
    target.topic === "/calibration"
      ? Promise.resolve(calibration)
      : time === "1"
        ? Promise.resolve(cloud)
        : pending,
  );
  const topic = (name: string, kind: string): Topic => ({
    source: "r/0",
    topic: name,
    schema_name: "T",
    schema_encoding: null,
    views: [
      {
        id: kind,
        kind,
        name: kind,
        // As the server suggests from the names of a camera's topics.
        ...(kind === "image"
          ? { calibration: { topic: "/calibration", view: "camera_calibration" } }
          : {}),
      },
    ],
    message_count: 1,
    error: null,
    fields: [],
  });
  mocks.history.mockResolvedValue([]);
  const index = buildFieldIndex([
    topic("/image", "image"),
    topic("/cloud", "pointcloud"),
    topic("/calibration", "camera_calibration"),
  ]);
  const state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "image",
  });
  const widget = state.widgets["widget-1"];
  widget.series = ["image", "cloud"].map((name, i) => ({
    key: name,
    source: "r/0",
    topic: `/${name}`,
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view: i ? "pointcloud" : "image",
  }));
  const info = { start_ns: "0", end_ns: "10", message_count: 1 };
  mocks.frame = image("1");
  const view = render(
    <ImageView widget={widget} info={info} index={index} />,
    withStore(widget.series[0].source.split("/")[0]),
  );
  await waitFor(() => expect(view.container.querySelector("canvas")).not.toBeNull());
  const oldSrc = screen.getByRole("img").getAttribute("src");
  mocks.frame = image("2");
  view.rerender(<ImageView widget={widget} info={info} index={index} />);
  await waitFor(() =>
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "/cloud" }),
      "2",
      expect.anything(),
      expect.anything(),
    ),
  );
  expect(screen.getByRole("img").getAttribute("src")).toBe(oldSrc);
  expect(view.container.querySelector("canvas")).not.toBeNull();
  resolveCloud(cloud);
  await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).not.toBe(oldSrc));
  expect(view.container.querySelector("canvas")).not.toBeNull();
});

it("projects a cloud of another frame with transforms resolved at the image's stamp", async () => {
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 640;
      naturalHeight = 480;
      onload: (() => void) | null = null;
      onerror = null;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:1", revokeObjectURL: vi.fn() });
  const fillRect = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    fillRect,
  } as any);
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      if (url.endsWith("/transforms/static")) return Response.json({ transforms: [] });
      // The lidar sits 1 m from the camera at stamp 4, and nowhere by log time 5.
      return Response.json({
        samples: [3, 4].map((stamp) => ({
          child: "lidar",
          parent: "camera",
          translation: [1, 0, 0],
          rotation: [0, 0, 0, 1],
          time_ns: String(stamp - 2),
          stamp_ns: String(stamp),
        })),
      });
    }),
  );
  const calibration = {
    time_ns: "1",
    value: {
      kind: "camera_calibration",
      frame_id: "camera",
      width: 640,
      height: 480,
      intrinsics: [400, 0, 320, 0, 400, 240, 0, 0, 1],
      distortion: [],
      distortion_model: "",
    },
    blob: () => new Uint8Array(),
  };
  const cloud = {
    time_ns: "5",
    value: {
      kind: "pointcloud",
      frame_id: "lidar",
      pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
    },
    blob: () => new Uint8Array(),
  };
  mocks.fetch.mockImplementation((target: { topic: string }) =>
    Promise.resolve(target.topic === "/calibration" ? calibration : cloud),
  );
  const topic = (name: string, kind: string): Topic => ({
    source: "stamped/0",
    topic: name,
    schema_name: "T",
    schema_encoding: null,
    views: [
      {
        id: kind,
        kind,
        name: kind,
        // As the server suggests from the names of a camera's topics.
        ...(kind === "image"
          ? { calibration: { topic: "/calibration", view: "camera_calibration" } }
          : {}),
      },
    ],
    message_count: 1,
    error: null,
    fields: [],
  });
  mocks.history.mockResolvedValue([]);
  const index = buildFieldIndex([
    topic("/image", "image"),
    topic("/cloud", "pointcloud"),
    topic("/calibration", "camera_calibration"),
  ]);
  const state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "image",
  });
  const widget = state.widgets["widget-1"];
  widget.series = ["image", "cloud"].map((name, i) => ({
    key: name,
    source: "stamped/0",
    topic: `/${name}`,
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view: i ? "pointcloud" : "image",
  }));
  mocks.frame = {
    time_ns: "5",
    value: {
      kind: "image",
      frame_id: "camera",
      stamp_ns: "4",
      format: "png",
      data: { $blob: { offset: 0, length: 1 } },
    },
    blob: () => new Uint8Array([1]),
  };
  const info = { start_ns: "0", end_ns: "10", message_count: 1 };
  const view = render(
    <ImageView widget={widget} info={info} index={index} />,
    withStore(widget.series[0].source.split("/")[0]),
  );
  await waitFor(() => expect(view.container.querySelector("canvas")).not.toBeNull());
  // Resolved from the run's samples; the server is not asked to resolve.
  expect(requests).toContain("/api/runs/stamped/transforms/static");
  expect(requests.some((url) => url.includes("/transforms?"))).toBe(false);
  // The point, 2 m ahead in the lidar, is drawn: the transform was found.
  await waitFor(() => expect(fillRect).toHaveBeenCalled());
});

it("overlays the marks of the image's stamp, sought around its time", async () => {
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 640;
      naturalHeight = 480;
      onload: (() => void) | null = null;
      onerror = null;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:1", revokeObjectURL: vi.fn() });
  const stroke = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke,
    fillText: vi.fn(),
  } as any);
  const marks = (time: string, stamp: string) => ({
    time_ns: time,
    value: {
      kind: "image_annotations",
      stamp_ns: stamp,
      annotations: [
        {
          type: "line_loop",
          points: [
            [1, 1],
            [2, 1],
            [2, 2],
          ],
        },
      ],
      omitted: 0,
    },
    blob: () => new Uint8Array(),
  });
  mocks.history.mockResolvedValue([marks("4000000000", "3"), marks("6000000000", "5")]);
  const topic = (name: string, kind: string): Topic => ({
    source: "r/0",
    topic: name,
    schema_name: "T",
    schema_encoding: null,
    views: [{ id: kind, kind, name: kind }],
    message_count: 1,
    error: null,
    fields: [],
  });
  const index = buildFieldIndex([topic("/image", "image"), topic("/marks", "image_annotations")]);
  const state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "image",
  });
  const widget = state.widgets["widget-1"];
  widget.series = [
    ["image", "image"],
    ["marks", "image_annotations"],
  ].map(([name, view]) => ({
    key: name,
    source: "r/0",
    topic: `/${name}`,
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view,
  }));
  mocks.frame = {
    time_ns: "5000000000",
    value: {
      kind: "image",
      frame_id: "camera",
      stamp_ns: "5",
      format: "png",
      data: { $blob: { offset: 0, length: 1 } },
    },
    blob: () => new Uint8Array([1]),
  };
  const info = { start_ns: "0", end_ns: "10000000000", message_count: 1 };
  render(
    <ImageView widget={widget} info={info} index={index} />,
    withStore(widget.series[0].source.split("/")[0]),
  );
  // The marks recorded a second after the image, with its stamp, are drawn.
  await waitFor(() => expect(stroke).toHaveBeenCalled());
  expect(mocks.history).toHaveBeenCalledWith(
    expect.objectContaining({ topic: "/marks" }),
    expect.anything(),
    { start_ns: "3000000000", end_ns: "7000000000" },
  );
});

it("displays raw images without encoding them as image files", async () => {
  const bitmap = { width: 2, height: 1, close: vi.fn() };
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
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as any);
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
  const topic: Topic = {
    source: "r/0",
    topic: "/image",
    schema_name: "T",
    schema_encoding: null,
    views: [{ id: "raw_image", kind: "image", name: "Image" }],
    message_count: 1,
    error: null,
    fields: [],
  };
  const index = buildFieldIndex([topic]);
  const state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "image",
  });
  const widget = state.widgets["widget-1"];
  widget.series = [
    {
      key: "image",
      source: "r/0",
      topic: "/image",
      path: [],
      color: "red",
      lineWidth: 1,
      hidden: false,
      view: "raw_image",
    },
  ];
  const view = render(
    <ImageView
      widget={widget}
      info={{ start_ns: "0", end_ns: "10", message_count: 1 }}
      index={index}
    />,
    withStore("r"),
  );
  await waitFor(() => expect(screen.getByRole("img").tagName).toBe("CANVAS"));
  expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
  view.unmount();
  expect(bitmap.close).toHaveBeenCalledOnce();
});

describe("image zoom", () => {
  const center = { x: 0.5, y: 0.5 };
  it("keeps the image point under the pointer", () => {
    const view = zoomImage({ zoom: 2, x: -0.5, y: -0.25 }, 1.5, { x: 0.25, y: 0.75 });
    expect(view.zoom).toBe(3);
    expect((0.25 - view.x) / 3).toBeCloseTo((0.25 + 0.5) / 2);
    expect((0.75 - view.y) / 3).toBeCloseTo((0.75 + 0.25) / 2);
  });
  it("returns to the full image when zoomed out, wherever it was moved", () => {
    expect(zoomImage({ zoom: 1.05, x: -0.05, y: 0 }, 0.5, center)).toEqual(fullImage);
  });
  it("stops zooming at the limit", () => {
    const view = zoomImage({ zoom: 30, x: -14.5, y: -14.5 }, 2, center);
    expect(view.zoom).toBe(32);
  });
  it("pans only as far as the image still covers the view", () => {
    expect(panImage({ zoom: 2, x: -0.5, y: -0.5 }, 0.9, -0.9)).toEqual({ zoom: 2, x: 0, y: -1 });
  });
});
