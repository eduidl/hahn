import { TabSettings } from "./TabControls";
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode } from "react";
import { addableFields } from "./drop";
import { SeriesName } from "../SeriesName";
import type { FieldIndex, IndexedField } from "./fieldIndex";
import type { CachedSeries } from "../data/useSeries";
import type { Selected } from "../types";
import { tableColumns } from "../views/table";
import { fixedFrameOf, useFrames } from "../data/useViewData";
import {
  addFieldAction,
  legendPositions,
  osmTiles,
  widgetSpecs,
  type LegendPosition,
  type Widget,
  type WorkspaceAction,
} from "./widgets";

type PanelProps = {
  widget: Widget;
  dispatch: Dispatch<WorkspaceAction>;
  records: Pick<CachedSeries, "key" | "status" | "received">[];
  pointCount: number;
  index: FieldIndex;
};
/** Rows rendered at once; the search narrows the rest. */
const pickerLimit = 100;

function statusLabel(record: Pick<CachedSeries, "status" | "received"> | undefined) {
  if (!record) return "Waiting";
  if (record.status === "loading") return `Loading · ${record.received.toLocaleString()}`;
  if (record.status === "complete")
    return `Complete · ${record.received.toLocaleString()} messages`;
  if (record.status === "stopped") return "Stopped · partial data";
  return "Loading error";
}

const name = (s: Selected) => `${s.topicName ?? s.topic} ${s.path.join(".")}`;

function PanelHeader({ widget }: PanelProps) {
  return (
    <>
      <div className="field-heading">
        <span className="eyebrow">{widget.title}</span>
        {widgetSpecs[widget.type].maxSeries !== 1 && <span>{widget.series.length} series</span>}
      </div>
      <p className="help">{widgetSpecs[widget.type].help}</p>
    </>
  );
}

/** A button opening a searchable list of the fields this widget can take now; picking one closes it. */
function FieldPicker({ widget, dispatch, index }: PanelProps) {
  const singleTarget = widgetSpecs[widget.type].maxSeries === 1;
  const label = singleTarget ? "Select target" : "Add field";
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const candidates = useMemo(
    () =>
      addableFields(index, widget).filter(
        (entry) => !kind || viewFor(widgetSpecs[widget.type], entry.topic)?.kind === kind,
      ),
    [index, widget, kind],
  );
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? candidates.filter((entry) => entry.label.toLowerCase().includes(needle))
    : candidates;
  useEffect(() => {
    // The popover focuses its `autofocus` descendant when shown; React's
    // autoFocus prop only focuses on mount and emits no attribute.
    input.current?.setAttribute("autofocus", "");
    // React's onToggle does not cover popovers, so listen to the native event.
    const node = popover.current;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed") setQuery("");
    };
    node?.addEventListener("toggle", onToggle);
    return () => node?.removeEventListener("toggle", onToggle);
  }, []);
  const pick = (entry: IndexedField) => {
    dispatch(addFieldAction(widget, entry.topic, entry.field));
    popover.current?.hidePopover();
  };
  return (
    <>
      <button className="add-field" popoverTarget="field-picker" disabled={!candidates.length}>
        {singleTarget ? label : `+ ${label}`}
      </button>
      <div
        id="field-picker"
        ref={popover}
        className="field-picker"
        popover="auto"
        role="dialog"
        aria-label={label}
      >
        <input
          ref={input}
          className="search"
          type="search"
          aria-label={
            singleTarget ? "Search for a topic or field to select" : "Search for a field to add"
          }
          placeholder={`Search ${singleTarget ? "topics and fields" : "fields"} (${candidates.length.toLocaleString()})`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // A search input's native Escape only clears the text; close instead.
            if (event.key === "Escape") {
              event.preventDefault();
              popover.current?.hidePopover();
              return;
            }
            if (event.key !== "Enter" || !matches.length) return;
            // Closing returns focus to the opener; without this the same
            // Enter would press it and reopen the list.
            event.preventDefault();
            pick(matches[0]);
          }}
        />
        <div className="field-picker-results">
          {matches.slice(0, pickerLimit).map((entry) => (
            <button key={entry.key} className="field-option" onClick={() => pick(entry)}>
              <SeriesName
                source={entry.topic.source}
                topic={entry.topic.topicName ?? entry.topic.topic}
                path={entry.field.path}
                type={entry.typeLabel}
              />
            </button>
          ))}
          {matches.length > pickerLimit && (
            <p className="muted">
              {(matches.length - pickerLimit).toLocaleString()} more. Refine your search.
            </p>
          )}
          {!matches.length && <p className="muted">No matching fields.</p>}
        </div>
      </div>
    </>
  );
}

