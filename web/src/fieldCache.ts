import { createContext, useContext } from "react";
import { consumeStream, type StreamEvent } from "./data";
import type { Json, MessageRow } from "./table";
import { keyOf, type Selected } from "./types";

export type FieldTarget = Pick<Selected, "source" | "topic" | "path">;
type Cell = { value: Json } | { children: string[] };
type FieldRef = { cell: Cell; exact: boolean; users: number };
type Block = {
  source: number;
  topic: string;
  path: string[];
  scope: string;
  times: string[];
  /** IDs distinguish messages sharing a timestamp, consistently across field requests. */
  ids: string[];
  ordinals: Map<string, number>;
  columns: Map<string, (FieldRef | undefined)[]>;
  complete: boolean;
};
type Listener = (event: StreamEvent<MessageRow>) => void;
type Job = { block: Block; controller: AbortController; listeners: Set<Listener>; done: Promise<void> };
const prefix = (parent: string[], child: string[]) => parent.length <= child.length && parent.every((p, i) => p === child[i]);
const pathKey = (path: string[]) => JSON.stringify(path);
const compound = (value: Json): value is Record<string, Json> => value !== null && typeof value === "object" && !Array.isArray(value)
  && !("$bytes" in value) && !("$truncated" in value);

/** Recording-owned cache. Structures contain child references, not duplicate leaf values.
 * Full histories and bounded playback windows use the same representation. A block
 * owns its message index, so values from different messages are never zipped by time.
 */
export class FieldCache {
  private blocks: Block[] = [];
  /** One value per source/topic/field/message, shared by all projections and windows. */
  private fields = new Map<string, Map<string, FieldRef>>();
  private jobs = new Map<string, Job>();
  private generation = 0;
  private pins = new Map<symbol, { target: FieldTarget; scope: string }>();
  private seeds = new Map<string, { controller: AbortController; result: Promise<MessageRow | null> }>();
  private listeners = new Set<() => void>();
  revision = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { this.revision++; this.listeners.forEach((listener) => listener()); }

  clear() {
    this.generation++;
    this.jobs.forEach((job) => job.controller.abort());
    this.jobs.clear();
    this.seeds.forEach((seed) => seed.controller.abort());
    this.seeds.clear();
    this.blocks = [];
    this.fields.clear();
    this.pins.clear();
    this.changed();
  }

  private block(target: FieldTarget, scope: string): Block {
    const block: Block = { ...target, path: [...target.path], scope, times: [], ids: [], ordinals: new Map(), columns: new Map(), complete: false };
    this.blocks.push(block);
    return block;
  }

