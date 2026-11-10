import { createContext, useContext } from "react";
import {
  flattenFields,
  isMetaPath,
  metaFields,
  type Info,
  type RecordingInfo,
  type Run,
  type Schemas,
  type Topic,
} from "../types";

/** Keep display names separate from the server's unique topic identifiers. */
export function sourceTopics(source: string, topics: Schemas["Topic"][]): Topic[] {
  const counts = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (const topic of topics) counts.set(topic.topic, (counts.get(topic.topic) ?? 0) + 1);
  return topics.map((topic) => {
    const ordinal = (ordinals.get(topic.topic) ?? 0) + 1;
    ordinals.set(topic.topic, ordinal);
    return {
      ...topic,
      topicName: counts.get(topic.topic)! > 1 ? `${topic.topic} [${ordinal}]` : topic.topic,
      topic: topic.id,
      source,
      fields: [...flattenFields(topic.fields), ...metaFields(topic.meta_fields)],
    };
  });
}

export { HttpError } from "./errors";

/** Identifies an open group of the open run. Ids never contain a slash. */
export const sourceOf = (run: string, group: string) => `${run}/${group}`;
export function sourceUrl(source: string) {
  const [run, group] = source.split("/");
  return `/api/runs/${run}/groups/${group}`;
}

/** Coordinate frames belong to the run, whichever group a value came from. */
export const runUrl = (source: string) => `/api/runs/${source.split("/")[0]}`;

/** What opening a run shows: a lone group always, otherwise the server's defaults. */
export function initialSources(run: Run): string[] {
  const groups =
    run.groups.length === 1 ? run.groups : run.groups.filter((group) => group.default_open);
  return groups.map((group) => sourceOf(run.id, group.id));
}

/** Selects a field of the message, or a meta field beside it. */
export function setField(params: URLSearchParams, path: string[]) {
  if (isMetaPath(path)) params.set("meta", path[1]);
  else if (path.length) params.set("path", JSON.stringify(path));
}

/** Where a field's history is read. `exact` also keeps long strings whole, for scalars only. */
export function messagesUrl(
  target: { source: string; topic: string; path: string[] },
  options: { range?: { start_ns: string; end_ns: string }; exact?: boolean } = {},
) {
  const params = new URLSearchParams({ topic: target.topic, ...options.range });
  setField(params, target.path);
  if (options.exact && !isMetaPath(target.path)) params.set("preview", "false");
  return `${sourceUrl(target.source)}/messages?${params}`;
}

/** Display names of the open groups, by source. */
export const SourceNames = createContext<ReadonlyMap<string, string>>(new Map());

/** The group name to show next to a series, only when several are open. */
export function useSourceLabel(source: string): string | undefined {
  const names = useContext(SourceNames);
  return names.size > 1 ? names.get(source) : undefined;
}

/** One open group as loaded from the server. */
export type LoadedSource = {
  info: RecordingInfo | null;
  topics: Topic[];
  error: string;
  loading: boolean;
};

/** A group the user has open, with whatever has loaded of it so far. */
export type OpenSource = LoadedSource & { id: string };

/**
 * The shared time axis of the open groups: earliest start to latest end.
 * Null until every group has settled, so the origin does not move while
 * loading; groups that failed to load are left out. Groups without messages
 * add to the count but not to the axis, and with no messages at all there is none.
 */
export function mergeInfo(sources: (LoadedSource | undefined)[]): Info | null {
  if (sources.some((s) => !s || s.loading)) return null;
  const infos = sources.flatMap((s) => (s?.info ? [s.info] : []));
  const ranged = infos.filter((i): i is Info => i.start_ns !== undefined && i.end_ns !== undefined);
  if (!ranged.length) return null;
  const min = (a: string, b: string) => (BigInt(a) <= BigInt(b) ? a : b);
  const max = (a: string, b: string) => (BigInt(a) >= BigInt(b) ? a : b);
  return {
    start_ns: ranged.map((i) => i.start_ns).reduce(min),
    end_ns: ranged.map((i) => i.end_ns).reduce(max),
    message_count: infos.every((i) => i.message_count !== null)
      ? infos.reduce((n, i) => n + i.message_count!, 0)
      : null,
  };
}
