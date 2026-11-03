import type { Schemas } from "../types";
import { get } from "./sources";
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
  private built?: { version: number; graph: TfGraph };

  constructor(readonly run: string) {}

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
    this.fixedLoad ??= get<Schemas["StaticTransforms"]>(`${this.run}/transforms/static`)
      .then(
        ({ transforms }) => ({ transforms, error: "" }),
        (error) => ({ transforms: [], error: messageOf(error) }),
      )
      .then((fixed) => {
        this.fixed = fixed;
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
      load = get<Schemas["DynamicTransforms"]>(`${this.run}/transforms/dynamic?${params}`)
        .then(
          ({ samples }) => ({ samples, error: "" }),
          (error) => ({ samples: [], error: messageOf(error) }),
        )
        .then((chunk) => {
          this.loading.delete(k);
          this.chunks.set(k, chunk);
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
    for (const k of far.slice(0, this.chunks.size - keptChunks)) this.chunks.delete(k);
    this.changed();
  }

  /** The first failure to load, if any. */
  error() {
    return this.fixed?.error || [...this.chunks.values()].find((c) => c.error)?.error || "";
  }

  /** The graph from everything loaded, rebuilt only when that changes. */
  graph() {
    if (this.built?.version !== this.version) {
      const keys = [...this.chunks.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // Chunks hold disjoint ranges of recording time, so this keeps recording order.
      const samples = keys.flatMap((k) => this.chunks.get(k)!.samples);
      this.built = {
        version: this.version,
        graph: new TfGraph(this.fixed?.transforms ?? [], samples),
      };
    }
    return this.built.graph;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

let current: RunTransforms | undefined;

/** The transforms of `run`. Only one run is open at a time, so only its are kept. */
export function runTransforms(run: string) {
  if (current?.run !== run) current = new RunTransforms(run);
  return current;
}
