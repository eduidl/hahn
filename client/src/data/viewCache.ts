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
/** Recording time read ahead of the playback position at normal speed (ADR 0010). */
export const viewLookaheadNs = 10_000_000_000n;
const maxLookaheadWindows = 40;
/** Reads ahead under way at once, leaving the browser's connections to a host for others. */
const maxAheadRequests = 4;
/** Bytes of held windows beyond which no further window is read ahead. */
const maxHeldBytes = 256 * 1024 * 1024;

/** Windows to read ahead of the playback position: further when playing faster. */
export function lookaheadWindows(speed: number) {
  const ns = Number(viewLookaheadNs) * Math.max(1, speed);
  return Math.min(maxLookaheadWindows, Math.ceil(ns / Number(viewWindowNs)));
}

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
  bytes?: number;
};

type AheadTask = { target: ViewTarget; start: bigint; batch: boolean; signal: AbortSignal };

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
  /** Windows to read ahead, nearest to their playback position first. */
  private queue: { task: AheadTask; distance: number }[] = [];
  private aheadRunning = 0;

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

  /** The window at `start` when it has been read, without waiting. */
  peek(target: ViewTarget, start: bigint): ViewWindow | undefined {
    if (this.large.has(targetKey(target))) return { start, tooLarge: true };
    return this.entries.get(windowKey(target, start))?.result;
  }

  /**
   * Reads and keeps the `count` windows after the one at `start`, nearest first, until
   * the returned function lets them go. Views too large to read at once are not read ahead.
   */
  ahead(target: ViewTarget, start: bigint, count: number, batch = false): () => void {
    if (count <= 0 || this.large.has(targetKey(target))) return () => {};
    const controller = new AbortController();
    const releases: (() => void)[] = [];
    for (let i = 1; i <= count; i++) {
      const at = start + BigInt(i) * viewWindowNs;
      releases.push(this.retain(target, at));
      this.queue.push({
        task: { target, start: at, batch, signal: controller.signal },
        distance: i,
      });
    }
    this.queue.sort((a, b) => a.distance - b.distance);
    this.pump();
    return () => {
      this.queue = this.queue.filter(({ task }) => task.signal !== controller.signal);
      // Let go only after whoever follows has joined the reads it shares, as when the
      // playback position moves on by a window.
      queueMicrotask(() => {
        controller.abort();
        for (const release of releases) release();
        this.pump();
      });
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

  /** The frames of a view over a range of recording time, for a moment other than playback's. */
  range(target: ViewTarget, range: { start_ns: string; end_ns: string }, signal: AbortSignal) {
    return fetchViewHistory(target, signal, range);
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
    this.queue = [];
  }

  /** Starts the reads ahead that fit, nearest first. */
  private pump() {
    while (this.aheadRunning < maxAheadRequests && this.queue.length) {
      const { task } = this.queue[0];
      const key = windowKey(task.target, task.start);
      if (task.signal.aborted || this.large.has(targetKey(task.target))) {
        this.queue.shift();
        continue;
      }
      const entry = this.entries.get(key);
      if (entry?.result) {
        this.queue.shift();
        continue;
      }
      if (entry) {
        // Already under way for someone else: wait on it too, so it goes on for this.
        this.queue.shift();
        this.window(task.target, task.start, task.signal, task.batch).catch(() => {});
        continue;
      }
      if (this.heldBytes() >= maxHeldBytes) return;
      this.queue.shift();
      // Small views of a group read ahead the same window together, as one request.
      const together = [task];
      if (task.batch) {
        const rest = [];
        for (const item of this.queue) {
          const other = item.task;
          if (
            other.batch &&
            other.start === task.start &&
            other.target.source === task.target.source
          )
            together.push(other);
          else rest.push(item);
        }
        this.queue = rest;
      }
      this.aheadRunning++;
      void Promise.allSettled(
        together.map((item) => this.window(item.target, item.start, item.signal, item.batch)),
      ).then(() => {
        this.aheadRunning--;
        this.pump();
      });
    }
  }

  private heldBytes() {
    let total = 0;
    for (const entry of this.entries.values())
      if (entry.result && this.pins.has(entry.key)) total += entry.bytes ?? 0;
    return total;
  }

  private read(target: ViewTarget, start: bigint, key: string, batch: boolean) {
    const controller = new AbortController();
    const { signal } = controller;
    const range = { start_ns: String(start), end_ns: String(start + viewWindowNs) };
    // The frame before the window is the last of the window before, when that is kept
    // or being read, as when reading ahead.
    const latest = () => fetchLatestFrame(target, String(start), undefined, signal);
    const before = this.entries.get(windowKey(target, start - viewWindowNs));
    const seed = before
      ? before.promise.then(
          (window) => (window.tooLarge ? latest() : (window.frames.at(-1) ?? window.seed)),
          latest,
        )
      : latest();
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
          const view = targetKey(target);
          // Stopped as another window of the view was found too large.
          if (this.large.has(view)) return { start, tooLarge: true };
          if (!(error instanceof ViewWindowTooLarge)) throw error;
          if (signal.aborted) return { start, tooLarge: true };
          this.large.add(view);
          // The view's other windows, read ahead, would be too large as well.
          for (const other of this.entries.values())
            if (other !== entry && other.key.startsWith(`${view}:`) && !other.result)
              other.controller.abort();
          return { start, tooLarge: true };
        },
      ),
    };
    entry.promise.then(
      (result) => {
        if (this.entries.get(key) !== entry) return;
        if (result.tooLarge) this.entries.delete(key);
        else {
          entry.result = result;
          entry.bytes = result.frames.reduce((sum, frame) => sum + (frame.bytes ?? 0), 0);
        }
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
