import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent,
  type CSSProperties,
} from "react";
import { SidebarResizer } from "./workspace/SidebarResizer";
import { WidgetWorkspace, widgetSeries } from "./workspace/WidgetWorkspace";
import { WidgetSettings } from "./workspace/WidgetSettings";
import {
  initialWorkspace,
  workspaceReducer,
  requestedSeries,
  addFieldAction,
  addSelectedAction,
  widgetDragMime,
  widgetSpecs,
  widgetTypes,
  type Widget,
} from "./workspace/widgets";
import { Highlight } from "./Highlight";
import { secondsFrom } from "./data/data";
import { dropVerdict } from "./workspace/drop";
import { buildFieldIndex, typeLabel } from "./workspace/fieldIndex";
import { FieldCache, FieldCacheContext } from "./data/fieldCache";
import { useMessages } from "./data/useMessages";
import { useSeries } from "./data/useSeries";
import { PlaybackBar } from "./workspace/PlaybackBar";
import { PlaybackContext, createPlaybackStore } from "./workspace/playback";
import {
  browserStorage,
  clearSession,
  loadSession,
  saveSession,
  type Session,
  type SidebarTab,
} from "./workspace/persistence";
import { ConfirmDialog } from "./workspace/ConfirmDialog";
import { RunsDialog } from "./workspace/RunsDialog";
import { TimeDisplaySelect, TimeZoneSelect } from "./workspace/TimeZoneSelect";
import {
  DisplayTimeMode,
  DisplayTimeZone,
  usableTimeZone,
  type TimeDisplay,
  type TimeZoneSource,
} from "./timeDisplay";
import {
  HttpError,
  SourceNames,
  get,
  initialSources,
  mergeInfo,
  sourceTopics,
  sourceOf,
  sourceUrl,
  type LoadedSource,
} from "./data/sources";
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
  type Topic,
  type TopicDrag,
} from "./types";