function TimeDisplaySetting({ widget, dispatch }: PanelProps) {
  const label = widgetSpecs[widget.type].maxSeries === 1 ? "Time display" : "X-axis time display";
  return (
    <label className="time-display-setting">
      {label}
      <select
        aria-label={label}
        value={widget.timeDisplay}
        onChange={(event) =>
          dispatch({
            type: "time-display",
            id: widget.id,
            value: event.target.value === "relative" ? "relative" : "absolute",
          })
        }
      >
        <option value="absolute">Absolute time</option>
        <option value="relative">Seconds from recording start</option>
      </select>
    </label>
  );
}

/** Series list shared by all panels; each panel supplies the per-series row. */
function SeriesList({
  widget,
  pointCount,
  row,
  showPoints = true,
}: PanelProps & { row: (series: Selected) => ReactNode; showPoints?: boolean }) {
  return (
    <section className="legend" aria-label="Selected series">
      <div className="legend-heading">
        <span className="eyebrow">SERIES</span>
        <span>
          {widget.series.length} series
          {showPoints && ` · ${pointCount.toLocaleString()} points`}
        </span>
      </div>
      {widget.series.map(row)}
      {!widget.series.length && (
        <p className="legend-empty">Selected series and loading status appear here.</p>
      )}
    </section>
  );
}

