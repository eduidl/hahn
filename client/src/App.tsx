import "./App.css";
import { useEffect, useMemo, useReducer, useState, type CSSProperties } from "react";
import { AppHeader } from "./workspace/AppHeader";
import { ConfirmDialog } from "./workspace/ConfirmDialog";
import { PlaybackBar } from "./workspace/PlaybackBar";
import { RunsDialog } from "./workspace/RunsDialog";
import { Sidebar } from "./workspace/Sidebar";
import { WidgetWorkspace, widgetSeries } from "./workspace/WidgetWorkspace";
import { buildFieldIndex } from "./workspace/fieldIndex";
import { browserStorage, loadSession, type SidebarTab } from "./workspace/persistence";
import { PlaybackContext, createPlaybackStore } from "./workspace/playback";
import { useRunSources } from "./workspace/useRunSources";
import { useSession } from "./workspace/useSession";
import { useTopicDrag } from "./workspace/useTopicDrag";
import {
  addSelectedAction,
  initialWorkspace,
  requestedSeries,
  workspaceReducer,
  type Widget,
} from "./workspace/widgets";
import { secondsFrom } from "./data/data";
import { FieldCache, FieldCacheContext } from "./data/fieldCache";
import { SourceNames } from "./data/sources";
import { useMessages } from "./data/useMessages";
import { useSeries } from "./data/useSeries";
import {
  DisplayTimeMode,
  DisplayTimeZone,
  usableTimeZone,
  type TimeDisplay,
  type TimeZoneSource,
} from "./timeDisplay";

export function App() {
  const [saved] = useState(() => loadSession(browserStorage()));
  const [runsOpen, setRunsOpen] = useState(!saved?.runId);
  const [resetOpen, setResetOpen] = useState(false);
  const [zoneSource, setZoneSource] = useState<TimeZoneSource>(saved?.zoneSource ?? "browser");
  const [timeDisplay, setTimeDisplay] = useState<TimeDisplay>(saved?.timeDisplay ?? "absolute");
  const [sidebarWidth, setSidebarWidth] = useState(saved?.sidebarWidth ?? null);
  const [sidebarOpen, setSidebarOpen] = useState(saved?.sidebarOpen ?? true);
  const [workspace, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    () => saved?.workspace ?? initialWorkspace(),
  );
  const {
    runId,
    run,
    restoring,
    sources,
    topics,
    sourceDetails,
    info,
    loadingInfo,
    error,
    sourceErrors,
    groups,
    sourceNames,
    selectRun,
    toggleSource,
  } = useRunSources(saved, dispatch, () => setRunsOpen(true));
  const activeWidget = workspace.activeId ? workspace.widgets[workspace.activeId] : undefined;
  const demand = requestedSeries(workspace.widgets);
  const [search, setSearch] = useState("");
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<SidebarTab>(saved?.tab ?? "settings");
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
  const serverZone = usableTimeZone(run?.timezone);
  const resetWorkspace = useSession(
    { workspace, runId, sources, zoneSource, timeDisplay, tab, sidebarWidth, sidebarOpen },
    restoring,
  );
  const topicDrag = useTopicDrag(topics, index, workspace, dispatch);
  const clearTopicFilter = () => {
    setSearch("");
    setExpandedTopics(new Set());
  };

  // A new time axis starts paused at its beginning.
  useEffect(() => {
    playback.reset(info ? fullEnd : 0);
  }, [playback, info, fullEnd]);

  return (
    <FieldCacheContext.Provider value={fieldCache}>
      <PlaybackContext.Provider value={playback}>
        <DisplayTimeZone.Provider value={chosenTimeZone(zoneSource, serverZone)}>
          <DisplayTimeMode.Provider value={timeDisplay}>
            <SourceNames.Provider value={sourceNames}>
              <div className="app">
                <RunsDialog
                  open={runsOpen}
                  current={runId}
                  onSelect={(id) => {
                    setRunsOpen(false);
                    if (id === runId) return;
                    clearTopicFilter();
                    selectRun(id);
                  }}
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
                <AppHeader
                  run={run}
                  groups={groups}
                  sources={sources}
                  info={info}
                  timeDisplay={timeDisplay}
                  zoneSource={zoneSource}
                  serverZone={serverZone}
                  sidebarOpen={sidebarOpen}
                  onOpenRuns={() => setRunsOpen(true)}
                  onToggleSource={(id, open) => {
                    toggleSource(id, open);
                    clearTopicFilter();
                  }}
                  onAddWidget={(type) => dispatch(addSelectedAction(workspace, type))}
                  onWidgetDrag={setWidgetDrag}
                  onTimeDisplay={setTimeDisplay}
                  onZoneSource={setZoneSource}
                  onToggleSidebar={() => setSidebarOpen((open) => !open)}
                />
                <div
                  className={sidebarOpen ? "workspace" : "workspace sidebar-closed"}
                  style={
                    sidebarWidth === null
                      ? undefined
                      : ({ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties)
                  }
                >
                  <Sidebar
                    tab={tab}
                    setTab={setTab}
                    activeWidget={activeWidget}
                    dispatch={dispatch}
                    records={[...records, ...messages.records]}
                    index={index}
                    topics={topics}
                    sourceNames={sourceNames}
                    multiSource={sources.length > 1}
                    loadingInfo={loadingInfo}
                    info={info}
                    search={search}
                    setSearch={setSearch}
                    expandedTopics={expandedTopics}
                    setExpandedTopics={setExpandedTopics}
                    error={error}
                    sourceErrors={sourceErrors}
                    topicDrag={topicDrag}
                    onResize={setSidebarWidth}
                    onReset={() => setResetOpen(true)}
                  />
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
                      dragVerdict={topicDrag.dragVerdict}
                      widgetDrag={widgetDrag}
                      drop={topicDrag.drop}
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
