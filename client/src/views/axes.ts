import type { Series } from "./Plot";

export type AxisRange = [number, number];
/** Center and magnification relative to a fixed reference range. */
export type AxisView = { center: number; zoom: number };
export const defaultView = (): AxisView => ({ center: 0.5, zoom: 1 });
const maxZoom = 1e6;

function constrain(view: AxisView): AxisView {
  const zoom = Math.max(1, Math.min(maxZoom, view.zoom));
  return { zoom, center: view.center };
}

export const isDefaultView = (view: AxisView): boolean =>
  Math.abs(view.zoom - 1) < 1e-10 && Math.abs(view.center - 0.5) < 1e-10;

export function axisRange(base: AxisRange, view: AxisView): AxisRange {
  const span = base[1] - base[0];
  return [
    base[0] + (view.center - 0.5 / view.zoom) * span,
    base[0] + (view.center + 0.5 / view.zoom) * span,
  ];
}

/** Preserve the data coordinate under the pointer as magnification changes. */
export function zoomAxis(view: AxisView, factor: number, anchor: number): AxisView {
  const zoom = constrain({
    ...view,
    zoom: Number((view.zoom * factor).toFixed(12)),
  }).zoom;
  const point = view.center + (anchor - 0.5) / view.zoom;
  return constrain({ zoom, center: point - (anchor - 0.5) / zoom });
}

/** Pulls a view back inside the reference range, for views that have no way to pan back. */
export function clampAxis(view: AxisView): AxisView {
  const half = 0.5 / view.zoom;
  return { ...view, center: Math.max(half, Math.min(1 - half, view.center)) };
}

export function panAxis(view: AxisView, delta: number): AxisView {
  return constrain({ ...view, center: view.center + delta / view.zoom });
}

export function selectAxis(view: AxisView, start: number, end: number): AxisView {
  return constrain({
    center: view.center + ((start + end) / 2 - 0.5) / view.zoom,
    zoom: view.zoom / Math.max(1e-12, end - start),
  });
}

/** Use all loaded samples, independently of the visible time interval. */
export function seriesYRange(series: Series[]): AxisRange {
  let min = Infinity,
    max = -Infinity;
  for (const s of series) {
    if (s.hidden) continue;
    for (const point of s.points) {
      if (point.y !== null && Number.isFinite(point.y)) {
        min = Math.min(min, point.y);
        max = Math.max(max, point.y);
      }
    }
  }
  if (!Number.isFinite(min)) return [-1, 1];
  const pad = max === min ? Math.max(1, Math.abs(min) * 0.05) : (max - min) * 0.08;
  return [min - pad, max + pad];
}

/** Sorted, unique numeric states used as equally spaced Y-axis categories. */
export function discreteYValues(series: Series[]): number[] {
  return [
    ...new Set(
      series
        .filter((item) => !item.hidden)
        .flatMap((item) => item.points.flatMap((point) => (point.y === null ? [] : [point.y]))),
    ),
  ].sort((a, b) => a - b);
}
