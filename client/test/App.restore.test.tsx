// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { keyOf, type Selected } from "../src/types";
import type { WorkspaceState } from "../src/workspace/widgets";
import { initialWorkspace, workspaceReducer as reduce } from "../src/workspace/widgets";
import { saveSession } from "../src/workspace/persistence";

// The workspace itself has its own tests; here only its restored state matters.
vi.mock("../src/workspace/WidgetWorkspace", () => ({
  widgetSeries: () => [],
  WidgetWorkspace: ({ state }: { state: WorkspaceState }) => (
    <pre data-testid="state">{JSON.stringify(state)}</pre>
  ),
}));

const key = "hahn.session";
const series: Selected = {
  key: keyOf("run/b", "/pose", ["x"]),
  source: "run/b",
  topic: "/pose",
  path: ["x"],
  color: "#ff0000",
  lineWidth: 0.1,
  hidden: false,
};
function savedWorkspace() {
  let workspace = reduce(initialWorkspace(), {
    type: "series",
    id: "widget-1",
    update: () => [series],
  });
  workspace = reduce(workspace, {
    type: "view",
    id: "widget-1",
    update: (view) => ({ ...view, x: { center: 0.2, zoom: 4 } }),
  });
  return workspace;
}
const save = () =>
  saveSession(localStorage, {
    workspace: savedWorkspace(),
    runId: "run",
    sources: ["run/b"],
    zoneSource: "browser",
    tab: "panel",
  });
const shown = (): WorkspaceState => JSON.parse(screen.getByTestId("state").textContent!);
const stored = () => JSON.parse(localStorage.getItem(key)!);
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const run = {
  id: "run",
  name: "Synthetic",
  // Group "b" is not a default, so only the saved session can have opened it.
  groups: [
    { id: "a", name: "A", default_open: true },
    { id: "b", name: "B", default_open: false },
  ],
};
const info = { start_ns: "0", end_ns: "1000000000", message_count: 0 };
const fetchMock = vi.fn();
const showModal = vi.fn(function (this: HTMLDialogElement) {
  this.open = true;
});
function server(runResponse: () => Promise<Response>) {
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/runs/run") return runResponse();
    if (url.startsWith("/api/runs?")) return json({ items: [], truncated: false });
    if (url.endsWith("/topics")) return json([]);
    return json(info);
  });
}

describe("App session restore", () => {
  beforeEach(() => {
    localStorage.clear();
    showModal.mockClear();
    fetchMock.mockReset();
    HTMLDialogElement.prototype.showModal = showModal;
    HTMLDialogElement.prototype.close = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks for a run when nothing is saved", () => {
    server(() => json(run));
    render(<App />);
    expect(showModal).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/runs/run", expect.anything());
  });
  it("reopens the saved run, groups, series and view without asking", async () => {
    save();
    server(() => json(run));
    render(<App />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run/groups/b", expect.anything()),
    );
    expect(showModal).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/runs/run/groups/a", expect.anything());
    const widget = shown().widgets["widget-1"];
    expect(widget.series).toEqual([series]);
    expect(widget.view.x).toEqual({ center: 0.2, zoom: 4 });
  });
  it("shows the open run in the header and asks when none is open", async () => {
    server(() => json(run));
    const { unmount } = render(<App />);
    expect(screen.getByRole("button", { name: "Select run" })).toBeTruthy();
    unmount();

    save();
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Select run: Synthetic" });
    expect(trigger.textContent).toContain("Synthetic");
  });
  it("closes the widget list once a drag has begun, not during dragstart", () => {
    server(() => json(run));
    vi.useFakeTimers();
    render(<App />);
    const list = document.getElementById("widget-catalog")!;
    list.hidePopover = vi.fn();
    fireEvent.dragStart(screen.getByText("Time Series").parentElement!, {
      dataTransfer: { setData: vi.fn() },
    });
    expect(list.hidePopover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(list.hidePopover).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite the session before the restore finishes", async () => {
    save();
    const before = localStorage.getItem(key);
    let answer = (_: Response) => {};
    server(() => new Promise((resolve) => (answer = resolve)));
    vi.useFakeTimers();
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(key)).toBe(before);

    await act(async () => {
      answer(new Response(JSON.stringify(run)));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(stored().sources).toEqual(["run/b"]);
    expect(stored().workspace.widgets["widget-1"].series).toEqual([series]);
  });
  it("asks again and drops series when the run is gone, keeping the layout", async () => {
    save();
    server(() => json({ error: "not found" }, 404));
    render(<App />);
    await waitFor(() => expect(showModal).toHaveBeenCalled());
    await waitFor(() => expect(shown().widgets["widget-1"].series).toEqual([]));
    expect(shown().widgets["widget-1"].view.x).toEqual({
      center: 0.2,
      zoom: 4,
    });
    await waitFor(() => expect(stored().runId).toBeNull());
  });
  it("keeps the session when the server cannot be reached", async () => {
    save();
    const before = localStorage.getItem(key);
    server(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<App />);
    await waitFor(() => expect(showModal).toHaveBeenCalled());
    expect(shown().widgets["widget-1"].series).toEqual([series]);
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(key)).toBe(before);
  });
  it("keeps the session when a workspace reset is cancelled", async () => {
    save();
    server(() => json(run));
    const reload = vi.fn();
    vi.stubGlobal("location", Object.assign(new URL("http://localhost/"), { reload }));
    render(<App />);
    await waitFor(() => expect(shown().widgets["widget-1"].series).toEqual([series]));

    fireEvent.click(screen.getByRole("button", { name: "Reset workspace" }));
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).not.toBeNull();
  });
  it("resets the layout but keeps the run after a workspace reset is confirmed", async () => {
    save();
    server(() => json(run));
    const reload = vi.fn();
    vi.stubGlobal("location", Object.assign(new URL("http://localhost/"), { reload }));
    render(<App />);
    await waitFor(() => expect(shown().widgets["widget-1"].series).toEqual([series]));

    fireEvent.click(screen.getByRole("button", { name: "Reset workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(stored().runId).toBe("run");
    expect(stored().sources).toEqual(["run/b"]);
    expect(stored().workspace).toEqual(JSON.parse(JSON.stringify(initialWorkspace())));

    // Whatever was pending must not bring the old layout back on the way out.
    window.dispatchEvent(new Event("pagehide"));
    expect(stored().workspace).toEqual(JSON.parse(JSON.stringify(initialWorkspace())));
  });
});
