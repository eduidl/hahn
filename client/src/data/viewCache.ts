import type { Selected } from "../types";
import {
  fetchLatestFrame,
  fetchViewHistory,
  ViewBatches,
  ViewWindowTooLarge,
  type ViewFrame,
} from "./viewFrames";

type ViewTarget = Pick<Selected, "source" | "topic" | "view">;

/** Recording time covered by one window of a view. */
export const viewWindowNs = 1_000_000_000n;
/** Windows kept once no view shows them, for seeking back. */
const keptWindows = 8;
/** A window larger than this is not read at once; its frames are read one at a time. */
const maxWindowBytes = 8 * 1024 * 1024;

/**
 * The frames of one window of recording time, with the frame before it, or the
 * finding that the window is too large to read at once.
 */
export type ViewWindow =
  | { start: bigint; seed: ViewFrame | null; frames: ViewFrame[]; tooLarge?: undefined }
  | { start: bigint; tooLarge: true; seed?: undefined; frames?: undefined };

type Entry<T> = {
  key: string;
  controller: AbortController;
  promise: Promise<T>;
  result?: T;
  /** Requests waiting for the result; when the last one leaves, the read stops. */
  waiting: number;
};

const targetKey = (target: ViewTarget) =>
  JSON.stringify([target.source, target.topic, target.view ?? ""]);
const windowKey = (target: ViewTarget, start: bigint) => `${targetKey(target)}:${start}`;
const aborted = () => new DOMException("Aborted", "AbortError");

/**
 * Windows of views at the playback position, shared by every widget that shows the
 * view. A window is read once; views shown together share it, and those kept let
 * playback seek back without reading it again.
 */
export class ViewCache {
  private entries = new Map<string, Entry<ViewWindow>>();
  private pins = new Map<string, number>();
  private histories = new Map<string, Entry<ViewFrame[]>>();
  private historyPins = new Map<string, number>();
  /** Views whose windows are too large to read at once. */
  private large = new Set<string>();
  private batches = new ViewBatches();

  /**
   * The window starting at `start`, a multiple of `viewWindowNs`. With `batch`, it is
   * read together with other small views of the group requested at the same time.
   */
  window(
    target: ViewTarget,
    start: bigint,
    signal: AbortSignal,
    batch = false,
  ): Promise<ViewWindow> {
    if (this.large.has(targetKey(target))) return Promise.resolve({ start, tooLarge: true });
    const key = windowKey(target, start);
    let entry = this.entries.get(key);
    if (entry?.result) {
      // Recently used windows are kept longest.
      this.entries.delete(key);
      this.entries.set(key, entry);
      return Promise.resolve(entry.result);
    }
    if (!entry) entry = this.read(target, start, key, batch);
    return join(entry, signal, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
  }

  /** Every frame of a view, ordered by time, read once while any widget holds it. */
  history(target: ViewTarget, signal: AbortSignal): Promise<ViewFrame[]> {
    const key = targetKey(target);
    let entry = this.histories.get(key);
    if (entry?.result) return Promise.resolve(entry.result);
    if (!entry) {
      const controller = new AbortController();
      const created: Entry<ViewFrame[]> = {
        key,
        controller,
        waiting: 0,
        promise: fetchViewHistory(target, controller.signal),
      };
      created.promise.then(
        (frames) => {
          if (this.histories.get(key) !== created) return;
          if (this.historyPins.has(key)) created.result = frames;
          else this.histories.delete(key);
        },
        () => {
          if (this.histories.get(key) === created) this.histories.delete(key);
        },
      );
      this.histories.set(key, created);
      entry = created;
    }
    const current = entry;
    return join(current, signal, () => {
      if (this.histories.get(key) === current) this.histories.delete(key);
    });
  }

  /** Keeps the history of a view while it is shown; it goes once no widget holds it. */
  retainHistory(target: ViewTarget) {
    const key = targetKey(target);
    this.historyPins.set(key, (this.historyPins.get(key) ?? 0) + 1);
    return () => {
      const count = (this.historyPins.get(key) ?? 1) - 1;
      if (count) return void this.historyPins.set(key, count);
      this.historyPins.delete(key);
      const entry = this.histories.get(key);
      if (entry && (entry.result || !entry.waiting)) {
        entry.controller.abort();
        this.histories.delete(key);
      }
    };
  }

  /** Keeps the window at `start` while it is shown. */
  retain(target: ViewTarget, start: bigint) {
    const key = windowKey(target, start);
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    return () => {
      const count = (this.pins.get(key) ?? 1) - 1;
      if (count) this.pins.set(key, count);
      else this.pins.delete(key);
      this.evict();
    };
  }

  /** The frame current at `ns`, for views whose windows are too large to read at once. */
  latest(target: ViewTarget, ns: string, known: ViewFrame | null | undefined, signal: AbortSignal) {
    return fetchLatestFrame(target, ns, known, signal);
  }

  /** Forgets every window and stops the reads under way. */
  clear() {
    for (const entry of [...this.entries.values(), ...this.histories.values()])
      entry.controller.abort();
    this.entries.clear();
    this.pins.clear();
    this.histories.clear();
    this.historyPins.clear();
    this.large.clear();
    this.batches = new ViewBatches();
  }

  private read(target: ViewTarget, start: bigint, key: string, batch: boolean) {
    const controller = new AbortController();
    const { signal } = controller;
    const range = { start_ns: String(start), end_ns: String(start + viewWindowNs) };
    // The frame before the window is the last of the window before, when that is kept.
    const before = this.entries.get(windowKey(target, start - viewWindowNs))?.result;
    const seed =
      before && !before.tooLarge
        ? Promise.resolve(before.frames.at(-1) ?? before.seed)
        : fetchLatestFrame(target, String(start), undefined, signal);
    const frames = batch
      ? this.batches.fetch(target, signal, range)
      : fetchViewHistory(target, signal, range, maxWindowBytes);
    const entry: Entry<ViewWindow> = {
      key,
      controller,
      waiting: 0,
      promise: Promise.all([seed, frames]).then(
        ([seed, frames]): ViewWindow => ({ start, seed, frames }),
        (error): ViewWindow => {
          if (!(error instanceof ViewWindowTooLarge)) throw error;
          if (!signal.aborted) this.large.add(targetKey(target));
          return { start, tooLarge: true };
        },
      ),
    };
    entry.promise.then(
      (result) => {
        if (this.entries.get(key) !== entry) return;
        if (result.tooLarge) this.entries.delete(key);
        else entry.result = result;
        this.evict();
      },
      // A failed window is read again when next asked for.
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.entries.set(key, entry);
    return entry;
  }

  private evict() {
    const unheld = [...this.entries.values()].filter(
      (entry) => entry.result && !this.pins.has(entry.key),
    );
    for (const entry of unheld.slice(0, Math.max(0, unheld.length - keptWindows)))
      this.entries.delete(entry.key);
  }
}

/**
 * Waits for `entry` until `signal` aborts. When the last waiter leaves before the
 * result, the read stops and `drop` forgets it.
 */
function join<T>(entry: Entry<T>, signal: AbortSignal, drop: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    entry.waiting++;
    let settled = false;
    const settle = () => {
      settled = true;
      entry.waiting--;
      signal.removeEventListener("abort", leave);
    };
    const leave = () => {
      if (settled) return;
      settle();
      if (!entry.waiting && entry.result === undefined) {
        entry.controller.abort();
        drop();
      }
      reject(aborted());
    };
    signal.addEventListener("abort", leave, { once: true });
    entry.promise.then(
      (result) => {
        if (settled) return;
        settle();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settle();
        reject(error);
      },
    );
  });
}
