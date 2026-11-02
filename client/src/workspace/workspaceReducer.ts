// The workspace state transitions.
import {
  defaultTabTitle,
  type Widget,
  type Container,
  type WorkspaceState,
  type WorkspaceAction,
} from "./widgetModel";
import { canPlaceWidget } from "./widgetSpecs";
import { widget } from "./workspaceActions";
import { kindsMatch, seriesKind, type Selected } from "../types";
import {
  leaves,
  hasTabs,
  mapLeaves,
  removeLeafNullable,
  insertLeaf,
  containerLayout,
  containerExists,
  ownerOf,
} from "./layoutTree";
import { type MosaicNode } from "react-mosaic-component";
import { defaultPlotView } from "../views/Plot";
import { clampColumnWidth } from "../views/table";

function withSeries(current: Widget, series: Selected[]): Widget {
  if (current.type === "table" && current.series[0]?.key !== series[0]?.key)
    current = { ...current, hiddenColumns: [], columnWidths: {} };
  if (kindsMatch(seriesKind(current.series), seriesKind(series))) return { ...current, series };
  return {
    ...current,
    series,
    view: { ...current.view, y: defaultPlotView().y, pinnedYBase: null },
  };
}

export function setContainerLayout(
  state: WorkspaceState,
  container: Container | undefined,
  layout: MosaicNode<string> | null,
): WorkspaceState {
  if (!container) return { ...state, layout };
  const owner = state.widgets[container.widgetId];
  if (owner?.type !== "tabs") return state;
  return {
    ...state,
    widgets: {
      ...state.widgets,
      [owner.id]: {
        ...owner,
        tabs: owner.tabs.map((tab) => (tab.id === container.tabId ? { ...tab, layout } : tab)),
      },
    },
  };
}

export function subtreeIds(state: WorkspaceState, id: string): string[] {
  const w = state.widgets[id];
  return [
    id,
    ...(w?.type === "tabs"
      ? w.tabs.flatMap((tab) => leaves(tab.layout).flatMap((child) => subtreeIds(state, child)))
      : []),
  ];
}

export function canMove(
  state: WorkspaceState,
  id: string,
  container?: Container,
  target?: string,
): boolean {
  if (
    !state.widgets[id] ||
    !containerExists(state, container) ||
    !canPlaceWidget(state.widgets[id].type, container)
  )
    return false;
  const subtree = subtreeIds(state, id);
  return (
    !(container && subtree.includes(container.widgetId)) &&
    (!target ||
      (!subtree.includes(target) && leaves(containerLayout(state, container)).includes(target)))
  );
}

export function firstVisible(
  state: WorkspaceState,
  layout: MosaicNode<string> | null,
): string | null {
  const id = leaves(layout)[0];
  const w = state.widgets[id];
  return w?.type === "tabs"
    ? (firstVisible(state, w.tabs.find((tab) => tab.id === w.activeTabId)?.layout ?? null) ?? id)
    : (id ?? null);
}

export function repairSelection(state: WorkspaceState, container?: Container): WorkspaceState {
  if (state.activeId && state.widgets[state.activeId]) return state;
  return {
    ...state,
    activeId:
      firstVisible(state, containerLayout(state, container)) ??
      container?.widgetId ??
      firstVisible(state, state.layout),
  };
}

export function revealContainer(state: WorkspaceState, container?: Container): WorkspaceState {
  if (!container) return state;
  const w = state.widgets[container.widgetId];
  if (w?.type !== "tabs") return state;
  return revealContainer(
    { ...state, widgets: { ...state.widgets, [w.id]: { ...w, activeTabId: container.tabId } } },
    ownerOf(state, w.id),
  );
}

