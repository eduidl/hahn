// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
});
