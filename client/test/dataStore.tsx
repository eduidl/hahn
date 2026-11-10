import type { ReactNode } from "react";
import { DataStore, DataStoreContext } from "../src/data/store";

/** A store of `run` for what is rendered, as the app provides for the open run. */
export function withStore(run: string | null = "r", store = new DataStore(run)) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DataStoreContext.Provider value={store}>{children}</DataStoreContext.Provider>
  );
  return { store, wrapper };
}