export function validLayoutChange(
  state: WorkspaceState,
  container: Container | undefined,
  layout: MosaicNode<string> | null,
) {
  if (!containerExists(state, container)) return false;
  const before = leaves(containerLayout(state, container)).sort();
  const after = leaves(layout).sort();
  return before.length === after.length && before.every((id, i) => id === after[i]);
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "add": {
      const target = state.widgets[action.target ?? (action.container ? "" : state.activeId) ?? ""];
      const container = action.container ?? (target ? ownerOf(state, target.id) : undefined);
      const addedType = action.duplicate && target ? target.type : (action.widgetType ?? "plot");
      if (!containerExists(state, container) || !canPlaceWidget(addedType, container)) return state;
      const widgets = { ...state.widgets };
      let nextNumber = state.nextNumber;
      const makeCopy = (original: Widget): Widget => {
        const copy = widget(nextNumber++, original.type);
        Object.assign(copy, {
          legend: { ...original.legend },
          hiddenColumns: [...original.hiddenColumns],
          columnWidths: { ...original.columnWidths },
          mode: original.mode,
          fixedFrame: original.fixedFrame,
          tileUrl: original.tileUrl,
          series: original.series.map((series) => ({ ...series, path: [...series.path] })),
        });
        if (copy.type === "tabs" && original.type === "tabs") {
          copy.tabs = original.tabs.map((tab) => ({
            ...tab,
            layout: mapLeaves(tab.layout, (id) => makeCopy(state.widgets[id]).id),
          }));
          copy.activeTabId = original.activeTabId;
          copy.nextTabNumber = original.nextTabNumber;
        }
        widgets[copy.id] = copy;
        return copy;
      };
      const added =
        action.duplicate && target ? makeCopy(target) : widget(nextNumber++, action.widgetType);
      widgets[added.id] = added;
      let next: WorkspaceState = {
        ...state,
        widgets,
        nextNumber,
        activeId: added.id,
        expandedId: null,
      };
      const layout = containerLayout(state, container);
      next = setContainerLayout(
        next,
        container,
        insertLeaf(layout, added.id, target?.id, action.direction, action.before),
      );
      return revealContainer(next, container);
    }
    case "move": {
      if (!state.widgets[action.id] || action.target === action.id) return state;
      const container =
        action.container ?? (action.target ? ownerOf(state, action.target) : undefined);
      if (!canMove(state, action.id, container, action.target)) return state;
      const source = ownerOf(state, action.id);
      let next = setContainerLayout(
        state,
        source,
        removeLeafNullable(containerLayout(state, source), action.id),
      );
      const direction = action.edge === "top" || action.edge === "bottom" ? "column" : "row";
      next = setContainerLayout(
        next,
        container,
        insertLeaf(
          containerLayout(next, container),
          action.id,
          action.target,
          direction,
          action.edge === "left" || action.edge === "top",
        ),
      );
      return revealContainer({ ...next, activeId: action.id, expandedId: null }, container);
    }
    case "remove": {
      if (!state.widgets[action.id]) return state;
      const container = ownerOf(state, action.id);
      const widgets = { ...state.widgets };
      for (const id of subtreeIds(state, action.id)) delete widgets[id];
      const next = setContainerLayout(
        { ...state, widgets, expandedId: null },
        container,
        removeLeafNullable(containerLayout(state, container), action.id),
      );
      return repairSelection(next, container);
    }
    case "tab-move": {
      const source = state.widgets[action.id];
      const target = state.widgets[action.targetId];
      if (source?.type !== "tabs" || target?.type !== "tabs" || source.id === target.id)
        return state;
      const tab = source.tabs.find((tab) => tab.id === action.tabId);
      if (!tab || (action.beforeId && !target.tabs.some((tab) => tab.id === action.beforeId)))
        return state;
      const moved = { ...tab, id: `tab-${target.nextTabNumber}` };
      const remaining = source.tabs.filter((t) => t.id !== tab.id);
      const emptied = remaining.length === 0;
      if (emptied)
        remaining.push({ id: `tab-${source.nextTabNumber}`, title: defaultTabTitle, layout: null });
      const sourceActiveId =
        source.activeTabId === tab.id
          ? remaining[Math.min(source.tabs.indexOf(tab), remaining.length - 1)].id
          : source.activeTabId;
      const placeholder =
        target.tabs.length === 1 &&
        target.tabs[0].layout === null &&
        target.tabs[0].title === defaultTabTitle;
      const tabs = placeholder ? [] : [...target.tabs];
      const index =
        action.beforeId && !placeholder
          ? tabs.findIndex((tab) => tab.id === action.beforeId) + (action.after ? 1 : 0)
          : tabs.length;
      tabs.splice(index, 0, moved);
      const next = {
        ...state,
        expandedId: null,
        widgets: {
          ...state.widgets,
          [source.id]: {
            ...source,
            tabs: remaining,
            activeTabId: sourceActiveId,
            nextTabNumber: source.nextTabNumber + (emptied ? 1 : 0),
          },
          [target.id]: {
            ...target,
            tabs,
            activeTabId: moved.id,
            nextTabNumber: target.nextTabNumber + 1,
          },
        },
      };
      return { ...next, activeId: firstVisible(next, moved.layout) ?? target.id };
    }
    case "tab-add": {
      const current = state.widgets[action.id];
      if (current?.type !== "tabs") return state;
      const tab = { id: `tab-${current.nextTabNumber}`, title: defaultTabTitle, layout: null };
      return {
        ...state,
        activeId: current.id,
        widgets: {
          ...state.widgets,
          [current.id]: {
            ...current,
            tabs: [...current.tabs, tab],
            activeTabId: tab.id,
            nextTabNumber: current.nextTabNumber + 1,
          },
        },
      };
    }
    case "tab-select":
    case "tab-remove":
    case "tab-rename":
    case "tab-reorder": {
      const current = state.widgets[action.id];
      if (current?.type !== "tabs") return state;
      const tab = current.tabs.find((tab) => tab.id === action.tabId);
      if (!tab) return state;
      if (action.type === "tab-select") {
        const next = {
          ...state,
          widgets: { ...state.widgets, [current.id]: { ...current, activeTabId: tab.id } },
        };
        return { ...next, activeId: firstVisible(next, tab.layout) ?? current.id };
      }
      if (action.type === "tab-rename") {
        const title = action.title.trim();
        if (title === tab.title) return state;
        return {
          ...state,
          widgets: {
            ...state.widgets,
            [current.id]: {
              ...current,
              tabs: current.tabs.map((t) => (t.id === tab.id ? { ...t, title } : t)),
            },
          },
        };
      }
      if (action.type === "tab-reorder") {
        if (tab.id === action.beforeId || !current.tabs.some((t) => t.id === action.beforeId))
          return state;
        const tabs = current.tabs.filter((t) => t.id !== tab.id);
        tabs.splice(
          tabs.findIndex((t) => t.id === action.beforeId) + (action.after ? 1 : 0),
          0,
          tab,
        );
        return { ...state, widgets: { ...state.widgets, [current.id]: { ...current, tabs } } };
      }
      if (current.tabs.length === 1) return state;
      const widgets = { ...state.widgets };
      for (const id of leaves(tab.layout).flatMap((id) => subtreeIds(state, id)))
        delete widgets[id];
      const tabs = current.tabs.filter((t) => t.id !== tab.id);
      const activeTabId =
        current.activeTabId === tab.id
          ? tabs[Math.min(current.tabs.indexOf(tab), tabs.length - 1)].id
          : current.activeTabId;
      widgets[current.id] = { ...current, tabs, activeTabId };
      const next = {
        ...state,
        widgets,
        expandedId: state.expandedId && widgets[state.expandedId] ? state.expandedId : null,
      };
      return repairSelection(next, { widgetId: current.id, tabId: activeTabId });
    }
    case "expand":
      return action.id === null || state.widgets[action.id]
        ? {
            ...state,
            expandedId: action.id,
            activeId: action.id ?? state.activeId,
          }
        : state;
    case "select":
      return state.widgets[action.id] && state.activeId !== action.id
        ? { ...state, activeId: action.id }
        : state;
    case "layout":
      return state.expandedId || hasTabs(action.layout)
        ? state
        : validLayoutChange(state, action.container, action.layout)
          ? setContainerLayout(state, action.container, action.layout)
          : state;
    case "sources":
      return {
        ...state,
        widgets: Object.fromEntries(
          Object.values(state.widgets).map((w) => [
            w.id,
            {
              ...w,
              series: w.series.filter((s) => action.open.has(s.source)),
              hiddenColumns:
                w.series[0] && !action.open.has(w.series[0].source) ? [] : w.hiddenColumns,
              columnWidths:
                w.series[0] && !action.open.has(w.series[0].source) ? {} : w.columnWidths,
              view: action.keepViews ? w.view : defaultPlotView(),
              fixedFrame: action.keepViews ? w.fixedFrame : null,
            },
          ]),
        ),
      };
    default: {
      const current = state.widgets[action.id];
      if (!current) return state;
      if (
        action.type === "change-type" &&
        !canPlaceWidget(action.widgetType, ownerOf(state, current.id))
      )
        return state;
      if (action.type === "change-type" || (action.type === "clear" && current.type === "tabs")) {
        const widgets = { ...state.widgets };
        for (const id of subtreeIds(state, current.id)) if (id !== current.id) delete widgets[id];
        widgets[current.id] = widget(
          Number(current.id.replace("widget-", "")),
          action.type === "clear" ? "tabs" : action.widgetType,
        );
        return {
          ...state,
          widgets,
          activeId: current.id,
          expandedId: state.expandedId && widgets[state.expandedId] ? state.expandedId : null,
        };
      }
      if (current.type === "tabs") return state;
      if (action.type === "table-columns") {
        if (current.type !== "table" || !current.series.length) return state;
        const hiddenColumns = action.visible
          ? []
          : [...new Set(action.paths.map((path) => JSON.stringify(path)))];
        return {
          ...state,
          widgets: { ...state.widgets, [action.id]: { ...current, hiddenColumns } },
        };
      }
      if (action.type === "table-column-width") {
        if (current.type !== "table" || !current.series.length || !Number.isFinite(action.width))
          return state;
        const key = action.path === null ? "time" : JSON.stringify(action.path);
        return {
          ...state,
          widgets: {
            ...state.widgets,
            [action.id]: {
              ...current,
              columnWidths: { ...current.columnWidths, [key]: clampColumnWidth(action.width) },
            },
          },
        };
      }
      if (action.type === "table-column") {
        if (current.type !== "table" || !current.series.length) return state;
        const key = JSON.stringify(action.path);
        const hiddenColumns = current.hiddenColumns.filter((path) => path !== key);
        if (!action.visible) hiddenColumns.push(key);
        return {
          ...state,
          widgets: { ...state.widgets, [action.id]: { ...current, hiddenColumns } },
        };
      }
      const updated =
        action.type === "series"
          ? // With nothing left, the next topic added decides the frame again.
            {
              ...withSeries(current, action.update(current.series)),
              ...(action.update(current.series).length ? {} : { fixedFrame: null }),
            }
          : action.type === "view"
            ? { ...current, view: action.update(current.view) }
            : action.type === "clear"
              ? {
                  ...current,
                  series: [],
                  hiddenColumns: [],
                  columnWidths: {},
                  view: defaultPlotView(),
                  fixedFrame: null,
                }
              : action.type === "legend"
                ? { ...current, legend: { ...current.legend, ...action.value } }
                : action.type === "fixed-frame"
                  ? { ...current, fixedFrame: action.value }
                  : action.type === "tile-url"
                    ? { ...current, tileUrl: action.value }
                    : { ...current, mode: action.mode };
      return { ...state, widgets: { ...state.widgets, [action.id]: updated } };
    }
  }
}
