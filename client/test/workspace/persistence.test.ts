// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  loadSession,
  reviveWorkspace,
  saveSession,
  type Session,
} from "../../src/workspace/persistence";
import { initialWorkspace, workspaceReducer as reduce } from "../../src/workspace/widgets";

const key = "hahn.session";
const session = (): Session => ({
  workspace: reduce(initialWorkspace(), { type: "add", direction: "row" }),
  runId: "run",
  sources: ["run/group"],
  zoneSource: "server",
  timeDisplay: "offset",
  tab: "topics",
  sidebarWidth: 420,
  sidebarOpen: false,
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("session persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults the sidebar for a session saved without it or with a bad width", () => {
    const saved = { ...session(), sidebarWidth: 9000 } as Partial<Session>;
    delete saved.sidebarOpen;
    saveSession(localStorage, saved as Session);
    expect(loadSession(localStorage)).toMatchObject({ sidebarWidth: null, sidebarOpen: true });
  });
  it("shows the current widget name for a widget saved under an older one", () => {
    const saved = copy(session());
    saved.workspace.widgets["widget-1"].title = "Older name";
    saveSession(localStorage, saved);
    expect(loadSession(localStorage)?.workspace.widgets["widget-1"].title).toBe("Plot");
  });
  it("keeps a named time zone, and ignores one that does not exist", () => {
    saveSession(localStorage, { ...session(), zoneSource: "Europe/Paris" });
    expect(loadSession(localStorage)?.zoneSource).toBe("Europe/Paris");
    saveSession(localStorage, { ...session(), zoneSource: "Mars/Olympus" });
    expect(loadSession(localStorage)?.zoneSource).toBe("browser");
  });
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
