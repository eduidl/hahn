// The list of a widget's series and the controls of each.
import { FieldPicker } from "./FieldPicker";
import { type WidgetSettingsProps } from "./WidgetSettings";
import { useContext, type ReactNode } from "react";
import { SeriesEnvironmentContext, seriesStates } from "./seriesState";
import { SeriesName } from "../SeriesName";
import { useSeriesViewProblem } from "../views/seriesViewProblem";
import { type CachedSeries } from "../data/useSeries";
import { type PointMarkers, type Selected } from "../types";

export function statusLabel(record: Pick<CachedSeries, "status" | "received"> | undefined) {
  if (!record) return "Waiting";
  if (record.status === "loading") return `Loading · ${record.received.toLocaleString()}`;
  if (record.status === "complete")
    return `Complete · ${record.received.toLocaleString()} messages`;
  return "Loading error";
}

export const name = (s: Selected) => `${s.topicName ?? s.topic} ${s.path.join(".")}`;

/**
 * One titled area of the settings, set apart from its neighbours by a line. A
 * collapsible one starts closed and folds away under its title.
 */
export function SettingsSection({
  title,
  aside,
  collapsible = false,
  children,
}: {
  title: string;
  aside?: ReactNode;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const heading = (
    <>
      <h3>{title}</h3>
      {aside && <span>{aside}</span>}
    </>
  );
  return (
    <section className="settings-section" aria-label={title}>
      {collapsible ? (
        <details className="settings-collapse">
          <summary className="settings-section-heading">{heading}</summary>
          <div className="settings-collapse-body">{children}</div>
        </details>
      ) : (
        <>
          <div className="settings-section-heading">{heading}</div>
          {children}
        </>
      )}
    </section>
  );
}

/** Series section shared by all settings; each widget type supplies the per-series row. */
export function SeriesList({
  row,
  ...props
}: WidgetSettingsProps & { row: (series: Selected) => ReactNode }) {
  const { series } = props.widget;
  return (
    <SettingsSection title="Series" aside={`${series.length} series`}>
      <FieldPicker {...props} />
      {series.length > 0 && <div>{series.map(row)}</div>}
    </SettingsSection>
  );
}

export function SeriesRow({
  widget,
  dispatch,
  records,
  series: s,
  marker,
  children,
  showStatus = true,
}: WidgetSettingsProps & {
  series: Selected;
  marker?: ReactNode;
  children?: ReactNode;
  /** Off for widgets that do not stream series, so there is no loading state. */
  showStatus?: boolean;
}) {
  const update = (change: (series: Selected[]) => Selected[]) =>
    dispatch({ type: "series", id: widget.id, update: change });
  const environment = useContext(SeriesEnvironmentContext);
  const state = environment && seriesStates(widget, environment).get(s.key);
  const viewProblem = useSeriesViewProblem(widget.id, s.key);
  const problem = (state && !state.usable ? state.problem : null) ?? viewProblem;
  return (
    <div className="legend-row">
      <button
        className={`series-toggle ${s.hidden ? "dim" : ""}`}
        aria-label={`Toggle visibility for ${name(s)}`}
        aria-pressed={!s.hidden}
        onClick={() =>
          update((list) => list.map((f) => (f.key === s.key ? { ...f, hidden: !f.hidden } : f)))
        }
      >
        {marker}
        <SeriesName source={s.source} topic={s.topicName ?? s.topic} path={s.path} />
      </button>
      {children}
      {problem ? (
        <span className="series-status series-problem">
          <span aria-hidden="true">⚠ </span>
          {problem}
        </span>
      ) : (
        showStatus && (
          <span className="series-status">{statusLabel(records.find((r) => r.key === s.key))}</span>
        )
      )}
      <button
        className="remove"
        aria-label={`Remove ${name(s)}`}
        onClick={() => update((list) => list.filter((f) => f.key !== s.key))}
      >
        ×
      </button>
    </div>
  );
}

export function SeriesStyle({
  widget,
  dispatch,
  series: s,
}: WidgetSettingsProps & { series: Selected }) {
  const restyle = (change: Partial<Selected>) =>
    dispatch({
      type: "series",
      id: widget.id,
      update: (list) => list.map((f) => (f.key === s.key ? { ...f, ...change } : f)),
    });
  return (
    <div className="series-style">
      <label>
        Color
        <input
          type="color"
          aria-label={`${name(s)} color`}
          value={s.color}
          onChange={(e) => restyle({ color: e.target.value })}
        />
      </label>
      <label>
        Line width
        <input
          className="text-input"
          type="number"
          step="any"
          aria-label={`${name(s)} line width`}
          defaultValue={s.lineWidth}
          onChange={(e) => {
            const width = e.target.valueAsNumber;
            if (Number.isFinite(width) && width > 0) restyle({ lineWidth: width });
          }}
          onBlur={(e) => {
            e.currentTarget.value = String(s.lineWidth);
          }}
        />
        <span>px</span>
      </label>
      <label>
        Points
        <select
          aria-label={`${name(s)} points`}
          value={s.pointMarkers ?? "auto"}
          onChange={(e) =>
            restyle({
              pointMarkers:
                e.target.value === "auto" ? undefined : (e.target.value as PointMarkers),
            })
          }
        >
          <option value="auto">Auto</option>
          <option value="show">Show</option>
          <option value="hide">Hide</option>
        </select>
      </label>
    </div>
  );
}
