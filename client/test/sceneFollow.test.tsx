// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { gridOffset } from "../src/views/sceneCamera";
import { FollowContext, useFramePlacement } from "../src/views/sceneLayers";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { reviveWorkspace } from "../src/workspace/persistence";
import { WidgetSettings } from "../src/workspace/WidgetSettings";
import { initialWorkspace, widget } from "../src/workspace/widgets";

const mocks = vi.hoisted(() => ({ frames: [] as any[] }));
const transformMocks = vi.hoisted(() => ({ frames: {} as any, lastTarget: null as string | null }));
vi.mock("../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../src/data/useViewData")>()),
  useFrames: () => ({ frames: mocks.frames, error: "" }),
  useTransforms: (_source: string, target: string | null, ns: string | null) => {
    transformMocks.lastTarget = target;
    return {
      transforms: target ? { target, time_ns: ns, frames: transformMocks.frames } : undefined,
      error: "",
    };
  },
}));

afterEach(cleanup);

const turned = (yaw: number) => [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
const close = (vector: THREE.Vector3, expected: number[]) =>
  vector.toArray().forEach((value, i) => expect(value).toBeCloseTo(expected[i]));

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
      const placement = useFramePlacement("r/0", "camera", "map", "5");
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
