import { describe, expect, it } from "vitest";
import type { ViewFrame } from "../../src/data/viewFrames";
import type { Selected, Topic } from "../../src/types";
import { buildFieldIndex } from "../../src/workspace/fieldIndex";
import {
  applyCalibration,
  calibrationChoice,
  pickCalibration,
  type Calibration,
} from "../../src/views/useCameraCalibration";

const calibration: Calibration = {
  kind: "camera_calibration",
  frame_id: "camera",
  width: 640,
  height: 480,
  intrinsics: [400, 0, 320, 0, 400, 240, 0, 0, 1],
  distortion: [0.1],
  distortion_model: "plumb_bob",
};
const at = (time: string, stamp?: string, value: object = calibration): ViewFrame => ({
  time_ns: time,
  value: { ...value, ...(stamp ? { stamp_ns: stamp } : {}) } as ViewFrame["value"],
  blob: () => new Uint8Array(),
});
const image = (time: string, stamp?: string) =>
  at(time, stamp, { kind: "image", frame_id: "camera" });

describe("the calibration value of an image", () => {
  it("is the latest by stamp when both have one, even recorded after the image", () => {
    const frames = [at("5", "1"), at("12", "2"), at("13", "3")];
    expect(pickCalibration(frames, image("10", "2"))?.time_ns).toBe("12");
  });
  it("is the latest by log time without stamps, or when aligning by log time", () => {
    const frames = [at("5", "1"), at("9", "9"), at("12", "2")];
    expect(pickCalibration(frames, image("10"))?.time_ns).toBe("9");
    expect(pickCalibration(frames, image("10", "2"), false)?.time_ns).toBe("9");
  });
  it("is the first when none precedes the image", () => {
    expect(pickCalibration([at("12"), at("13")], image("10"))?.time_ns).toBe("12");
    expect(pickCalibration([], image("10"))).toBeUndefined();
  });
});

describe("applying a calibration to pixels", () => {
  it("keeps the camera matrix and distortion for raw pixels", () => {
    expect(applyCalibration(calibration, false).calibration).toBe(calibration);
  });
  it("takes the projection without distortion for rectified pixels", () => {
    const projection = [390, 0, 310, 5, 0, 391, 241, 0, 0, 0, 1, 0];
    const applied = applyCalibration({ ...calibration, projection }, true).calibration!;
    expect(applied.intrinsics).toEqual([390, 0, 310, 0, 391, 241, 0, 0, 1]);
    expect(applied.distortion).toEqual([]);
    expect(applyCalibration(calibration, true).error).toContain("no projection");
  });
});

describe("choosing the calibration", () => {
  const topic: Topic = {
    source: "r/0",
    topic: "/cam/image_rect",
    topicName: "/cam/image_rect",
    schema_name: "T",
    schema_encoding: null,
    views: [
      {
        id: "image",
        kind: "image",
        name: "Image",
        calibration: { topic: "/cam/camera_info", view: "info" },
        rectified: true,
      },
    ],
    message_count: 1,
    error: null,
    fields: [],
  };
  const index = buildFieldIndex([topic]);
  const series = (extra: Partial<Selected> = {}): Selected => ({
    key: "image",
    source: "r/0",
    topic: "/cam/image_rect",
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view: "image",
    ...extra,
  });
  it("follows the server's suggestion unless the user chose otherwise", () => {
    expect(calibrationChoice(index, series())).toEqual({
      target: { source: "r/0", topic: "/cam/camera_info", view: "info" },
      rectified: true,
    });
    const chosen = series({ calibration: { topic: "/other", view: "info" }, rectified: false });
    expect(calibrationChoice(index, chosen)).toEqual({
      target: { source: "r/0", topic: "/other", view: "info" },
      rectified: false,
    });
    expect(calibrationChoice(index, series({ calibration: null })).target).toBeUndefined();
  });
});
