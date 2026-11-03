import type { Dispatch, DragEvent, SetStateAction } from "react";
import { Highlight } from "../Highlight";
import { matchesTerms, searchTerms } from "../search";
import { typeLabel } from "./fieldIndex";
import { keyOf, topicKey, type Field, type Info, type Topic, type TopicDrag } from "../types";

type DragHandlers = {
  onAdd: (payload: TopicDrag) => void;
  onDragStart: (event: DragEvent, payload: TopicDrag) => void;
  onDragEnd: () => void;
};

function TopicField({
  topic,
  field,
  search,
  onAdd,
  onDragStart,
  onDragEnd,
}: DragHandlers & { topic: Topic; field: Field; search: string }) {
  return (
    <div
      className="field topic-field"
      // Not a <button>: Firefox does not drag those.
      role="button"
      tabIndex={0}
      draggable
      onDoubleClick={() => onAdd({ source: topic.source, topic: topic.topic, path: field.path })}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onAdd({ source: topic.source, topic: topic.topic, path: field.path });
      }}
      onDragStart={(e) =>
        onDragStart(e, {
          source: topic.source,
          topic: topic.topic,
          path: field.path,
        })
      }
      onDragEnd={onDragEnd}
    >
      <span title={field.path.join(".")}>
        <Highlight text={field.path.join(".")} query={search} />
      </span>
      {/* The concrete type suffices: nesting already tells structs apart. */}
      <small title={field.type_name ?? field.data_type}>{typeLabel(topic, field)}</small>
    </div>
  );
}

export function TopicsTab({
  topics,
  sourceNames,
  multiSource,
  loadingInfo,
  info,
  search,
  setSearch,
  expandedTopics,
  setExpandedTopics,
  showErrorTopics,
  setShowErrorTopics,
  onAdd,
  onDragStart,
  onDragEnd,
}: DragHandlers & {
  topics: Topic[];
  sourceNames: Map<string, string>;
  multiSource: boolean;
  loadingInfo: boolean;
  info: Info | null;
  search: string;
  setSearch: (search: string) => void;
  expandedTopics: Set<string>;
  setExpandedTopics: Dispatch<SetStateAction<Set<string>>>;
  showErrorTopics: boolean;
  setShowErrorTopics: (show: boolean) => void;
}) {
  const terms = searchTerms(search);
  const visibleTopics = topics
    .filter((t) => showErrorTopics || !t.error)
    .flatMap((t) => {
      const name = t.topicName ?? t.topic;
      const topicMatch = matchesTerms(name, terms);
      // The same text the field pickers search, so a word can come from either part.
      const fields = t.fields.filter(
        (f) => topicMatch || matchesTerms(`${name} · ${f.path.join(".")}`, terms),
      );
      return topicMatch || fields.length ? [{ topic: t, fields }] : [];
    });
  return (
    <div
      id="sidebar-topics"
      className="sidebar-content"
      role="tabpanel"
      aria-labelledby="tab-topics"
    >
      <input
        className="text-input search"
        aria-label="Search fields"
        placeholder="Search topics and fields…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setExpandedTopics(
            new Set(e.target.value ? topics.map((t) => topicKey(t.source, t.topic)) : []),
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
      <div className="topics-toolbar">
        <span>
          {visibleTopics.length} / {topics.length} topics
        </span>
        <button
          className="collapse-topics"
          onClick={() => setExpandedTopics(new Set())}
          disabled={expandedTopics.size === 0}
        >
          Collapse all
        </button>
      </div>
      <div className="topics">
        {loadingInfo && <p className="muted">Loading group information…</p>}
        {visibleTopics.map(({ topic: t, fields }, i) => {
          const id = topicKey(t.source, t.topic);
          // Several recordings: head each one's topics with its name.
          const heading = multiSource && visibleTopics[i - 1]?.topic.source !== t.source && (
            <div className="source-heading" key={`source-${t.source}`}>
              {sourceNames.get(t.source)}
            </div>
          );
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
                onDragStart={(e) => onDragStart(e, { source: t.source, topic: t.topic })}
                onDragEnd={onDragEnd}
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
                fields.map((f) => (
                  <TopicField
                    key={keyOf(t.source, t.topic, f.path)}
                    topic={t}
                    field={f}
                    search={search}
                    onAdd={onAdd}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                  />
                ))
              ) : (
                <p className="muted">No fields</p>
              )}
            </details>,
          ];
        })}
        {!loadingInfo && info && !visibleTopics.length && (
          <p className="muted">
            {terms.length ? "No matching topics or fields" : "No topics to display"}
          </p>
        )}
      </div>
    </div>
  );
}
