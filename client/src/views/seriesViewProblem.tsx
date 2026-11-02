// Problems a view finds with one series while still showing the rest of what it can.
// They appear in the sidebar instead of staying over the view.
import { createContext, useContext, useEffect, useId, useSyncExternalStore } from "react";
import type { Selected } from "../types";

/** The widget whose view is being drawn. */
export const ViewWidget = createContext({ id: "", title: "" });

export type SeriesViewProblem = {
  widgetId: string;
  widgetTitle: string;
  series: Selected;
  problem: string;
};

const reports = new Map<string, Map<string, SeriesViewProblem>>();
const listeners = new Set<() => void>();
let snapshot: SeriesViewProblem[] = [];
const slot = (widgetId: string, seriesKey: string) => JSON.stringify([widgetId, seriesKey]);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function publish() {
  // Several parts of a view can report the same series; one line for each is enough.
  snapshot = [...reports.values()].map((parts) => [...parts.values()][0]);
  for (const listener of listeners) listener();
}

function report(id: string, reporter: string, value: SeriesViewProblem | null) {
  const parts = reports.get(id) ?? new Map<string, SeriesViewProblem>();
  if (value) {
    parts.set(reporter, value);
    reports.set(id, parts);
  } else {
    parts.delete(reporter);
    if (!parts.size) reports.delete(id);
  }
  publish();
}

export const useSeriesViewProblems = () => useSyncExternalStore(subscribe, () => snapshot);

/** One problem of a series in a widget's view, if any. */
export function useSeriesViewProblem(widgetId: string, seriesKey: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => reports.get(slot(widgetId, seriesKey))?.values().next().value?.problem ?? null,
  );
}

/** Reports a problem of a series to the sidebar, for as long as it lasts. */
export function ReportSeriesProblem({ series, problem }: { series: Selected; problem: string }) {
  const { id: widgetId, title: widgetTitle } = useContext(ViewWidget);
  const reporter = useId();
  const id = slot(widgetId, series.key);
  const topicName = series.topicName ?? series.topic;
  useEffect(() => {
    if (!problem) return;
    report(id, reporter, { widgetId, widgetTitle, series, problem });
    return () => report(id, reporter, null);
    // `series` is rebuilt on every render; what is listed from it follows its name.
  }, [id, reporter, widgetId, widgetTitle, topicName, problem]);
  return null;
}
