import { topicKey, type Topic } from "../types";
import type { CachedSeries } from "../data/useSeries";

export function ErrorsTab({
  count,
  error,
  sourceErrors,
  runtimeErrors,
  unreadable,
  multiSource,
  sourceNames,
}: {
  count: number;
  error: string;
  sourceErrors: { group: { source: string; name: string }; error: string }[];
  runtimeErrors: Pick<CachedSeries, "key" | "source" | "topic" | "topicName" | "error">[];
  unreadable: Topic[];
  multiSource: boolean;
  sourceNames: Map<string, string>;
}) {
  return (
    <div
      id="sidebar-errors"
      className="sidebar-content errors-panel"
      role="tabpanel"
      aria-labelledby="tab-errors"
    >
      <div className="field-heading">
        <span className="eyebrow">Errors</span>
        <span>{count}</span>
      </div>
      {!count && <p className="muted">No errors</p>}
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
  );
}
