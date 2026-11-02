// What each widget type accepts and how it is described.
import { type Widget, type Container } from "./widgetModel";
import { type FieldIndex } from "./fieldIndex";
import { topicKey, type Selected, type Topic, type ValueKind } from "../types";

/** What a widget type shows and which series it takes. */
export type WidgetSpec = {
  label: string;
  description: string;
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
  /** How to operate the view, one operation per item. */
  controls?: readonly string[];
  /** Takes topics converted to these kinds, rather than fields by value kind. */
  viewKinds?: ReadonlySet<string>;
};

export const widgetSpecs: Record<Widget["type"], WidgetSpec> = {
  "tf-tree": {
    label: "TF tree",
    description: "Show coordinate frame relationships",
    controls: ["Drag: pan", "Wheel: zoom"],
    emptyHint: "No frames",
    accepts: new Set(),
    sameKind: false,
    maxSeries: 0,
    loadsSeries: false,
  },
  "source-info": {
    label: "Data source info",
    description: "Show the time range and topics of the open groups",
    emptyHint: "No data source",
    accepts: new Set(),
    sameKind: false,
    maxSeries: 0,
    loadsSeries: false,
  },
  tabs: {
    label: "Tabs",
    description: "Switch between widget layouts using tabs",
    emptyHint: "Drop a widget",
    accepts: new Set(),
    sameKind: false,
    maxSeries: 0,
    loadsSeries: false,
  },
  plot: {
    label: "Plot",
    controls: [
      "Wheel: zoom",
      "Shift + wheel: zoom values",
      "Click: move playback position",
      "Click legend item: show or hide series",
    ],
    description: "Overlay numeric, bool, or enum time series",
    emptyHint: "Drop a numeric, bool, or enum field",
    accepts: new Set(["numeric", "bool", "enum"]),
    sameKind: true,
    maxSeries: Infinity,
    loadsSeries: true,
  },
  state: {
    label: "State timeline",
    controls: ["Wheel: zoom", "Drag: pan while zoomed", "Click: move playback position"],
    description: "Show how bool, enum, or string values stay and change along a time axis",
    emptyHint: "Drop a bool, enum, or string field",
    accepts: new Set(["bool", "enum", "string"]),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: true,
  },
  "value-changes": {
    label: "State table",
    description: "Show each bool, enum, or string value change with its time in a table",
    emptyHint: "Drop a string, enum, or bool field",
    accepts: new Set(["string", "enum", "bool"]),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: true,
  },
  table: {
    label: "Table",
    description: "Show topic or field history in a table",
    emptyHint: "Drop a topic or field",
    accepts: new Set(["numeric", "bool", "enum", "string", "other"]),
    sameKind: false,
    maxSeries: 1,
    loadsSeries: false,
  },
  raw: {
    label: "Raw message",
    description: "Show a topic or field at the playback position",
    emptyHint: "Drop a topic or field",
    accepts: new Set(["numeric", "bool", "enum", "string", "other"]),
    sameKind: false,
    maxSeries: 1,
    loadsSeries: false,
  },
  image: {
    label: "Image",
    description: "Show an image and projected point clouds",
    controls: ["Drag: pan", "Wheel: zoom"],
    emptyHint: "Drop an image topic",
    accepts: new Set(),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: false,
    viewKinds: new Set(["image", "pointcloud"]),
  },
  scene: {
    label: "3D",
    description: "Show point clouds, cameras, poses and coordinate frames in 3D",
    controls: ["Drag: rotate", "Right-drag: pan", "Wheel: zoom"],
    emptyHint: "Drop a point cloud, image or pose topic",
    accepts: new Set(),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: false,
    viewKinds: new Set(["pointcloud", "image", "pose"]),
  },
  map: {
    label: "Map",
    description: "Show location history and playback position on a map",
    controls: ["Drag: pan", "Wheel: zoom"],
    emptyHint: "Drop a location topic",
    accepts: new Set(),
    sameKind: false,
    maxSeries: Infinity,
    loadsSeries: false,
    viewKinds: new Set(["geo"]),
  },
};

/** Every widget type, in the alphabetical order the widget lists show them. */
export const widgetTypes = (Object.keys(widgetSpecs) as Widget["type"][]).sort((a, b) =>
  widgetSpecs[a].label.localeCompare(widgetSpecs[b].label, "en"),
);

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
) => (spec.viewKinds ? path.length === 0 && !!viewFor(spec, topic) : acceptsKind(spec, kind));

/** The selected view kind, independent of converter IDs and topic names. */
export const selectedViewKind = (index: FieldIndex, series: Selected) =>
  index.topics
    .get(topicKey(series.source, series.topic))
    ?.views.find((view) => view.id === series.view)?.kind;

/** Tab containers are only allowed in the root layout. */
export const canPlaceWidget = (type: Widget["type"], container?: Container) =>
  type !== "tabs" || container === undefined;
