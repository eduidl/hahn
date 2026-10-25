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
import { SourceNames, mergeInfo, type LoadedSource } from "./sources";
import {
  dragMime,
  errorMessage,
  keyOf,
  parseDrop,
  topicKey,
  type Field,
  type FileEntry,
  type Info,
  type Topic,
  type TopicDrag,
} from "./types";

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

export function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  // Open recordings in the order they were opened.
  const [sources, setSources] = useState<number[]>([]);
  const [loaded, setLoaded] = useState<Record<number, LoadedSource>>({});
  const requests = useRef(new Map<number, AbortController>());
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
  const openFiles = sources.flatMap((id) => files.filter((f) => f.id === id));
  const sourceNames = useMemo(
    () => new Map(openFiles.map((f) => [f.id, f.name])),
    [JSON.stringify(openFiles.map((f) => [f.id, f.name]))],
  );
  const multiSource = sources.length > 1;
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
  const sourceErrors = openFiles.flatMap((f) =>
    loaded[f.id]?.error ? [{ file: f, error: loaded[f.id].error }] : [],
  );
  const errorCount =
    unreadable.length + runtimeErrors.length + sourceErrors.length + (error ? 1 : 0);

  useEffect(() => {
    const controller = new AbortController();
    get<FileEntry[]>("/api/files", controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setFiles(data);
        const recording = data.find((file) => file.name === "ros2.mcap");
        if (recording) setSources([recording.id]);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, []);

  // Load each newly opened recording once; closing one cancels its requests.
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
        get<Info>(`/api/files/${id}`, controller.signal),
        get<Omit<Topic, "source">[]>(`/api/files/${id}/topics`, controller.signal),
      ])
        .then(([info, topics]) =>
          settle({
            info,
            topics: topics.map((topic) => ({ ...topic, source: id })),
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

  /** Open or close a recording. Series of closed recordings are dropped. */
  const toggleSource = (id: number, open: boolean) => {
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
    <SourceNames.Provider value={sourceNames}>
    <div className="app">
      <header>
        <div className="header-start">
          <div className="brand">
            <span className="brand-mark">h</span>hahn
          </div>
          <button
            className="recording-trigger"
            popoverTarget="recording-menu"
            aria-label="録画を開く"
            title="録画を開く"
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
        </div>
        <div
          id="recording-menu"
          className="recording-menu"
          popover="auto"
          role="dialog"
          aria-label="録画を開く"
        >
          <h2>録画を開く</h2>
          <p className="help">
            複数の録画を開くと、共通の時間軸に並べて表示します。
          </p>
          <div className="recording-list">
            {files.map((f) => (
              <label key={f.id} className="recording-option">
                <input
                  type="checkbox"
                  checked={sources.includes(f.id)}
                  onChange={(e) => toggleSource(f.id, e.target.checked)}
                />
                <span className="recording-name" title={f.name}>
                  {f.name}
                </span>
                <small>
                  {f.format.toUpperCase()} ·{" "}
                  {(f.size_bytes / 1024 / 1024).toFixed(1)} MB
                </small>
              </label>
            ))}
          </div>
          <div className="file-detail">
            {sources.length
              ? `${sources.length} 件を表示中 · ${info?.message_count?.toLocaleString() ?? "—"} メッセージ`
              : `${files.length} 件の録画`}
          </div>
        </div>

        <span
          className="header-file"
          title={openFiles.map((f) => f.name).join("\n")}
        >
          {openFiles.length
            ? openFiles.map((f) => f.name).join(" ＋ ")
            : "録画未選択"}
        </span>
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
        <span className="local">
          <i />
          LOCAL WORKSPACE
        </span>
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
                {loadingInfo && <p className="muted">録画情報を読み込み中…</p>}
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
                  <strong>録画の読み込み</strong>
                  <p>{error}</p>
                </div>
              )}
              {sourceErrors.map(({ file, error }) => (
                <div className="error-item" key={`source-${file.id}`}>
                  <strong>{file.name}</strong>
                  <span>録画の読み込み</span>
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
    </PlaybackContext.Provider>
    </FieldCacheContext.Provider>
  );
}
