/** How the reading of one series stands, as the sidebar and the playback bar show it. */
export type LoadRecord = {
  key: string;
  source: string;
  topic: string;
  topicName?: string;
  status: "loading" | "complete" | "error";
  received: number;
  error?: string;
};

/**
 * What the widgets of the open run are reading, gathered from each of them: they
 * read on their own, while the sidebar and the playback bar show it all together.
 */
export class Activity {
  private reports = new Map<symbol, readonly LoadRecord[]>();
  private snapshot: readonly LoadRecord[] = [];
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  /** Replaces what `reporter` reads; an empty list removes it. */
  report(reporter: symbol, records: readonly LoadRecord[]) {
    if (!records.length && !this.reports.has(reporter)) return;
    if (records.length) this.reports.set(reporter, records);
    else this.reports.delete(reporter);
    this.snapshot = [...this.reports.values()].flat();
    for (const listener of this.listeners) listener();
  }
}
