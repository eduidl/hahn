// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  loadSession,
  reviveWorkspace,
  saveSession,
  type Session,
} from "../src/workspace/persistence";
import { initialWorkspace, workspaceReducer as reduce } from "../src/workspace/widgets";

const key = "hahn.session";
const session = (): Session => ({
  workspace: reduce(initialWorkspace(), { type: "add", direction: "row" }),
  runId: "run",
  sources: ["run/group"],
  zoneSource: "server",
  tab: "topics",
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("session persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a session", () => {
    const saved = session();
    saveSession(localStorage, saved);
    expect(loadSession(localStorage)).toEqual(saved);
    clearSession(localStorage);
    expect(loadSession(localStorage)).toBeNull();
  });
  it("restores a Data Source Info widget", () => {
    const saved = {
      ...session(),
      workspace: reduce(initialWorkspace(), { type: "add", widgetType: "source-info" }),
    };
    saveSession(localStorage, saved);
    expect(loadSession(localStorage)?.workspace.widgets["widget-2"].type).toBe("source-info");
  });
  it("ignores corrupt data and other versions", () => {
    localStorage.setItem(key, "{not json");
    expect(loadSession(localStorage)).toBeNull();
    saveSession(localStorage, session());
    const stored = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...stored, version: 999 }));
    expect(loadSession(localStorage)).toBeNull();
  });
  it("rejects layouts naming missing widgets, including inside tabs", () => {
    const root = copy(initialWorkspace());
    root.layout = "widget-9";
    expect(reviveWorkspace(root)).toBeNull();

    const tabbed = copy(
      reduce(initialWorkspace(), {
        type: "change-type",
        id: "widget-1",
        widgetType: "tabs",
      }),
    );
    const tabs = tabbed.widgets["widget-1"];
    if (tabs.type !== "tabs") throw new Error("expected tabs");
    expect(reviveWorkspace(tabbed)).not.toBeNull();
    tabs.tabs[0].layout = "widget-9";
    expect(reviveWorkspace(tabbed)).toBeNull();
  });
  it("rejects unknown types, malformed layouts and reusable numbers", () => {
    const unknownType = copy(initialWorkspace()) as unknown as {
      widgets: Record<string, { type: string }>;
    };
    unknownType.widgets["widget-1"].type = "hologram";
    expect(reviveWorkspace(unknownType)).toBeNull();

    expect(
      reviveWorkspace({
        ...copy(initialWorkspace()),
        layout: { type: "split" },
      }),
    ).toBeNull();
    expect(reviveWorkspace({ ...copy(initialWorkspace()), nextNumber: 1 })).toBeNull();
  });
  it("clears references to missing widgets instead of rejecting", () => {
    const revived = reviveWorkspace({
      ...copy(initialWorkspace()),
      activeId: "widget-9",
      expandedId: "widget-9",
    });
    expect(revived).toMatchObject({ activeId: null, expandedId: null });
  });
  it("fills fields added after the widget was saved", () => {
    const old = copy(initialWorkspace()) as unknown as {
      widgets: Record<string, { tileUrl?: string; mode: string }>;
    };
    delete old.widgets["widget-1"].tileUrl;
    old.widgets["widget-1"].mode = "zoom";
    const revived = reviveWorkspace(old)!;
    expect(revived.widgets["widget-1"].tileUrl).toBe(
      initialWorkspace().widgets["widget-1"].tileUrl,
    );
    expect(revived.widgets["widget-1"].mode).toBe("zoom");
  });
  it("opens settings for the sidebar tab name of an older save", () => {
    saveSession(localStorage, {
      workspace: initialWorkspace(),
      runId: null,
      sources: [],
      zoneSource: "browser",
      tab: "panel" as never,
    });
    expect(loadSession(localStorage)?.tab).toBe("settings");
  });
  it("replaces a retired widget name in an older save", () => {
    const old = copy(initialWorkspace()) as unknown as {
      widgets: Record<string, { title: string }>;
    };
    old.widgets["widget-1"].title = "Time Series";
    expect(reviveWorkspace(old)!.widgets["widget-1"].title).toBe("Time series");
  });
  it("survives a storage that throws", () => {
    const broken = {
      getItem: vi.fn(() => {
        throw new Error("denied");
      }),
      setItem: vi.fn(() => {
        throw new Error("full");
      }),
      removeItem: vi.fn(() => {
        throw new Error("denied");
      }),
    } as unknown as Storage;
    expect(loadSession(broken)).toBeNull();
    expect(() => saveSession(broken, session())).not.toThrow();
    expect(() => clearSession(broken)).not.toThrow();
    expect(loadSession(null)).toBeNull();
  });
});