  private append(block: Block, rows: MessageRow[], exact = false) {
    // Equal-time ties preserve source order; chunk boundaries never split a timestamp.
    let previous = block.times.at(-1);
    let reorder = false;
    for (const row of rows) {
      if (previous !== undefined && BigInt(row.time_ns) < BigInt(previous)) reorder = true;
      const ordinal = block.ordinals.get(row.time_ns) ?? 0;
      block.ordinals.set(row.time_ns, ordinal + 1);
      const index = block.times.length;
      block.times.push(row.time_ns);
      block.ids.push(`${row.time_ns}:${ordinal}`);
      previous = row.time_ns;
      const put = (path: string[], value: Json) => {
        const key = pathKey(path);
        let column = block.columns.get(key);
        if (!column) { column = []; block.columns.set(key, column); }
        const cell: Cell = compound(value) ? { children: Object.keys(value) } : { value };
        const fieldKey = keyOf(block.source, block.topic, path);
        let samples = this.fields.get(fieldKey);
        if (!samples) { samples = new Map(); this.fields.set(fieldKey, samples); }
        const id = block.ids[index];
        let ref = samples.get(id);
        // Preview strings must never overwrite exact scalar values.
        const precise = exact || typeof value !== "string";
        if (!ref) { ref = { cell, exact: precise, users: 0 }; samples.set(id, ref); }
        else if (precise || !ref.exact) { ref.cell = cell; ref.exact = precise; }
        column[index] = ref;
        ref.users++;
        if (compound(value)) for (const child of Object.keys(value)) put([...path, child], value[child]);
      };
      put(block.path, row.value);
    }
    if (reorder) {
      const order = block.times.map((_, i) => i).sort((a, b) => {
        const x = BigInt(block.times[a]), y = BigInt(block.times[b]);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      block.times = order.map((i) => block.times[i]);
      block.ids = order.map((i) => block.ids[i]);
      for (const [path, column] of block.columns) block.columns.set(path, order.map((i) => column[i]));
    }
  }

  private rows(block: Block, path: string[], scope = "full"): MessageRow[] | undefined {
    if (!prefix(block.path, path)) return undefined;
    const valueAt = (path: string[], i: number): Json | undefined => {
      const cell = block.columns.get(pathKey(path))?.[i]?.cell;
      if (cell) {
        if ("value" in cell) return cell.value;
        return Object.fromEntries(cell.children.map((name) => [name, valueAt([...path, name], i) ?? null]));
      }
      // A missing child of a fetched parent is a known absent value, not an unloaded field.
      return undefined;
    };
    let first = 0, last = block.times.length;
    if (scope !== "full") {
      const [start, end] = scope.split(":").map(BigInt);
      const bound = (ns: bigint) => {
        let lo = 0, hi = block.times.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (BigInt(block.times[mid]) < ns) lo = mid + 1; else hi = mid; }
        return lo;
      };
      first = Math.max(0, bound(start) - (block.scope === "full" ? 1 : 0));
      last = bound(end);
      // Preserve the single-message endpoint's first-after-start behavior.
      if (block.scope === "full" && last === 0 && block.times.length) last = 1;
    }
    return block.times.slice(first, last).map((time_ns, offset) => ({ time_ns, value: valueAt(path, first + offset) ?? null }));
  }

  retain(target: FieldTarget, scope: string) {
    const token = Symbol();
    this.pins.set(token, { target, scope });
    return () => { this.pins.delete(token); this.evict(); };
  }

  private evict() {
    const windows = this.blocks.filter((b) => b.scope !== "full" && b.complete);
    let excess = windows.length - 12;
    for (const block of windows) {
      if (excess <= 0) break;
      const pinned = [...this.pins.values()].some(({ target, scope }) => scope === block.scope && target.source === block.source && target.topic === block.topic && prefix(block.path, target.path));
      if (!pinned) { this.discard(block); excess--; }
    }
  }

  private discard(block: Block) {
    if (!this.blocks.includes(block)) return;
    this.blocks = this.blocks.filter((b) => b !== block);
    for (const [path, column] of block.columns) {
      const key = keyOf(block.source, block.topic, JSON.parse(path));
      const samples = this.fields.get(key);
      column.forEach((ref, i) => {
        if (ref && --ref.users === 0 && samples?.get(block.ids[i]) === ref) samples.delete(block.ids[i]);
      });
      if (samples?.size === 0) this.fields.delete(key);
    }
  }

  hasHistory(target: FieldTarget) {
    return this.blocks.some((b) => b.complete && b.scope === "full" && b.source === target.source && b.topic === target.topic && prefix(b.path, target.path));
  }

  read(target: FieldTarget, scope = "full"): MessageRow[] | undefined {
    const block = this.blocks.find((b) => {
      if (b.source !== target.source || b.topic !== target.topic || !prefix(b.path, target.path)) return false;
      if (b.scope !== "full" && b.scope !== scope) return false;
      if (b.complete) return true;
      return false;
    });
    return block && this.rows(block, target.path, scope);
  }

  /** Scalar histories may seed generic views; never replace exact strings with previews. */
  putScalar(target: FieldTarget, rows: MessageRow[]) {
    const block = this.block(target, "full");
    this.append(block, rows, true);
    block.complete = true;
    this.changed();
  }

  /** Find an exact scalar column in a generic history. Strings may be preview-truncated. */
  readScalar(target: FieldTarget, dataType?: string): MessageRow[] | undefined {
    if (dataType?.includes("string")) {
      const block = this.blocks.find((b) => b.complete && b.scope === "full" && b.source === target.source && b.topic === target.topic && prefix(b.path, target.path)
        && b.columns.get(pathKey(target.path))?.every((ref) => ref?.exact));
      return block && this.rows(block, target.path);
    }
    return this.read(target);
  }

  hasPendingScalar(target: FieldTarget, dataType?: string): boolean {
    if (dataType?.includes("string")) return false;
    const job = [...this.jobs.values()].find((job) => !job.controller.signal.aborted && job.block.scope === "full" && job.block.source === target.source && job.block.topic === target.topic && prefix(job.block.path, target.path));
    return job !== undefined;
  }

  /** Sparse-topic predecessor lookups are shared too, and bounded independently. */
  seed(target: FieldTarget, time_ns: string): Promise<MessageRow | null> {
    const key = `${keyOf(target.source, target.topic, target.path)}:${time_ns}`;
    const hit = this.seeds.get(key);
    if (hit) return hit.result;
    const controller = new AbortController();
    const params = new URLSearchParams({ topic: target.topic, time_ns });
    if (target.path.length) params.set("path", JSON.stringify(target.path));
    const result = fetch(`/api/files/${target.source}/message?${params}`, { signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      return body as MessageRow | null;
    }).catch((error) => { this.seeds.delete(key); throw error; });
    this.seeds.set(key, { controller, result });
    while (this.seeds.size > 32) this.seeds.delete(this.seeds.keys().next().value!);
    return result;
  }

  /** Shared in-flight parent requests also serve descendants. Each consumer can leave
   * without cancelling other consumers; the last departing consumer cancels the job.
   */
  load(target: FieldTarget, signal: AbortSignal, onEvent: Listener, range?: { start_ns: string; end_ns: string }): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    const scope = range ? `${range.start_ns}:${range.end_ns}` : "full";
    const hit = this.read(target, scope);
    if (hit) {
      onEvent({ type: "batch", rows: hit, scanned_messages: hit.length });
      onEvent({ type: "complete", scanned_messages: hit.length });
      return Promise.resolve();
    }
    const ancestor = [...this.jobs.values()].find((job) => !job.controller.signal.aborted && job.block.source === target.source && job.block.topic === target.topic
      && (job.block.scope === "full" || job.block.scope === scope) && prefix(job.block.path, target.path));
    const key = `${keyOf(target.source, target.topic, target.path)}:${scope}`;
    let job = ancestor ?? this.jobs.get(key);
    if (job?.controller.signal.aborted) job = undefined;
    if (!job) {
      const block = this.block(target, scope);
      const controller = new AbortController();
      job = { block, controller, listeners: new Set(), done: Promise.resolve() };
      this.jobs.set(key, job);
      const current = job;
      const generation = this.generation;
      job.done = fetch(`/api/files/${target.source}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: target.topic, path: target.path, ...range }), signal: controller.signal,
      }).then((response) => consumeStream<MessageRow>(response, (event) => {
        if (controller.signal.aborted || generation !== this.generation) return;
        if (event.type === "batch") this.append(block, event.rows);
        if (event.type === "complete") block.complete = true;
        current.listeners.forEach((listener) => listener(event));
        this.changed();
      })).finally(() => {
        if (this.jobs.get(key) === current) this.jobs.delete(key);
        if (!block.complete) this.discard(block);
        // Active playback windows are pinned and cannot be evicted.
        this.evict();
      });
    }
    const current = job;
    const listener: Listener = (event) => {
      if (signal.aborted) return;
      if (event.type !== "batch" || current.block.path.length === target.path.length) return onEvent(event);
      const tail = target.path.slice(current.block.path.length);
      onEvent({ ...event, rows: event.rows.map((row) => {
        let value = row.value;
        for (const name of tail) value = compound(value) ? value[name] ?? null : null;
        return { time_ns: row.time_ns, value };
      }) });
    };
    // Replay rows already received, projecting from the same message boundaries.
    if (current.block.times.length) listener({ type: "batch", rows: this.rows(current.block, current.block.path)!, scanned_messages: current.block.times.length });
    current.listeners.add(listener);
    const leave = () => {
      current.listeners.delete(listener);
      if (!current.listeners.size && !current.block.complete) current.controller.abort();
    };
    signal.addEventListener("abort", leave, { once: true });
    return current.done.finally(() => { signal.removeEventListener("abort", leave); current.listeners.delete(listener); });
  }
}

export const FieldCacheContext = createContext<FieldCache | null>(null);
export function useFieldCache() { return useContext(FieldCacheContext); }
