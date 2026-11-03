// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gridOffset,
  lookCamera,
  minWalkSpeed,
  walkCamera,
  walkSpeedPerHeight,
} from "../../src/views/sceneCamera";
import { FollowContext, PlacementContext, useFramePlacement } from "../../src/views/sceneLayers";
import { buildFieldIndex } from "../../src/workspace/fieldIndex";
import { reviveWorkspace } from "../../src/workspace/persistence";
import { WidgetSettings } from "../../src/workspace/WidgetSettings";
import { initialWorkspace, widget } from "../../src/workspace/widgets";
import { defaultPlacement } from "../../src/workspace/widgetModel";

const mocks = vi.hoisted(() => ({ frames: [] as any[] }));
const transformMocks = vi.hoisted(() => ({
  frames: {} as any,
  lastTarget: null as string | null,
  lastAt: null as string | null,
  lastOptions: undefined as any,
}));
vi.mock("../../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../../src/data/useViewData")>()),
  useFrames: () => ({ frames: mocks.frames, error: "" }),
  useTransforms: (
    _source: string,
    target: string | null,
    ns: string | null,
    _hold: boolean,
    options: any,
  ) => {
    transformMocks.lastTarget = target;
    transformMocks.lastAt = ns;
    transformMocks.lastOptions = options;
    return {
      transforms: target ? { target, time_ns: ns, frames: transformMocks.frames } : undefined,
      error: "",
    };
  },
}));

afterEach(cleanup);

const turned = (yaw: number) => [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
const close = (vector: THREE.Vector3, expected: number[]) => {
  for (const [i, value] of vector.toArray().entries()) expect(value).toBeCloseTo(expected[i]);
};

it("puts the grid level with the origin, its lines staying put in the root", () => {
  close(gridOffset(new THREE.Vector3(12.3, -4.5, 0.8), 1), [-0.3, -0.5, 0]);
  // Moving by whole cells shows the same grid.
  close(gridOffset(new THREE.Vector3(22.3, 5.5, 0.8), 10), [-2.3, -5.5, 0]);
});

it("chooses the followed frame from the settings, the root until one is known", () => {
  mocks.frames = [
    { id: "map", parent: null },
    { id: "lidar", parent: "map" },
  ];
  const dispatch = vi.fn();
  render(
    <WidgetSettings
      widget={widget(1, "scene")}
      dispatch={dispatch}
      records={[]}
      index={buildFieldIndex([])}
    />,
  );
  const frame = screen.getByLabelText("Frame") as HTMLSelectElement;
  expect(frame.value).toBe("map");
  expect(screen.queryByLabelText("Fixed frame")).toBeNull();
  fireEvent.change(frame, { target: { value: "lidar" } });
  expect(dispatch).toHaveBeenLastCalledWith({
    type: "follow-frame",
    id: "widget-1",
    value: "lidar",
  });
});

it("forgets a saved fixed frame and a broken followed frame", () => {
  const saved = JSON.parse(JSON.stringify(initialWorkspace()));
  saved.widgets["widget-1"].fixedFrame = "lidar";
  saved.widgets["widget-1"].followFrame = 3;
  const revived = reviveWorkspace(saved)!.widgets["widget-1"];
  expect(revived.followFrame).toBeNull();
  expect("fixedFrame" in revived).toBe(false);
});

it("places data relative to the followed frame, which sits where it is now", () => {
  const seen: (string | null)[] = [];
  transformMocks.frames = { camera: { translation: [0, 1, 0], rotation: [0, 0, 0, 1] } };
  const anchor = {
    frame: "lidar",
    pose: { translation: [10, 0, 0], rotation: turned(Math.PI / 2) },
  };
  const { result } = renderHook(
    () => {
      const placement = useFramePlacement("r/0", "camera", "map", frameAt("5"));
      seen.push(transformMocks.lastTarget);
      return placement;
    },
    {
      wrapper: ({ children }) => (
        <FollowContext.Provider value={anchor}>{children}</FollowContext.Provider>
      ),
    },
  );
  // Asked for the camera in the followed frame at the data's time, not in the scene's.
  expect(seen.at(-1)).toBe("lidar");
  // One meter along lidar's y, which now points along -x of the map.
  close(new THREE.Vector3().applyMatrix4(result.current.matrix!), [9, 0, 0]);
  expect(result.current.settled).toBe(true);
});

/** A frame recorded at `time`, measured at `stamp` when given. */
const frameAt = (time: string, stamp?: string) =>
  ({
    time_ns: time,
    value: { kind: "pose", frame_id: "camera", ...(stamp ? { stamp_ns: stamp } : {}) },
    blob: () => new Uint8Array(),
  }) as any;

describe("placing by time", () => {
  const place = (frame: any, settings?: { alignment: "stamp" | "time"; interpolate: boolean }) =>
    renderHook(() => useFramePlacement("r/0", "camera", "map", frame), {
      wrapper: ({ children }) => (
        <PlacementContext.Provider value={settings ?? defaultPlacement()}>
          {children}
        </PlacementContext.Provider>
      ),
    }).result.current;
  it("uses the measurement time by default, loading samples near the recording time", () => {
    transformMocks.frames = { camera: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } };
    const placement = place(frameAt("50", "40"));
    expect(transformMocks.lastAt).toBe("40");
    expect(transformMocks.lastOptions).toMatchObject({ axis: "stamp", near: "50" });
    expect(placement.estimated).toBe(false);
  });
  it("falls back to the recording time without a stamp, and says so", () => {
    const placement = place(frameAt("50"));
    expect(transformMocks.lastAt).toBe("50");
    expect(transformMocks.lastOptions).toMatchObject({ axis: "time" });
    expect(placement.estimated).toBe(true);
  });
  it("follows the widget's choice of recording time and interpolation", () => {
    const placement = place(frameAt("50", "40"), { alignment: "time", interpolate: false });
    expect(transformMocks.lastAt).toBe("50");
    expect(transformMocks.lastOptions).toMatchObject({ axis: "time", interpolate: false });
    expect(placement.estimated).toBe(false);
  });
});

