// Building new widgets and the actions that add them.
import {
  osmTiles,
  defaultTabTitle,
  defaultFrameAxes,
  type Widget,
  type WorkspaceState,
  type WorkspaceAction,
} from "./widgetModel";
import {
  type WidgetSpec,
  widgetSpecs,
  maxFieldsPerTopic,
  viewFor,
  selectedViewKind,
  canPlaceWidget,
} from "./widgetSpecs";
import { type DropEdge, ownerOf } from "./layoutTree";
import { type FieldIndex } from "./fieldIndex";
import { defaultPlotView } from "../views/Plot";
import { colors, keyOf, type Field, type Selected, type Topic } from "../types";

/** Append a field as a new series, or replace the series of a single-series widget. */
export function addSeries(
  list: Selected[],
  { source, topic, views, topicName }: Pick<Topic, "source" | "topic" | "views" | "topicName">,
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
    colors.find((c) => !base.some((s) => s.color === c)) ?? colors[base.length % colors.length];
  return [
    ...base,
    {
      key,
      source,
      topic,
      topicName,
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
  topic: Pick<Topic, "source" | "topic" | "views" | "topicName">,
  field: Field,
  index: FieldIndex,
): WorkspaceAction => ({
  type: "series",
  id: widget.id,
  update: (list) => {
    if (widget.type !== "image") return addSeries(list, topic, field, widgetSpecs[widget.type]);
    const kind = viewFor(widgetSpecs.image, topic)?.kind;
    const image = list.find((item) => selectedViewKind(index, item) === "image");
    if (kind !== "image" && !image) return list;
    if (kind === "image" && image && image.key !== keyOf(topic.source, topic.topic, field.path))
      return addSeries(
        list.filter((item) => item.key !== image.key),
        topic,
        field,
        widgetSpecs.image,
      );
    return addSeries(list, topic, field, widgetSpecs.image);
  },
});

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

export const widget = (number: number, type: Widget["type"] = "plot"): Widget => ({
  id: `widget-${number}`,
  ...(type === "tabs"
    ? {
        type,
        tabs: [{ id: "tab-1", title: defaultTabTitle, layout: null }],
        activeTabId: "tab-1",
        nextTabNumber: 2,
      }
    : { type }),
  title: widgetSpecs[type].label,
  series: [],
  mode: "pan",
  legend: { visible: true, position: "top-left" },
  hiddenColumns: [],
  columnWidths: {},
  view: defaultPlotView(),
  fixedFrame: null,
  tileUrl: osmTiles,
  frameAxes: defaultFrameAxes(),
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

/** A Y range fitted to one value kind is meaningless for another. */

/**
 * Adds at a fixed place, the left of the layout holding the selection, which a
 * drag can override. A selected Tabs widget holds its open tab's layout. A Tabs
 * widget cannot nest, so it always goes to the workspace.
 */
export function addSelectedAction(state: WorkspaceState, type: Widget["type"]): WorkspaceAction {
  const selected = state.activeId ? state.widgets[state.activeId] : undefined;
  const container =
    selected?.type === "tabs"
      ? { widgetId: selected.id, tabId: selected.activeTabId }
      : selected && ownerOf(state, selected.id);
  return {
    type: "add",
    widgetType: type,
    leading: true,
    container: container && canPlaceWidget(type, container) ? container : undefined,
  };
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
