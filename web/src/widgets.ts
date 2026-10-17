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
