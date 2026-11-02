import "./Sidebar.css";
import { useState, type Dispatch, type DragEvent, type SetStateAction } from "react";
import { ErrorsTab } from "./ErrorsTab";
import type { FieldIndex } from "./fieldIndex";
import type { SidebarTab } from "./persistence";
import { SidebarResizer } from "./SidebarResizer";
import { TopicsTab } from "./TopicsTab";
import type { useTopicDrag } from "./useTopicDrag";
import { WidgetSettings } from "./WidgetSettings";
import { useSeriesViewProblems } from "../views/seriesViewProblem";
import type { Widget, WorkspaceAction } from "./widgets";
import type { CachedSeries } from "../data/useSeries";
import type { MessageRecord } from "../data/useMessages";
import { topicKey, type Info, type Topic } from "../types";

export function Sidebar({
  tab,
  setTab,
  activeWidget,
  dispatch,
  records,
  index,
  topics,
  sourceNames,
  multiSource,
  loadingInfo,
  info,
  search,
  setSearch,
  expandedTopics,
  setExpandedTopics,
  error,
  sourceErrors,
  topicDrag,
  onResize,
  onReset,
}: {
  tab: SidebarTab;
  setTab: (tab: SidebarTab) => void;
  activeWidget: Widget | undefined;
  dispatch: Dispatch<WorkspaceAction>;
  records: (CachedSeries | MessageRecord)[];
  index: FieldIndex;
  topics: Topic[];
  sourceNames: Map<string, string>;
  multiSource: boolean;
  loadingInfo: boolean;
  info: Info | null;
  search: string;
  setSearch: (search: string) => void;
  expandedTopics: Set<string>;
  setExpandedTopics: Dispatch<SetStateAction<Set<string>>>;
  error: string;
  sourceErrors: { group: { source: string; name: string }; error: string }[];
  topicDrag: ReturnType<typeof useTopicDrag>;
  onResize: (width: number | null) => void;
  onReset: () => void;
}) {
  const [showErrorTopics, setShowErrorTopics] = useState(false);
  const runtimeErrors = [
    ...new Map(
      records.filter((r) => r.error).map((r) => [`${topicKey(r.source, r.topic)}:${r.error}`, r]),
    ).values(),
  ];
  const unreadable = topics.filter((t) => t.error);
  const viewProblems = useSeriesViewProblems();
  const errorCount =
    unreadable.length +
    runtimeErrors.length +
    viewProblems.length +
    sourceErrors.length +
    (error ? 1 : 0);
  return (
    <aside>
      <SidebarResizer onResize={onResize} />
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
        <TopicsTab
          topics={topics}
          sourceNames={sourceNames}
          multiSource={multiSource}
          loadingInfo={loadingInfo}
          info={info}
          search={search}
          setSearch={setSearch}
          expandedTopics={expandedTopics}
          setExpandedTopics={setExpandedTopics}
          showErrorTopics={showErrorTopics}
          setShowErrorTopics={setShowErrorTopics}
          onAdd={topicDrag.addToSelected}
          onDragStart={topicDrag.startDrag}
          onDragEnd={topicDrag.endDrag}
        />
      )}
      {tab === "settings" && (
        <div
          id="sidebar-settings"
          className="sidebar-content widget-settings"
          role="tabpanel"
          aria-labelledby="tab-settings"
          onDragOver={topicDrag.acceptDrag}
          onDrop={(event: DragEvent) => topicDrag.drop(event)}
        >
          {activeWidget ? (
            <WidgetSettings
              widget={activeWidget}
              dispatch={dispatch}
              records={records}
              index={index}
            />
          ) : (
            <p className="muted">Add a widget.</p>
          )}
        </div>
      )}
      {tab === "errors" && (
        <ErrorsTab
          count={errorCount}
          error={error}
          sourceErrors={sourceErrors}
          runtimeErrors={runtimeErrors}
          viewProblems={viewProblems}
          unreadable={unreadable}
          multiSource={multiSource}
          sourceNames={sourceNames}
        />
      )}
      <p className="sidebar-status" role="status">
        {topicDrag.addStatus}
      </p>
      <footer className="sidebar-footer">
        {tab === "topics" && <span>Drag or double-click to add</span>}
        <button className="reset-workspace" onClick={onReset}>
          Reset workspace
        </button>
      </footer>
    </aside>
  );
}
