import type { MosaicDirection, MosaicNode } from "react-mosaic-component";
import type { DragMode, PlotView } from "./Plot";
import { defaultPlotView } from "./Plot";
import type { TimeDisplay } from "./timeDisplay";
import { clampColumnWidth } from "./table";
import {
  colors,
  keyOf,
  kindsMatch,
  seriesKind,
  type Field,
  type Selected,
  type Topic,
  type ValueKind,
} from "./types";

export type LegendPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type LegendSettings = { visible: boolean; position: LegendPosition };
export const legendPositions: Record<LegendPosition, string> = {
  "top-left": "左上",
  "top-right": "右上",
  "bottom-left": "左下",
  "bottom-right": "右下",
};
type WidgetBase = {
  id: string;
  title: string;
  series: Selected[];
  mode: DragMode;
  timeDisplay: TimeDisplay;
  legend: LegendSettings;
  /** JSON-encoded column paths relative to the Table target. Time stays visible. */
  hiddenColumns: string[];
  columnWidths: Record<string, number>;
  view: PlotView;
  /** The frame a 3D widget renders in; null follows the graph's root. */
  fixedFrame: string | null;
  /** Map tile URL template. Empty shows no background and requests no tiles. */
  tileUrl: string;
};
export const osmTiles = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const defaultTabTitle = "";
export type WidgetTab = { id: string; title: string; layout: MosaicNode<string> | null };
export type Widget = WidgetBase & (
  | { type: "time-series" | "state" | "raw" | "log" | "table" | "image" | "scene" | "map" }
  | { type: "tabs"; tabs: WidgetTab[]; activeTabId: string; nextTabNumber: number }
);
export type TabWidget = Extract<Widget, { type: "tabs" }>;
/** Omitted for the root workspace. */
export type Container = { widgetId: string; tabId: string };
export type WorkspaceState = {
  widgets: Record<string, Widget>;
  layout: MosaicNode<string> | null;
  activeId: string | null;
  expandedId: string | null;
  nextNumber: number;
};
export type WorkspaceAction =
  | {
      type: "add";
      target?: string;
      container?: Container;
      direction?: MosaicDirection;
      /** Place the new widget left of / above the target instead of after it. */
      before?: boolean;
      duplicate?: boolean;
      widgetType?: Widget["type"];
    }
  | { type: "remove"; id: string }
  | { type: "clear"; id: string }
  | { type: "change-type"; id: string; widgetType: Widget["type"] }
  | { type: "select"; id: string }
  | { type: "expand"; id: string | null }
  | { type: "layout"; layout: MosaicNode<string> | null; container?: Container }
  | { type: "move"; id: string; target?: string; container?: Container; edge?: DropEdge }
  | { type: "tab-add"; id: string }
  | { type: "tab-move"; id: string; tabId: string; targetId: string; beforeId?: string; after?: boolean }
  | { type: "tab-select" | "tab-remove"; id: string; tabId: string }
  | { type: "tab-rename"; id: string; tabId: string; title: string }
  | { type: "tab-reorder"; id: string; tabId: string; beforeId: string; after?: boolean }
  | { type: "series"; id: string; update: (series: Selected[]) => Selected[] }
  | { type: "view"; id: string; update: (view: PlotView) => PlotView }
  | { type: "mode"; id: string; mode: DragMode }
  | { type: "time-display"; id: string; value: TimeDisplay }
  | { type: "legend"; id: string; value: Partial<LegendSettings> }
  | { type: "fixed-frame"; id: string; value: string | null }
  | { type: "tile-url"; id: string; value: string }
  | { type: "table-column"; id: string; path: string[]; visible: boolean }
  | { type: "table-columns"; id: string; paths: string[][]; visible: boolean }
  | { type: "table-column-width"; id: string; path: string[] | null; width: number }
  /**
   * The open recordings changed: drop series of recordings that are no
   * longer open and reset every view to the new full range.
   */
  | { type: "sources"; open: ReadonlySet<string> };

