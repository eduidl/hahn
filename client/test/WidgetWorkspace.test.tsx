// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReducer, useState, type ReactNode } from "react";
import type { MosaicNode } from "react-mosaic-component";
import { createPlaybackStore, PlaybackContext } from "../src/workspace/playback";
import { WidgetWorkspace } from "../src/workspace/WidgetWorkspace";
import { WidgetSettings } from "../src/workspace/WidgetSettings";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import {
  initialWorkspace,
  workspaceReducer as reduce,
  widgetDragMime,
  widgetMoveMime,
  tabDragMime,
  type Widget,
  type WorkspaceState,
} from "../src/workspace/widgets";

// Exercise workspace interactions without the library's browser-only DnD backend.
vi.mock("react-mosaic-component", () => ({
  Mosaic: ({
    value,
    renderTile,
    zeroStateView,
  }: {
    value: MosaicNode<string> | null;
    renderTile: (id: string, path: number[]) => ReactNode;
    zeroStateView: ReactNode;
  }) => {
    const renderNode = (node: MosaicNode<string> | null): ReactNode =>
      node === null
        ? zeroStateView
        : typeof node === "string"
          ? renderTile(node, [])
          : node.type === "split"
            ? node.children.map((n, i) => <div key={i}>{renderNode(n)}</div>)
            : null;
    return <div>{renderNode(value)}</div>;
  },
  MosaicWindow: (props: {
    children: ReactNode;
    toolbarControls: ReactNode;
    renderToolbar: (props: unknown) => ReactNode;
  }) => (
    <div>
      {props.renderToolbar(props)}
      {props.children}
    </div>
  ),
}));
vi.mock("../src/views/Plot", () => ({
  defaultPlotView: () => ({
    x: { center: 0, zoom: 1 },
    y: { center: 0, zoom: 1 },
    pinnedYBase: null,
  }),
  Plot: () => <div>Plot</div>,
}));
const index = buildFieldIndex([]);
const first = { widgetId: "widget-1", tabId: "tab-1" };
const initial = () =>
  reduce(initialWorkspace(), { type: "change-type", id: "widget-1", widgetType: "tabs" });
function Harness({
  initialState = initial(),
  catalog = null,
}: {
  initialState?: WorkspaceState;
  catalog?: Widget["type"] | null;
}) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [playback] = useState(createPlaybackStore);
  const selected = state.activeId ? state.widgets[state.activeId] : null;
  return (
    <PlaybackContext.Provider value={playback}>
      <WidgetWorkspace
        state={state}
        dispatch={dispatch}
        data={[]}
        messageRecords={[]}
        fieldIndex={index}
        info={null}
        sources={[]}
        fullEnd={1}
        revision={0}
        dragVerdict={() => null}
        widgetDrag={catalog}
        drop={vi.fn()}
        openSettings={vi.fn()}
      />
      {selected && (
        <aside aria-label="設定">
          <WidgetSettings
            widget={selected}
            dispatch={dispatch}
            index={index}
            records={[]}
            pointCount={0}
          />
        </aside>
      )}
    </PlaybackContext.Provider>
  );
}
function transfer(type: string, value = "") {
  return {
    types: [type],
    getData: (key: string) => (key === type ? value : ""),
    setData: vi.fn(),
    effectAllowed: "all",
    dropEffect: "none",
  };
}
const tab = (id: string) => document.getElementById(`widget-1-${id}`)!;
const panel = (widgetId = "widget-1") => document.getElementById(`${widgetId}-tab-1-panel`)!;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Data Source Info widget", () => {
  it("shows its own content without the series toolbar or empty state", () => {
    const initialState = reduce(initialWorkspace(), {
      type: "change-type",
      id: "widget-1",
      widgetType: "source-info",
    });
    render(<Harness initialState={initialState} />);
    expect(screen.getByText("Open a run from the header")).toBeTruthy();
    expect(screen.queryByText("No topic selected")).toBeNull();
  });
});

it("shows selected topics and field paths in the widget toolbar", () => {
  const state = initialWorkspace();
  state.widgets["widget-1"].series = [
    {
      key: "first",
      source: "r/0",
      topic: "/robot/pose",
      path: ["position", "x"],
      color: "red",
      lineWidth: 1,
      hidden: false,
    },
    {
      key: "second",
      source: "r/0",
      topic: "/robot/status",
      path: [],
      color: "blue",
      lineWidth: 1,
      hidden: false,
    },
  ];
  render(<Harness initialState={state} />);
  const label = screen.getByText("/robot/pose · position.x, /robot/status");
  expect(label.getAttribute("title")).toBe("/robot/pose · position.x, /robot/status");
  expect(
    within(label.closest(".widget-plot-toolbar") as HTMLElement).queryByText("2 series"),
  ).toBeNull();
});

