import { TabSettings } from "./TabControls";
import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type ReactNode } from "react";
import { addableFields } from "./drop";
import { SeriesName } from "../SeriesName";
import type { FieldIndex, IndexedField } from "./fieldIndex";
import type { CachedSeries } from "../data/useSeries";
import type { Selected } from "../types";
import { tableColumns } from "../views/table";
import { defaultImageDistance } from "../views/camera";
import { fixedFrameOf, useFrames } from "../data/useViewData";
import {
  addFieldAction,
  legendPositions,
  osmTiles,
  selectedViewKind,
  viewFor,
  widgetSpecs,
  type LegendPosition,
  type Widget,
  type WorkspaceAction,
} from "./widgets";

type WidgetSettingsProps = {
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

function SettingsHeader({ widget }: WidgetSettingsProps) {
  return (
    <>
      <div className="field-heading">
        <span className="eyebrow">{widget.title}</span>
        {widget.type !== "image" && widgetSpecs[widget.type].maxSeries !== 1 && (
          <span>{widget.series.length} series</span>
        )}
      </div>
      <p className="help">{widgetSpecs[widget.type].help}</p>
    </>
  );
}

/** A button opening a searchable list of the fields this widget can take now; picking one closes it. */
function FieldPicker({
  widget,
  dispatch,
  index,
  kind,
}: WidgetSettingsProps & { kind?: "image" | "pointcloud" }) {
  const singleTarget = widgetSpecs[widget.type].maxSeries === 1 || kind === "image";
  const label =
    kind === "image"
      ? "Select image topic"
      : kind === "pointcloud"
        ? "Add topic"
        : singleTarget
          ? "Select target"
          : "Add field";
  const pickerId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
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
  const shown = matches.slice(0, pickerLimit);
  // Candidates can shrink while the list is open, so never point past the end.
  const activeIndex = Math.min(active, shown.length - 1);
  useEffect(() => {
    results.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);
  useEffect(() => {
    // The popover focuses its `autofocus` descendant when shown; React's
    // autoFocus prop only focuses on mount and emits no attribute.
    input.current?.setAttribute("autofocus", "");
    // React's onToggle does not cover popovers, so listen to the native event.
    const node = popover.current;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== "closed") return;
      setQuery("");
      setActive(0);
    };
    node?.addEventListener("toggle", onToggle);
    return () => node?.removeEventListener("toggle", onToggle);
  }, []);
  const pick = (entry: IndexedField) => {
    dispatch(addFieldAction(widget, entry.topic, entry.field, index));
    popover.current?.hidePopover();
  };
  return (
    <>
      <button
        className="add-field"
        aria-label={label}
        popoverTarget={pickerId}
        disabled={!candidates.length}
      >
        {singleTarget ? label : label === "Add topic" ? "+ Topic" : "+ Field"}
      </button>
      <div
        id={pickerId}
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
          role="combobox"
          aria-expanded="true"
          aria-controls={`${pickerId}-results`}
          aria-activedescendant={shown.length ? `${pickerId}-${activeIndex}` : undefined}
          aria-label={
            singleTarget ? "Search for a topic or field to select" : "Search for a field to add"
          }
          placeholder={`Search ${candidates.length.toLocaleString()} ${singleTarget ? "topics and fields" : "fields"}…`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((activeIndex + step + shown.length) % shown.length);
              return;
            }
            // A search input's native Escape only clears the text; close instead.
            if (event.key === "Escape") {
              event.preventDefault();
              popover.current?.hidePopover();
              return;
            }
            if (event.key !== "Enter" || !shown.length) return;
            // Closing returns focus to the opener; without this the same
            // Enter would press it and reopen the list.
            event.preventDefault();
            pick(shown[activeIndex]);
          }}
        />
        <div
          ref={results}
          id={`${pickerId}-results`}
          className="field-picker-results"
          role="listbox"
          aria-label={label}
        >
          {shown.map((entry, i) => (
            <button
              key={entry.key}
              id={`${pickerId}-${i}`}
              className="field-option"
              role="option"
              aria-selected={i === activeIndex}
              // Focus stays in the search box; the arrow keys move the selection.
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(entry)}
            >
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
          {!matches.length && <p className="muted">No matching fields</p>}
        </div>
      </div>
    </>
  );
}

function TimeDisplaySetting({ widget, dispatch }: WidgetSettingsProps) {
  const label =
    widget.type === "image" || widgetSpecs[widget.type].maxSeries === 1
      ? "Time display"
      : "X-axis time display";
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
        <option value="relative">Seconds from run start</option>
      </select>
    </label>
  );
}