export const widgetMoveMime = "application/x-hahn-widget-move";
export const tabDragMime = "application/x-hahn-tab";
export const widgetDragMime = "application/x-hahn-widget";
/** What a widget type shows and which series it takes. */
export type WidgetSpec = {
  label: string;
  titlePrefix: string;
  description: string;
  help: string;
  /** Shown in an empty widget. */
  emptyHint: string;
  /** Value kinds the widget can display at all. */
  accepts: ReadonlySet<ValueKind["type"]>;
  /** Series must share the first series' kind (one Y axis), or may mix. */
  sameKind: boolean;
  /** At 1, adding a field replaces the current series. */
  maxSeries: number;
  /** Whether selections load as exact series; generic viewers fetch on their own. */
  loadsSeries: boolean;
  /** Takes topics converted to these kinds, rather than fields by value kind. */
  viewKinds?: ReadonlySet<string>;
};
export const widgetSpecs: Record<Widget["type"], WidgetSpec> = {
  tabs: {
    label: "Tab", titlePrefix: "Tab",
    description: "複数ウィジェットの配置をタブで切り替え",
    help: "各タブにウィジェットを配置できます。タブの名前と順序を編集します。",
    emptyHint: "ウィジェットをドロップ", accepts: new Set(),
    sameKind: false, maxSeries: 0, loadsSeries: false,
  },
  "time-series": {
    label: "Time Series",
    titlePrefix: "Time series",
    description: "数値・bool・enum の時系列を重ねて表示",
    help: "数値・bool・enum フィールドを追加します。最初の系列と同じ型だけを重ねられます。",
    emptyHint: "数値・bool・enum フィールドをドロップ",
    accepts: new Set(["numeric", "bool", "enum"]),
    sameKind: true,
    maxSeries: Infinity,
    loadsSeries: true,
  },
  state: {
    label: "State Transition",
    titlePrefix: "State",
    description: "bool・enum・string の状態遷移を1系列1行で表示",
    help: "bool・enum・string フィールドを追加します。型や enum の定義が異なる系列も並べられます。",
    emptyHint: "bool・enum・string フィールドをドロップ",
    accepts: new Set(["bool", "enum", "string"]),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: true,
  },
  log: {
    label: "Log",
    titlePrefix: "Log",
    description: "string・enum・bool の値の変化を時刻順の一覧で表示",
    help: "string・enum・bool フィールドを追加します。値が変わった時点だけを時刻順に並べます。",
    emptyHint: "string・enum・bool フィールドをドロップ",
    accepts: new Set(["string", "enum", "bool"]),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: true,
  },
  table: {
    label: "Table",
    titlePrefix: "Table",
    description: "トピック・フィールド配下の履歴をテーブルで表示",
    help: "表示するトピックまたはフィールドを1つ指定します。配下すべてを列に展開します。",
    emptyHint: "トピックまたはフィールドをドロップ",
    accepts: new Set(["numeric", "bool", "enum", "string", "other"]),
    sameKind: false,
    maxSeries: 1,
    loadsSeries: false,
  },
  raw: {
    label: "Raw Message",
    titlePrefix: "Raw",
    description: "トピック・フィールドの中身を再生位置の時点で表示",
    help: "表示するトピックまたはフィールドを1つ指定します。",
    emptyHint: "トピックまたはフィールドをドロップ",
    accepts: new Set(["numeric", "bool", "enum", "string", "other"]),
    sameKind: false,
    maxSeries: 1,
    loadsSeries: false,
  },
  image: {
    label: "Image",
    titlePrefix: "Image",
    description: "画像トピックを再生位置の時点で表示",
    help: "表示する画像トピックを1つ指定します。",
    emptyHint: "画像トピックをドロップ",
    accepts: new Set(),
    sameKind: false,
    maxSeries: 1,
    loadsSeries: false,
    viewKinds: new Set(["image"]),
  },
  scene: {
    label: "3D",
    titlePrefix: "3D",
    description: "点群と座標系を再生位置の時点で3D表示",
    help: "点群トピックを追加します。ドラッグで回転、右ドラッグで移動、ホイールで拡大縮小します。",
    emptyHint: "点群トピックをドロップ",
    accepts: new Set(),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: false,
    viewKinds: new Set(["pointcloud"]),
  },
  map: {
    label: "Map",
    titlePrefix: "Map",
    description: "位置トピックの軌跡と再生位置を地図に表示",
    help: "位置トピックを追加します。背景の地図タイルはパネル設定で変更できます。",
    emptyHint: "位置トピックをドロップ",
    accepts: new Set(),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: false,
    viewKinds: new Set(["geo"]),
  },
};
export const widgetTypes = Object.keys(widgetSpecs) as Widget["type"][];
/** Fields per topic and widget; mirrors the series API batch limit. */
export const maxFieldsPerTopic = 64;
export const acceptsKind = (spec: WidgetSpec, kind: ValueKind | null) =>
  kind !== null && spec.accepts.has(kind.type);
