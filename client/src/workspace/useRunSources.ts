import { useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import type { Session } from "./persistence";
import type { WorkspaceAction } from "./widgets";
import {
  HttpError,
  initialSources,
  mergeInfo,
  sourceOf,
  sourceTopics,
  sourceUrl,
  type LoadedSource,
} from "../data/sources";
import { get } from "../data/request";
import { errorMessage, type RecordingInfo, type Run, type Schemas } from "../types";

/**
 * The open run and its groups: what is open, what has loaded, and the restore of a saved session.
 * `onRestoreFailed` asks the user for another run when the saved one could not be loaded.
 */
export function useRunSources(
  saved: Session | null | undefined,
  dispatch: Dispatch<WorkspaceAction>,
  onRestoreFailed: () => void,
) {
  const [runId, setRunId] = useState<string | null>(saved?.runId ?? null);
  // The saved session until its run is confirmed. Saving waits for that, so a
  // half-restored state cannot overwrite the session.
  const pendingRestore = useRef(saved?.runId ? saved : null);
  const [restoring, setRestoring] = useState(Boolean(saved?.runId));
  const [run, setRun] = useState<Run | null>(null);
  const previousRun = useRef<Run | null>(null);
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
  const loadingInfo = openSources.some((s) => !s || s.loading);
  const [error, setError] = useState("");
  const groups = (run?.groups ?? []).map((group) => ({
    source: sourceOf(run!.id, group.id),
    name: group.name,
  }));
  const openGroups = sources.flatMap((id) => groups.filter((g) => g.source === id));
  const sourceNames = useMemo(
    () => new Map(openGroups.map((g) => [g.source, g.name])),
    [JSON.stringify(openGroups)],
  );
  const sourceErrors = openGroups.flatMap((group) =>
    loaded[group.source]?.error ? [{ group, error: loaded[group.source].error }] : [],
  );

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
        const groupNames = new Map(
          previousRun.current?.groups.map((group) => [
            sourceOf(previousRun.current!.id, group.id),
            group.name,
          ]),
        );
        dispatch({
          type: "sources",
          open: new Set(open),
          keepViews: restored,
          rebind:
            restored || !open.length
              ? undefined
              : (source) => {
                  if (existing.includes(source)) return source;
                  const same = detail.groups.find((group) => group.name === groupNames.get(source));
                  return same ? sourceOf(detail.id, same.id) : open[0];
                },
        });
        pendingRestore.current = null;
        setRestoring(false);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(e));
        if (pendingRestore.current?.runId !== runId) return;
        setRunId(null);
        onRestoreFailed();
        // A run the server no longer has is gone for good. Anything else may be
        // a server restart, so keep the session for the next reload.
        if (e instanceof HttpError && e.code === "run_not_found") {
          pendingRestore.current = null;
          setRestoring(false);
          dispatch({ type: "sources", open: new Set(), keepViews: true });
        }
      });
    return () => controller.abort();
  }, [runId]);

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
        get<RecordingInfo>(sourceUrl(id), controller.signal),
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
    return () => {
      for (const controller of current.values()) controller.abort();
    };
  }, []);

  /** Switch runs: everything stays, and each series moves to the new run's matching group. */
  const selectRun = (id: string) => {
    if (run) previousRun.current = run;
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
    setRunId(id);
  };

  /** Open or close a group. Series of a closed group wait until it is open again. */
  const toggleSource = (id: string, open: boolean) => {
    const next = open ? [...sources.filter((s) => s !== id), id] : sources.filter((s) => s !== id);
    setSources(next);
    setLoaded((current) => {
      const kept = { ...current };
      if (!open) delete kept[id];
      return kept;
    });
    dispatch({ type: "sources", open: new Set(next) });
  };

  return {
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
  };
}
