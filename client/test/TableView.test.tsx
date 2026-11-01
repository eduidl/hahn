// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReducer } from "react";
import { WidgetSettings } from "../src/workspace/WidgetSettings";
import { TableView, messageAt } from "../src/views/TableView";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { createPlaybackStore, PlaybackContext } from "../src/workspace/playback";
import { initialWorkspace, workspaceReducer } from "../src/workspace/widgets";
import { keyOf, type Topic } from "../src/types";

const topic: Topic = {
  source: "r/0",
  topic: "/t",
  schema_name: "T",
  schema_encoding: null,
  views: [],
  message_count: 1000,
  error: null,
  fields: [{ path: ["x"], data_type: "int64" }],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("table playback", () => {
  it("finds exact ns boundaries and the last equal timestamp", () => {
    const rows = ["9007199254740993", "9007199254740994", "9007199254740994"].map((time_ns) => ({
      time_ns,
      value: null,
    }));
    expect(messageAt(rows, 9007199254740992n)).toBe(-1);
    expect(messageAt(rows, 9007199254740993n)).toBe(0);
    expect(messageAt(rows, 9007199254740994n)).toBe(2);
  });
  it("virtualizes rows, follows seeking, and seeks when a row is activated", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: (entries: unknown[]) => void) {}
        observe() {
          this.callback([{ contentRect: { height: 260 } }]);
        }
        disconnect() {}
      },
    );
    const state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "table" });
    const widget = state.widgets["widget-2"];
    widget.timeDisplay = "relative";
    widget.series = [
      {
        key: keyOf("r/0", "/t", []),
        source: "r/0",
        topic: "/t",
        path: [],
        dataType: "struct",
        hidden: false,
        color: "#fff",
        lineWidth: 1,
      },
    ];
    const store = createPlaybackStore(
      () => 1,
      () => {},
    );
    store.reset(1000);
    const { container } = render(
      <PlaybackContext.Provider value={store}>
        <TableView
          widget={widget}
          dispatch={vi.fn()}
          index={buildFieldIndex([topic])}
          originNs="0"
          record={{
            key: widget.series[0].key,
            source: "r/0",
            topic: "/t",
            received: 1000,
            status: "complete",
            rows: Array.from({ length: 1000 }, (_, i) => ({
              time_ns: String(BigInt(i) * 1000000000n),
              value: { x: `value-${i}` },
            })),
          }}
        />
      </PlaybackContext.Provider>,
    );
    expect(screen.getAllByRole("columnheader").map((n) => n.textContent)).toEqual(["Time", "x"]);
    expect(container.querySelectorAll("tbody tr").length).toBeLessThan(40);
    fireEvent.click(screen.getByText("value-5"));
    expect(store.getState().time).toBe(5);
    expect(container.querySelector('tr[aria-current="true"]')?.textContent).toContain("value-5");
    act(() => store.seek(500));
    const viewport = container.querySelector(".table-scroll") as HTMLDivElement;
    expect(viewport.scrollTop).toBeGreaterThan(12000);
    fireEvent.scroll(viewport);
    const current = container.querySelector('tr[aria-current="true"]');
    expect(current?.textContent).toContain("value-500");
    const next = screen.getByText("value-501").closest("tr")!;
    fireEvent.keyDown(next, { key: "Enter" });
    expect(store.getState().time).toBe(501);
  });
  it("toggles individual columns from settings and keeps time when all are hidden", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const index = buildFieldIndex([
      {
        ...topic,
        fields: [
          { path: ["pose"], data_type: "struct" },
          { path: ["pose", "x"], data_type: "int64" },
          { path: ["label"], data_type: "string" },
        ],
      },
    ]);
    const initial = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "table" });
    initial.widgets["widget-2"].series = [
      {
        key: keyOf("r/0", "/t", []),
        source: "r/0",
        topic: "/t",
        path: [],
        hidden: false,
        color: "#fff",
        lineWidth: 1,
      },
    ];
    const store = createPlaybackStore(
      () => 1,
      () => {},
    );
    function Harness() {
      const [state, dispatch] = useReducer(workspaceReducer, initial);
      const widget = state.widgets["widget-2"];
      return (
        <PlaybackContext.Provider value={store}>
          <WidgetSettings
            widget={widget}
            dispatch={dispatch}
            index={index}
            records={[]}
            pointCount={0}
          />
          <TableView
            widget={widget}
            dispatch={dispatch}
            index={index}
            originNs="0"
            record={{
              key: widget.series[0].key,
              source: "r/0",
              topic: "/t",
              received: 1,
              status: "complete",
              rows: [{ time_ns: "0", value: { pose: { x: "9007199254740993" }, label: "sample" } }],
            }}
          />
        </PlaybackContext.Provider>
      );
    }
    render(<Harness />);
    expect(screen.getAllByRole("columnheader").map((n) => n.textContent)).toEqual([
      "Time",
      "pose.x",
      "label",
    ]);
    const handle = screen.getByRole("separator", { name: "pose.x width" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("176");
    expect(document.querySelectorAll("col")[1].style.width).toBe("176px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "Time width" }), { key: "ArrowLeft" });
    expect(document.querySelectorAll("col")[0].style.width).toBe("176px");
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: MouseEventInit & { pointerId?: number }) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
        }
      },
    );
    Object.defineProperties(handle, {
      setPointerCapture: { value: vi.fn() },
      releasePointerCapture: { value: vi.fn() },
    });
    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 280, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("160");
    fireEvent.click(screen.getByRole("button", { name: "Hide pose.x" }));
    expect((screen.getByRole("checkbox", { name: "pose.x" }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(screen.queryByRole("columnheader", { name: "pose.x" })).toBeNull();
    expect(screen.queryByRole("cell", { name: "9007199254740993" })).toBeNull();
    expect(screen.getByRole("cell", { name: "sample" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "label" }));
    expect(screen.getAllByRole("columnheader").map((n) => n.textContent)).toEqual(["Time"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "pose.x" }));
    expect(screen.getByRole("cell", { name: "9007199254740993" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getAllByRole("columnheader").map((n) => n.textContent)).toEqual([
      "Time",
      "pose.x",
      "label",
    ]);
    expect(
      screen.getAllByRole("checkbox").every((node) => (node as HTMLInputElement).checked),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide all" }));
    expect(screen.getAllByRole("columnheader").map((n) => n.textContent)).toEqual(["Time"]);
    expect(
      screen.getAllByRole("checkbox").every((node) => !(node as HTMLInputElement).checked),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("cell", { name: "9007199254740993" })).toBeTruthy();
    expect(document.querySelectorAll("col")[0].style.width).toBe("176px");
    expect(document.querySelectorAll("col")[1].style.width).toBe("160px");
  });
});
