// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PanelSettings } from "../src/workspace/PanelSettings";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { addFieldAction, initialWorkspace, workspaceReducer } from "../src/workspace/widgets";
import type { Topic } from "../src/types";

vi.mock("../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../src/data/useViewData")>()),
  useFrames: () => ({ frames: [], error: "" }),
}));

afterEach(cleanup);

it("separates the image from additional topics and removes them together", () => {
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
  const index = buildFieldIndex([topic("/camera", "image"), topic("/lidar", "pointcloud")]);
  let state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "image",
  });
  for (const name of ["/camera", "/lidar"]) {
    const entry = index.candidates.image.find((item) => item.topic.topic === name)!;
    state = workspaceReducer(
      state,
      addFieldAction(state.widgets["widget-1"], entry.topic, entry.field, index),
    );
  }
  function Harness() {
    const [current, dispatch] = useReducer(workspaceReducer, state);
    return (
      <PanelSettings
        widget={current.widgets["widget-1"]}
        dispatch={dispatch}
        records={[]}
        pointCount={0}
        index={index}
      />
    );
  }
  render(<Harness />);
  expect(
    within(screen.getByRole("region", { name: "Image topic" })).getByText("/camera"),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Additional topics" })).getByText("/lidar"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove image topic" }));
  expect(screen.queryByText("/lidar")).toBeNull();
  expect(screen.getByText("Select an image topic first.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "+ Add topic" }).hasAttribute("disabled")).toBe(true);
});

it("sets an independent image distance in the 3D panel", () => {
  const image: Topic = {
    source: "r/0",
    topic: "/camera",
    schema_name: "T",
    schema_encoding: null,
    views: [{ id: "image", kind: "image", name: "Image" }],
    message_count: 1,
    error: null,
    fields: [],
  };
  const index = buildFieldIndex([image]);
  let state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "scene",
  });
  const entry = index.candidates.scene[0];
  state = workspaceReducer(
    state,
    addFieldAction(state.widgets["widget-1"], entry.topic, entry.field, index),
  );
  function Harness() {
    const [current, dispatch] = useReducer(workspaceReducer, state);
    return (
      <>
        <PanelSettings
          widget={current.widgets["widget-1"]}
          dispatch={dispatch}
          records={[]}
          pointCount={0}
          index={index}
        />
        <output data-testid="distance">
          {current.widgets["widget-1"].series[0].imageDistance ?? "default"}
        </output>
      </>
    );
  }
  render(<Harness />);
  const input = screen.getByRole("spinbutton", { name: /Image distance for/ }) as HTMLInputElement;
  expect(input.value).toBe("1");
  fireEvent.change(input, { target: { value: "5" } });
  expect(screen.getByTestId("distance").textContent).toBe("5");
  fireEvent.change(input, { target: { value: "0" } });
  expect(screen.getByTestId("distance").textContent).toBe("5");
});

it("sets and clears a pose topic's trail duration", () => {
  const topic: Topic = {
    source: "r/0",
    topic: "/odom",
    schema_name: "T",
    schema_encoding: null,
    views: [{ id: "pose", kind: "pose", name: "Pose" }],
    message_count: 1,
    error: null,
    fields: [],
  };
  const index = buildFieldIndex([topic]);
  let state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "scene",
  });
  const entry = index.candidates.scene[0];
  state = workspaceReducer(
    state,
    addFieldAction(state.widgets["widget-1"], entry.topic, entry.field, index),
  );
  function Harness() {
    const [current, dispatch] = useReducer(workspaceReducer, state);
    return (
      <>
        <PanelSettings
          widget={current.widgets["widget-1"]}
          dispatch={dispatch}
          records={[]}
          pointCount={0}
          index={index}
        />
        <output data-testid="duration">
          {current.widgets["widget-1"].series[0].trailDuration ?? "all"}
        </output>
      </>
    );
  }
  render(<Harness />);
  const input = screen.getByRole("spinbutton", { name: /Trail duration for/ }) as HTMLInputElement;
  expect(input.value).toBe("");
  fireEvent.change(input, { target: { value: "2.5" } });
  expect(screen.getByTestId("duration").textContent).toBe("2.5");
  fireEvent.change(input, { target: { value: "0" } });
  expect(screen.getByTestId("duration").textContent).toBe("2.5");
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByTestId("duration").textContent).toBe("all");
});
