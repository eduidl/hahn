// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WidgetSettings } from "../../src/workspace/WidgetSettings";
import { buildFieldIndex } from "../../src/workspace/fieldIndex";
import { addFieldAction, initialWorkspace, workspaceReducer } from "../../src/workspace/widgets";
import type { Topic } from "../../src/types";

vi.mock("../../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../../src/data/useViewData")>()),
  useFrames: () => ({ frames: [], error: "" }),
}));

afterEach(cleanup);

it.each(["image", "scene"] as const)("does not repeat the suggested calibration in %s", (type) => {
  const image: Topic = {
    source: "r/0",
    topic: "/camera",
    schema_name: "Image",
    schema_encoding: null,
    views: [
      { id: "image", kind: "image", name: "Image", calibration: { topic: "/info", view: "info" } },
    ],
    message_count: 1,
    error: null,
    fields: [],
  };
  const calibration: Topic = {
    ...image,
    topic: "/info",
    views: [
      { id: "info", kind: "camera_calibration", name: "Calibration" },
      { id: "other", kind: "camera_calibration", name: "Other calibration" },
    ],
  };
  const index = buildFieldIndex([image, calibration]);
  let state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: type,
  });
  const entry = index.candidates[type][0];
  state = workspaceReducer(
    state,
    addFieldAction(state.widgets["widget-1"], entry.topic, entry.field, index),
  );
  const widget = state.widgets["widget-1"];
  const props = { dispatch: vi.fn(), records: [], index };
  const { rerender } = render(<WidgetSettings {...props} widget={widget} />);
  const select = screen.getByRole<HTMLSelectElement>("combobox", {
    name: "Calibration for /camera",
  });
  expect([...select.options].map((option) => option.value)).toEqual([
    "suggested",
    JSON.stringify(["/info", "other"]),
    "none",
  ]);
  expect(select.selectedOptions[0].textContent).toBe("Suggested: /info");
  const manual = {
    ...widget,
    series: [{ ...widget.series[0], calibration: { topic: "/info", view: "info" } }],
  };
  rerender(<WidgetSettings {...props} widget={manual} />);
  expect(select.value).toBe("suggested");
  const changedIndex = buildFieldIndex([
    { ...image, views: [{ ...image.views[0], calibration: { topic: "/info", view: "other" } }] },
    calibration,
  ]);
  rerender(<WidgetSettings {...props} widget={manual} index={changedIndex} />);
  expect(select.value).toBe(JSON.stringify(["/info", "info"]));
});

it("separates the image from additional topics and removes them together", () => {
  const topic = (name: string, kind: string): Topic => ({
    source: "r/0",
    topic: name,
    schema_name: `example/${kind}`,
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
      <WidgetSettings
        widget={current.widgets["widget-1"]}
        dispatch={dispatch}
        records={[]}
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
  for (const [region, view, type] of [
    ["Image topic", "image", "example/image"],
    ["Additional topics", "pointcloud", "example/pointcloud"],
  ]) {
    const label = within(screen.getByRole("region", { name: region })).getByText(view);
    expect(label.nextSibling?.nodeName).toBe("BR");
    expect(label.nextSibling?.nextSibling?.textContent).toBe(type);
  }
  const additional = screen.getByRole("region", { name: "Additional topics" });
  const add = within(additional).getByRole("button", { name: "Add topic" });
  expect(add.textContent).toBe("+ Topic");
  expect(
    add.compareDocumentPosition(within(additional).getByText("/lidar")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove image topic" }));
  expect(screen.queryByText("/lidar")).toBeNull();
  expect(screen.getByText("Select an image topic first.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add topic" }).hasAttribute("disabled")).toBe(true);
});

it("shows the original type below the view name in a map", () => {
  const topic: Topic = {
    source: "r/0",
    topic: "/location",
    schema_name: "sensor_msgs/msg/NavSatFix",
    schema_encoding: null,
    views: [{ id: "location", kind: "geo_location", name: "Location" }],
    message_count: 1,
    error: null,
    fields: [],
  };
  const index = buildFieldIndex([topic]);
  let state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: "map",
  });
  const entry = index.candidates.map[0];
  state = workspaceReducer(
    state,
    addFieldAction(state.widgets["widget-1"], entry.topic, entry.field, index),
  );
  render(
    <WidgetSettings
      widget={state.widgets["widget-1"]}
      dispatch={vi.fn()}
      records={[]}
      index={index}
    />,
  );
  const view = screen.getByText("Location");
  expect(view.nextSibling?.nodeName).toBe("BR");
  expect(view.nextSibling?.nextSibling?.textContent).toBe("sensor_msgs/msg/NavSatFix");
  expect(screen.getByRole("spinbutton", { name: /Trail duration for/ })).toBeTruthy();
});

it("sets an independent image distance in the 3D panel", () => {
  const image: Topic = {
    source: "r/0",
    topic: "/camera",
    schema_name: "sensor_msgs/msg/Image",
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
        <WidgetSettings
          widget={current.widgets["widget-1"]}
          dispatch={dispatch}
          records={[]}
          index={index}
        />
        <output data-testid="distance">
          {current.widgets["widget-1"].series[0].imageDistance ?? "default"}
        </output>
      </>
    );
  }
  const { rerender } = render(<Harness />);
  const view = screen.getByText("Image");
  expect(view.nextSibling?.nodeName).toBe("BR");
  expect(view.nextSibling?.nextSibling?.textContent).toBe("sensor_msgs/msg/Image");
  const input = screen.getByRole("spinbutton", { name: /Image distance for/ }) as HTMLInputElement;
  expect(input.value).toBe("1");
  fireEvent.change(input, { target: { value: "5" } });
  expect(screen.getByTestId("distance").textContent).toBe("5");
  fireEvent.change(input, { target: { value: "0" } });
  expect(screen.getByTestId("distance").textContent).toBe("5");
  rerender(
    <WidgetSettings
      widget={state.widgets["widget-1"]}
      dispatch={() => {}}
      records={[]}
      index={buildFieldIndex([{ ...image, schema_name: null }])}
    />,
  );
  expect(within(screen.getByRole("region", { name: "Topics" })).getByText("Image")).toBeTruthy();
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
        <WidgetSettings
          widget={current.widgets["widget-1"]}
          dispatch={dispatch}
          records={[]}
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
  fireEvent.change(input, { target: { value: "-1" } });
  expect(screen.getByTestId("duration").textContent).toBe("2.5");
  // Zero shows only the latest value.
  fireEvent.change(input, { target: { value: "0" } });
  expect(screen.getByTestId("duration").textContent).toBe("0");
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByTestId("duration").textContent).toBe("all");
});