describe("walking the camera", () => {
  const start = () => {
    const camera = new THREE.PerspectiveCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(0, -10, 10);
    camera.lookAt(0, 0, 0);
    return { camera, target: new THREE.Vector3() };
  };
  it("goes forward along the ground toward where the camera looks", () => {
    const { camera, target } = start();
    walkCamera(camera, target, 1, 0, 0.1, false);
    // Ten meters up: for 0.1 s at the speed for that height, all along +y.
    const step = 10 * walkSpeedPerHeight * 0.1;
    close(target, [0, step, 0]);
    close(camera.position, [0, -10 + step, 10]);
  });
  it("goes right across the view, faster with Shift, and not at all with opposite keys", () => {
    const { camera, target } = start();
    walkCamera(camera, target, 0, 1, 0.1, true);
    close(target, [4 * 10 * walkSpeedPerHeight * 0.1, 0, 0]);
    walkCamera(camera, target, 1, 0, 0, false);
    walkCamera(camera, target, 0, 0, 0.1, false);
    close(target, [4 * 10 * walkSpeedPerHeight * 0.1, 0, 0]);
  });
  it("takes the top of the screen as ahead when looking straight down", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const target = new THREE.Vector3();
    walkCamera(camera, target, 1, 0, 0.1, false);
    expect(target.z).toBeCloseTo(0);
    expect(target.length()).toBeCloseTo(10 * walkSpeedPerHeight * 0.1);
  });
  it("still moves when the camera is down at the ground", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(0, -10, 0);
    const target = new THREE.Vector3();
    walkCamera(camera, target, 1, 0, 0.1, false);
    close(target, [0, minWalkSpeed * 0.1, 0]);
  });
});

describe("looking around", () => {
  const start = () => {
    const camera = new THREE.PerspectiveCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(0, -10, 10);
    return { camera, target: new THREE.Vector3() };
  };
  it("keeps the camera in place and the target on the ground", () => {
    const { camera, target } = start();
    // A quarter turn to the left: from looking along +y to looking along -x.
    lookCamera(camera, target, Math.PI / 2, 0);
    close(camera.position, [0, -10, 10]);
    close(target, [-10, -10, 0]);
  });
  it("keeps the old distance once the line of sight misses the ground", () => {
    const { camera, target } = start();
    // From 45 degrees down to 15 degrees up.
    lookCamera(camera, target, 0, Math.PI / 3);
    expect(target.distanceTo(camera.position)).toBeCloseTo(10 * Math.SQRT2);
    expect(target.z).toBeGreaterThan(10);
  });
  it("stops short of looking straight down", () => {
    const { camera, target } = start();
    lookCamera(camera, target, 0, -Math.PI);
    expect(target.z).toBeCloseTo(0);
    expect(Math.hypot(target.x, target.y + 10)).toBeGreaterThan(0);
    expect(Math.hypot(target.x, target.y + 10)).toBeLessThan(0.2);
  });
});

it("names what each series of a 3D view is shown as", () => {
  const topic = (name: string, view: { id: string; kind: string; name: string }) => ({
    source: "r/0",
    topic: name,
    schema_name: "T",
    schema_encoding: null,
    views: [view],
    message_count: 1,
    error: null,
    fields: [],
  });
  const scene = widget(1, "scene");
  scene.series = [
    ["/lidar", "ros_pointcloud"],
    ["/objects", "ros_boxes"],
  ].map(([name, view]) => ({
    key: name,
    source: "r/0",
    topic: name,
    path: [],
    color: "red",
    lineWidth: 1,
    hidden: false,
    view,
  }));
  render(
    <WidgetSettings
      widget={scene}
      dispatch={vi.fn()}
      records={[]}
      index={buildFieldIndex([
        topic("/lidar", { id: "ros_pointcloud", kind: "pointcloud", name: "Point cloud" }),
        topic("/objects", { id: "ros_boxes", kind: "bbox3d", name: "Boxes" }),
      ])}
    />,
  );
  expect(screen.getByText("Point cloud")).toBeTruthy();
  expect(screen.getByText("Boxes")).toBeTruthy();
});
