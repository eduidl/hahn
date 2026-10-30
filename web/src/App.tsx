import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { WidgetWorkspace, widgetSeries } from "./WidgetWorkspace";
import { PanelSettings } from "./PanelSettings";
import {
  initialWorkspace,
  workspaceReducer,
  requestedSeries,
  addFieldAction,
  widgetDragMime,
  widgetSpecs,
  widgetTypes,
  type Widget,
} from "./widgets";
import { secondsFrom } from "./data";
import { dropVerdict } from "./drop";
import { buildFieldIndex, typeLabel } from "./fieldIndex";
import { FieldCache, FieldCacheContext } from "./fieldCache";
import { useMessages } from "./useMessages";
import { useSeries } from "./useSeries";
import { PlaybackBar } from "./PlaybackBar";
import { PlaybackContext, createPlaybackStore } from "./playback";
import { RunsDialog } from "./RunsDialog";
import { TimeZoneSelect } from "./TimeZoneSelect";
import { DisplayTimeZone, usableTimeZone, type TimeZoneSource } from "./timeDisplay";
import { SourceNames, get, initialSources, mergeInfo, sourceOf, sourceUrl, type LoadedSource } from "./sources";
import {
  dragMime,
  errorMessage,
  keyOf,
  parseDrop,
  topicKey,
  type Field,
  type Run,
  type Schemas,
  type Info,
  flattenFields,
  metaFields,
  type Topic,
  type TopicDrag,
} from "./types";

