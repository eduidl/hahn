import "./WidgetSettings.css";
import { FieldPicker } from "./FieldPicker";
import { statusLabel, name, SeriesList, SeriesRow, SeriesStyle } from "./SeriesList";
import { TabSettings } from "./TabControls";
import { useMemo, type Dispatch, type ReactNode } from "react";
import { SeriesName } from "../SeriesName";
import { type FieldIndex } from "./fieldIndex";
import { type CachedSeries } from "../data/useSeries";
import { tableColumns } from "../views/table";
import { defaultImageDistance } from "../views/camera";
import { fixedFrameOf, useFrames } from "../data/useViewData";
import {
  legendPositions,
  osmTiles,
  selectedViewKind,
  type LegendPosition,
  type Widget,
  type WorkspaceAction,
} from "./widgets";

export type WidgetSettingsProps = {
  widget: Widget;
  dispatch: Dispatch<WorkspaceAction>;
  records: Pick<CachedSeries, "key" | "status" | "received">[];
  pointCount: number;
  index: FieldIndex;
};

function SettingsHeader({ widget }: WidgetSettingsProps) {
  return <h2 className="settings-title">{widget.title}</h2>;
}

function NoSettings(props: WidgetSettingsProps) {
  return (
    <>
      <SettingsHeader {...props} />
      <div className="settings-section">
        <p className="muted">No settings</p>
      </div>
    </>
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

function PlotSettings(props: WidgetSettingsProps) {
  return (
    <>
      <SettingsHeader {...props} />
      <LegendSetting {...props} />
      <FieldPicker {...props} />
      <SeriesList
        {...props}
        row={(s) => (
          <SeriesRow
            key={s.key}
            {...props}
            series={s}
            marker={<i className="series-dot" style={{ background: s.color }} />}
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
      <FieldPicker {...props} />
      <SeriesList {...props} row={(s) => <SeriesRow key={s.key} {...props} series={s} />} />
    </>
  );
}

/** Values change over time as rows; the dot color tells the series apart. */
function ValueChangesSettings(props: WidgetSettingsProps) {
  return (
    <>
      <SettingsHeader {...props} />
      <FieldPicker {...props} />
      <SeriesList
        {...props}
        row={(s) => (
          <SeriesRow
            key={s.key}
            {...props}
            series={s}
            marker={<i className="series-dot" style={{ background: s.color }} />}
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
              className="small-button"
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
              className="small-button"
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
          marker={<i className="series-dot" style={{ background: s.color }} />}
        >
          {props.widget.type === "scene" && selectedViewKind(props.index, s) === "image" && (
            <label className="series-style">
              Image distance (m)
              <input
                className="text-input"
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
                className="text-input"
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
      <section className="target-setting" aria-label="Image topic">
        <div className="legend-heading">Image topic</div>
        {image ? (
          <div className="target-summary removable">
            <SeriesName
              source={image.source}
              topic={image.topicName ?? image.topic}
              path={image.path}
              inline
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
            marker={<i className="series-dot" style={{ background: series.color }} />}
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
          className="text-input search"
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
  "tf-tree": NoSettings,
  "source-info": NoSettings,
  tabs: (props) =>
    props.widget.type === "tabs" ? (
      <>
        <SettingsHeader {...props} />
        <TabSettings widget={props.widget} dispatch={props.dispatch} />
      </>
    ) : null,
  plot: PlotSettings,
  state: StateSettings,
  raw: SingleTargetSettings,
  "value-changes": ValueChangesSettings,
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