/** The view of a topic that a widget type shows, if it takes views at all. */
export const viewFor = (spec: WidgetSpec, topic: Pick<Topic, "views">) =>
  topic.views.find((view) => spec.viewKinds?.has(view.kind));
/** Whether a widget type can display a field at all. Views belong to whole topics. */
export const acceptsField = (
  spec: WidgetSpec,
  topic: Pick<Topic, "views">,
  path: string[],
  kind: ValueKind | null,
) =>
  spec.viewKinds ? path.length === 0 && !!viewFor(spec, topic) : acceptsKind(spec, kind);

/** Append a field as a new series, or replace the series of a single-series widget. */
export function addSeries(
  list: Selected[],
  { source, topic, views }: Pick<Topic, "source" | "topic" | "views">,
  field: Field,
  spec: WidgetSpec,
): Selected[] {
  const key = keyOf(source, topic, field.path);
  if (list.some((s) => s.key === key)) return list;
  const base = spec.maxSeries === 1 ? [] : list;
  if (base.length >= spec.maxSeries) return list;
  if (base.filter((s) => s.source === source && s.topic === topic).length >= maxFieldsPerTopic)
    return list;
  const color =
    colors.find((c) => !base.some((s) => s.color === c)) ??
    colors[base.length % colors.length];
  return [
    ...base,
    {
      key,
      source,
      topic,
      path: field.path,
      color,
      lineWidth: 1.5,
      hidden: false,
      dataType: field.data_type,
      enumValues: field.enum_values,
      view: viewFor(spec, { views })?.id,
    },
  ];
}
export const addFieldAction = (
  widget: Widget,
  topic: Pick<Topic, "source" | "topic" | "views">,
  field: Field,
): WorkspaceAction => ({
  type: "series",
  id: widget.id,
  update: (list) => addSeries(list, topic, field, widgetSpecs[widget.type]),
});
export type DropEdge = "left" | "right" | "top" | "bottom";
/** The tile edge nearest to a pointer, given its position relative to the tile. */
export function dropEdge(x: number, y: number, width: number, height: number): DropEdge {
  const distances: [DropEdge, number][] = [
    ["left", x / width],
    ["right", 1 - x / width],
    ["top", y / height],
    ["bottom", 1 - y / height],
  ];
  return distances.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}
export const addAt = (
  widgetType: Widget["type"],
  target: string,
  edge: DropEdge,
): WorkspaceAction => ({
  type: "add",
  widgetType,
  target,
  direction: edge === "left" || edge === "right" ? "row" : "column",
  before: edge === "left" || edge === "top",
});

