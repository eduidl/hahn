import "./App.css";
import { useEffect, useMemo, useReducer, useState, type CSSProperties } from "react";
import { AppHeader } from "./workspace/AppHeader";
import { ConfirmDialog } from "./workspace/ConfirmDialog";
import { PlaybackBar } from "./workspace/PlaybackBar";
import { RunsDialog } from "./workspace/RunsDialog";
import { Sidebar } from "./workspace/Sidebar";
import { WidgetWorkspace } from "./workspace/WidgetWorkspace";
import { buildFieldIndex } from "./workspace/fieldIndex";
import { browserStorage, loadSession, type SidebarTab } from "./workspace/persistence";
import { PlaybackContext, createPlaybackStore } from "./workspace/playback";
import { SeriesEnvironmentContext, usableWorkspace } from "./workspace/seriesState";
import { useRunSources } from "./workspace/useRunSources";
import { takeRequestedRun } from "./workspace/address";
import { useSession } from "./workspace/useSession";
import { useTopicDrag } from "./workspace/useTopicDrag";
import {
  addSelectedAction,
  initialWorkspace,
  workspaceReducer,
  type Widget,
} from "./workspace/widgets";
import { secondsFrom } from "./data/data";
import { DataStore, DataStoreContext, useActivity } from "./data/store";
import { SourceNames } from "./data/sources";
import { inDesktopApp, selectRecording } from "./desktop";
import {
  DisplayTimeMode,
  chosenTimeZone,
  DisplayTimeZone,
  usableTimeZone,
  type TimeDisplay,
  type TimeZoneSource,
} from "./timeDisplay";

export function App() {
  const [saved] = useState(() => loadSession(browserStorage()));
  const desktop = inDesktopApp();
  // The desktop app decides the run, by the address it opens: a reload opens the same
  // run, and without one the window waits for the user to pick a recording.
  const [initialRun] = useState(() =>
    desktop ? takeRequestedRun(true) : (takeRequestedRun() ?? saved?.runId ?? null),
  );
  const [runsOpen, setRunsOpen] = useState(!initialRun && !desktop);
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
  } = useRunSources(saved, dispatch, () => setRunsOpen(!desktop), initialRun);
  const activeWidget = workspace.activeId ? workspace.widgets[workspace.activeId] : undefined;
  const [search, setSearch] = useState("");
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<SidebarTab>(saved?.tab ?? "settings");
  // Field kinds and per-widget-type candidates, computed once per recording.
  const index = useMemo(() => buildFieldIndex(topics), [topics]);
  const seriesEnvironment = useMemo(
    () => ({ runOpen: run !== null, sources: sourceDetails, index }),
    [run, sourceDetails, index],
  );
  // Views and data loading only see the series that can be shown; settings list them all.
  const shownWorkspace = useMemo(
    () => usableWorkspace(workspace, seriesEnvironment),
    [workspace, seriesEnvironment],
  );
  const [widgetDrag, setWidgetDrag] = useState<Widget["type"] | null>(null);
  // One store per open run; its data stays while groups of the run open and close.
  const store = useMemo(() => new DataStore(runId), [runId]);
  useEffect(() => () => store.clear(), [store]);
  // Widgets read on their own; the sidebar and the playback bar show it all together.
  const records = useActivity(store);
  const busy = records.some((record) => record.status === "loading");
  const fullEnd = info ? Math.max(1e-9, secondsFrom(info.end_ns, info.start_ns)) : 1;
  const [playback] = useState(createPlaybackStore);
  const serverZone = usableTimeZone(run?.timezone);
  const resetWorkspace = useSession(
    { workspace, runId, sources, zoneSource, timeDisplay, tab, sidebarWidth, sidebarOpen },
    restoring,
  );
  const topicDrag = useTopicDrag(topics, index, shownWorkspace, dispatch);
  const clearTopicFilter = () => {
    setSearch("");
    setExpandedTopics(new Set());
  };

  useEffect(() => dispatch({ type: "topic-ids", topics }), [topics]);

  // A new time axis starts paused at its beginning.
  useEffect(() => {
    playback.reset(info ? fullEnd : 0);
  }, [playback, info, fullEnd]);

  return (
    <SeriesEnvironmentContext.Provider value={seriesEnvironment}>
      <DataStoreContext.Provider value={store}>
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
                    onOpenRuns={() => (desktop ? selectRecording() : setRunsOpen(true))}
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
                      records={records}
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
                        state={shownWorkspace}
                        dispatch={dispatch}
                        fieldIndex={index}
                        info={info}
                        sources={sourceDetails}
                        fullEnd={fullEnd}
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
                  <PlaybackBar info={info} fullEnd={fullEnd} busy={busy} />
                </div>
              </SourceNames.Provider>
            </DisplayTimeMode.Provider>
          </DisplayTimeZone.Provider>
        </PlaybackContext.Provider>
      </DataStoreContext.Provider>
    </SeriesEnvironmentContext.Provider>
  );
}
