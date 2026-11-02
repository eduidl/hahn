// Whether a widget's series can be shown with what is open now. A series stays in
// the widget when it cannot, so that it comes back with the run or group that has it.
import { createContext } from "react";
import { kindsMatch, keyOf, topicKey, type Selected, type ValueKind } from "../types";
import type { FieldIndex, IndexedField } from "./fieldIndex";
import type { Widget, WorkspaceState } from "./widgetModel";
import { acceptsField, widgetSpecs } from "./widgetSpecs";

export type SeriesEnvironment = {
  /** Whether a run is open. Until then nothing can be said about any series. */
  runOpen: boolean;
  sources: { id: string; loading: boolean; error: string }[];
  index: FieldIndex;
};

/** A null problem means it is not known yet, which is not worth marking. */
export type SeriesState =
  | { usable: true; entry: IndexedField }
  | { usable: false; problem: string | null };

export const SeriesEnvironmentContext = createContext<SeriesEnvironment | null>(null);

function stateOf(series: Selected, type: Widget["type"], env: SeriesEnvironment): SeriesState {
  if (!env.runOpen) return { usable: false, problem: null };
  const source = env.sources.find((item) => item.id === series.source);
  if (!source) return { usable: false, problem: "Group is closed." };
  if (source.loading) return { usable: false, problem: null };
  if (source.error) return { usable: false, problem: "Group could not be loaded." };
  const topic = env.index.topics.get(topicKey(series.source, series.topic));
  // Ids mean nothing across runs: the same one may belong to another topic here.
  if (!topic || (series.topicName && series.topicName !== topic.topicName))
    return { usable: false, problem: "Topic not found in this run." };
  if (topic.error) return { usable: false, problem: "This topic cannot be read." };
  const entry = env.index.byKey.get(keyOf(series.source, series.topic, series.path));
  if (!entry) return { usable: false, problem: "Field not found in this run." };
  const spec = widgetSpecs[type];
  const shown = spec.viewKinds
    ? topic.views.some((view) => view.id === series.view)
    : acceptsField(spec, topic, series.path, entry.kind);
  if (!shown) return { usable: false, problem: `This widget cannot show ${entry.typeLabel}.` };
  return { usable: true, entry };
}

export function seriesStates(widget: Widget, env: SeriesEnvironment) {
  const states = new Map<string, SeriesState>();
  let kind: ValueKind | null | undefined;
  for (const series of widget.series) {
    let state = stateOf(series, widget.type, env);
    // Fields added while another run was open may not go with the ones that came back.
    if (state.usable && widgetSpecs[widget.type].sameKind) {
      if (kind === undefined) kind = state.entry.kind;
      else if (!kindsMatch(kind, state.entry.kind))
        state = { usable: false, problem: "Cannot be shown with the other series." };
    }
    states.set(series.key, state);
  }
  return states;
}

/** The current run's definition of a field: its type may differ from the run it was added in. */
function current(series: Selected, { entry }: { entry: IndexedField }): Selected {
  const { data_type: dataType, enum_values: enumValues } = entry.field;
  const topicName = entry.topic.topicName;
  return series.dataType === dataType &&
    series.topicName === topicName &&
    JSON.stringify(series.enumValues) === JSON.stringify(enumValues)
    ? series
    : { ...series, dataType, enumValues, topicName };
}

/** The workspace as views and data loading see it: only the series that can be shown. */
export function usableWorkspace(state: WorkspaceState, env: SeriesEnvironment): WorkspaceState {
  const widgets = Object.fromEntries(
    Object.values(state.widgets).map((widget) => {
      if (!widget.series.length) return [widget.id, widget];
      const states = seriesStates(widget, env);
      const series = widget.series.flatMap((item) => {
        const itemState = states.get(item.key)!;
        return itemState.usable ? [current(item, itemState)] : [];
      });
      const same =
        series.length === widget.series.length &&
        series.every((item, i) => item === widget.series[i]);
      return [widget.id, same ? widget : { ...widget, series }];
    }),
  );
  return { ...state, widgets };
}
