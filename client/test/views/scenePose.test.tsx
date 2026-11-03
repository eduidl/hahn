// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { PoseLayer, PoseTrail } from "../../src/views/sceneLayers";
import { useSeriesViewProblems } from "../../src/views/seriesViewProblem";

function ReportedProblems() {
  return <output>{useSeriesViewProblems().map((item) => item.problem)}</output>;
}

const mocks = vi.hoisted(() => ({
  frame: undefined as any,
  transforms: undefined as any,
  ns: 2n,
  history: vi.fn(),
}));
vi.mock("../../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../../src/data/useViewData")>()),
  useViewFrame: () => ({ frame: mocks.frame, error: "" }),
  useTransforms: () => ({ transforms: mocks.transforms, error: "" }),
  usePlaybackNs: () => mocks.ns,
}));

vi.mock("../../src/data/viewFrames", async (original) => ({
  ...(await original<typeof import("../../src/data/viewFrames")>()),
  fetchViewHistory: mocks.history,
}));

it("places the latest pose in the fixed frame and hides it if the transform is missing", () => {
  const stage = {
    scene: new THREE.Scene(),
    invalidate: vi.fn(),
    fit: vi.fn(),
    reframe: vi.fn(),
    resetView: vi.fn(),
    setOrigin: vi.fn(),
  };
  const series = {
    key: "pose",
    source: "r/0",
    topic: "/odom",
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view: "pose",
  };
  mocks.frame = {
    time_ns: "1",
    value: {
      kind: "pose",
      frame_id: "map",
      pose: { position: [1, 0, 0], orientation: [0, 0, 0, 1] },
    },
  };
  mocks.transforms = {
    time_ns: "1",
    frames: { map: { translation: [0, 2, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } },
  };
  const view = render(
    <PoseLayer world="map" series={series} info={null} target="fixed" stage={stage} />,
  );
  const arrow = stage.scene.children[0];
  expect(arrow.visible).toBe(true);
  const origin = new THREE.Vector3().applyMatrix4(arrow.matrix);
  expect(origin.x).toBeCloseTo(0);
  expect(origin.y).toBeCloseTo(3);
  const forward = new THREE.Vector3(1, 0, 0).applyMatrix4(arrow.matrix);
  expect(forward.x).toBeCloseTo(0);
  expect(forward.y).toBeCloseTo(4);
  mocks.transforms = { time_ns: "1", frames: {} };
  view.rerender(<PoseLayer world="map" series={series} info={null} target="fixed" stage={stage} />);
  expect(arrow.visible).toBe(false);
  render(<ReportedProblems />);
  expect(screen.getByText(/No transform from map to fixed/)).toBeTruthy();
  view.unmount();
  expect(stage.scene.children).toHaveLength(0);
});

it("shows the trajectory up to playback and updates it when seeking", async () => {
  const stage = {
    scene: new THREE.Scene(),
    invalidate: vi.fn(),
    fit: vi.fn(),
    reframe: vi.fn(),
    resetView: vi.fn(),
    setOrigin: vi.fn(),
  };
  const series = {
    key: "pose",
    source: "r/0",
    topic: "/odom",
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view: "pose",
  };
  const pose = (time: string, x: number) => ({
    time_ns: time,
    value: {
      kind: "pose",
      frame_id: "map",
      pose: { position: [x, 0, 0], orientation: [0, 0, 0, 1] },
    },
    blob: () => new Uint8Array(),
  });
  mocks.history.mockResolvedValue([pose("1", 1), pose("2", 2), pose("3", 3)]);
  mocks.ns = 2n;
  const info = { start_ns: "0", end_ns: "10", message_count: 3 };
  const view = render(
    <PoseTrail series={series} info={info} target="map" world="map" stage={stage} />,
  );
  await waitFor(() =>
    expect((stage.scene.children[0] as THREE.LineSegments).geometry.attributes.position.count).toBe(
      4,
    ),
  );
  const line = stage.scene.children[0] as THREE.LineSegments;
  expect(line.geometry.drawRange.count).toBe(2);
  expect(mocks.history).toHaveBeenCalledWith(series, expect.any(AbortSignal), "map");
  mocks.ns = 3n;
  view.rerender(<PoseTrail series={series} info={info} target="map" world="map" stage={stage} />);
  expect(line.geometry.drawRange.count).toBe(4);
  view.rerender(
    <PoseTrail
      series={{ ...series, trailDuration: 1e-9 }}
      info={info}
      target="map"
      world="map"
      stage={stage}
    />,
  );
  expect(line.geometry.drawRange.start).toBe(2);
  expect(line.geometry.drawRange.count).toBe(2);
  view.rerender(<PoseTrail series={series} info={info} target="map" world="map" stage={stage} />);
  expect(line.geometry.drawRange.start).toBe(0);
  expect(line.geometry.drawRange.count).toBe(4);
  expect(stage.fit).not.toHaveBeenCalled();
  view.unmount();
  expect(stage.scene.children).toHaveLength(0);
});

it("shows a trail recorded in a stable frame from where the fixed frame is now", async () => {
  const stage = {
    scene: new THREE.Scene(),
    invalidate: vi.fn(),
    fit: vi.fn(),
    reframe: vi.fn(),
    resetView: vi.fn(),
    setOrigin: vi.fn(),
  };
  const series = {
    key: "pose",
    source: "r/0",
    topic: "/odom",
    path: [],
    color: "#ffffff",
    lineWidth: 1,
    hidden: false,
    view: "pose",
  };
  const info = { start_ns: "0", end_ns: "10", message_count: 2 };
  const pose = (time: string, x: number) => ({
    time_ns: time,
    value: {
      kind: "pose",
      frame_id: "map",
      pose: { position: [x, 0, 0], orientation: [0, 0, 0, 1] },
    },
    blob: () => new Uint8Array(),
  });
  mocks.history.mockClear();
  mocks.history.mockResolvedValue([pose("1", 1), pose("2", 2)]);
  mocks.ns = 2n;
  const moved = (x: number) => ({
    frames: { map: { translation: [x, 0, 0], rotation: [0, 0, 0, 1] } },
  });
  mocks.transforms = moved(-2);
  const trail = () => (
    <PoseTrail series={series} info={info} target="lidar" world="map" stage={stage} />
  );
  const view = render(trail());
  await waitFor(() => expect(mocks.history).toHaveBeenCalled());
  // In the stable frame, not in the moving one, where every sample would be at its origin.
  expect(mocks.history).toHaveBeenCalledWith(series, expect.any(AbortSignal), "map");
  const line = stage.scene.children[0] as THREE.LineSegments;
  expect(line.visible).toBe(true);
  expect(new THREE.Vector3(2, 0, 0).applyMatrix4(line.matrix).x).toBeCloseTo(0);
  // As the body moves on, the same samples fall behind it.
  mocks.transforms = moved(-5);
  view.rerender(trail());
  expect(new THREE.Vector3(2, 0, 0).applyMatrix4(line.matrix).x).toBeCloseTo(-3);
  mocks.transforms = { time_ns: "1", frames: {} };
  view.rerender(trail());
  expect(line.visible).toBe(false);
  view.unmount();
});

it("keeps a pose rigid to the fixed frame still, using the transform at its own time", () => {
  const stage = {
    scene: new THREE.Scene(),
    invalidate: vi.fn(),
    fit: vi.fn(),
    reframe: vi.fn(),
    resetView: vi.fn(),
    setOrigin: vi.fn(),
  };
  const series = {
    key: "pose",
    source: "r/0",
    topic: "/odom",
    path: [],
    color: "#ffffff",
    lineWidth: 1,
    hidden: false,
    view: "pose",
  };
  mocks.frame = {
    time_ns: "1",
    value: {
      kind: "pose",
      frame_id: "map",
      pose: { position: [5, 0, 0], orientation: [0, 0, 0, 1] },
    },
    blob: () => new Uint8Array(),
  };
  mocks.transforms = {
    time_ns: "1",
    frames: { map: { translation: [-5, 0, 0], rotation: [0, 0, 0, 1] } },
  };
  // However far playback has moved past the message.
  mocks.ns = 99n;
  const view = render(
    <PoseLayer series={series} info={null} target="lidar" world="map" stage={stage} />,
  );
  const arrow = stage.scene.children[0];
  expect(new THREE.Vector3().applyMatrix4(arrow.matrix).x).toBeCloseTo(0);
  // The next message waits for its own transform, instead of using this one for a moment.
  mocks.frame = {
    ...mocks.frame,
    time_ns: "2",
    value: { ...mocks.frame.value, pose: { position: [6, 0, 0], orientation: [0, 0, 0, 1] } },
  };
  const layer = () => (
    <PoseLayer series={series} info={null} target="lidar" world="map" stage={stage} />
  );
  view.rerender(layer());
  expect(new THREE.Vector3().applyMatrix4(arrow.matrix).x).toBeCloseTo(0);
  mocks.transforms = {
    time_ns: "2",
    frames: { map: { translation: [-6, 0, 0], rotation: [0, 0, 0, 1] } },
  };
  view.rerender(layer());
  expect(new THREE.Vector3().applyMatrix4(arrow.matrix).x).toBeCloseTo(0);
  view.unmount();
});