const widget = (number: number, type: Widget["type"] = "time-series"): Widget => ({
  id: `widget-${number}`,
  ...(type === "tabs"
    ? { type, tabs: [{ id: "tab-1", title: defaultTabTitle, layout: null }], activeTabId: "tab-1", nextTabNumber: 2 }
    : { type }),
  title: widgetSpecs[type].titlePrefix,
  series: [],
  mode: "pan",
  timeDisplay: "absolute",
  legend: { visible: true, position: "top-left" },
  hiddenColumns: [],
  columnWidths: {},
  view: defaultPlotView(),
  fixedFrame: null,
  tileUrl: osmTiles,
});
export function initialWorkspace(): WorkspaceState {
  const first = widget(1);
  return {
    widgets: { [first.id]: first },
    layout: first.id,
    activeId: first.id,
    expandedId: null,
    nextNumber: 2,
  };
}
function replaceLeaf(
  node: MosaicNode<string>,
  id: string,
  replacement: MosaicNode<string>,
): MosaicNode<string> {
  if (typeof node === "string") return node === id ? replacement : node;
  if (node.type === "tabs") return node;
  return {
    ...node,
    children: node.children.map((child) => replaceLeaf(child, id, replacement)),
  };
}
function removeLeaf(
  node: MosaicNode<string>,
  id: string,
): MosaicNode<string> | null {
  if (typeof node === "string") return node === id ? null : node;
  if (node.type === "tabs") return node;
  const remaining = node.children
    .map((child, i) => ({
      node: removeLeaf(child, id),
      weight: node.splitPercentages?.[i] ?? 100 / node.children.length,
    }))
    .filter((child) => child.node !== null);
  if (!remaining.length) return null;
  if (remaining.length === 1) return remaining[0].node;
  const total = remaining.reduce((sum, child) => sum + child.weight, 0);
  return {
    ...node,
    children: remaining.map((child) => child.node!),
    splitPercentages: remaining.map((child) => (child.weight / total) * 100),
  };
}
export function leaves(node: MosaicNode<string> | null): string[] {
  if (node === null) return [];
  if (typeof node === "string") return [node];
  return node.type === "tabs" ? node.tabs : node.children.flatMap(leaves);
}
export function hasTabs(node: MosaicNode<string> | null): boolean {
  return (
    node !== null &&
    typeof node !== "string" &&
    (node.type === "tabs" || node.children.some(hasTabs))
  );
}
/** A Y range fitted to one value kind is meaningless for another. */
function withSeries(current: Widget, series: Selected[]): Widget {
  if (current.type === "table" && current.series[0]?.key !== series[0]?.key)
    current = { ...current, hiddenColumns: [], columnWidths: {} };
  if (kindsMatch(seriesKind(current.series), seriesKind(series)))
    return { ...current, series };
  return {
    ...current,
    series,
    view: { ...current.view, y: defaultPlotView().y, pinnedYBase: null },
  };
}
function mapLeaves(node: MosaicNode<string> | null, map: (id: string) => string): MosaicNode<string> | null {
  if (node === null) return null;
  if (typeof node === "string") return map(node);
  if (node.type === "tabs") return { ...node, tabs: node.tabs.map(map) };
  return { ...node, children: node.children.map((child) => mapLeaves(child, map)!) };
}
export function containerLayout(state: WorkspaceState, container?: Container): MosaicNode<string> | null {
  if (!container) return state.layout;
  const owner = state.widgets[container.widgetId];
  return owner?.type === "tabs" ? owner.tabs.find((tab) => tab.id === container.tabId)?.layout ?? null : null;
}
function containerExists(state: WorkspaceState, container?: Container): boolean {
  if (!container) return true;
  const owner = state.widgets[container.widgetId];
  return owner?.type === "tabs" && owner.tabs.some((tab) => tab.id === container.tabId);
}
export function ownerOf(state: WorkspaceState, id: string): Container | undefined {
  for (const w of Object.values(state.widgets)) {
    if (w.type !== "tabs") continue;
    const tab = w.tabs.find((tab) => leaves(tab.layout).includes(id));
    if (tab) return { widgetId: w.id, tabId: tab.id };
  }
  return undefined;
}
function setContainerLayout(state: WorkspaceState, container: Container | undefined, layout: MosaicNode<string> | null): WorkspaceState {
  if (!container) return { ...state, layout };
  const owner = state.widgets[container.widgetId];
  if (owner?.type !== "tabs") return state;
  return { ...state, widgets: { ...state.widgets, [owner.id]: {
    ...owner, tabs: owner.tabs.map((tab) => tab.id === container.tabId ? { ...tab, layout } : tab),
  } } };
}
export function subtreeIds(state: WorkspaceState, id: string): string[] {
  const w = state.widgets[id];
  return [id, ...(w?.type === "tabs" ? w.tabs.flatMap((tab) => leaves(tab.layout).flatMap((child) => subtreeIds(state, child))) : [])];
}
/** Tab containers are only allowed in the root layout. */
export const canPlaceWidget = (type: Widget["type"], container?: Container) =>
  type !== "tabs" || container === undefined;

