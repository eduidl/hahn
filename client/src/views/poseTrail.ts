import { compose, type ResolveOptions, type TfGraph } from "../data/tfGraph";
import { frameIndexAt, type ViewFrame } from "../data/viewFrames";

/**
 * Poses expressed in `world`, each by the transform at its own time: its measurement
 * time when `axis` is `stamp` and it has one, else its log time (ADR 0002). A pose
 * that cannot be placed becomes an error, which leaves a gap in the trail.
 */
export function placePoses(
  frames: ViewFrame[],
  graph: TfGraph,
  world: string,
  { axis = "stamp", interpolate = true }: ResolveOptions = {},
): ViewFrame[] {
  return frames.map((frame) => {
    const value = frame.value?.kind === "pose" ? frame.value : undefined;
    if (!value?.frame_id) return frame;
    const byStamp = axis === "stamp" && value.stamp_ns !== undefined;
    const at = BigInt(byStamp ? value.stamp_ns! : frame.time_ns);
    const placement =
      value.frame_id === world
        ? undefined
        : graph.between(world, value.frame_id, at, {
            axis: byStamp ? "stamp" : "time",
            interpolate,
          });
    if (value.frame_id !== world && !placement)
      return {
        ...frame,
        value: undefined,
        error: `No transform from ${value.frame_id} to ${world}`,
      };
    const pose = placement
      ? compose(placement, {
          translation: value.pose.position,
          rotation: value.pose.orientation,
        })
      : { translation: value.pose.position, rotation: value.pose.orientation };
    return {
      ...frame,
      value: {
        ...value,
        frame_id: world,
        pose: { position: pose.translation, orientation: pose.rotation },
      },
    };
  });
}

/** Build separate line segments so conversion failures never bridge gaps. */
export function poseTrail(frames: ViewFrame[]) {
  const positions: number[] = [];
  const ends: Pick<ViewFrame, "time_ns">[] = [];
  const starts: Pick<ViewFrame, "time_ns">[] = [];
  let previous: ViewFrame | undefined;
  let source: string | null | undefined;
  let gaps = false;
  for (const frame of frames) {
    const value = frame.value?.kind === "pose" ? frame.value : undefined;
    if (value?.frame_id && source === undefined) source = value.frame_id;
    if (!value?.frame_id || value.frame_id !== source) {
      previous = undefined;
      gaps = true;
      continue;
    }
    const prior = previous?.value?.kind === "pose" ? previous.value : undefined;
    if (prior) {
      positions.push(...prior.pose.position, ...value.pose.position);
      starts.push({ time_ns: previous!.time_ns });
      ends.push({ time_ns: frame.time_ns });
    }
    previous = frame;
  }
  return { positions: new Float32Array(positions), starts, ends, gaps };
}

/** The visible line segments and an interpolated first point at the time boundary. */
export function trailWindow(
  trail: ReturnType<typeof poseTrail>,
  now: bigint | null,
  seconds?: number,
) {
  if (now === null) return { start: 0, count: 0 };
  const end = frameIndexAt(trail.ends, now) + 1;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0)
    return { start: 0, count: end };
  const nanos =
    BigInt(Math.trunc(seconds)) * 1_000_000_000n + BigInt(Math.round((seconds % 1) * 1e9));
  const cutoff = now - nanos;
  const start = Math.min(end, frameIndexAt(trail.ends, cutoff) + 1);
  if (start === end) return { start, count: 0 };
  const from = BigInt(trail.starts[start].time_ns),
    to = BigInt(trail.ends[start].time_ns);
  if (cutoff <= from || to <= from) return { start, count: end - start };
  const fraction = Number(cutoff - from) / Number(to - from);
  const offset = start * 6;
  const point = [0, 1, 2].map(
    (axis) =>
      trail.positions[offset + axis] +
      fraction * (trail.positions[offset + 3 + axis] - trail.positions[offset + axis]),
  );
  return { start, count: end - start, point };
}