export function App() {
  const [runsOpen, setRunsOpen] = useState(true);
  const [zoneSource, setZoneSource] = useState<TimeZoneSource>("browser");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  // Open groups of the run, in the order they were opened.
  const [sources, setSources] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<Record<string, LoadedSource>>({});
  const requests = useRef(new Map<string, AbortController>());
  const openSources = sources.map((id) => loaded[id]);
  const topics = useMemo(
    () => openSources.flatMap((s) => s?.topics ?? []),
    [sources, loaded],
  );
  const merged = mergeInfo(openSources);
  // Keep one object per range, so dependents only react to real changes.
  const mergedKey = JSON.stringify(merged);
  const info = useMemo(() => merged, [mergedKey]);
  const [workspace, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    initialWorkspace,
  );
  const activeWidget = workspace.activeId
    ? workspace.widgets[workspace.activeId]
    : undefined;
  const demand = requestedSeries(workspace.widgets);
  const [showErrorTopics, setShowErrorTopics] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"panel" | "topics" | "errors">("panel");
  const [error, setError] = useState("");
  const loadingInfo = openSources.some((s) => !s || s.loading);
  const [drag, setDrag] = useState<TopicDrag | null>(null);
  // Field kinds and per-widget-type candidates, computed once per recording.
  const index = useMemo(() => buildFieldIndex(topics), [topics]);
  const [widgetDrag, setWidgetDrag] = useState<Widget["type"] | null>(null);
  const fieldCache = useMemo(() => new FieldCache(), [info?.start_ns]);
  useEffect(() => () => fieldCache.clear(), [fieldCache]);
  const { plotted, records, revision, stop, busy } = useSeries(
    info?.start_ns ?? null,
    demand,
    fieldCache,
  );
  const messages = useMessages(info?.start_ns ?? null, workspace.widgets, fieldCache);
  const fullEnd = info
    ? Math.max(1e-9, secondsFrom(info.end_ns, info.start_ns))
    : 1;
  const [playback] = useState(createPlaybackStore);
  const groups = (run?.groups ?? []).map((group) => ({
    source: sourceOf(run!.id, group.id),
    name: group.name,
  }));
  const openGroups = sources.flatMap((id) => groups.filter((g) => g.source === id));
  const sourceNames = useMemo(
    () => new Map(openGroups.map((g) => [g.source, g.name])),
    [JSON.stringify(openGroups)],
  );
  const multiSource = sources.length > 1;
  const serverZone = usableTimeZone(run?.timezone);
  const count = activeWidget
    ? widgetSeries(activeWidget, plotted).reduce(
        (n, s) => n + s.points.length,
        0,
      )
    : 0;
  const runtimeErrors = [
    ...new Map(
      [...records, ...messages.records]
        .filter((r) => r.error)
        .map((r) => [`${topicKey(r.source, r.topic)}:${r.error}`, r]),
    ).values(),
  ];
  const unreadable = topics.filter((t) => t.error);
  const visibleTopics = topics.filter((t) => showErrorTopics || !t.error);
  const sourceErrors = openGroups.flatMap((group) =>
    loaded[group.source]?.error ? [{ group, error: loaded[group.source].error }] : [],
  );
  const errorCount =
    unreadable.length + runtimeErrors.length + sourceErrors.length + (error ? 1 : 0);

  // Opening a run opens the groups its server marks as default.
  useEffect(() => {
    if (runId === null) return;
    const controller = new AbortController();
    get<Run>(`/api/runs/${runId}`, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        setRun(detail);
        if (!detail.groups.length) setError("この走行にはグループがありません");
        const open = initialSources(detail);
        setSources(open);
        dispatch({ type: "sources", open: new Set(open) });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [runId]);

  // Load each newly opened group once; closing one cancels its requests.
  useEffect(() => {
    for (const [id, controller] of requests.current)
      if (!sources.includes(id)) {
        controller.abort();
        requests.current.delete(id);
      }
    for (const id of sources) {
      if (requests.current.has(id)) continue;
      const controller = new AbortController();
      requests.current.set(id, controller);
      const settle = (source: LoadedSource) => {
        if (!controller.signal.aborted)
          setLoaded((current) => ({ ...current, [id]: source }));
      };
      settle({ info: null, topics: [], error: "", loading: true });
      Promise.all([
        get<Info>(sourceUrl(id), controller.signal),
        get<Schemas["Topic"][]>(`${sourceUrl(id)}/topics`, controller.signal),
      ])
        .then(([info, topics]) =>
          settle({
            info,
            topics: topics.map((topic) => ({
              ...topic,
              source: id,
              fields: [...flattenFields(topic.fields), ...metaFields(topic.meta_fields)],
            })),
            error: "",
            loading: false,
          }),
        )
        .catch((e) =>
          settle({ info: null, topics: [], error: errorMessage(e), loading: false }),
        );
    }
  }, [sources]);
  useEffect(() => {
    const current = requests.current;
    return () => current.forEach((controller) => controller.abort());
  }, []);

  /** Switch runs: the layout and widget settings stay, the previous run's series do not. */
  const selectRun = (id: string) => {
    setRunsOpen(false);
    if (id === runId) return;
    setRun(null);
    setError("");
    setSources([]);
    setLoaded({});
    dispatch({ type: "sources", open: new Set() });
    setSearch("");
    setExpandedTopics(new Set());
    setRunId(id);
  };

  /** Open or close a group. Series of closed groups are dropped. */
  const toggleSource = (id: string, open: boolean) => {
    const next = open
      ? [...sources.filter((s) => s !== id), id]
      : sources.filter((s) => s !== id);
    setSources(next);
    setLoaded((current) => {
      const kept = { ...current };
      if (!open) delete kept[id];
      return kept;
    });
    dispatch({ type: "sources", open: new Set(next) });
    setSearch("");
    setExpandedTopics(new Set());
  };

  // A new time axis starts paused at its beginning.
  useEffect(() => {
    playback.reset(info ? fullEnd : 0);
  }, [playback, info, fullEnd]);

  const startDrag = (event: DragEvent, payload: TopicDrag) => {
    event.stopPropagation();
    event.dataTransfer.setData(dragMime, JSON.stringify(payload));
    event.dataTransfer.setData(
      "text/plain",
      payload.topic + (payload.path ? ` · ${payload.path.join(".")}` : ""),
    );
    event.dataTransfer.effectAllowed = "copy";
    setDrag(payload);
  };
  const drop = (event: DragEvent, widgetId = workspace.activeId) => {
    event.preventDefault();
    setDrag(null);
    const payload = parseDrop(event.dataTransfer.getData(dragMime), topics);
    const widget = widgetId ? workspace.widgets[widgetId] : undefined;
    if (!payload || !widget) return;
    event.stopPropagation();
    dispatch({ type: "select", id: widget.id });
    const verdict = dropVerdict(index, payload, widget);
    // Rejected drags never reach here: drop targets only accept fitting fields.
    if (verdict.ok)
      dispatch(addFieldAction(widget, verdict.entry.topic, verdict.entry.field));
  };
  /** Verdict for the in-progress drag, so widgets can show it before the drop. */
  const dragVerdict = (widget: Widget) =>
    drag ? dropVerdict(index, drag, widget) : null;
  const acceptDrag = (event: DragEvent) => {
    if (
      event.dataTransfer.types.includes(dragMime) &&
      activeWidget &&
      dragVerdict(activeWidget)?.ok
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };
  const topicField = (topic: Topic, field: Field) => (
    <div
      key={keyOf(topic.source, topic.topic, field.path)}
      className="field topic-field"
      draggable
      onDragStart={(e) =>
        startDrag(e, {
          source: topic.source,
          topic: topic.topic,
          path: field.path,
        })
      }
      onDragEnd={() => setDrag(null)}
    >
      <span title={field.path.join(".")}>{field.path.join(".")}</span>
      {/* The concrete type suffices: nesting already tells structs apart. */}
      <small title={field.type_name ?? field.data_type}>
        {typeLabel(topic, field)}
      </small>
    </div>
  );

  return (
    <FieldCacheContext.Provider value={fieldCache}>
    <PlaybackContext.Provider value={playback}>
    <DisplayTimeZone.Provider value={zoneSource === "server" ? serverZone ?? undefined : undefined}>
    <SourceNames.Provider value={sourceNames}>
    <div className="app">
      <RunsDialog
        open={runsOpen}
        current={runId}
        onSelect={selectRun}
        onClose={() => setRunsOpen(false)}
      />
      <header>
        <div className="header-start">
          <div className="brand">
            <span className="brand-mark">h</span>hahn
          </div>
          <button className="runs-trigger" onClick={() => setRunsOpen(true)}>
            走行を選択
          </button>
          {groups.length > 1 && (
            <button
              className="recording-trigger"
              popoverTarget="recording-menu"
              aria-label="グループを開く"
              title="グループを開く"
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v3" />
                <path d="M4 20h15l3-10H7L4 20 2 8h5" />
              </svg>
            </button>
          )}
        </div>
        <div
          id="recording-menu"
          className="recording-menu"
          popover="auto"
          role="dialog"
          aria-label="グループを開く"
        >
          <h2>グループを開く</h2>
          <p className="help">
            開いたグループは共通の時間軸に並べて表示します。
          </p>
          <div className="recording-list">
            {groups.map((g) => (
              <label key={g.source} className="recording-option">
                <input
                  type="checkbox"
                  checked={sources.includes(g.source)}
                  onChange={(e) => toggleSource(g.source, e.target.checked)}
                />
                <span className="recording-name" title={g.name}>
                  {g.name}
                </span>
              </label>
            ))}
          </div>
          <div className="file-detail">
            {sources.length
              ? `${sources.length} グループを表示中 · ${info?.message_count?.toLocaleString() ?? "—"} メッセージ`
              : `${groups.length} グループ`}
          </div>
        </div>

        <button className="add-widget" popoverTarget="widget-catalog">
          ＋ ウィジェットを追加
        </button>
        <div
          id="widget-catalog"
          className={`widget-catalog ${widgetDrag ? "dragging" : ""}`}
          popover="auto"
          role="dialog"
          aria-label="ウィジェットを追加"
        >
          <p className="help">配置したい位置へドラッグしてください。</p>
          {widgetTypes.map((type) => (
            <div
              key={type}
              className={`widget-catalog-item ${widgetDrag === type ? "source" : ""}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(widgetDragMime, type);
                // react-dnd (used by the mosaic) cancels drags without a native type.
                event.dataTransfer.setData("text/plain", widgetSpecs[type].label);
                event.dataTransfer.effectAllowed = "copy";
                setWidgetDrag(type);
              }}
              onDragEnd={() => {
                setWidgetDrag(null);
                document.getElementById("widget-catalog")?.hidePopover();
              }}
            >
              <strong>{widgetSpecs[type].label}</strong>
              <span>{widgetSpecs[type].description}</span>
            </div>
          ))}
        </div>
        <TimeZoneSelect source={zoneSource} serverZone={serverZone} onChange={setZoneSource} />
      </header>
      <div className="workspace">
        <aside>
          <div className="sidebar-tabs" role="tablist" aria-label="サイドバー">
            <button
              id="tab-panel"
              role="tab"
              aria-controls="sidebar-panel"
              aria-selected={tab === "panel"}
              onClick={() => setTab("panel")}
            >
              パネル設定
            </button>
            <button
              id="tab-topics"
              role="tab"
              aria-controls="sidebar-topics"
              aria-selected={tab === "topics"}
              onClick={() => setTab("topics")}
            >
              トピック
            </button>
            <button
              id="tab-errors"
              role="tab"
              aria-controls="sidebar-errors"
              aria-selected={tab === "errors"}
              onClick={() => setTab("errors")}
            >
              エラー
              {errorCount > 0 && <span className="badge">{errorCount}</span>}
            </button>
          </div>
          {tab === "topics" && (
            <div
              id="sidebar-topics"
              className="sidebar-content"
              role="tabpanel"
              aria-labelledby="tab-topics"
            >
              <div className="field-heading">
                <span className="eyebrow">TOPICS</span>
                <button
                  className="collapse-topics"
                  onClick={() => setExpandedTopics(new Set())}
                  disabled={expandedTopics.size === 0}
                >
                  すべて折りたたむ
                </button>
                <span>
                  {visibleTopics.length} / {topics.length}
                </span>
              </div>
              <input
                className="search"
                aria-label="フィールドを検索"
                placeholder="トピック・フィールドを検索…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setExpandedTopics(
                    new Set(
                      e.target.value
                        ? topics.map((t) => topicKey(t.source, t.topic))
                        : [],
                    ),
                  );
                }}
              />
              <label className="show-error-topics">
                <input
                  type="checkbox"
                  checked={showErrorTopics}
                  onChange={(e) => setShowErrorTopics(e.target.checked)}
                />
                エラーのあるトピックを表示
              </label>
              <div className="topics">
                {loadingInfo && <p className="muted">グループ情報を読み込み中…</p>}
                {visibleTopics.map((t, i) => {
                  const id = topicKey(t.source, t.topic);
                  // Several recordings: head each one's topics with its name.
                  const heading = multiSource &&
                    visibleTopics[i - 1]?.source !== t.source && (
                      <div className="source-heading" key={`source-${t.source}`}>
                        {sourceNames.get(t.source)}
                      </div>
                    );
                  const query = search.toLowerCase();
                  const topicMatch = t.topic.toLowerCase().includes(query);
                  const fields = t.fields.filter(
                    (f) =>
                      topicMatch ||
                      f.path.join(".").toLowerCase().includes(query),
                  );
                  if (!fields.length && !topicMatch) return heading || null;
                  return [
                    heading,
                    <details
                      key={id}
                      open={expandedTopics.has(id)}
                      className={`topic-group ${t.message_count === 0 ? "no-messages" : ""}`}
                    >
                      <summary
                        onClick={(e) => {
                          e.preventDefault();
                          setExpandedTopics((current) => {
                            const next = new Set(current);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          });
                        }}
                        draggable
                        onDragStart={(e) =>
                          startDrag(e, { source: t.source, topic: t.topic })
                        }
                        onDragEnd={() => setDrag(null)}
                      >
                        <span className="topic-label">
                          <span className="topic-name">{t.topic}</span>
                          <span className="topic-type">
                            {[
                              t.schema_name,
                              t.message_count === null
                                ? null
                                : `${t.message_count.toLocaleString()} 件`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        {t.error && (
                          <span className="unreadable">読み取り不可</span>
                        )}
                      </summary>
                      {t.error ? (
                        <p className="topic-error">{t.error}</p>
                      ) : fields.length ? (
                        fields.map((f) => topicField(t, f))
                      ) : (
                        <p className="muted">フィールドなし</p>
                      )}
                    </details>,
                  ];
                })}
                {!loadingInfo && info && !visibleTopics.length && (
                  <p className="muted">表示するトピックがありません。</p>
                )}
              </div>
            </div>
          )}
          {tab === "panel" && (
            <div
              id="sidebar-panel"
              className="sidebar-content panel-settings"
              role="tabpanel"
              aria-labelledby="tab-panel"
              onDragOver={acceptDrag}
              onDrop={(event) => drop(event)}
            >
              {activeWidget ? (
                <PanelSettings
                  widget={activeWidget}
                  dispatch={dispatch}
                  records={[...records, ...messages.records]}
                  pointCount={count}
                  index={index}
                />
              ) : (
                <p className="muted">ウィジェットを追加してください。</p>
              )}
            </div>
          )}
          {tab === "errors" && (
            <div
              id="sidebar-errors"
              className="sidebar-content errors-panel"
              role="tabpanel"
              aria-labelledby="tab-errors"
            >
              <div className="field-heading">
                <span className="eyebrow">ERRORS</span>
                <span>{errorCount}</span>
              </div>
              {!errorCount && <p className="muted">エラーはありません。</p>}
              {error && (
                <div className="error-item">
                  <strong>走行の読み込み</strong>
                  <p>{error}</p>
                </div>
              )}
              {sourceErrors.map(({ group, error }) => (
                <div className="error-item" key={`source-${group.source}`}>
                  <strong>{group.name}</strong>
                  <span>グループの読み込み</span>
                  <p>{error}</p>
                </div>
              ))}
              {runtimeErrors.map((r) => (
                <div className="error-item" key={r.key}>
                  <strong>
                    {multiSource && <small>{sourceNames.get(r.source)} </small>}
                    {r.topic}
                  </strong>
                  <span>配信エラー</span>
                  <p>{r.error}</p>
                </div>
              ))}
              {unreadable.map((t) => (
                <div className="error-item" key={topicKey(t.source, t.topic)}>
                  <strong>
                    {multiSource && <small>{sourceNames.get(t.source)} </small>}
                    {t.topic}
                  </strong>
                  <span>読み取り不可</span>
                  <p>{t.error}</p>
                </div>
              ))}
            </div>
          )}
          <footer className="sidebar-footer">
            トピック・フィールドをドラッグして追加
          </footer>
        </aside>
        <main>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <WidgetWorkspace
            state={workspace}
            dispatch={dispatch}
            data={plotted}
            messageRecords={messages.records}
            fieldIndex={index}
            info={info}
            fullEnd={fullEnd}
            revision={revision}
            dragVerdict={dragVerdict}
            widgetDrag={widgetDrag}
            drop={drop}
            openSettings={() => setTab("panel")}
          />
        </main>
      </div>
      <PlaybackBar info={info} fullEnd={fullEnd} busy={busy || messages.busy} stop={() => { stop(); messages.stop(); }} />
    </div>
    </SourceNames.Provider>
    </DisplayTimeZone.Provider>
    </PlaybackContext.Provider>
    </FieldCacheContext.Provider>
  );
}
