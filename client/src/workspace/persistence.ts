import type { TimeZoneSource } from "../timeDisplay";
import { leaves, widget, widgetSpecs, type Widget, type WorkspaceState } from "./widgets";

/** What survives a reload. Fetched data and playback position are not kept. */
export type Session = {
  workspace: WorkspaceState;
  runId: string | null;
  /** Open groups of the run, in the order they were opened. */
  sources: string[];
  zoneSource: TimeZoneSource;
  tab: SidebarTab;
};
export type SidebarTab = "panel" | "topics" | "errors";

const storageKey = "hahn.session";
const version = 1;

/** Null when the browser denies storage, in which case nothing persists. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Fills fields added since the widget was saved, keeping what was saved. */
function reviveWidget(id: string, saved: unknown): Widget | null {
  if (!isRecord(saved) || saved.id !== id) return null;
  const type = saved.type as Widget["type"];
  if (typeof type !== "string" || !Object.hasOwn(widgetSpecs, type)) return null;
  const revived = { ...widget(0, type), ...saved } as Widget;
  if (!Array.isArray(revived.series)) return null;
  if (revived.type === "tabs") {
    const { tabs, activeTabId } = revived;
    if (!Array.isArray(tabs) || !tabs.some((tab) => tab?.id === activeTabId)) return null;
  }
  return revived;
}

/**
 * Checks untrusted saved state before it reaches the reducer, because the
 * workspace indexes widgets by layout leaf without a guard. Null when it does
 * not hold together.
 */
export function reviveWorkspace(value: unknown): WorkspaceState | null {
  if (!isRecord(value) || !isRecord(value.widgets)) return null;
  const { nextNumber } = value;
  if (typeof nextNumber !== "number") return null;
  const widgets: Record<string, Widget> = {};
  for (const [id, saved] of Object.entries(value.widgets)) {
    const revived = reviveWidget(id, saved);
    if (!revived) return null;
    const number = /^widget-(\d+)$/.exec(id);
    // A reused number would make a new widget overwrite this one.
    if (!number || Number(number[1]) >= nextNumber) return null;
    widgets[id] = revived;
  }
  const layout = (value.layout ?? null) as WorkspaceState["layout"];
  try {
    const layouts = [
      layout,
      ...Object.values(widgets).flatMap((w) =>
        w.type === "tabs" ? w.tabs.map((tab) => tab.layout) : [],
      ),
    ];
    if (!layouts.flatMap(leaves).every((id) => Object.hasOwn(widgets, id))) return null;
  } catch {
    return null; // A node of an unknown shape.
  }
  const existing = (id: unknown) =>
    typeof id === "string" && Object.hasOwn(widgets, id) ? id : null;
  return {
    widgets,
    layout,
    activeId: existing(value.activeId),
    expandedId: existing(value.expandedId),
    nextNumber,
  };
}

export function loadSession(storage: Storage | null): Session | null {
  if (!storage) return null;
  try {
    const saved: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (!isRecord(saved) || saved.version !== version) return null;
    const workspace = reviveWorkspace(saved.workspace);
    if (!workspace) return null;
    return {
      workspace,
      runId: typeof saved.runId === "string" ? saved.runId : null,
      sources: isStringArray(saved.sources) ? saved.sources : [],
      zoneSource: saved.zoneSource === "server" ? "server" : "browser",
      tab: saved.tab === "topics" || saved.tab === "errors" ? saved.tab : "panel",
    };
  } catch {
    return null;
  }
}

/** Best effort: a full or blocked storage must not interrupt the session. */
export function saveSession(storage: Storage | null, session: Session) {
  try {
    storage?.setItem(storageKey, JSON.stringify({ version, ...session }));
  } catch {
    // Keep working; only the next reload is affected.
  }
}

export function clearSession(storage: Storage | null) {
  try {
    storage?.removeItem(storageKey);
  } catch {
    // Nothing more can be done without storage.
  }
}
