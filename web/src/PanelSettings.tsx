import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode } from "react";
import { addableFields } from "./drop";
import { SeriesName } from "./SeriesName";
import type { FieldIndex, IndexedField } from "./fieldIndex";
import type { CachedSeries } from "./useSeries";
import type { Selected } from "./types";
import {
  addFieldAction,
  widgetSpecs,
  type Widget,
  type WorkspaceAction,
} from "./widgets";

type PanelProps = {
  widget: Widget;
  dispatch: Dispatch<WorkspaceAction>;
  records: CachedSeries[];
  pointCount: number;
  index: FieldIndex;
};
/** Rows rendered at once; the search narrows the rest. */
const pickerLimit = 100;

function statusLabel(record: CachedSeries | undefined) {
  if (!record) return "待機中";
  if (record.status === "loading")
    return `読み込み中 · ${record.received.toLocaleString()}`;
  if (record.status === "complete")
    return `完了 · ${record.received.toLocaleString()} メッセージ`;
  if (record.status === "stopped") return "停止 · 部分データ";
  return "読み込みエラー";
}

const name = (s: Selected) => `${s.topic} ${s.path.join(".")}`;

function PanelHeader({ widget }: PanelProps) {
  return (
    <>
      <div className="field-heading">
        <span className="eyebrow">{widget.title}</span>
        <span>{widget.series.length} 系列</span>
      </div>
      <p className="help">{widgetSpecs[widget.type].help}</p>
    </>
  );
}

/** A button opening a searchable list of the fields this widget can take now; picking one closes it. */
function FieldPicker({ widget, dispatch, index }: PanelProps) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const candidates = useMemo(() => addableFields(index, widget), [index, widget]);
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
    dispatch(addFieldAction(widget, entry.topic.topic, entry.field));
    popover.current?.hidePopover();
  };
  return (
    <>
      <button
        className="add-field"
        popoverTarget="field-picker"
        disabled={!candidates.length}
      >
        ＋ フィールドを追加
      </button>
      <div
        id="field-picker"
        ref={popover}
        className="field-picker"
        popover="auto"
        role="dialog"
        aria-label="フィールドを追加"
      >
        <input
          ref={input}
          className="search"
          type="search"
          aria-label="追加するフィールドを検索"
          placeholder={`フィールドを検索（${candidates.length.toLocaleString()} 件）`}
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
            <button
              key={entry.key}
              className="field-option"
              onClick={() => pick(entry)}
            >
              <SeriesName
                topic={entry.topic.topic}
                path={entry.field.path}
                type={entry.typeLabel}
              />
            </button>
          ))}
          {matches.length > pickerLimit && (
            <p className="muted">
              他 {(matches.length - pickerLimit).toLocaleString()} 件。絞り込んでください。
            </p>
          )}
          {!matches.length && <p className="muted">一致するフィールドがありません。</p>}
        </div>
      </div>
    </>
  );
}

function TimeDisplaySetting({ widget, dispatch }: PanelProps) {
  return (
    <label className="time-display-setting">
      横軸の時刻表示
      <select
        aria-label="横軸の時刻表示"
        value={widget.timeDisplay}
        onChange={(event) =>
          dispatch({
            type: "time-display",
            id: widget.id,
            value: event.target.value === "relative" ? "relative" : "absolute",
          })
        }
      >
        <option value="absolute">実時刻（ローカル）</option>
        <option value="relative">録画開始からの秒数</option>
      </select>
    </label>
  );
}

/** Series list shared by all panels; each panel supplies the per-series row. */
function SeriesList({
  widget,
  pointCount,
  row,
}: PanelProps & { row: (series: Selected) => ReactNode }) {
  return (
    <section className="legend" aria-label="選択した系列">
      <div className="legend-heading">
        <span className="eyebrow">SERIES</span>
        <span>
          {widget.series.length} 系列 · {pointCount.toLocaleString()} 点
        </span>
      </div>
      {widget.series.map(row)}
      {!widget.series.length && (
        <p className="legend-empty">
          選択した系列と読み込み状況がここに表示されます。
        </p>
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
}: PanelProps & { series: Selected; marker?: ReactNode; children?: ReactNode }) {
  const update = (change: (series: Selected[]) => Selected[]) =>
    dispatch({ type: "series", id: widget.id, update: change });
  return (
    <div className="legend-row">
      <button
        className={`series-toggle ${s.hidden ? "dim" : ""}`}
        aria-label={`${name(s)} の表示切替`}
        aria-pressed={!s.hidden}
        onClick={() =>
          update((list) =>
            list.map((f) => (f.key === s.key ? { ...f, hidden: !f.hidden } : f)),
          )
        }
      >
        {marker}
        <SeriesName topic={s.topic} path={s.path} />
      </button>
      {children}
      <span className="series-status">
        {statusLabel(records.find((r) => r.key === s.key))}
      </span>
      <button
        className="remove"
        aria-label={`${name(s)} を削除`}
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
        色
        <input
          type="color"
          aria-label={`${name(s)} の色`}
          value={s.color}
          onChange={(e) => restyle({ color: e.target.value })}
        />
      </label>
      <label>
        線の太さ
        <input
          type="number"
          step="any"
          aria-label={`${name(s)} の線の太さ`}
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

function TimeSeriesPanel(props: PanelProps) {
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
      <SeriesList
        {...props}
        row={(s) => <SeriesRow key={s.key} {...props} series={s} />}
      />
    </>
  );
}

const panels: Record<Widget["type"], (props: PanelProps) => ReactNode> = {
  "time-series": TimeSeriesPanel,
  state: StatePanel,
};

/** Settings for the selected widget, chosen wholesale by widget type. */
export function PanelSettings(props: PanelProps) {
  const Panel = panels[props.widget.type];
  // Keyed by widget so uncontrolled inputs do not carry over between widgets.
  return <Panel key={props.widget.id} {...props} />;
}
