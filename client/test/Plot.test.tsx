// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Plot } from "../src/views/Plot";
import { PlaybackContext, createPlaybackStore } from "../src/workspace/playback";
import { initialWorkspace } from "../src/workspace/widgets";

const pointer = (type: string, clientX: number, clientY = 200) =>
  new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });

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
        timeDisplay="relative"
        revision={0}
        view={initialWorkspace().widgets["widget-1"].view}
        onViewChange={() => {}}
        mode={mode}
        legend={{ visible: false, position: "top-left" }}
        selectedCount={0}
        onCanReset={() => {}}
      />
    </PlaybackContext.Provider>,
  );
  return { store, canvas: screen.getByRole("img") };
}

describe("Plot playback position", () => {
  beforeEach(() => {
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
  });
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
