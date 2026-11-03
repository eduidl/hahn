import "./WidgetSettings.css";
import { FieldPicker } from "./FieldPicker";
import {
  statusLabel,
  name,
  SeriesList,
  SeriesRow,
  SeriesStyle,
  SettingsSection,
} from "./SeriesList";
import { TabSettings } from "./TabControls";
import { useMemo, type Dispatch, type ReactNode } from "react";
import { SeriesName } from "../SeriesName";
import type { FieldIndex } from "./fieldIndex";
import type { CachedSeries } from "../data/useSeries";
import { tableColumns } from "../views/table";
import { defaultImageDistance } from "../views/camera";
import { fixedFrameOf, useFrames } from "../data/useViewData";
import {
  legendPositions,
  osmTiles,
  selectedViewKind,
  type FrameAxesSettings,
  type PlacementSettings,
  type LegendPosition,
  type Widget,
  type WorkspaceAction,
} from "./widgets";

export type WidgetSettingsProps = {
  widget: Widget;
  dispatch: Dispatch<WorkspaceAction>;
  records: Pick<CachedSeries, "key" | "status" | "received">[];
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
      <SettingsSection title="Display">
        <LegendSetting {...props} />
      </SettingsSection>
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
      <SeriesList {...props} row={(s) => <SeriesRow key={s.key} {...props} series={s} />} />
    </>
  );
}

/** Values change over time as rows; the dot color tells the series apart. */
function ValueChangesSettings(props: WidgetSettingsProps) {
  return (
    <>
      <SettingsHeader {...props} />
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
      <SettingsSection title="Target">
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
      </SettingsSection>
      {props.widget.type === "table" && target && (
        <SettingsSection title="Columns">
          <fieldset className="table-column-actions" aria-label="Bulk column controls">
            <button
              type="button"
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
              type="button"
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
          </fieldset>
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
        </SettingsSection>
      )}
    </>
  );
}

/** Series of a view have nothing to load in advance, and take no line width. */
function ViewSeriesList(props: WidgetSettingsProps) {
  return (
    <SeriesList
      {...props}
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
          {props.widget.type === "scene" &&
            ["pose", "position"].includes(selectedViewKind(props.index, s) ?? "") && (
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
      <SettingsSection title="Image topic">
        {image ? (
          <div className="target-summary removable">
            <SeriesName
              source={image.source}
              topic={image.topicName ?? image.topic}
              path={image.path}
              inline
            />
            <button
              type="button"
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
      </SettingsSection>
      <SettingsSection title="Additional topics">
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
      </SettingsSection>
    </>
  );
}

function SceneSettings(props: WidgetSettingsProps) {
  const { widget, dispatch } = props;
  const { frames, error } = useFrames(widget.series.map((s) => s.source));
  const followed = fixedFrameOf(widget.followFrame, frames);
  return (
    <>
      <SettingsHeader {...props} />
      <SettingsSection title="Display">
        <label className="time-display-setting">
          Frame
          <select
            aria-label="Frame"
            title="The camera follows this frame's position. The root keeps it still."
            value={followed ?? ""}
            disabled={!frames.length}
            onChange={(event) =>
              dispatch({ type: "follow-frame", id: widget.id, value: event.target.value })
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
      </SettingsSection>
      <PlacementSection {...props} />
      <FrameAxesSection {...props} frames={frames.map((frame) => frame.id)} />
      <ViewSeriesList {...props} />
    </>
  );
}

/** Which time places values in space, and whether transforms blend between samples. */
function PlacementSection({ widget, dispatch }: WidgetSettingsProps) {
  const settings = widget.placement;
  const set = (value: Partial<PlacementSettings>) =>
    dispatch({ type: "placement", id: widget.id, value });
  return (
    <SettingsSection title="Placement">
      <label className="time-display-setting">
        Align by
        <select
          aria-label="Align by"
          title="The time whose transforms place each value. Values without a measurement time use their log time."
          value={settings.alignment}
          onChange={(event) =>
            set({ alignment: event.target.value as PlacementSettings["alignment"] })
          }
        >
          <option value="stamp">Measurement time</option>
          <option value="time">Log time</option>
        </select>
      </label>
      <label className="settings-checkbox">
        <input
          type="checkbox"
          checked={settings.interpolate}
          onChange={(event) => set({ interpolate: event.target.checked })}
        />
        Interpolate transforms
      </label>
    </SettingsSection>
  );
}

/** A number input that applies only positive values and shows the applied one on blur. */
function PositiveNumber({
  label,
  value,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  step: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="series-style">
      {label}
      <input
        className="text-input"
        type="number"
        min="0"
        step={step}
        disabled={disabled}
        defaultValue={value}
        onChange={(event) => {
          const number = event.currentTarget.valueAsNumber;
          if (Number.isFinite(number) && number > 0) onChange(number);
        }}
        onBlur={(event) => {
          event.currentTarget.value = String(value);
        }}
      />
    </label>
  );
}

function FrameAxesSection({
  widget,
  dispatch,
  frames,
}: WidgetSettingsProps & { frames: string[] }) {
  const settings = widget.frameAxes;
  const set = (value: Partial<FrameAxesSettings>) =>
    dispatch({ type: "frame-axes", id: widget.id, value });
  const hidden = new Set(settings.hidden);
  return (
    <SettingsSection title="Frame axes" collapsible>
      <PositiveNumber
        label="Length (m)"
        value={settings.length}
        step="any"
        onChange={(length) => set({ length })}
      />
      <PositiveNumber
        label="Width (px)"
        value={settings.width}
        step="0.5"
        onChange={(width) => set({ width })}
      />
      {frames.length > 0 && (
        <>
          <fieldset className="table-column-actions" aria-label="Frame axes controls">
            <button
              type="button"
              className="small-button"
              disabled={frames.every((id) => !hidden.has(id))}
              onClick={() => set({ hidden: [] })}
            >
              Show all
            </button>
            <button
              type="button"
              className="small-button"
              disabled={frames.every((id) => hidden.has(id))}
              onClick={() => set({ hidden: [...new Set([...settings.hidden, ...frames])] })}
            >
              Hide all
            </button>
          </fieldset>
          <div className="table-column-options">
            {frames.map((id) => (
              <label className="table-column-option" key={id}>
                <input
                  type="checkbox"
                  aria-label={`Axes of ${id}`}
                  checked={!hidden.has(id)}
                  onChange={(event) =>
                    set({
                      hidden: event.target.checked
                        ? settings.hidden.filter((item) => item !== id)
                        : [...settings.hidden, id],
                    })
                  }
                />
                <span>{id}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

function MapSettings(props: WidgetSettingsProps) {
  const { widget, dispatch } = props;
  const setTiles = (value: string) => dispatch({ type: "tile-url", id: widget.id, value });
  return (
    <>
      <SettingsHeader {...props} />
      <SettingsSection title="Display">
        <div className="settings-label">Map tiles</div>
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
          <button
            type="button"
            disabled={widget.tileUrl === osmTiles}
            onClick={() => setTiles(osmTiles)}
          >
            Use OpenStreetMap
          </button>
          <button type="button" disabled={!widget.tileUrl} onClick={() => setTiles("")}>
            None
          </button>
        </div>
      </SettingsSection>
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
