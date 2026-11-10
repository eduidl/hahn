import { createContext, useContext } from "react";
import { FieldCache } from "./fieldCache";
import { RunTransforms } from "./runTransforms";

/**
 * Everything the client reads of one open run (ADR 0010). Widgets ask the store for
 * data, and only the store sends requests to the server; it is discarded with the run.
 */
export class DataStore {
  /** Message fields of the run's groups. */
  readonly fields = new FieldCache();
  private readonly runTransforms: RunTransforms | undefined;

  constructor(readonly run: string | null) {
    this.runTransforms = run === null ? undefined : new RunTransforms(`/api/runs/${run}`);
  }

  /** The run's transforms, given the run's URL; none for another run. */
  transforms(runUrl: string): RunTransforms | undefined {
    return this.runTransforms?.run === runUrl ? this.runTransforms : undefined;
  }

  /** Forgets what has been read and stops the requests under way. */
  clear() {
    this.fields.clear();
    this.runTransforms?.clear();
  }
}

export const DataStoreContext = createContext<DataStore | null>(null);

/** The store of the open run. */
export function useDataStore(): DataStore {
  const store = useContext(DataStoreContext);
  if (!store) throw new Error("No data store is provided");
  return store;
}