export function App() {
  const [saved] = useState(() => loadSession(browserStorage()));
  const [runsOpen, setRunsOpen] = useState(!saved?.runId);
  const [resetOpen, setResetOpen] = useState(false);
  const [zoneSource, setZoneSource] = useState<TimeZoneSource>(saved?.zoneSource ?? "browser");
  const [timeDisplay, setTimeDisplay] = useState<TimeDisplay>(saved?.timeDisplay ?? "absolute");
  const [sidebarWidth, setSidebarWidth] = useState(saved?.sidebarWidth ?? null);
  const [sidebarOpen, setSidebarOpen] = useState(saved?.sidebarOpen ?? true);
  const [runId, setRunId] = useState<string | null>(saved?.runId ?? null);
  // The saved session until its run is confirmed. Saving waits for that, so a
  // half-restored state cannot overwrite the session.
  const pendingRestore = useRef(saved?.runId ? saved : null);
  const [restoring, setRestoring] = useState(Boolean(saved?.runId));
  const [run, setRun] = useState<Run | null>(null);
  // Open groups of the run, in the order they were opened.
  const [sources, setSources] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<Record<string, LoadedSource>>({});
  const requests = useRef(new Map<string, AbortController>());
  const openSources = sources.map((id) => loaded[id]);
  const topics = useMemo(() => openSources.flatMap((s) => s?.topics ?? []), [sources, loaded]);
  const sourceDetails = useMemo(
    () =>
      sources.map((id) => ({
        id,
        ...(loaded[id] ?? { info: null, topics: [], error: "", loading: true }),
      })),
    [sources, loaded],
  );
  const merged = mergeInfo(openSources);
  // Keep one object per range, so dependents only react to real changes.
  const mergedKey = JSON.stringify(merged);
  const info = useMemo(() => merged, [mergedKey]);
  const [workspace, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    () => saved?.workspace ?? initialWorkspace(),
  );
  const activeWidget = workspace.activeId ? workspace.widgets[workspace.activeId] : undefined;
  const demand = requestedSeries(workspace.widgets);
  const [showErrorTopics, setShowErrorTopics] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<SidebarTab>(saved?.tab ?? "settings");
  const [error, setError] = useState("");
  const loadingInfo = openSources.some((s) => !s || s.loading);
  const [drag, setDrag] = useState<TopicDrag | null>(null);
  // Field kinds and per-widget-type candidates, computed once per recording.
  const index = useMemo(() => buildFieldIndex(topics), [topics]);
  const [widgetDrag, setWidgetDrag] = useState<Widget["type"] | null>(null);
  const fieldCache = useMemo(() => new FieldCache(), [info?.start_ns]);
  useEffect(() => () => fieldCache.clear(), [fieldCache]);
  const { plotted, records, revision, busy } = useSeries(
    info?.start_ns ?? null,
    demand,
    fieldCache,
  );
  const messages = useMessages(info?.start_ns ?? null, workspace.widgets, fieldCache);
  const fullEnd = info ? Math.max(1e-9, secondsFrom(info.end_ns, info.start_ns)) : 1;
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
    ? widgetSeries(activeWidget, plotted).reduce((n, s) => n + s.points.length, 0)
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
        if (!detail.groups.length) setError("This run has no groups");
        const pending = pendingRestore.current;
        const restored = pending?.runId === runId;
        const existing = detail.groups.map((group) => sourceOf(detail.id, group.id));
        const kept = restored ? pending.sources.filter((id) => existing.includes(id)) : [];
        const open = kept.length ? kept : initialSources(detail);
        setSources(open);
        dispatch({ type: "sources", open: new Set(open), keepViews: restored });
        pendingRestore.current = null;
        setRestoring(false);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(e));
        if (pendingRestore.current?.runId !== runId) return;
        setRunId(null);
        setRunsOpen(true);
        // A run the server no longer has is gone for good. Anything else may be
        // a server restart, so keep the session for the next reload.
        if (e instanceof HttpError && e.status === 404) {
          pendingRestore.current = null;
          setRestoring(false);
          dispatch({ type: "sources", open: new Set(), keepViews: true });
        }
      });
    return () => controller.abort();
  }, [runId]);

  // Save shortly after changes settle, and on leaving in case they have not.
  const session = useRef<Session | null>(null);
  const discarded = useRef(false);
  const saveCurrent = () => {
    if (session.current && !discarded.current) saveSession(browserStorage(), session.current);
  };
  useEffect(() => {
    session.current = restoring
      ? null
      : { workspace, runId, sources, zoneSource, timeDisplay, tab, sidebarWidth, sidebarOpen };
    const timer = setTimeout(saveCurrent, 300);
    return () => clearTimeout(timer);
  }, [
    restoring,
    workspace,
    runId,
    sources,
    zoneSource,
    timeDisplay,
    tab,
    sidebarWidth,
    sidebarOpen,
  ]);
  useEffect(() => {
    window.addEventListener("pagehide", saveCurrent);
    return () => window.removeEventListener("pagehide", saveCurrent);
  }, []);
  const addFromCatalog = (type: Widget["type"]) => {
    dispatch(addSelectedAction(workspace, type));
    document.getElementById("widget-catalog")?.hidePopover();
  };
  const resetWorkspace = () => {
    discarded.current = true;
    // Clear first so a failed save still resets instead of keeping the old layout.
    clearSession(browserStorage());
    saveSession(browserStorage(), {
      workspace: initialWorkspace(),
      runId,
      sources,
      zoneSource,
      timeDisplay,
      tab,
      sidebarWidth,
      sidebarOpen,
    });
    location.reload();
  };

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
        if (!controller.signal.aborted) setLoaded((current) => ({ ...current, [id]: source }));
      };
      settle({ info: null, topics: [], error: "", loading: true });
      Promise.all([
        get<Info>(sourceUrl(id), controller.signal),
        get<Schemas["Topic"][]>(`${sourceUrl(id)}/topics`, controller.signal),
      ])
        .then(([info, topics]) => {
          settle({
            info,
            topics: sourceTopics(id, topics),
            error: "",
            loading: false,
          });
        })
        .catch((e) => settle({ info: null, topics: [], error: errorMessage(e), loading: false }));
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
    // Picking the run a failed restore was for retries it; another run ends it.
    if (pendingRestore.current?.runId !== id) {
      pendingRestore.current = null;
      setRestoring(false);
      dispatch({ type: "sources", open: new Set() });
    }
    setSearch("");
    setExpandedTopics(new Set());
    setRunId(id);
  };

  /** Open or close a group. Series of closed groups are dropped. */
  const toggleSource = (id: string, open: boolean) => {
    const next = open ? [...sources.filter((s) => s !== id), id] : sources.filter((s) => s !== id);
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
      (topics.find((t) => t.source === payload.source && t.topic === payload.topic)?.topicName ??
        payload.topic) + (payload.path ? ` · ${payload.path.join(".")}` : ""),
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
      dispatch(addFieldAction(widget, verdict.entry.topic, verdict.entry.field, index));
  };
  /** Verdict for the in-progress drag, so widgets can show it before the drop. */
  const dragVerdict = (widget: Widget) => (drag ? dropVerdict(index, drag, widget) : null);
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
  const [addStatus, setAddStatus] = useState("");
  const addStatusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(addStatusTimer.current), []);
  /** Adds without dragging; a drag would show the refusal on the widget, so show it here. */
  const addToSelected = (payload: TopicDrag) => {
    clearTimeout(addStatusTimer.current);
    const verdict = activeWidget
      ? dropVerdict(index, payload, activeWidget)
      : { ok: false as const, reason: "Add a widget first." };
    if (verdict.ok) {
      setAddStatus("");
      dispatch(addFieldAction(activeWidget!, verdict.entry.topic, verdict.entry.field, index));
      return;
    }
    setAddStatus(verdict.reason);
    addStatusTimer.current = setTimeout(() => setAddStatus(""), 5000);
  };
  const topicField = (topic: Topic, field: Field) => (
    <div
      key={keyOf(topic.source, topic.topic, field.path)}
      className="field topic-field"
      // Not a <button>: Firefox does not drag those.
      role="button"
      tabIndex={0}
      draggable
      onDoubleClick={() =>
        addToSelected({ source: topic.source, topic: topic.topic, path: field.path })
      }
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        addToSelected({ source: topic.source, topic: topic.topic, path: field.path });
      }}
      onDragStart={(e) =>
        startDrag(e, {
          source: topic.source,
          topic: topic.topic,
          path: field.path,
        })
      }
      onDragEnd={() => setDrag(null)}
    >
      <span title={field.path.join(".")}>
        <Highlight text={field.path.join(".")} query={search} />
      </span>
      {/* The concrete type suffices: nesting already tells structs apart. */}
      <small title={field.type_name ?? field.data_type}>{typeLabel(topic, field)}</small>
    </div>
  );

  return (
    <FieldCacheContext.Provider value={fieldCache}>
      <PlaybackContext.Provider value={playback}>
        <DisplayTimeZone.Provider
          value={zoneSource === "server" ? (serverZone ?? undefined) : undefined}
        >
          <DisplayTimeMode.Provider value={timeDisplay}>
            <SourceNames.Provider value={sourceNames}>
              <div className="app">
                <RunsDialog
                  open={runsOpen}
                  current={runId}
                  onSelect={selectRun}
                  onClose={() => setRunsOpen(false)}
                />
                <ConfirmDialog
                  open={resetOpen}
                  title="Reset workspace?"
                  message="This removes all widgets, tabs, and series saved in this browser. This cannot be undone."
                  confirmLabel="Reset"
                  onConfirm={resetWorkspace}
                  onClose={() => setResetOpen(false)}
                />
                <header>
                  <div className="header-start">
                    <div className="brand">
                      <img
                        className="brand-mark"
                        src={new URL("./assets/favicon.svg", import.meta.url).href}
                        alt=""
                      />
                      hahn
                    </div>
                    <button
                      className="runs-trigger"
                      aria-label={run ? `Select run: ${run.name}` : undefined}
                      title={run?.name}
                      onClick={() => setRunsOpen(true)}
                    >
                      {run ? (
                        <>
                          <span className="runs-trigger-name">{run.name}</span>
                          <span aria-hidden="true">▾</span>
                        </>
                      ) : (
                        "Select run"
                      )}
                    </button>
                    {groups.length > 1 && (
                      <button
                        className="group-trigger"
                        popoverTarget="group-menu"
                        aria-label="Open groups"
                        title="Open groups"
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
                    id="group-menu"
                    className="group-menu"
                    popover="auto"
                    role="dialog"
                    aria-label="Open groups"
                  >
                    <h2>Open groups</h2>
                    <p className="help">Open groups are displayed on a shared timeline.</p>
                    <div className="group-list">
                      {groups.map((g) => (
                        <label key={g.source} className="group-option">
                          <input
                            type="checkbox"
                            checked={sources.includes(g.source)}
                            onChange={(e) => toggleSource(g.source, e.target.checked)}
                          />
                          <span className="group-name" title={g.name}>
                            {g.name}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="file-detail">
                      {sources.length
                        ? `${sources.length} groups open · ${info?.message_count?.toLocaleString() ?? "—"} messages`
                        : `${groups.length} groups`}
                    </div>
                  </div>

                  <button
                    className="add-widget"
                    aria-label="Add widget"
                    popoverTarget="widget-catalog"
                  >
                    + Widget
                  </button>
                  <div
                    id="widget-catalog"
                    className="widget-catalog"
                    popover="auto"
                    role="dialog"
                    aria-label="Add widget"
                  >
                    <p className="help">
                      Click to add next to the selected widget, or drag to a position.
                    </p>
                    {widgetTypes.map((type) => (
                      <div
                        key={type}
                        className="widget-catalog-item"
                        // Not a <button>: Firefox does not drag those.
                        role="button"
                        tabIndex={0}
                        draggable
                        onClick={() => addFromCatalog(type)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          event.stopPropagation();
                          addFromCatalog(type);
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.setData(widgetDragMime, type);
                          // react-dnd (used by the mosaic) cancels drags without a native type.
                          event.dataTransfer.setData("text/plain", widgetSpecs[type].label);
                          event.dataTransfer.effectAllowed = "copy";
                          setWidgetDrag(type);
                          // The list would cover the drop targets. Hiding the source during
                          // dragstart cancels the drag, so wait until it has begun.
                          setTimeout(() =>
                            document.getElementById("widget-catalog")?.hidePopover(),
                          );
                        }}
                        onDragEnd={() => setWidgetDrag(null)}
                      >
                        <strong>{widgetSpecs[type].label}</strong>
                        <span>{widgetSpecs[type].description}</span>
                      </div>
                    ))}
                  </div>
                  <TimeDisplaySelect value={timeDisplay} onChange={setTimeDisplay} />
                  <TimeZoneSelect
                    disabled={timeDisplay === "offset"}
                    source={zoneSource}
                    serverZone={serverZone}
                    onChange={setZoneSource}
                  />
                  <button
                    className="sidebar-toggle"
                    aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
                    title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
                    aria-expanded={sidebarOpen}
                    onClick={() => setSidebarOpen((open) => !open)}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <path d="M9 4v16" />
                    </svg>
                  </button>
                </header>
                <div
                  className={sidebarOpen ? "workspace" : "workspace sidebar-closed"}
                  style={
                    sidebarWidth === null
                      ? undefined
                      : ({ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties)
                  }
                >
                  <aside>
                    <SidebarResizer onResize={setSidebarWidth} />
                    <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
                      <button
                        id="tab-settings"
                        role="tab"
                        aria-controls="sidebar-settings"
                        aria-selected={tab === "settings"}
                        onClick={() => setTab("settings")}
                      >
                        Settings
                      </button>
                      <button
                        id="tab-topics"
                        role="tab"
                        aria-controls="sidebar-topics"
                        aria-selected={tab === "topics"}
                        onClick={() => setTab("topics")}
                      >
                        Topics
                      </button>
                      <button
                        id="tab-errors"
                        role="tab"
                        aria-controls="sidebar-errors"
                        aria-selected={tab === "errors"}
                        onClick={() => setTab("errors")}
                      >
                        Errors
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
                          <span className="eyebrow">Topics</span>
                          <button
                            className="collapse-topics"
                            onClick={() => setExpandedTopics(new Set())}
                            disabled={expandedTopics.size === 0}
                          >
                            Collapse all
                          </button>
                          <span>
                            {visibleTopics.length} / {topics.length}
                          </span>
                        </div>
                        <input
                          className="search"
                          aria-label="Search fields"
                          placeholder="Search topics and fields…"
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
                          Show topics with errors
                        </label>
                        <div className="topics">
                          {loadingInfo && <p className="muted">Loading group information…</p>}
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
                            const topicMatch = (t.topicName ?? t.topic)
                              .toLowerCase()
                              .includes(query);
                            const fields = t.fields.filter(
                              (f) => topicMatch || f.path.join(".").toLowerCase().includes(query),
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
                                    <span className="topic-name">
                                      <Highlight text={t.topicName ?? t.topic} query={search} />
                                    </span>
                                    <span className="topic-type">
                                      {[
                                        t.schema_name,
                                        t.message_count === null
                                          ? null
                                          : `${t.message_count.toLocaleString()} messages`,
                                        ...t.views.map((view) => view.name),
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </span>
                                  </span>
                                  {t.error && <span className="unreadable">Unreadable</span>}
                                </summary>
                                {t.error ? (
                                  <p className="topic-error">{t.error}</p>
                                ) : fields.length ? (
                                  fields.map((f) => topicField(t, f))
                                ) : (
                                  <p className="muted">No fields</p>
                                )}
                              </details>,
                            ];
                          })}
                          {!loadingInfo && info && !visibleTopics.length && (
                            <p className="muted">No topics to display</p>
                          )}
                        </div>
                      </div>
                    )}
                    {tab === "settings" && (
                      <div
                        id="sidebar-settings"
                        className="sidebar-content widget-settings"
                        role="tabpanel"
                        aria-labelledby="tab-settings"
                        onDragOver={acceptDrag}
                        onDrop={(event) => drop(event)}
                      >
                        {activeWidget ? (
                          <WidgetSettings
                            widget={activeWidget}
                            dispatch={dispatch}
                            records={[...records, ...messages.records]}
                            pointCount={count}
                            index={index}
                          />
                        ) : (
                          <p className="muted">Add a widget.</p>
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
                          <span className="eyebrow">Errors</span>
                          <span>{errorCount}</span>
                        </div>
                        {!errorCount && <p className="muted">No errors</p>}
                        {error && (
                          <div className="error-item">
                            <strong>Loading run</strong>
                            <p>{error}</p>
                          </div>
                        )}
                        {sourceErrors.map(({ group, error }) => (
                          <div className="error-item" key={`source-${group.source}`}>
                            <strong>{group.name}</strong>
                            <span>Loading group</span>
                            <p>{error}</p>
                          </div>
                        ))}
                        {runtimeErrors.map((r) => (
                          <div className="error-item" key={r.key}>
                            <strong>
                              {multiSource && <small>{sourceNames.get(r.source)} </small>}
                              {r.topicName ?? r.topic}
                            </strong>
                            <span>Stream error</span>
                            <p>{r.error}</p>
                          </div>
                        ))}
                        {unreadable.map((t) => (
                          <div className="error-item" key={topicKey(t.source, t.topic)}>
                            <strong>
                              {multiSource && <small>{sourceNames.get(t.source)} </small>}
                              {t.topicName ?? t.topic}
                            </strong>
                            <span>Unreadable</span>
                            <p>{t.error}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="sidebar-status" role="status">
                      {addStatus}
                    </p>
                    <footer className="sidebar-footer">
                      {tab === "topics" && <span>Drag or double-click to add</span>}
                      <button className="reset-workspace" onClick={() => setResetOpen(true)}>
                        Reset workspace
                      </button>
                    </footer>
                  </aside>
                  <main>
                    {error && (
                      <div className="error" role="alert">
                        {error}
                      </div>
                    )}
                    <WidgetWorkspace
                      runId={runId}
                      state={workspace}
                      dispatch={dispatch}
                      data={plotted}
                      messageRecords={messages.records}
                      fieldIndex={index}
                      info={info}
                      sources={sourceDetails}
                      fullEnd={fullEnd}
                      revision={revision}
                      dragVerdict={dragVerdict}
                      widgetDrag={widgetDrag}
                      drop={drop}
                      openSettings={() => {
                        setTab("settings");
                        setSidebarOpen(true);
                      }}
                    />
                  </main>
                </div>
                <PlaybackBar info={info} fullEnd={fullEnd} busy={busy || messages.busy} />
              </div>
            </SourceNames.Provider>
          </DisplayTimeMode.Provider>
        </DisplayTimeZone.Provider>
      </PlaybackContext.Provider>
    </FieldCacheContext.Provider>
  );
}
