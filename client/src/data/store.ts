import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { Schemas } from "../types";
import { Activity, type LoadRecord } from "./activity";
import { createCalibrationLoader } from "./calibration";
import { FieldCache } from "./fieldCache";
import { Once } from "./once";
import { get } from "./request";
import { RunTransforms } from "./runTransforms";
import { ViewCache } from "./viewCache";

/**
 * Everything the client reads of one open run (ADR 0010). Widgets ask the store for
 * data, and only the store sends requests to the server; it is discarded with the run.
 */
export class DataStore {
  /** What the widgets are reading, for showing it all together. */
  readonly activity = new Activity();
  /** Message fields of the run's groups. */
  readonly fields = new FieldCache();
  /** Views of the run's groups at the playback position. */
  readonly views = new ViewCache();
  /** The calibration of an image, read for each second of images. */
  calibration = createCalibrationLoader();
  /** The coordinate frames of the run, as listed once for all its views. */
  readonly frames: Once<Schemas["FrameInfo"][]> | undefined;
  private readonly runTransforms: RunTransforms | undefined;

  constructor(readonly run: string | null) {
    const url = `/api/runs/${run}`;
    this.runTransforms = run === null ? undefined : new RunTransforms(url);
    this.frames =
      run === null
        ? undefined
        : new Once(
            async (signal) => (await get<Schemas["FrameList"]>(`${url}/frames`, signal)).frames,
          );
  }

  /** The run's transforms, given the run's URL; none for another run. */
  transforms(runUrl: string): RunTransforms | undefined {
    return this.runTransforms?.run === runUrl ? this.runTransforms : undefined;
  }

  /** Forgets what has been read and stops the requests under way. */
  clear() {
    this.fields.clear();
    this.views.clear();
    this.calibration.clear();
    this.calibration = createCalibrationLoader();
    this.runTransforms?.clear();
    this.frames?.clear();
  }
}

/** Tells the store what the caller reads, until it unmounts. */
export function useReportActivity(records: readonly LoadRecord[]) {
  const { activity } = useDataStore();
  const [reporter] = useState(() => Symbol("activity"));
  // Records change in place, so their content says when to report them again.
  const content = JSON.stringify(
    records.map(({ key, source, topic, topicName, status, received, error }) => ({
      key,
      source,
      topic,
      topicName,
      status,
      received,
      error,
    })),
  );
  useEffect(() => activity.report(reporter, JSON.parse(content)), [activity, reporter, content]);
  useEffect(() => () => activity.report(reporter, []), [activity, reporter]);
}

/** What all the widgets are reading. */
export function useActivity(store: DataStore) {
  return useSyncExternalStore(store.activity.subscribe, store.activity.getSnapshot);
}

export const DataStoreContext = createContext<DataStore | null>(null);

/** The store of the open run. */
export function useDataStore(): DataStore {
  const store = useContext(DataStoreContext);
  if (!store) throw new Error("No data store is provided");
  return store;
}
