import { createContext, useContext } from "react";
import { isMetaPath, type Info, type Run, type Topic } from "../types";

export async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

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
  info: Info | null;
  topics: Topic[];
  error: string;
  loading: boolean;
};

/**
 * The shared time axis of the open groups: earliest start to latest end.
 * Null until every group has settled, so the origin does not move while
 * loading; groups that failed to load are left out.
 */
export function mergeInfo(sources: (LoadedSource | undefined)[]): Info | null {
  if (sources.some((s) => !s || s.loading)) return null;
  const infos = sources.flatMap((s) => (s?.info ? [s.info] : []));
  if (!infos.length) return null;
  const min = (a: string, b: string) => (BigInt(a) <= BigInt(b) ? a : b);
  const max = (a: string, b: string) => (BigInt(a) >= BigInt(b) ? a : b);
  return {
    start_ns: infos.map((i) => i.start_ns).reduce(min),
    end_ns: infos.map((i) => i.end_ns).reduce(max),
    message_count: infos.every((i) => i.message_count !== null)
      ? infos.reduce((n, i) => n + i.message_count!, 0)
      : null,
  };
}
