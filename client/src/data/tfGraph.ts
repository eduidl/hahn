import type { Schemas } from "../types";

/** Moves a point into the target: `p_target = rotation * p_frame + translation`. */
export type Transform = Schemas["Transform"];
export type StaticTransform = Schemas["StaticTransform"];
export type DynamicTransform = Schemas["DynamicTransform"];

/**
 * Which time to resolve the graph at (ADR 0002): the recording time of messages, or
 * the measurement time of their stamps. Samples without a stamp have no place on the
 * measurement axis.
 */
export type Axis = "time" | "stamp";

export type ResolveOptions = {
  axis?: Axis;
  /** Off, the earlier sample holds until the next one instead of blending into it. */
  interpolate?: boolean;
};

const identity: Transform = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };

function multiply(a: number[], b: number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotate(q: number[], v: number[]): [number, number, number] {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // v + 2w(u × v) + 2u × (u × v), with t = 2(u × v).
  const t = [2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)];
  return [
    vx + w * t[0] + y * t[2] - z * t[1],
    vy + w * t[1] + z * t[0] - x * t[2],
    vz + w * t[2] + x * t[1] - y * t[0],
  ];
}

/** The transform applying `b` first and then `a`. */
export function compose(a: Transform, b: Transform): Transform {
  const moved = rotate(a.rotation, b.translation);
  return {
    translation: [
      a.translation[0] + moved[0],
      a.translation[1] + moved[1],
      a.translation[2] + moved[2],
    ],
    rotation: multiply(a.rotation, b.rotation),
  };
}

export function invert(t: Transform): Transform {
  const [x, y, z, w] = t.rotation;
  const rotation = [-x, -y, -z, w];
  const [tx, ty, tz] = rotate(rotation, t.translation);
  return { translation: [-tx, -ty, -tz], rotation };
}

function slerp(a: number[], b: number[], ratio: number): number[] {
  let dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  // Take the short way round: q and -q are the same rotation.
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let from: number, to: number;
  if (dot > 0.9995) {
    // Nearly parallel: the sine below would lose precision.
    from = 1 - ratio;
    to = ratio;
  } else {
    const angle = Math.acos(dot);
    from = Math.sin((1 - ratio) * angle) / Math.sin(angle);
    to = Math.sin(ratio * angle) / Math.sin(angle);
  }
  const q = a.map((v, i) => from * v + to * sign * b[i]);
  const length = Math.hypot(...q);
  return q.map((v) => v / length);
}

function interpolateTransform(a: Transform, b: Transform, ratio: number): Transform {
  return {
    translation: a.translation.map((v, i) => v + (b.translation[i] - v) * ratio),
    rotation: slerp(a.rotation, b.rotation, ratio),
  };
}

type Sample = { parent: string; transform: Transform; at: bigint };
type Fixed = { parent: string; transform: Transform };

