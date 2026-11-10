import type { Schemas } from "../types";
import { get } from "./request";
import { TfGraph, type DynamicTransform, type StaticTransform } from "./tfGraph";

/** Recording time covered by one request for dynamic samples. */
const chunkNs = 5_000_000_000n;
/** Chunks kept once loaded: about two minutes around where the run was last read. */
const keptChunks = 24;

type Chunk = { samples: DynamicTransform[]; error: string };

const chunkOf = (at: bigint) => at / chunkNs;

/**
 * The transforms of one run as the server delivers them (ADR 0003): its static
 * transforms once, and its dynamic samples in chunks of recording time around where
 * it is read. Every view of the run shares them, and resolves the graph itself.
 */
export class RunTransforms {
  private fixed?: { transforms: StaticTransform[]; error: string };
  private fixedLoad?: Promise<void>;
  private chunks = new Map<bigint, Chunk>();
  private loading = new Map<bigint, Promise<void>>();
  private listeners = new Set<() => void>();
  private version = 0;
  private resolver = new TfGraph();
  private controller = new AbortController();

  constructor(readonly run: string) {}

  /** Forgets everything loaded and stops the loads under way. */
  clear() {
    this.controller.abort();
    this.controller = new AbortController();
    this.fixed = undefined;
    this.fixedLoad = undefined;
    this.chunks.clear();
    this.loading.clear();
    this.resolver = new TfGraph();
    this.changed();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getVersion = () => this.version;

  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Whether the graph can be resolved at `at`: the chunk holding it and its
   * neighbours are loaded, so that samples around it and stamps lagging it are there.
   */
  covers(at: bigint) {
    if (!this.fixed) return false;
    const chunk = chunkOf(at);
    return [chunk - 1n, chunk, chunk + 1n].every((k) => k < 0n || this.chunks.has(k));
  }

  /** Loads what resolving at `at` needs, settling once it is there or has failed. */
  ensure(at: bigint): Promise<void> {
    const chunk = chunkOf(at);
    const loads = [this.loadFixed()];
    for (const k of [chunk - 1n, chunk, chunk + 1n]) if (k >= 0n) loads.push(this.loadChunk(k));
    return Promise.all(loads).then(() => this.evict(chunk));
  }

  private loadFixed() {
    const { signal } = this.controller;
    this.fixedLoad ??= get<Schemas["StaticTransforms"]>(`${this.run}/transforms/static`, signal)
      .then(
        ({ transforms }) => ({ transforms, error: "" }),
        (error) => ({ transforms: [], error: messageOf(error) }),
      )
      .then((fixed) => {
        if (signal.aborted) return;
        this.fixed = fixed;
        this.resolver.setFixed(fixed.transforms);
        this.changed();
      });
    return this.fixedLoad;
  }

  private loadChunk(k: bigint) {
    if (this.chunks.has(k)) return Promise.resolve();
    let load = this.loading.get(k);
    if (!load) {
      const params = new URLSearchParams({
        start_ns: String(k * chunkNs),
        end_ns: String((k + 1n) * chunkNs),
      });
      const { signal } = this.controller;
      load = get<Schemas["DynamicTransforms"]>(`${this.run}/transforms/dynamic?${params}`, signal)
        .then(
          ({ samples }) => ({ samples, error: "" }),
          (error) => ({ samples: [], error: messageOf(error) }),
        )
        .then((chunk) => {
          if (signal.aborted) return;
          this.loading.delete(k);
          this.chunks.set(k, chunk);
          this.resolver.add(k, chunk.samples);
          this.changed();
        });
      this.loading.set(k, load);
    }
    return load;
  }

  /** Drops the chunks farthest from `around` beyond those kept. */
  private evict(around: bigint) {
    if (this.chunks.size <= keptChunks) return;
    const distance = (k: bigint) => (k > around ? k - around : around - k);
    const far = [...this.chunks.keys()].sort((a, b) => Number(distance(b) - distance(a)));
    for (const k of far.slice(0, this.chunks.size - keptChunks)) {
      this.chunks.delete(k);
      this.resolver.remove(k);
    }
    this.changed();
  }

  /**
   * A graph of the transforms over a range of recording time, read at once: for placing
   * a whole history, such as a trail, rather than the moment being played.
   */
  async over(start: bigint, end: bigint, signal?: AbortSignal): Promise<TfGraph> {
    const params = new URLSearchParams({ start_ns: String(start), end_ns: String(end) });
    const [, dynamic] = await Promise.all([
      this.loadFixed(),
      get<Schemas["DynamicTransforms"]>(`${this.run}/transforms/dynamic?${params}`, signal),
    ]);
    if (this.fixed?.error) throw new Error(this.fixed.error);
    return new TfGraph(this.fixed?.transforms ?? [], dynamic.samples);
  }

  /** The first failure to load, if any. */
  error() {
    return this.fixed?.error || [...this.chunks.values()].find((c) => c.error)?.error || "";
  }

  /**
   * The graph of everything loaded. It changes as chunks come and go, each indexed on
   * its own, so a new chunk does not cost the samples already held.
   */
  graph() {
    return this.resolver;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
