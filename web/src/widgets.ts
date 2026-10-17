import type { MosaicDirection, MosaicNode } from "react-mosaic-component";
import type { DragMode, PlotView } from "./Plot";
import { defaultPlotView } from "./Plot";
import type { TimeDisplay } from "./timeDisplay";
import {
  colors,
  keyOf,
  kindsMatch,
  seriesKind,
  valueKind,
  type Field,
  type Selected,
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
  type: "time-series" | "state";
  title: string;
  series: Selected[];
  mode: DragMode;
  timeDisplay: TimeDisplay;
  legend: LegendSettings;
  /** JSON-encoded column paths relative to the Table target. Time stays visible. */
  hiddenColumns: string[];
  columnWidths: Record<string, number>;
  view: PlotView;
};
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
  | { type: "layout"; layout: MosaicNode<string> | null }
  | { type: "series"; id: string; update: (series: Selected[]) => Selected[] }
  | { type: "view"; id: string; update: (view: PlotView) => PlotView }
  | { type: "mode"; id: string; mode: DragMode }
  | { type: "time-display"; id: string; value: TimeDisplay }
  | { type: "recording" };

export const widgetDragMime = "application/x-hahn-widget";
/** What a widget type shows and which series it takes. */
export type WidgetSpec = {
  label: string;
  titlePrefix: string;
  description: string;
  help: string;
  /** Value kinds the widget can display at all. */
  accepts: ReadonlySet<ValueKind["type"]>;
  /** Series must share the first series' kind (one Y axis), or may mix. */
  sameKind: boolean;
  /** At 1, adding a field replaces the current series. */
  maxSeries: number;
};
export const widgetSpecs: Record<Widget["type"], WidgetSpec> = {
  "time-series": {
    label: "Time Series",
    titlePrefix: "Time series",
    description: "数値・bool・enum の時系列を重ねて表示",
    help: "数値・bool・enum フィールドを追加します。最初の系列と同じ型だけを重ねられます。",
    accepts: new Set(["numeric", "bool", "enum"]),
    sameKind: true,
    maxSeries: Infinity,
  },
  state: {
    label: "State Transition",
    titlePrefix: "State",
    description: "bool・enum の状態遷移を1系列1行で表示",
    help: "bool・enum フィールドを追加します。型や enum の定義が異なる系列も並べられます。",
    accepts: new Set(["bool", "enum"]),
    sameKind: false,
    maxSeries: Infinity,
  },
};
export const widgetTypes = Object.keys(widgetSpecs) as Widget["type"][];
/** Fields per topic and widget; mirrors the series API batch limit. */
export const maxFieldsPerTopic = 64;
export const acceptsKind = (spec: WidgetSpec, kind: ValueKind | null) =>
  kind !== null && spec.accepts.has(kind.type);

/** Append a field as a new series, or replace the series of a single-series widget. */
export function addSeries(
  list: Selected[],
  topic: string,
  field: Field,
  spec: WidgetSpec,
): Selected[] {
  const key = keyOf(topic, field.path);
  if (list.some((s) => s.key === key)) return list;
  const base = spec.maxSeries === 1 ? [] : list;
  if (base.length >= spec.maxSeries) return list;
  if (base.filter((s) => s.topic === topic).length >= maxFieldsPerTopic) return list;
  const color =
    colors.find((c) => !base.some((s) => s.color === c)) ??
    colors[base.length % colors.length];
  return [
    ...base,
    {
      key,
      topic,
      path: field.path,
      color,
      lineWidth: 1.5,
      hidden: false,
      dataType: field.data_type,
      enumValues: field.enum_values,
    },
  ];
}
export const addFieldAction = (
  widget: Widget,
  topic: string,
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

const defaultTitle = (type: Widget["type"], number: number | string) =>
  `${widgetSpecs[type].titlePrefix} ${number}`;
/** Series a widget of the given type can keep after switching to it. */
export function compatibleSeries(type: Widget["type"], series: Selected[]) {
  const spec = widgetSpecs[type];
  const kind = (s: Selected) => valueKind(s.dataType, s.enumValues);
  const accepted = series.filter((s) => acceptsKind(spec, kind(s)));
  const first = seriesKind(accepted);
  return accepted
    .filter((s) => !spec.sameKind || kindsMatch(first, kind(s)))
    .slice(0, spec.maxSeries);
}
const widget = (number: number, type: Widget["type"] = "time-series"): Widget => ({
  id: `widget-${number}`,
  type,
  title: defaultTitle(type, number),
  series: [],
  mode: "pan",
  timeDisplay: "absolute",
  legend: { visible: true, position: "top-left" },
  hiddenColumns: [],
  columnWidths: {},
  view: defaultPlotView(),
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
export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "add": {
      const target = state.widgets[action.target ?? state.activeId ?? ""];
      const added = widget(
        state.nextNumber,
        action.widgetType ?? (action.duplicate ? target?.type : undefined),
      );
      if (action.duplicate && target) {
        added.timeDisplay = target.timeDisplay;
        added.mode = target.mode;
        added.series = target.series.map((series) => ({
          ...series,
          path: [...series.path],
        }));
      }
      const layout =
        state.layout === null
          ? added.id
          : replaceLeaf(state.layout, target?.id ?? leaves(state.layout)[0], {
              type: "split",
              direction: action.direction ?? "row",
              children: action.before
                ? [added.id, target?.id ?? leaves(state.layout)[0]]
                : [target?.id ?? leaves(state.layout)[0], added.id],
              splitPercentages: [50, 50],
            });
      return {
        ...state,
        widgets: { ...state.widgets, [added.id]: added },
        layout,
        activeId: added.id,
        expandedId: null,
        nextNumber: state.nextNumber + 1,
      };
    }
    case "remove": {
      if (!state.widgets[action.id]) return state;
      const widgets = { ...state.widgets };
      delete widgets[action.id];
      const layout = state.layout && removeLeaf(state.layout, action.id);
      return {
        ...state,
        widgets,
        layout,
        expandedId: null,
        activeId:
          state.activeId === action.id
            ? (leaves(layout)[0] ?? null)
            : state.activeId,
      };
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
        : { ...state, layout: action.layout };
    case "recording":
      return {
        ...state,
        widgets: Object.fromEntries(
          Object.values(state.widgets).map((w) => [
            w.id,
            {
              ...w,
              series: [],
              view: defaultPlotView(),
            },
          ]),
        ),
      };
    default: {
      const current = state.widgets[action.id];
      if (!current) return state;
      const updated =
        action.type === "series"
          ? withSeries(current, action.update(current.series))
          : action.type === "view"
            ? { ...current, view: action.update(current.view) }
            : action.type === "clear"
              ? { ...current, series: [], view: defaultPlotView() }
            : action.type === "change-type"
              ? {
                  ...current,
                  type: action.widgetType,
                  title: defaultTitle(action.widgetType, current.id.replace("widget-", "")),
                  series: compatibleSeries(action.widgetType, current.series),
                  view: defaultPlotView(),
                }
            : action.type === "time-display"
              ? { ...current, timeDisplay: action.value }
            : action.type === "legend"
              ? { ...current, legend: { ...current.legend, ...action.value } }
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
        .flatMap((w) => w.series)
        .map((s) => [s.key, s]),
    ).values(),
  ].sort((a, b) => a.key.localeCompare(b.key));
}
