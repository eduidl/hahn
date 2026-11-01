// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageView } from "../src/views/ImageView";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { initialWorkspace, workspaceReducer } from "../src/workspace/widgets";
import type { Topic } from "../src/types";

const mocks = vi.hoisted(() => ({ frame: null as any, fetch: vi.fn() }));
vi.mock("../src/data/useViewData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/useViewData")>()),
  useViewFrame: () => ({ frame: mocks.frame, error: "" }),
}));
vi.mock("../src/data/viewFrames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/viewFrames")>()),
  fetchLatestFrame: mocks.fetch,
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
    views: [{ id: kind, kind, name: kind }],
    message_count: 1,
    error: null,
    fields: [],
  });
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
  const view = render(<ImageView widget={widget} info={info} index={index} />);
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