export function canMove(state: WorkspaceState, id: string, container?: Container, target?: string): boolean {
  if (!state.widgets[id] || !containerExists(state, container) || !canPlaceWidget(state.widgets[id].type, container)) return false;
  const subtree = subtreeIds(state, id);
  return !(container && subtree.includes(container.widgetId)) &&
    (!target || (!subtree.includes(target) && leaves(containerLayout(state, container)).includes(target)));
}
function removeLeafNullable(layout: MosaicNode<string> | null, id: string) {
  return layout === null ? null : removeLeaf(layout, id);
}
function insertLeaf(layout: MosaicNode<string> | null, id: string, target?: string, direction: MosaicDirection = "row", before = false): MosaicNode<string> {
  if (layout === null) return id;
  const split = (node: MosaicNode<string>): MosaicNode<string> => ({
    type: "split", direction, children: before ? [id, node] : [node, id], splitPercentages: [50, 50],
  });
  return target && leaves(layout).includes(target) ? replaceLeaf(layout, target, split(target)) : split(layout);
}
function firstVisible(state: WorkspaceState, layout: MosaicNode<string> | null): string | null {
  const id = leaves(layout)[0];
  const w = state.widgets[id];
  return w?.type === "tabs" ? firstVisible(state, w.tabs.find((tab) => tab.id === w.activeTabId)?.layout ?? null) ?? id : id ?? null;
}
function repairSelection(state: WorkspaceState, container?: Container): WorkspaceState {
  if (state.activeId && state.widgets[state.activeId]) return state;
  return { ...state, activeId: firstVisible(state, containerLayout(state, container)) ?? container?.widgetId ?? firstVisible(state, state.layout) };
}
function revealContainer(state: WorkspaceState, container?: Container): WorkspaceState {
  if (!container) return state;
  const w = state.widgets[container.widgetId];
  if (w?.type !== "tabs") return state;
  return revealContainer({ ...state, widgets: { ...state.widgets, [w.id]: { ...w, activeTabId: container.tabId } } }, ownerOf(state, w.id));
}
function validLayoutChange(state: WorkspaceState, container: Container | undefined, layout: MosaicNode<string> | null) {
  if (!containerExists(state, container)) return false;
  const before = leaves(containerLayout(state, container)).sort();
  const after = leaves(layout).sort();
  return before.length === after.length && before.every((id, i) => id === after[i]);
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "add": {
      const target = state.widgets[action.target ?? (action.container ? "" : state.activeId) ?? ""];
      const container = action.container ?? (target ? ownerOf(state, target.id) : undefined);
      const addedType = action.duplicate && target ? target.type : action.widgetType ?? "time-series";
      if (!containerExists(state, container) || !canPlaceWidget(addedType, container)) return state;
      const widgets = { ...state.widgets };
      let nextNumber = state.nextNumber;
      const makeCopy = (original: Widget): Widget => {
        const copy = widget(nextNumber++, original.type);
        Object.assign(copy, {
          timeDisplay: original.timeDisplay, legend: { ...original.legend },
          hiddenColumns: [...original.hiddenColumns], columnWidths: { ...original.columnWidths },
          mode: original.mode, fixedFrame: original.fixedFrame, tileUrl: original.tileUrl, series: original.series.map((series) => ({ ...series, path: [...series.path] })),
        });
        if (copy.type === "tabs" && original.type === "tabs") {
          copy.tabs = original.tabs.map((tab) => ({ ...tab, layout: mapLeaves(tab.layout, (id) => makeCopy(state.widgets[id]).id) }));
          copy.activeTabId = original.activeTabId;
          copy.nextTabNumber = original.nextTabNumber;
        }
        widgets[copy.id] = copy;
        return copy;
      };
      const added = action.duplicate && target ? makeCopy(target) : widget(nextNumber++, action.widgetType);
      widgets[added.id] = added;
      let next: WorkspaceState = { ...state, widgets, nextNumber, activeId: added.id, expandedId: null };
      const layout = containerLayout(state, container);
      next = setContainerLayout(next, container, insertLeaf(layout, added.id, target?.id, action.direction, action.before));
      return revealContainer(next, container);
    }
    case "move": {
      if (!state.widgets[action.id] || action.target === action.id) return state;
      const container = action.container ?? (action.target ? ownerOf(state, action.target) : undefined);
      if (!canMove(state, action.id, container, action.target)) return state;
      const source = ownerOf(state, action.id);
      let next = setContainerLayout(state, source, removeLeafNullable(containerLayout(state, source), action.id));
      const direction = action.edge === "top" || action.edge === "bottom" ? "column" : "row";
      next = setContainerLayout(next, container, insertLeaf(containerLayout(next, container), action.id, action.target, direction, action.edge === "left" || action.edge === "top"));
      return revealContainer({ ...next, activeId: action.id, expandedId: null }, container);
    }
    case "remove": {
      if (!state.widgets[action.id]) return state;
      const container = ownerOf(state, action.id);
      const widgets = { ...state.widgets };
      for (const id of subtreeIds(state, action.id)) delete widgets[id];
      const next = setContainerLayout({ ...state, widgets, expandedId: null }, container,
        removeLeafNullable(containerLayout(state, container), action.id));
      return repairSelection(next, container);
    }
    case "tab-move": {
      const source = state.widgets[action.id];
      const target = state.widgets[action.targetId];
      if (source?.type !== "tabs" || target?.type !== "tabs" || source.id === target.id) return state;
      const tab = source.tabs.find((tab) => tab.id === action.tabId);
      if (!tab || (action.beforeId && !target.tabs.some((tab) => tab.id === action.beforeId))) return state;
      const moved = { ...tab, id: `tab-${target.nextTabNumber}` };
      const remaining = source.tabs.filter((t) => t.id !== tab.id);
      const emptied = remaining.length === 0;
      if (emptied) remaining.push({ id: `tab-${source.nextTabNumber}`, title: defaultTabTitle, layout: null });
      const sourceActiveId = source.activeTabId === tab.id
        ? remaining[Math.min(source.tabs.indexOf(tab), remaining.length - 1)].id : source.activeTabId;
      const placeholder = target.tabs.length === 1 && target.tabs[0].layout === null && target.tabs[0].title === defaultTabTitle;
      const tabs = placeholder ? [] : [...target.tabs];
      const index = action.beforeId && !placeholder
        ? tabs.findIndex((tab) => tab.id === action.beforeId) + (action.after ? 1 : 0) : tabs.length;
      tabs.splice(index, 0, moved);
      const next = { ...state, expandedId: null, widgets: {
        ...state.widgets,
        [source.id]: { ...source, tabs: remaining, activeTabId: sourceActiveId, nextTabNumber: source.nextTabNumber + (emptied ? 1 : 0) },
        [target.id]: { ...target, tabs, activeTabId: moved.id, nextTabNumber: target.nextTabNumber + 1 },
      } };
      return { ...next, activeId: firstVisible(next, moved.layout) ?? target.id };
    }
    case "tab-add": {
      const current = state.widgets[action.id];
      if (current?.type !== "tabs") return state;
      const tab = { id: `tab-${current.nextTabNumber}`, title: defaultTabTitle, layout: null };
      return { ...state, activeId: current.id, widgets: { ...state.widgets, [current.id]: {
        ...current, tabs: [...current.tabs, tab], activeTabId: tab.id, nextTabNumber: current.nextTabNumber + 1,
      } } };
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
        const next = { ...state, widgets: { ...state.widgets, [current.id]: { ...current, activeTabId: tab.id } } };
        return { ...next, activeId: firstVisible(next, tab.layout) ?? current.id };
      }
      if (action.type === "tab-rename") {
        const title = action.title.trim();
        if (title === tab.title) return state;
        return { ...state, widgets: { ...state.widgets, [current.id]: { ...current, tabs: current.tabs.map((t) => t.id === tab.id ? { ...t, title } : t) } } };
      }
      if (action.type === "tab-reorder") {
        if (tab.id === action.beforeId || !current.tabs.some((t) => t.id === action.beforeId)) return state;
        const tabs = current.tabs.filter((t) => t.id !== tab.id);
        tabs.splice(tabs.findIndex((t) => t.id === action.beforeId) + (action.after ? 1 : 0), 0, tab);
        return { ...state, widgets: { ...state.widgets, [current.id]: { ...current, tabs } } };
      }
      if (current.tabs.length === 1) return state;
      const widgets = { ...state.widgets };
      for (const id of leaves(tab.layout).flatMap((id) => subtreeIds(state, id))) delete widgets[id];
      const tabs = current.tabs.filter((t) => t.id !== tab.id);
      const activeTabId = current.activeTabId === tab.id ? tabs[Math.min(current.tabs.indexOf(tab), tabs.length - 1)].id : current.activeTabId;
      widgets[current.id] = { ...current, tabs, activeTabId };
      const next = { ...state, widgets, expandedId: state.expandedId && widgets[state.expandedId] ? state.expandedId : null };
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
          ? setContainerLayout(state, action.container, action.layout) : state;
    case "sources":
      return {
        ...state,
        widgets: Object.fromEntries(
          Object.values(state.widgets).map((w) => [
            w.id,
            {
              ...w,
              series: w.series.filter((s) => action.open.has(s.source)),
              hiddenColumns: w.series[0] && !action.open.has(w.series[0].source) ? [] : w.hiddenColumns,
              columnWidths: w.series[0] && !action.open.has(w.series[0].source) ? {} : w.columnWidths,
              view: defaultPlotView(),
              fixedFrame: null,
            },
          ]),
        ),
      };
    default: {
      const current = state.widgets[action.id];
      if (!current) return state;
      if (action.type === "change-type" && !canPlaceWidget(action.widgetType, ownerOf(state, current.id))) return state;
      if (action.type === "change-type" || (action.type === "clear" && current.type === "tabs")) {
        const widgets = { ...state.widgets };
        for (const id of subtreeIds(state, current.id)) if (id !== current.id) delete widgets[id];
        widgets[current.id] = widget(Number(current.id.replace("widget-", "")), action.type === "clear" ? "tabs" : action.widgetType);
        return { ...state, widgets, activeId: current.id, expandedId: state.expandedId && widgets[state.expandedId] ? state.expandedId : null };
      }
      if (current.type === "tabs") return state;
      if (action.type === "table-columns") {
        if (current.type !== "table" || !current.series.length) return state;
        const hiddenColumns = action.visible ? [] : [...new Set(action.paths.map((path) => JSON.stringify(path)))];
        return {
          ...state,
          widgets: { ...state.widgets, [action.id]: { ...current, hiddenColumns } },
        };
      }
      if (action.type === "table-column-width") {
        if (current.type !== "table" || !current.series.length || !Number.isFinite(action.width)) return state;
        const key = action.path === null ? "time" : JSON.stringify(action.path);
        return {
          ...state,
          widgets: {
            ...state.widgets,
            [action.id]: { ...current, columnWidths: { ...current.columnWidths, [key]: clampColumnWidth(action.width) } },
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
          ? withSeries(current, action.update(current.series))
          : action.type === "view"
            ? { ...current, view: action.update(current.view) }
            : action.type === "clear"
              ? { ...current, series: [], hiddenColumns: [], columnWidths: {}, view: defaultPlotView() }
            : action.type === "time-display"
              ? { ...current, timeDisplay: action.value }
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

/** One demand per recording field, independently of presentation in each widget. */
export function requestedSeries(widgets: Record<string, Widget>): Selected[] {
  return [
    ...new Map(
      Object.values(widgets)
        .filter((w) => widgetSpecs[w.type].loadsSeries)
        .flatMap((w) => w.series)
        .map((s) => [s.key, s]),
    ).values(),
  ].sort((a, b) => a.key.localeCompare(b.key));
}
