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

/** A frame's link to its parent: fixed, or samples ordered on each axis. */
type Edge = { fixed?: { parent: string; transform: Transform }; samples: DynamicTransform[] };

/**
 * The frame graph of a run from what the server delivers, resolved here so that the
 * axis and interpolation can change without asking it (ADR 0001, 0003). Dynamic
 * samples must be given in recording order, which settles ties of equal times.
 */
export class TfGraph {
  private edges = new Map<string, Edge>();
  private sorted = new Map<string, Sample[]>();

  constructor(fixed: StaticTransform[], dynamic: DynamicTransform[]) {
    for (const t of fixed)
      this.edge(t.child).fixed = {
        parent: t.parent,
        transform: { translation: t.translation, rotation: t.rotation },
      };
    for (const sample of dynamic) this.edge(sample.child).samples.push(sample);
  }

  private edge(child: string) {
    let edge = this.edges.get(child);
    if (!edge) {
      edge = { samples: [] };
      this.edges.set(child, edge);
    }
    return edge;
  }

  /** A frame's samples that have a time on `axis`, ordered by it, ties in recording order. */
  private samples(child: string, edge: Edge, axis: Axis): Sample[] {
    const key = `${axis}\0${child}`;
    let samples = this.sorted.get(key);
    if (!samples) {
      samples = edge.samples.flatMap((s) => {
        const at = axis === "time" ? s.time_ns : s.stamp_ns;
        if (at === undefined) return [];
        return [
          {
            parent: s.parent,
            transform: { translation: s.translation, rotation: s.rotation },
            at: BigInt(at),
          },
        ];
      });
      // Stable, so that the last of equal times stays the last recorded.
      samples.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      this.sorted.set(key, samples);
    }
    return samples;
  }

  /** The frame's parent and transform at `at`. Never extrapolates. */
  private at(child: string, edge: Edge, at: bigint, axis: Axis, interpolate: boolean) {
    if (edge.fixed) return edge.fixed;
    const samples = this.samples(child, edge, axis);
    // The first sample after `at`.
    let after = 0,
      end = samples.length;
    while (after < end) {
      const mid = (after + end) >>> 1;
      if (samples[mid].at <= at) after = mid + 1;
      else end = mid;
    }
    const before = samples[after - 1];
    if (!before) return undefined;
    if (before.at === at) return before;
    const next = samples[after];
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
    for (const [child, edge] of this.edges) {
      const found = this.at(child, edge, at, axis, interpolate);
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
