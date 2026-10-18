import { createContext, useContext } from "react";
import type { Info, Topic } from "./types";

/** Display names of the open recordings, by file id. */
export const SourceNames = createContext<ReadonlyMap<number, string>>(new Map());

/** The recording name to show next to a series, only when several are open. */
export function useSourceLabel(source: number): string | undefined {
  const names = useContext(SourceNames);
  return names.size > 1 ? names.get(source) : undefined;
}

/** One open recording as loaded from the server. */
export type LoadedSource = {
  info: Info | null;
  topics: Topic[];
  error: string;
  loading: boolean;
};

/**
 * The shared time axis of the open recordings: earliest start to latest end.
 * Null until every recording has settled, so the origin does not move while
 * loading; recordings that failed to load are left out.
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