describe("Tab widget interactions", () => {
  it("adds a TF Tree widget inside a tab", () => {
    render(<Harness />);
    fireEvent.click(within(panel()).getByRole("button", { name: "Add TF tree" }));
    expect(within(panel()).getByRole("region", { name: "TF tree" })).toBeDefined();
    expect(within(panel()).getByText("Open a run from the header")).toBeDefined();
  });
  it("adds, switches, renames and deletes tabs with keyboard navigation", () => {
    render(<Harness />);
    expect(document.querySelector(".widget-tab-close")!.hasAttribute("disabled")).toBe(true);
    fireEvent.click(
      within(screen.getByRole("tablist", { name: "Tabs" })).getByRole("button", {
        name: "Add tab",
      }),
    );
    expect(tab("tab-2").getAttribute("aria-selected")).toBe("true");
    const close = document.querySelector(".widget-tab-close")!;
    expect(close.parentElement).toBe(tab("tab-2").parentElement);
    expect(
      within(tab("tab-1").parentElement!).queryByRole("button", {
        name: "Delete tab Untitled tab",
      }),
    ).toBeNull();
    fireEvent.doubleClick(tab("tab-2"));
    const name = screen.getAllByRole("textbox", { name: "Untitled tab name" })[0];
    fireEvent.change(name, { target: { value: "Details" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(screen.getByRole("tab", { name: "Details" })).toBeDefined();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Details" }), { key: "ArrowLeft" });
    expect(tab("tab-1").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(document.querySelector(".widget-tab-close")!);
    expect(document.getElementById("widget-1-tab-1")).toBeNull();
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
  });

  it("starts unnamed inputs empty, shows a hint and lets a name be cleared", () => {
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Untitled tab name" }) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Enter tab name");
    expect(tab("tab-1").textContent).toBe("Untitled tab");
    fireEvent.change(input, { target: { value: "Sensors" } });
    fireEvent.blur(input);
    expect(screen.getByRole("tab", { name: "Sensors" })).toBeDefined();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("");
    expect(screen.getByRole("tab", { name: "Untitled tab" })).toBeDefined();
    fireEvent.doubleClick(tab("tab-1"));
    expect(
      (screen.getAllByRole("textbox", { name: "Untitled tab name" })[0] as HTMLInputElement).value,
    ).toBe("");
  });

  it("shows an inline catalog in empty root and tab layouts and adds the chosen kind", () => {
    const state = reduce(initialWorkspace(), { type: "remove", id: "widget-1" });
    render(<Harness initialState={state} />);
    const catalog = screen.getByLabelText("Widgets to add");
    expect(within(catalog).getAllByRole("button")).toHaveLength(11);
    fireEvent.click(within(catalog).getByRole("button", { name: "Add Tabs" }));
    const tabPanel = panel("widget-2");
    expect(within(tabPanel).queryByRole("button", { name: "Add Tabs" })).toBeNull();
    expect(
      within(tabPanel).getByLabelText("Widgets to add").querySelectorAll("button"),
    ).toHaveLength(10);
    fireEvent.click(within(tabPanel).getByRole("button", { name: "Add Table" }));
    expect(within(tabPanel).getByRole("region", { name: "Table" })).toBeDefined();
    expect(within(tabPanel).queryByLabelText("Widgets to add")).toBeNull();
  });

  it("places the tab list and widget controls in the same toolbar row", () => {
    const { container } = render(<Harness />);
    const toolbar = container.querySelector(".widget-tabs-toolbar")!;
    expect(toolbar.contains(screen.getByRole("tablist", { name: "Tabs" }))).toBe(true);
    expect(toolbar.contains(screen.getByRole("button", { name: "Maximize Tabs" }))).toBe(true);
    expect(toolbar.querySelector(".mosaic-window-controls")).not.toBeNull();
    expect(within(toolbar as HTMLElement).queryByText("Tabs")).toBeNull();
    expect(within(toolbar as HTMLElement).getByLabelText("Move Tabs widget")).toBeDefined();
  });

  it("accepts a catalog widget in an empty tab without adding it at the root", () => {
    render(<Harness catalog="table" />);
    const tabPanel = panel();
    fireEvent.drop(within(tabPanel).getByLabelText("Widgets to add"), {
      dataTransfer: transfer(widgetDragMime, "table"),
    });
    expect(within(tabPanel).getByRole("region", { name: "Table" })).toBeDefined();
    expect(document.querySelectorAll(".widget-shell")).toHaveLength(2);
  });

  it("rejects catalog Tabs in empty contents and tab headings while allowing the outer root edges", () => {
    const { container } = render(<Harness catalog="tabs" />);
    const dataTransfer = transfer(widgetDragMime, "tabs");
    const empty = within(panel()).getByLabelText("Widgets to add");
    const drag = fireEvent.dragOver(empty, { dataTransfer });
    expect(drag).toBe(true);
    fireEvent.drop(empty, { dataTransfer });
    fireEvent.drop(tab("tab-1"), { dataTransfer });
    expect(screen.getAllByRole("region", { name: "Tabs" })).toHaveLength(1);
    const edge = container.querySelector(
      '[data-widget-id="widget-1"] > .tab-frame-drop > .widget-drop-edge.right',
    )!;
    fireEvent.drop(edge, { dataTransfer });
    expect(screen.getAllByRole("region", { name: "Tabs" })).toHaveLength(2);
  });

  it("omits Tab from a child widget's type menu while keeping it available at the root", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "add", target: "widget-1" });
    const { container } = render(<Harness initialState={state} />);
    const child = container.querySelector<HTMLElement>('[data-widget-id="widget-2"]')!;
    fireEvent.click(child.querySelector(".submenu-host > button")!);
    const childTypes = within(child).getAllByRole("menuitemradio", { hidden: true });
    expect(childTypes).toHaveLength(10);
    expect(childTypes.some((item) => item.firstChild?.textContent === "Tabs")).toBe(false);
    const root = container.querySelector<HTMLElement>('[data-widget-id="widget-3"]')!;
    fireEvent.click(root.querySelector(".submenu-host > button")!);
    expect(
      within(root)
        .getAllByRole("menuitemradio", { hidden: true })
        .some((item) => item.firstChild?.textContent === "Tabs"),
    ).toBe(true);
  });

  it("does not accept a root Tab dragged into another Tab's contents or heading", () => {
    const state = reduce(initial(), { type: "add", target: "widget-1", widgetType: "tabs" });
    const { container } = render(<Harness initialState={state} />);
    const title = container.querySelector('[data-widget-id="widget-2"] .mosaic-window-title')!;
    const dataTransfer = transfer(widgetMoveMime, "widget-2");
    fireEvent.dragStart(title, { dataTransfer });
    const empty = within(panel()).getByLabelText("Widgets to add");
    expect(fireEvent.dragOver(empty, { dataTransfer })).toBe(true);
    fireEvent.drop(empty, { dataTransfer });
    expect(fireEvent.dragOver(tab("tab-1"), { dataTransfer })).toBe(true);
    fireEvent.drop(tab("tab-1"), { dataTransfer });
    expect(within(panel()).queryByRole("region", { name: "Tabs" })).toBeNull();
    expect(screen.getAllByRole("region", { name: "Tabs" })).toHaveLength(2);
    fireEvent.dragEnd(title);
  });

  it.each(["left", "right", "top", "bottom"] as const)(
    "splits outside the whole Tab at its %s edge and previews that half",
    (edge) => {
      const state = reduce(initial(), { type: "add", container: first });
      const { container } = render(<Harness initialState={state} catalog="table" />);
      const frame = container.querySelector('[data-widget-id="widget-1"] > .tab-frame-drop')!;
      const zone = frame.querySelector(`.widget-drop-edge.${edge}`)!;
      const dataTransfer = transfer(widgetDragMime, "table");
      fireEvent.dragOver(zone, { dataTransfer });
      expect(frame.querySelector(`.widget-drop-preview.${edge}`)).not.toBeNull();
      fireEvent.drop(zone, { dataTransfer });
      expect(within(panel()).getByRole("region", { name: "Plot" })).toBeDefined();
      expect(within(panel()).queryByRole("region", { name: "Table" })).toBeNull();
      expect(screen.getByRole("region", { name: "Table" })).toBeDefined();
      expect(container.querySelector(".widget-drop-preview")).toBeNull();
    },
  );

  it("moves an existing root widget onto a tab and preserves hidden mounted contents", () => {
    let state = reduce(initial(), { type: "add", target: "widget-1" });
    state = reduce(state, { type: "tab-add", id: "widget-1" });
    const { container } = render(<Harness initialState={state} />);
    const title = container.querySelector('[data-widget-id="widget-2"] .mosaic-window-title')!;
    const dataTransfer = transfer(widgetMoveMime, "widget-2");
    fireEvent.dragStart(title, { dataTransfer });
    fireEvent.drop(tab("tab-1"), { dataTransfer });
    const tabPanel = panel();
    expect(within(tabPanel).getByRole("region", { name: "Plot" })).toBeDefined();
    fireEvent.click(tab("tab-2"));
    expect(screen.queryByRole("region", { name: "Plot" })).toBeNull();
    expect(container.querySelector('[data-widget-id="widget-2"]')).not.toBeNull();
    fireEvent.click(tab("tab-1"));
    expect(screen.getByRole("region", { name: "Plot" })).toBeDefined();
  });

  it("switches after 500ms of valid hover, cancels on leave and reorders tab headings", () => {
    vi.useFakeTimers();
    let state = reduce(initial(), { type: "tab-add", id: "widget-1" });
    render(<Harness initialState={state} catalog="table" />);
    const hoveredTab = tab("tab-1");
    fireEvent.dragOver(hoveredTab, { dataTransfer: transfer(widgetDragMime) });
    act(() => vi.advanceTimersByTime(499));
    expect(hoveredTab.getAttribute("aria-selected")).toBe("false");
    fireEvent.dragLeave(hoveredTab);
    act(() => vi.advanceTimersByTime(1));
    expect(hoveredTab.getAttribute("aria-selected")).toBe("false");
    fireEvent.dragOver(hoveredTab, { dataTransfer: transfer(widgetDragMime) });
    act(() => vi.advanceTimersByTime(500));
    expect(hoveredTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.drop(hoveredTab, {
      dataTransfer: transfer(tabDragMime, JSON.stringify({ widgetId: "widget-1", tabId: "tab-2" })),
    });
    expect(screen.getAllByRole("tab").map((tab) => tab.id)).toEqual([
      "widget-1-tab-2",
      "widget-1-tab-1",
    ]);
  });

  it("moves a tab and its widgets to another Tab heading without nesting the containers", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "tab-rename", id: "widget-1", tabId: "tab-1", title: "Sensors" });
    state = reduce(state, { type: "add", target: "widget-1", widgetType: "tabs" });
    render(<Harness initialState={state} />);
    const dataTransfer = transfer(
      tabDragMime,
      JSON.stringify({ widgetId: "widget-1", tabId: "tab-1" }),
    );
    fireEvent.dragStart(tab("tab-1"), { dataTransfer });
    fireEvent.drop(document.getElementById("widget-3-tab-1")!, { dataTransfer });
    const destination = document.getElementById("widget-3-tab-2-panel")!;
    expect(within(destination).getByRole("region", { name: "Plot" })).toBeDefined();
    expect(document.getElementById("widget-3-tab-2")?.textContent).toBe("Sensors");
    expect(document.getElementById("widget-3-tab-1")).toBeNull();
    expect(
      within(document.getElementById("widget-1-tab-2-panel")!).getByLabelText("Widgets to add"),
    ).toBeDefined();
    expect(screen.getAllByRole("region", { name: "Tabs" })).toHaveLength(2);
  });

  it("accepts tabs on the destination bar's blank space and appends them", () => {
    let state = reduce(initial(), {
      type: "tab-rename",
      id: "widget-1",
      tabId: "tab-1",
      title: "Moved",
    });
    state = reduce(state, { type: "add", target: "widget-1", widgetType: "tabs" });
    state = reduce(state, {
      type: "tab-rename",
      id: "widget-2",
      tabId: "tab-1",
      title: "Existing",
    });
    const { container } = render(<Harness initialState={state} />);
    const bar = container.querySelector('[data-widget-id="widget-2"] .widget-tab-bar')!;
    const dataTransfer = transfer(
      tabDragMime,
      JSON.stringify({ widgetId: "widget-1", tabId: "tab-1" }),
    );
    expect(fireEvent.dragOver(bar, { dataTransfer })).toBe(false);
    fireEvent.drop(bar, { dataTransfer });
    expect(
      within(bar as HTMLElement)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Existing", "Moved"]);
    fireEvent.drop(bar, { dataTransfer: transfer(tabDragMime, "invalid") });
    expect(within(bar as HTMLElement).getAllByRole("tab")).toHaveLength(2);
  });

  it("maximizes a root Tab and restores its sibling widget with Escape", () => {
    const state = reduce(initial(), { type: "add", target: "widget-1" });
    render(<Harness initialState={state} />);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Tabs" }));
    expect(document.querySelector('[data-widget-id="widget-2"]')).toBeNull();
    expect(screen.getByRole("region", { name: "Tabs" })).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Tabs" })).toBeDefined();
    expect(document.querySelector('[data-widget-id="widget-2"]')).not.toBeNull();
  });
});
