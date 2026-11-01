// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Plot, tooltipValue } from "../src/views/Plot";
import { PlaybackContext, createPlaybackStore } from "../src/workspace/playback";
import { initialWorkspace } from "../src/workspace/widgets";

const pointer = (type: string, clientX: number, clientY = 200) =>
  new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });

function stubCanvas() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const context = new Proxy(
    {},
    {
      get: (_, name) => (name === "measureText" ? () => ({ width: 10 }) : () => {}),
      set: () => true,
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => context) as never;
  HTMLCanvasElement.prototype.setPointerCapture = () => {};
}

function setup(mode: "pan" | "zoom") {
  const store = createPlaybackStore(
    () => 1,
    () => {},
  );
  store.reset(10);
  render(
    <PlaybackContext.Provider value={store}>
      <Plot
        series={[]}
        fullEnd={10}
        originNs="0"
        revision={0}
        view={initialWorkspace().widgets["widget-1"].view}
        onViewChange={() => {}}
        mode={mode}
        legend={{ visible: false, position: "top-left" }}
        onCanReset={() => {}}
        onToggleSeries={() => {}}
      />
    </PlaybackContext.Provider>,
  );
  return { store, canvas: screen.getByRole("img") };
}

describe("tooltipValue", () => {
  it("shortens floats to 6 significant digits", () => {
    expect(tooltipValue(-9.164398388109513, "float64")).toBe("-9.1644");
    expect(tooltipValue(0.10000000149011612, "float32")).toBe("0.1");
    expect(tooltipValue(1234567.89, "float64")).toBe("1234570");
    expect(tooltipValue(1.23456789e-9, "float64")).toBe("1.23457e-9");
    expect(tooltipValue(2, "float64")).toBe("2");
  });
  it("keeps integers exact, including 64-bit ones carried as strings", () => {
    expect(tooltipValue(1234567, "int32")).toBe("1234567");
    expect(tooltipValue("9007199254740993", "int64")).toBe("9007199254740993");
  });
  it("keeps other values as they are", () => {
    expect(tooltipValue(true, "bool")).toBe("true");
    expect(tooltipValue("NaN", "float64")).toBe("NaN");
    expect(tooltipValue(Number.NaN, "float64")).toBe("NaN");
    expect(tooltipValue(null, "float64")).toBe("—");
  });
});

describe("Plot legend", () => {
  const series = (key: string, hidden: boolean) =>
    ({
      key,
      source: "r/0",
      topic: `/${key}`,
      path: ["x"],
      color: "red",
      lineWidth: 1,
      hidden,
      points: [],
      dataType: "float64",
    }) as unknown as ComponentProps<typeof Plot>["series"][number];
  const show = (
    onToggleSeries: (key: string) => void,
    list = [series("a", false), series("b", true)],
  ) => {
    const store = createPlaybackStore(
      () => 1,
      () => {},
    );
    render(
      <PlaybackContext.Provider value={store}>
        <Plot
          series={list}
          fullEnd={10}
          originNs="0"
          revision={0}
          view={initialWorkspace().widgets["widget-1"].view}
          onViewChange={() => {}}
          mode="pan"
          legend={{ visible: true, position: "top-left" }}
          onCanReset={() => {}}
          onToggleSeries={onToggleSeries}
        />
      </PlaybackContext.Provider>,
    );
  };
  beforeEach(stubCanvas);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists hidden series too, on one line each", () => {
    show(() => {});
    const a = screen.getByRole("button", { name: "Toggle visibility for /a x" });
    const b = screen.getByRole("button", { name: "Toggle visibility for /b x" });
    expect(a.getAttribute("aria-pressed")).toBe("true");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(a.textContent).toBe("/a · x");
  });
  it("shows nothing at all without series", () => {
    show(() => {}, []);
    expect(document.querySelector(".plot-legend")).toBeNull();
  });
  it("toggles the clicked series", () => {
    const toggle = vi.fn();
    show(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Toggle visibility for /b x" }));
    expect(toggle).toHaveBeenCalledWith("b");
  });
});

describe("Plot tooltip", () => {
  const points = [
    { x: 0, y: 1, raw: 1, ns: "0" },
    { x: 10, y: 2, raw: 2, ns: "10" },
  ];
  const show = (mode: "pan" | "zoom") => {
    render(
      <PlaybackContext.Provider value={createPlaybackStore()}>
        <Plot
          series={
            [
              {
                key: "a",
                source: "r/0",
                topic: "/a",
                path: ["x"],
                color: "red",
                lineWidth: 1,
                hidden: false,
                points,
                dataType: "float64",
              },
            ] as unknown as ComponentProps<typeof Plot>["series"]
          }
          fullEnd={10}
          originNs="0"
          revision={0}
          view={initialWorkspace().widgets["widget-1"].view}
          onViewChange={() => {}}
          mode={mode}
          legend={{ visible: false, position: "top-left" }}
          onCanReset={() => {}}
          onToggleSeries={() => {}}
        />
      </PlaybackContext.Provider>,
    );
    return screen.getByRole("img");
  };
  beforeEach(stubCanvas);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["pan", "zoom"] as const)("hides during a %s drag and returns after it", (mode) => {
    const canvas = show(mode);
    const tooltip = () => document.querySelector(".tooltip");
    fireEvent(canvas, pointer("pointermove", 400));
    expect(tooltip()).not.toBeNull();
    fireEvent(canvas, pointer("pointerdown", 400));
    expect(tooltip()).not.toBeNull();
    fireEvent(canvas, pointer("pointermove", 500));
    expect(tooltip()).toBeNull();
    fireEvent(canvas, pointer("pointerup", 500));
    fireEvent(canvas, pointer("pointermove", 510));
    expect(tooltip()).not.toBeNull();
  });
});

describe("Plot playback position", () => {
  beforeEach(stubCanvas);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["pan", "zoom"] as const)("moves there on a click in %s mode", (mode) => {
    const { store, canvas } = setup(mode);
    fireEvent(canvas, pointer("pointerdown", 400));
    fireEvent(canvas, pointer("pointerup", 400));
    expect(store.getState().time).toBeGreaterThan(0);
    expect(store.getState().time).toBeLessThan(10);
  });
  it("previews the time under the pointer until it leaves", () => {
    const { store, canvas } = setup("pan");
    fireEvent(canvas, pointer("pointermove", 400));
    expect(store.getState().preview).toBeGreaterThan(0);
    expect(store.getState().time).toBe(0);
    fireEvent.pointerLeave(canvas);
    expect(store.getState().preview).toBeNull();
  });
  it("hides the preview outside the plot area and while dragging", () => {
    const { store, canvas } = setup("pan");
    fireEvent(canvas, pointer("pointermove", 1));
    expect(store.getState().preview).toBeNull();
    fireEvent(canvas, pointer("pointermove", 400));
    fireEvent(canvas, pointer("pointerdown", 400));
    fireEvent(canvas, pointer("pointermove", 500));
    expect(store.getState().preview).toBeNull();
  });
  it("clears the preview when the plot goes away", () => {
    const { store, canvas } = setup("pan");
    fireEvent(canvas, pointer("pointermove", 400));
    cleanup();
    expect(store.getState().preview).toBeNull();
  });
  it.each(["pan", "zoom"] as const)("stays put after a drag in %s mode", (mode) => {
    const { store, canvas } = setup(mode);
    fireEvent(canvas, pointer("pointerdown", 400));
    fireEvent(canvas, pointer("pointermove", 500));
    fireEvent(canvas, pointer("pointerup", 500));
    expect(store.getState().time).toBe(0);
  });
});