function SeriesRow({
  widget,
  dispatch,
  records,
  series: s,
  marker,
  children,
  showStatus = true,
}: PanelProps & {
  series: Selected;
  marker?: ReactNode;
  children?: ReactNode;
  /** Off for widgets that do not stream series, so there is no loading state. */
  showStatus?: boolean;
}) {
  const update = (change: (series: Selected[]) => Selected[]) =>
    dispatch({ type: "series", id: widget.id, update: change });
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
      {showStatus && (
        <span className="series-status">{statusLabel(records.find((r) => r.key === s.key))}</span>
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

function SeriesStyle({ widget, dispatch, series: s }: PanelProps & { series: Selected }) {
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
    </div>
  );
}

function LegendSetting({ widget, dispatch }: PanelProps) {
  const set = (value: Partial<Widget["legend"]>) =>
    dispatch({ type: "legend", id: widget.id, value });
  return (
    <fieldset className="legend-setting">
      <legend>Legend</legend>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={widget.legend.visible}
          onChange={(event) => set({ visible: event.target.checked })}
        />
        Show
      </label>
      <select
        aria-label="Legend position"
        value={widget.legend.position}
        disabled={!widget.legend.visible}
        onChange={(event) => set({ position: event.target.value as LegendPosition })}
      >
        {Object.entries(legendPositions).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

function TimeSeriesPanel(props: PanelProps) {
  return (
    <>
      <PanelHeader {...props} />
      <TimeDisplaySetting {...props} />
      <LegendSetting {...props} />
      <FieldPicker {...props} />
      <SeriesList
        {...props}
        row={(s) => (
          <SeriesRow
            key={s.key}
            {...props}
            series={s}
            marker={<i style={{ background: s.color }} />}
          >
            <SeriesStyle {...props} series={s} />
          </SeriesRow>
        )}
      />
    </>
  );
}

/** State rows are colored per value, so series color and width do not apply. */
function StatePanel(props: PanelProps) {
  return (
    <>
      <PanelHeader {...props} />
      <TimeDisplaySetting {...props} />
      <FieldPicker {...props} />
      <SeriesList {...props} row={(s) => <SeriesRow key={s.key} {...props} series={s} />} />
    </>
  );
}

/** Values change over time as rows; the dot color tells the series apart. */
function LogPanel(props: PanelProps) {
  return (
    <>
      <PanelHeader {...props} />
      <TimeDisplaySetting {...props} />
      <FieldPicker {...props} />
      <SeriesList
        {...props}
        row={(s) => (
          <SeriesRow
            key={s.key}
            {...props}
            series={s}
            marker={<i style={{ background: s.color }} />}
          />
        )}
      />
    </>
  );
}

/** A single display target is specified, rather than managed as a series list. */
function SingleTargetPanel(props: PanelProps) {
  const target = props.widget.series[0];
  const columns = useMemo(
    () => (props.widget.type === "table" && target ? tableColumns(props.index, target) : []),
    [props.index, props.widget.type, target?.key],
  );
  const visibleColumns = columns.filter(
    (column) => !props.widget.hiddenColumns.includes(JSON.stringify(column.path)),
  ).length;
  return (
    <>
      <PanelHeader {...props} />
      <TimeDisplaySetting {...props} />
      <section className="target-setting" aria-label="Target">
        <div className="legend-heading">Target</div>
        {target ? (
          <div className="target-summary">
            <SeriesName
              source={target.source}
              topic={target.topicName ?? target.topic}
              path={target.path}
            />
            {props.widget.type === "table" && (
              <span className="series-status">
                {statusLabel(props.records.find((record) => record.key === target.key))}
              </span>
            )}
          </div>
        ) : (
          <p className="muted">Not selected</p>
        )}
        <FieldPicker {...props} />
      </section>
      {props.widget.type === "table" && target && (
        <section className="target-setting" aria-label="Column visibility">
          <div className="legend-heading">Columns</div>
          <div className="table-column-actions" role="group" aria-label="Bulk column controls">
            <button
              disabled={visibleColumns === columns.length}
              onClick={() =>
                props.dispatch({
                  type: "table-columns",
                  id: props.widget.id,
                  paths: columns.map((column) => column.path),
                  visible: true,
                })
              }
            >
              Show all
            </button>
            <button
              disabled={visibleColumns === 0}
              onClick={() =>
                props.dispatch({
                  type: "table-columns",
                  id: props.widget.id,
                  paths: columns.map((column) => column.path),
                  visible: false,
                })
              }
            >
              Hide all
            </button>
          </div>
          <div className="table-column-options">
            {columns.map((column) => {
              const key = JSON.stringify(column.path);
              return (
                <label className="table-column-option" key={key}>
                  <input
                    type="checkbox"
                    checked={!props.widget.hiddenColumns.includes(key)}
                    onChange={(event) =>
                      props.dispatch({
                        type: "table-column",
                        id: props.widget.id,
                        path: column.path,
                        visible: event.target.checked,
                      })
                    }
                  />
                  <span>{column.label}</span>
                </label>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

/** Series of a view have nothing to load in advance, and take no line width. */
function ViewSeriesList(props: PanelProps) {
  return (
    <SeriesList
      {...props}
      showPoints={false}
      row={(s) => (
        <SeriesRow
          key={s.key}
          {...props}
          series={s}
          showStatus={false}
          marker={<i style={{ background: s.color }} />}
        />
      )}
    />
  );
}

function ScenePanel(props: PanelProps) {
  const { widget, dispatch } = props;
  const { frames, error } = useFrames(widget.series.map((s) => s.source));
  const fixed = fixedFrameOf(widget.fixedFrame, frames);
  return (
    <>
      <PanelHeader {...props} />
      <label className="time-display-setting">
        Fixed frame
        <select
          aria-label="Fixed frame"
          value={fixed ?? ""}
          disabled={!frames.length}
          onChange={(event) =>
            dispatch({ type: "fixed-frame", id: widget.id, value: event.target.value })
          }
        >
          {!frames.length && <option value="">{error || "No coordinate frames"}</option>}
          {frames.map((frame) => (
            <option key={frame.id} value={frame.id}>
              {frame.id}
            </option>
          ))}
        </select>
      </label>
      <FieldPicker {...props} />
      <ViewSeriesList {...props} />
    </>
  );
}

function MapPanel(props: PanelProps) {
  const { widget, dispatch } = props;
  const setTiles = (value: string) => dispatch({ type: "tile-url", id: widget.id, value });
  return (
    <>
      <PanelHeader {...props} />
      <section className="target-setting" aria-label="Map tiles">
        <div className="legend-heading">Map tiles</div>
        <input
          className="search"
          type="url"
          aria-label="Map tile URL"
          placeholder="https://…/{z}/{x}/{y}.png"
          value={widget.tileUrl}
          onChange={(event) => setTiles(event.target.value.trim())}
        />
        <p className="help">
          The visible area is sent to the tile provider. Select None to disable tiles.
        </p>
        <div className="table-column-actions">
          <button disabled={widget.tileUrl === osmTiles} onClick={() => setTiles(osmTiles)}>
            Use OpenStreetMap
          </button>
          <button disabled={!widget.tileUrl} onClick={() => setTiles("")}>
            None
          </button>
        </div>
      </section>
      <FieldPicker {...props} />
      <ViewSeriesList {...props} />
    </>
  );
}

const panels: Record<Widget["type"], (props: PanelProps) => ReactNode> = {
  "tf-tree": () => <p className="help">Drag to pan and use the mouse wheel to zoom.</p>,
  tabs: (props) =>
    props.widget.type === "tabs" ? (
      <TabSettings widget={props.widget} dispatch={props.dispatch} />
    ) : null,
  "time-series": TimeSeriesPanel,
  state: StatePanel,
  raw: SingleTargetPanel,
  log: LogPanel,
  table: SingleTargetPanel,
  image: SingleTargetPanel,
  scene: ScenePanel,
  map: MapPanel,
};

/** Settings for the selected widget, chosen wholesale by widget type. */
export function PanelSettings(props: PanelProps) {
  const Panel = panels[props.widget.type];
  // Keyed by widget so uncontrolled inputs do not carry over between widgets.
  return <Panel key={props.widget.id} {...props} />;
}