/** Series list shared by all settings; each widget type supplies the per-series row. */
function SeriesList({
  widget,
  pointCount,
  row,
  showPoints = true,
}: WidgetSettingsProps & { row: (series: Selected) => ReactNode; showPoints?: boolean }) {
  return (
    <section className="legend" aria-label="Selected series">
      <div className="legend-heading">
        <span className="eyebrow">Series</span>
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
}: WidgetSettingsProps & {
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

function SeriesStyle({ widget, dispatch, series: s }: WidgetSettingsProps & { series: Selected }) {
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

function LegendSetting({ widget, dispatch }: WidgetSettingsProps) {
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

function TimeSeriesSettings(props: WidgetSettingsProps) {
  return (
    <>
      <SettingsHeader {...props} />
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
function StateSettings(props: WidgetSettingsProps) {
  return (
    <>
      <SettingsHeader {...props} />
      <TimeDisplaySetting {...props} />
      <FieldPicker {...props} />
      <SeriesList {...props} row={(s) => <SeriesRow key={s.key} {...props} series={s} />} />
    </>
  );
}

/** Values change over time as rows; the dot color tells the series apart. */
function LogSettings(props: WidgetSettingsProps) {
  return (
    <>
      <SettingsHeader {...props} />
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
function SingleTargetSettings(props: WidgetSettingsProps) {
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
      <SettingsHeader {...props} />
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
function ViewSeriesList(props: WidgetSettingsProps) {
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
        >
          {props.widget.type === "scene" && selectedViewKind(props.index, s) === "image" && (
            <label className="series-style">
              Image distance (m)
              <input
                type="number"
                min="0"
                step="any"
                aria-label={`Image distance for ${name(s)}`}
                defaultValue={s.imageDistance ?? defaultImageDistance}
                onChange={(event) => {
                  const distance = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(distance) && distance > 0)
                    props.dispatch({
                      type: "series",
                      id: props.widget.id,
                      update: (list) =>
                        list.map((item) =>
                          item.key === s.key ? { ...item, imageDistance: distance } : item,
                        ),
                    });
                }}
                onBlur={(event) => {
                  event.currentTarget.value = String(s.imageDistance ?? defaultImageDistance);
                }}
              />
            </label>
          )}
          {props.widget.type === "scene" && selectedViewKind(props.index, s) === "pose" && (
            <label className="series-style">
              Trail duration (s)
              <input
                type="number"
                min="0"
                step="any"
                placeholder="All"
                aria-label={`Trail duration for ${name(s)}`}
                defaultValue={s.trailDuration ?? ""}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const duration = input.value === "" ? undefined : input.valueAsNumber;
                  if (duration === undefined || (Number.isFinite(duration) && duration > 0))
                    props.dispatch({
                      type: "series",
                      id: props.widget.id,
                      update: (list) =>
                        list.map((item) =>
                          item.key === s.key ? { ...item, trailDuration: duration } : item,
                        ),
                    });
                }}
                onBlur={(event) => {
                  event.currentTarget.value =
                    s.trailDuration === undefined ? "" : String(s.trailDuration);
                }}
              />
            </label>
          )}
        </SeriesRow>
      )}
    />
  );
}

function ImageSettings(props: WidgetSettingsProps) {
  const { widget, index, dispatch } = props;
  const image = widget.series.find((item) => selectedViewKind(index, item) === "image");
  const additional = widget.series.filter((item) => selectedViewKind(index, item) !== "image");
  return (
    <>
      <SettingsHeader {...props} />
      <TimeDisplaySetting {...props} />
      <section className="target-setting" aria-label="Image topic">
        <div className="legend-heading">Image topic</div>
        {image ? (
          <div className="target-summary">
            <SeriesName
              source={image.source}
              topic={image.topicName ?? image.topic}
              path={image.path}
            />
            <button
              className="remove"
              aria-label="Remove image topic"
              onClick={() => dispatch({ type: "series", id: widget.id, update: () => [] })}
            >
              ×
            </button>
          </div>
        ) : (
          <p className="muted">Not selected</p>
        )}
        <FieldPicker {...props} kind="image" />
      </section>
      <section className="legend" aria-label="Additional topics">
        <div className="legend-heading">Additional topics</div>
        {!image && <p className="muted">Select an image topic first.</p>}
        {additional.map((series) => (
          <SeriesRow
            key={series.key}
            {...props}
            series={series}
            showStatus={false}
            marker={<i style={{ background: series.color }} />}
          />
        ))}
        <FieldPicker {...props} kind="pointcloud" />
      </section>
    </>
  );
}

function SceneSettings(props: WidgetSettingsProps) {
  const { widget, dispatch } = props;
  const { frames, error } = useFrames(widget.series.map((s) => s.source));
  const fixed = fixedFrameOf(widget.fixedFrame, frames);
  return (
    <>
      <SettingsHeader {...props} />
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

function MapSettings(props: WidgetSettingsProps) {
  const { widget, dispatch } = props;
  const setTiles = (value: string) => dispatch({ type: "tile-url", id: widget.id, value });
  return (
    <>
      <SettingsHeader {...props} />
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

const settingsByType: Record<Widget["type"], (props: WidgetSettingsProps) => ReactNode> = {
  "tf-tree": () => <p className="help">Drag to pan and use the mouse wheel to zoom.</p>,
  "source-info": () => (
    <p className="help">Shows the open groups. There is nothing to configure.</p>
  ),
  tabs: (props) =>
    props.widget.type === "tabs" ? (
      <TabSettings widget={props.widget} dispatch={props.dispatch} />
    ) : null,
  "time-series": TimeSeriesSettings,
  state: StateSettings,
  raw: SingleTargetSettings,
  log: LogSettings,
  table: SingleTargetSettings,
  image: ImageSettings,
  scene: SceneSettings,
  map: MapSettings,
};

/** Settings for the selected widget, chosen wholesale by widget type. */
export function WidgetSettings(props: WidgetSettingsProps) {
  const Settings = settingsByType[props.widget.type];
  // Keyed by widget so uncontrolled inputs do not carry over between widgets.
  return <Settings key={props.widget.id} {...props} />;
}
