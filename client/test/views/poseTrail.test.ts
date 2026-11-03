import { expect, it } from "vitest";
import { frameIndexAt, type ViewFrame } from "../../src/data/viewFrames";
import { TfGraph } from "../../src/data/tfGraph";
import { placePoses, poseTrail, trailWindow } from "../../src/views/poseTrail";

it("draws past poses without joining across conversion or coordinate-frame gaps", () => {
  const pose = (time: string, x: number, frame_id = "map"): ViewFrame => ({
    time_ns: time,
    value: { kind: "pose", frame_id, pose: { position: [x, 0, 0], orientation: [0, 0, 0, 1] } },
    blob: () => new Uint8Array(),
  });
  const frames: ViewFrame[] = [
    pose("1", 1),
    pose("2", 2),
    { time_ns: "3", error: "No transform", blob: () => new Uint8Array() },
    pose("4", 4),
    pose("5", 5),
    pose("6", 6, "other"),
    pose("7", 7),
  ];
  const trail = poseTrail(frames);
  expect([...trail.positions]).toEqual([1, 0, 0, 2, 0, 0, 4, 0, 0, 5, 0, 0]);
  expect(trail.ends.map((end) => end.time_ns)).toEqual(["2", "5"]);
  expect(trail.gaps).toBe(true);
  expect(frameIndexAt(trail.ends, 1n) + 1).toBe(0);
  expect(frameIndexAt(trail.ends, 4n) + 1).toBe(1);
  expect(frameIndexAt(trail.ends, 5n) + 1).toBe(2);
});

it("limits the past duration and interpolates its first segment", () => {
  const pose = (time: string, x: number): ViewFrame => ({
    time_ns: time,
    value: {
      kind: "pose",
      frame_id: "map",
      pose: { position: [x, 0, 0], orientation: [0, 0, 0, 1] },
    },
    blob: () => new Uint8Array(),
  });
  const trail = poseTrail([
    pose("1000000000", 1),
    pose("2000000000", 2),
    pose("3000000000", 3),
    pose("4000000000", 4),
  ]);
  expect(trailWindow(trail, 4000000000n)).toEqual({ start: 0, count: 3 });
  expect(trailWindow(trail, 4000000000n, 1.5)).toEqual({ start: 1, count: 2, point: [2.5, 0, 0] });
  expect(trailWindow(trail, 3000000000n, 1)).toEqual({ start: 1, count: 1 });
  expect(trailWindow(trail, 1000000000n, 1)).toEqual({ start: 0, count: 0 });
  // Zero seconds is no trail: only the latest value shows.
  expect(trailWindow(trail, 4000000000n, 0)).toEqual({ start: 3, count: 0 });
  expect(trailWindow(trail, null, 1)).toEqual({ start: 0, count: 0 });
});

it("places each pose in the stable frame by the transform at its own time", () => {
  const graph = new TfGraph(
    [],
    [10, 20].map((stamp) => ({
      child: "odom",
      parent: "map",
      translation: [stamp, 0, 0],
      rotation: [0, 0, 0, 1],
      time_ns: String(stamp + 100),
      stamp_ns: String(stamp),
    })),
  );
  const pose = (time: string, stamp?: string): ViewFrame => ({
    time_ns: time,
    value: {
      kind: "pose",
      frame_id: "odom",
      ...(stamp ? { stamp_ns: stamp } : {}),
      pose: { position: [1, 0, 0], orientation: [0, 0, 0, 1] },
    },
    blob: () => new Uint8Array(),
  });
  const x = (frame: ViewFrame) =>
    frame.value?.kind === "pose" ? frame.value.pose.position[0] : frame.error;
  // By stamp 15 by default; without a stamp, by log time 115; past the samples, a gap.
  const placed = placePoses([pose("115", "15"), pose("115"), pose("200", "30")], graph, "map");
  expect(placed.map(x)).toEqual([16, 16, "No transform from odom to map"]);
  expect(placed[0].value && "frame_id" in placed[0].value && placed[0].value.frame_id).toBe("map");
  // By log time on request, and holding the earlier sample without interpolation.
  expect(placePoses([pose("115", "15")], graph, "map", { axis: "time" }).map(x)).toEqual([16]);
  expect(placePoses([pose("119", "19")], graph, "map", { interpolate: false }).map(x)).toEqual([
    11,
  ]);
});
