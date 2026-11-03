// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as THREE from "three";
import type { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { afterEach, expect, it, vi } from "vitest";
import { FrameAxes } from "../src/views/sceneLayers";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { reviveWorkspace } from "../src/workspace/persistence";
import { WidgetSettings } from "../src/workspace/WidgetSettings";
import {
  defaultFrameAxes,
  initialWorkspace,
  widget,
  workspaceReducer,
  type FrameAxesSettings,
} from "../src/workspace/widgets";

const mocks = vi.hoisted(() => ({ frames: [] as any[] }));
vi.mock("../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../src/data/useViewData")>()),
  useFrames: () => ({ frames: mocks.frames, error: "" }),
}));

afterEach(cleanup);

const stage = () => ({
  scene: new THREE.Scene(),
  invalidate: vi.fn(),
  fit: vi.fn(),
  reframe: vi.fn(),
  resetView: vi.fn(),
  setOrigin: vi.fn(),
});

it("draws the shown frames at the set length and width", () => {
  const transforms = {
    time_ns: "1",
    target: "map",
    frames: {
      map: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      lidar: { translation: [1, 2, 3], rotation: [0, 0, 0, 1] },
    },
  };
  const scene = stage();
  const draw = (settings: FrameAxesSettings) => (
    <FrameAxes transforms={transforms} stage={scene} settings={settings} />
  );
  const view = render(draw(defaultFrameAxes()));
  const group = scene.scene.children[0];
  expect(group.children).toHaveLength(2);

  view.rerender(draw({ ...defaultFrameAxes(), hidden: ["map"], length: 2, width: 5 }));
  expect(group.children).toHaveLength(1);
  const axes = group.children[0] as THREE.Mesh;
  // The end of the x axis is one length along x from the frame's origin.
  expect(new THREE.Vector3(1, 0, 0).applyMatrix4(axes.matrix).toArray()).toEqual([3, 2, 3]);
  expect((axes.material as LineMaterial).linewidth).toBe(5);

  view.rerender(draw({ ...defaultFrameAxes(), hidden: ["map", "lidar"] }));
  expect(group.children).toHaveLength(0);
  view.unmount();
  expect(scene.scene.children).toHaveLength(0);
});

it("hides axes of single frames or of all of them from the settings", () => {
  mocks.frames = [
    { id: "map", parent: null },
    { id: "lidar", parent: "map" },
  ];
  const dispatch = vi.fn();
  const scene = { ...widget(1, "scene"), frameAxes: { ...defaultFrameAxes(), hidden: ["lidar"] } };
  render(
    <WidgetSettings widget={scene} dispatch={dispatch} records={[]} index={buildFieldIndex([])} />,
  );
  const section = screen.getByRole("region", { name: "Frame axes" });
  const details = section.querySelector("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("Frame axes"));
  expect(details.open).toBe(true);
  const lidar = screen.getByRole("checkbox", { name: "Axes of lidar" }) as HTMLInputElement;
  expect(lidar.checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Axes of map" }));
  expect(dispatch).toHaveBeenLastCalledWith({
    type: "frame-axes",
    id: "widget-1",
    value: { hidden: ["lidar", "map"] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Show all" }));
  expect(dispatch).toHaveBeenLastCalledWith({
    type: "frame-axes",
    id: "widget-1",
    value: { hidden: [] },
  });
  fireEvent.change(screen.getByLabelText("Width (px)"), { target: { value: "4" } });
  expect(dispatch).toHaveBeenLastCalledWith({
    type: "frame-axes",
    id: "widget-1",
    value: { width: 4 },
  });
  fireEvent.change(screen.getByLabelText("Length (m)"), { target: { value: "0" } });
  expect(dispatch).toHaveBeenCalledTimes(3);
});

it("keeps axis settings in the workspace and copies them with the widget", () => {
  let state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "scene",
  });
  state = workspaceReducer(state, { type: "frame-axes", id: "widget-1", value: { width: 6 } });
  state = workspaceReducer(state, { type: "add", target: "widget-1", duplicate: true });
  expect(state.widgets["widget-2"].frameAxes).toEqual({ ...defaultFrameAxes(), width: 6 });
});

it("restores missing or broken axis settings as defaults", () => {
  const saved = JSON.parse(JSON.stringify(initialWorkspace()));
  delete saved.widgets["widget-1"].frameAxes;
  expect(reviveWorkspace(saved)!.widgets["widget-1"].frameAxes).toEqual(defaultFrameAxes());
  saved.widgets["widget-1"].frameAxes = { hidden: [1], length: -1, width: 3 };
  expect(reviveWorkspace(saved)!.widgets["widget-1"].frameAxes).toEqual({
    ...defaultFrameAxes(),
    width: 3,
  });
});