/** The last index whose time is at or before `at`, plus one: the first after it. */
function firstAfter(samples: Sample[], at: bigint) {
  let low = 0,
    high = samples.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (samples[mid].at <= at) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Samples received together, indexed per frame on their own. Adding or dropping a
 * chunk then costs only its own samples, however many others the graph holds.
 */
class Chunk {
  private byChild = new Map<string, DynamicTransform[]>();
  private sorted = new Map<string, Sample[]>();

  constructor(samples: DynamicTransform[]) {
    for (const sample of samples) {
      const list = this.byChild.get(sample.child);
      if (list) list.push(sample);
      else this.byChild.set(sample.child, [sample]);
    }
  }

  children() {
    return this.byChild.keys();
  }

  /** A frame's samples that have a time on `axis`, ordered by it, ties in recording order. */
  samples(child: string, axis: Axis): Sample[] | undefined {
    const recorded = this.byChild.get(child);
    if (!recorded) return undefined;
    const key = `${axis}\0${child}`;
    let samples = this.sorted.get(key);
    if (!samples) {
      samples = recorded.flatMap((s) => {
        const at = axis === "time" ? s.time_ns : s.stamp_ns;
        if (at === undefined) return [];
        const transform = { translation: s.translation, rotation: s.rotation };
        return [{ parent: s.parent, transform, at: BigInt(at) }];
      });
      // Stable, so that the last of equal times stays the last recorded.
      samples.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      this.sorted.set(key, samples);
    }
    return samples;
  }
}

/**
 * The frame graph of a run from what the server delivers, resolved here so that the
 * axis and interpolation can change without asking it (ADR 0001, 0003). Dynamic
 * samples come in chunks keyed in recording order, each in recording order itself,
 * which settles ties of equal times: the later chunk, then the later sample.
 */
export class TfGraph {
  private fixed = new Map<string, Fixed>();
  private chunks = new Map<bigint, Chunk>();
  /** Chunk keys in recording order. */
  private order: bigint[] = [];
  /** How many chunks hold samples of each dynamic frame. */
  private dynamic = new Map<string, number>();

  constructor(fixed: StaticTransform[] = [], dynamic: DynamicTransform[] = []) {
    this.setFixed(fixed);
    if (dynamic.length) this.add(0n, dynamic);
  }

  setFixed(fixed: StaticTransform[]) {
    this.fixed = new Map(
      fixed.map((t) => [
        t.child,
        { parent: t.parent, transform: { translation: t.translation, rotation: t.rotation } },
      ]),
    );
  }

  /** Adds the samples of chunk `key`, replacing any it held. */
  add(key: bigint, samples: DynamicTransform[]) {
    this.remove(key);
    const chunk = new Chunk(samples);
    this.chunks.set(key, chunk);
    this.order.push(key);
    this.order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const child of chunk.children())
      this.dynamic.set(child, (this.dynamic.get(child) ?? 0) + 1);
  }

  remove(key: bigint) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.chunks.delete(key);
    this.order = this.order.filter((k) => k !== key);
    for (const child of chunk.children()) {
      const count = this.dynamic.get(child)! - 1;
      if (count) this.dynamic.set(child, count);
      else this.dynamic.delete(child);
    }
  }

  /** The frame's parent and transform at `at`. Never extrapolates. */
  private at(child: string, at: bigint, axis: Axis, interpolate: boolean): Fixed | undefined {
    const fixed = this.fixed.get(child);
    if (fixed) return fixed;
    // The last sample at or before `at` and the last of the first time after it,
    // over every chunk; on equal times the later chunk wins.
    let before: Sample | undefined;
    let next: Sample | undefined;
    for (const key of this.order) {
      const samples = this.chunks.get(key)!.samples(child, axis);
      if (!samples?.length) continue;
      const after = firstAfter(samples, at);
      const last = samples[after - 1];
      if (last && (!before || last.at >= before.at)) before = last;
      const first = samples[after];
      if (first && (!next || first.at <= next.at)) {
        next = samples[firstAfter(samples, first.at) - 1];
      }
    }
    if (!before) return undefined;
    if (before.at === at) return before;
    if (!next) return undefined;
    // A change of parent cannot be interpolated across.
    if (next.parent !== before.parent || !interpolate) return before;
    const ratio = Number(at - before.at) / Number(next.at - before.at);
    return {
      parent: before.parent,
      transform: interpolateTransform(before.transform, next.transform, ratio),
    };
  }

  /**
   * Every frame connected to `target` at `at`, with its transform into `target`. A
   * frame not connected, or reached through a dynamic frame outside its samples, is
   * left out. On a cycle, which way round its frames are resolved is unspecified.
   */
  resolve(target: string, at: bigint, options: ResolveOptions = {}): Record<string, Transform> {
    const { axis = "time", interpolate = true } = options;
    const neighbours = new Map<string, [string, Transform][]>();
    const link = (from: string, to: string, transform: Transform) => {
      const list = neighbours.get(from);
      if (list) list.push([to, transform]);
      else neighbours.set(from, [[to, transform]]);
    };
    for (const child of new Set([...this.fixed.keys(), ...this.dynamic.keys()])) {
      const found = this.at(child, at, axis, interpolate);
      if (!found) continue;
      link(found.parent, child, found.transform);
      link(child, found.parent, invert(found.transform));
    }
    // Without a prototype, so that any frame name is just a key.
    const resolved: Record<string, Transform> = Object.create(null);
    resolved[target] = identity;
    const queue = [target];
    for (let frame = queue.shift(); frame !== undefined; frame = queue.shift()) {
      for (const [next, transform] of neighbours.get(frame) ?? []) {
        if (next in resolved) continue;
        resolved[next] = compose(resolved[frame], transform);
        queue.push(next);
      }
    }
    return resolved;
  }
}
