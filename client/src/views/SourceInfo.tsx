import "./SourceInfo.css";
import { useContext } from "react";
import { SourceNames, type OpenSource } from "../data/sources";
import { useTimeFormatter } from "../timeDisplay";
import type { Info } from "../types";

/** Exact span of a range, to the millisecond. Nanosecond times do not fit a Number. */
export function formatDuration(info: Pick<Info, "start_ns" | "end_ns">): string {
  const ms = (BigInt(info.end_ns) - BigInt(info.start_ns)) / 1_000_000n;
  const hours = ms / 3_600_000n;
  const minutes = (ms / 60_000n) % 60n;
  const seconds = (ms / 1_000n) % 60n;
  const millis = String(ms % 1_000n).padStart(3, "0");
  const pad = (value: bigint) => String(value).padStart(2, "0");
  if (hours) return `${hours}h ${pad(minutes)}m ${pad(seconds)}.${millis}s`;
  if (minutes) return `${minutes}m ${pad(seconds)}.${millis}s`;
  return `${seconds}.${millis}s`;
}

/** The open groups' time range and topics. */
export function SourceInfo({ info, sources }: { info: Info | null; sources: OpenSource[] }) {
  const names = useContext(SourceNames);
  const start = useTimeFormatter(info?.start_ns ?? null, "absolute");
  const end = useTimeFormatter(info?.end_ns ?? null, "absolute");
  if (!sources.length) return <p className="widget-status">Open a run from the header</p>;
  if (sources.some((source) => source.loading)) return <p className="widget-status">Loading…</p>;
  const failed = sources.filter((source) => source.error);
  const multiple = sources.length > 1;
  const topicCount = sources.reduce((count, source) => count + source.topics.length, 0);
  return (
    <div className="source-info">
      {failed.map((source) => (
        <p key={source.id} className="widget-status widget-status-error" role="alert">
          {names.get(source.id) ?? source.id}: {source.error}
        </p>
      ))}
      {!info && failed.length < sources.length && <p className="widget-status">No messages</p>}
      {info && (
        <dl className="source-info-summary">
          <dt>Start</dt>
          <dd>{start.tooltip(0)}</dd>
          <dt>End</dt>
          <dd>{end.tooltip(0)}</dd>
          <dt>Duration</dt>
          <dd>{formatDuration(info)}</dd>
          <dt>Messages</dt>
          <dd>{info.message_count?.toLocaleString() ?? "—"}</dd>
          <dt>Topics</dt>
          <dd>{topicCount.toLocaleString()}</dd>
        </dl>
      )}
      {topicCount > 0 && (
        <table className="source-info-topics">
          <thead>
            <tr>
              {multiple && <th scope="col">Group</th>}
              <th scope="col">Topic</th>
              <th scope="col">Schema</th>
              <th scope="col" className="number">
                Messages
              </th>
            </tr>
          </thead>
          <tbody>
            {sources.flatMap((source) =>
              source.topics.map((topic) => (
                <tr key={`${source.id}/${topic.topic}`}>
                  {multiple && <td>{names.get(source.id) ?? source.id}</td>}
                  <td>
                    {topic.topicName ?? topic.topic}
                    {topic.error && <div className="widget-status-error">{topic.error}</div>}
                  </td>
                  <td>{topic.schema_name ?? "—"}</td>
                  <td className="number">{topic.message_count?.toLocaleString() ?? "—"}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
