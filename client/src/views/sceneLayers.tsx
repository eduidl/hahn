// What a 3D widget draws: point clouds, poses, camera images and frame axes.
import { ReportSeriesProblem } from "./seriesViewProblem";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { errorMessage, type Info, type Selected } from "../types";
import {
  defaultPlacement,
  type FrameAxesSettings,
  type PlacementSettings,
} from "../workspace/widgetModel";
import { decodeImage } from "../data/imagePixels";
import type { FieldIndex } from "../workspace/fieldIndex";
import { usePlaybackNs, useTransforms, useViewFrame, useViewHistory } from "../data/useViewData";
import {
  pointBuffers,
  type PointCloudValue,
  type Transform,
  type ViewFrame,
} from "../data/viewFrames";
import { cameraSurface, defaultImageDistance } from "./camera";
import { useCameraCalibration } from "./useCameraCalibration";
import { locate, placePoses, poseTrail, trailWindow } from "./poseTrail";
import type { ResolvedFrames } from "../data/tfGraph";
import { useDataStore } from "../data/store";
import { runUrl } from "../data/sources";

export type Stage = {
  /** What layers draw into, in the graph's root, shifted so that the origin is in view. */
  scene: THREE.Object3D;
  invalidate: () => void;
  fit: (object: THREE.Object3D) => void;
  /** Carries the view over into a new fixed frame. */
  reframe: (transform: Transform) => void;
  resetView: () => void;
  /**
   * Draws around `origin`, a position in the root, which then sits at the scene's origin.
   * With `keepView`, the camera moves along so that nothing appears to move.
   */
  setOrigin: (origin: number[], keepView?: boolean) => void;
};

export const matrixOf = ({ translation, rotation }: Transform) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(...(translation as [number, number, number])),
    new THREE.Quaternion(...(rotation as [number, number, number, number])),
    new THREE.Vector3(1, 1, 1),
  );

/** The frame the camera follows and where it is now in the scene's frame. */
export type FollowAnchor = { frame: string; pose: Transform } | null;

/** Set by a 3D view while its camera follows a frame other than the one it renders in. */
export const FollowContext = createContext<FollowAnchor>(null);

/** How the 3D widget around a layer places values: its placement settings. */
export const PlacementContext = createContext<PlacementSettings>(defaultPlacement());

/** A value's measurement time, if it has one. */
/** Said of a value placed by log time because it has no measurement time. */
export const estimatedPlacement = "No measurement time: placed by log time";

const stampOf = (frame: ViewFrame | null | undefined) =>
  frame?.value && "stamp_ns" in frame.value ? frame.value.stamp_ns : undefined;

/**
 * Where the latest data of `frameId` sits in `target`, by the transform at the data's own time.
 * It counts as the present, so what is rigid to `target` stays still between messages.
 * While the camera follows a frame, data is placed relative to that frame at the data's time,
 * which then sits where it is now: what is rigid to it, such as its own sensors, stays still
 * in view rather than falling behind until the next message.
 */
export function useFramePlacement(
  source: string | undefined,
  frameId: string | null | undefined,
  target: string | null,
  frame: ViewFrame | null | undefined,
) {
  const anchor = useContext(FollowContext);
  const { alignment, interpolate } = useContext(PlacementContext);
  const placed = !!frameId && !!target;
  const via = anchor?.frame ?? target;
  // By its measurement time when chosen and known, else by its recording time (ADR 0002).
  const stamp = stampOf(frame);
  const byStamp = alignment === "stamp" && stamp !== undefined;
  const dataNs = frame ? (byStamp ? stamp : frame.time_ns) : null;
  const { transforms, error } = useTransforms(
    source,
    placed && frameId !== via ? via : null,
    dataNs,
    true,
    { axis: byStamp ? "stamp" : "time", interpolate, near: frame?.time_ns ?? null },
  );
  const transform = frameId ? transforms?.frames[frameId] : undefined;
  const matrix = useMemo(() => {
    if (!placed) return undefined;
    const local =
      frameId === via ? new THREE.Matrix4() : transform ? matrixOf(transform) : undefined;
    if (!local || !anchor) return local;
    return matrixOf(anchor.pose).multiply(local);
  }, [placed, frameId, via, transform, anchor]);
  // Data arrives ahead of its transform; placed by the previous one, it would jump and return.
  const settled = !placed || frameId === via || transforms?.time_ns === dataNs || !!error;
  return {
    matrix,
    missing: placed && frameId !== via && !!transforms && !transform,
    /** Placed by recording time for want of a measurement time. */
    estimated: alignment === "stamp" && placed && frameId !== via && !!frame?.value && !byStamp,
    error,
    settled,
  };
}

/** Dark to bright, so that intensity reads on the dark background. */
export function intensityColors(intensities: Float32Array) {
  const colors = new Float32Array(intensities.length * 3);
  const color = new THREE.Color();
  intensities.forEach((value, i) => {
    color.setHSL(0.66 * (1 - value), 1, 0.5);
    color.toArray(colors, i * 3);
  });
  return colors;
}

/** One point cloud topic. Draws into the stage, and renders only its problems. */
export function PointsLayer({
  series,
  info,
  target,
  stage,
}: {
  series: Selected;
  info: Info | null;
  target: string | null;
  stage: Stage;
}) {
  const { frame, error } = useViewFrame(series, info);
  const value = frame?.value?.kind === "pointcloud" ? (frame.value as PointCloudValue) : undefined;
  // A cloud is placed by where its frame was when it was captured.
  const {
    matrix: placement,
    missing: unresolved,
    error: transformError,
    settled,
    estimated,
  } = useFramePlacement(series.source, value?.frame_id, target, frame);
  const points = useMemo(() => {
    const object = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 3, sizeAttenuation: false }),
    );
    object.matrixAutoUpdate = false;
    return object;
  }, []);
  useEffect(() => {
    stage.scene.add(points);
    return () => {
      stage.scene.remove(points);
      points.geometry.dispose();
      points.material.dispose();
      stage.invalidate();
    };
  }, [stage, points]);
  useEffect(() => {
    if (!frame || !value) return;
    const { positions, intensities } = pointBuffers(value, frame.blob);
    points.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (intensities)
      geometry.setAttribute("color", new THREE.BufferAttribute(intensityColors(intensities), 3));
    points.geometry = geometry;
    points.material.vertexColors = !!intensities;
    points.material.color.set(intensities ? "#ffffff" : series.color);
    points.material.needsUpdate = true;
    stage.invalidate();
  }, [frame, value, points, stage, series.color]);
  const frameId = value?.frame_id ?? null;
  useEffect(() => {
    if (!settled) return;
    points.visible = !series.hidden && !!value && !unresolved;
    if (value) {
      const pose = matrixOf({ translation: value.pose.position, rotation: value.pose.orientation });
      points.matrix.copy(placement ? placement.clone().multiply(pose) : pose);
      points.matrixWorldNeedsUpdate = true;
    }
    stage.invalidate();
  }, [points, value, placement, unresolved, series.hidden, stage, settled]);
  const problem =
    error ||
    frame?.error ||
    transformError ||
    (unresolved ? `No transform from ${frameId} to ${target} at this time` : "") ||
    (estimated ? estimatedPlacement : "");
  return <ReportSeriesProblem series={series} problem={problem} />;
}

/** The recorded pose history up to the playback position. */
export function PoseTrail({
  series,
  info,
  target,
  world,
  stage,
}: {
  series: Selected;
  info: Info | null;
  target: string | null;
  /** A frame that stays put, for the samples: in the frame of a moving body, each would be at its origin. */
  world: string | null;
  stage: Stage;
}) {
  const ns = usePlaybackNs(info);
  const { alignment, interpolate } = useContext(PlacementContext);
  const identity = JSON.stringify([
    series.key,
    series.view,
    info?.start_ns,
    world,
    alignment,
    interpolate,
  ]);
  // The whole trail is then seen from where the fixed frame is now.
  const { transforms, error: transformError } = useTransforms(
    series.source,
    target,
    ns === null ? null : String(ns),
    true,
  );
  const placement = world ? transforms?.frames[world] : undefined;
  const readHistory = useViewHistory(series);
  const store = useDataStore();
  const [loaded, setLoaded] = useState<{ identity: string; frames: ViewFrame[]; error: string }>();
  useEffect(() => {
    if (!info) return;
    const controller = new AbortController();
    readHistory(controller.signal)
      .then(async (frames) => {
        if (world && frames.length) {
          // Each pose by the transform at its own time, from samples spanning the history
          // with a margin for stamps that lag their log time.
          const margin = 1_000_000_000n;
          const first = BigInt(frames[0].time_ns);
          const last = BigInt(frames[frames.length - 1].time_ns);
          const runTransforms = store.transforms(runUrl(series.source));
          if (!runTransforms) throw new Error("The run is no longer open");
          const graph = await runTransforms.over(
            first > margin ? first - margin : 0n,
            last + margin,
            controller.signal,
          );
          frames = placePoses(frames, graph, world, {
            axis: alignment === "stamp" ? "stamp" : "time",
            interpolate,
          });
        }
        if (!controller.signal.aborted) setLoaded({ identity, frames, error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLoaded({ identity, frames: [], error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [identity, readHistory, store]);
  const history = loaded?.identity === identity ? loaded : undefined;
  const trail = useMemo(() => poseTrail(history?.frames ?? []), [history]);
  const line = useMemo(() => {
    const line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    line.matrixAutoUpdate = false;
    return line;
  }, []);
  useEffect(() => {
    line.matrix.copy(placement ? matrixOf(placement) : new THREE.Matrix4());
    line.matrixWorldNeedsUpdate = true;
    stage.invalidate();
  }, [line, placement, stage]);
  const unplaced = !!target && !!world && !!transforms && !placement;
  const clipped = useRef<number | null>(null);
  useEffect(() => {
    stage.scene.add(line);
    return () => {
      stage.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
      stage.invalidate();
    };
  }, [stage, line]);
  useEffect(() => {
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry();
    line.geometry.setAttribute("position", new THREE.BufferAttribute(trail.positions.slice(), 3));
    clipped.current = null;
    stage.invalidate();
  }, [line, trail, stage]);
  useEffect(() => {
    const window = trailWindow(trail, ns, series.trailDuration);
    const attribute = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    if (clipped.current !== null) {
      const i = clipped.current * 6;
      attribute.addUpdateRange(i, 3);
      attribute.setXYZ(
        clipped.current * 2,
        trail.positions[i],
        trail.positions[i + 1],
        trail.positions[i + 2],
      );
    }
    const changed = clipped.current !== null || !!window.point;
    clipped.current = window.point ? window.start : null;
    if (window.point) {
      attribute.addUpdateRange(window.start * 6, 3);
      attribute.setXYZ(window.start * 2, window.point[0], window.point[1], window.point[2]);
    }
    if (changed) attribute.needsUpdate = true;
    line.geometry.setDrawRange(window.start * 2, window.count * 2);
    line.material.color.set(series.color);
    line.visible = !series.hidden && !unplaced;
    stage.invalidate();
  }, [line, trail, ns, series.color, series.hidden, series.trailDuration, stage, unplaced]);
  const problem =
    history?.error ||
    transformError ||
    (trail.gaps ? "Some trajectory samples could not be placed" : "");
  return <ReportSeriesProblem series={series} problem={problem} />;
}

/**
 * The latest pose, with the arrow pointing along the body's positive x axis, or the
 * latest position, as a dot.
 */
export function PoseLayer({
  series,
  info,
  target,
  world,
  stage,
}: {
  series: Selected;
  info: Info | null;
  target: string | null;
  world: string | null;
  stage: Stage;
}) {
  const { frame, error } = useViewFrame(series, info, true);
  const value = locate(frame?.value);
  const isPosition = frame?.value?.kind === "position";
  const frameId = value?.frame_id;
  const {
    matrix: placement,
    missing,
    error: transformError,
    settled,
    estimated,
  } = useFramePlacement(series.source, frameId, target, frame);
  const arrow = useMemo(() => {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      1,
      series.color,
    );
    arrow.matrixAutoUpdate = false;
    return arrow;
  }, []);
  const dot = useMemo(() => {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.15), new THREE.MeshBasicMaterial());
    dot.matrixAutoUpdate = false;
    return dot;
  }, []);
  useEffect(() => {
    stage.scene.add(arrow, dot);
    return () => {
      stage.scene.remove(arrow, dot);
      arrow.dispose();
      dot.geometry.dispose();
      dot.material.dispose();
      stage.invalidate();
    };
  }, [arrow, dot, stage]);
  useEffect(() => {
    if (!settled) return;
    const shown = !series.hidden && !!value && !!frameId && (!target || !!placement);
    arrow.visible = shown && !isPosition;
    dot.visible = shown && isPosition;
    arrow.setColor(new THREE.Color(series.color));
    dot.material.color.set(series.color);
    if (value) {
      const pose = matrixOf(value.transform);
      const matrix = placement ? placement.clone().multiply(pose) : pose;
      for (const object of [arrow, dot]) {
        object.matrix.copy(matrix);
        object.matrixWorldNeedsUpdate = true;
      }
    }
    stage.invalidate();
  }, [
    arrow,
    dot,
    value,
    isPosition,
    frameId,
    target,
    placement,
    series.hidden,
    series.color,
    stage,
    settled,
  ]);
  const problem =
    error ||
    frame?.error ||
    transformError ||
    (value && !frameId ? `${isPosition ? "Position" : "Pose"} has no frame ID` : "") ||
    (missing ? `No transform from ${frameId} to ${target} at this time` : "") ||
    (estimated ? estimatedPlacement : "");
  return (
    <>
      {info && (
        <PoseTrail series={series} info={info} target={target} world={world} stage={stage} />
      )}
      <ReportSeriesProblem series={series} problem={problem} />
    </>
  );
}

/** The length of the arrow drawn for each pose of a set, in meters. */
const headingLength = 0.5;

/**
 * The latest set of poses: a `path` joined in order, or `poses` each drawn as an
 * arrow along its x axis, like a single pose. A new message replaces the whole set (ADR 0005).
 */
export function PoseSetLayer({
  series,
  info,
  target,
  stage,
}: {
  series: Selected;
  info: Info | null;
  target: string | null;
  stage: Stage;
}) {
  const { frame, error } = useViewFrame(series, info, true);
  const value =
    frame?.value?.kind === "poses" || frame?.value?.kind === "path" ? frame.value : undefined;
  const frameId = value?.frame_id;
  const {
    matrix: placement,
    missing,
    error: transformError,
    settled,
    estimated,
  } = useFramePlacement(series.source, frameId, target, frame);
  const lines = useMemo(() => {
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    lines.matrixAutoUpdate = false;
    return lines;
  }, []);
  useEffect(() => {
    stage.scene.add(lines);
    return () => {
      stage.scene.remove(lines);
      lines.geometry.dispose();
      lines.material.dispose();
      stage.invalidate();
    };
  }, [lines, stage]);
  useEffect(() => {
    if (!value) return;
    const segments: number[] = [];
    if (value.kind === "path")
      value.poses.forEach((pose, i) => {
        if (i) segments.push(...value.poses[i - 1].position, ...pose.position);
      });
    else
      for (const pose of value.poses) {
        // An arrow along the pose's x axis: its shaft, then the two sides of its head.
        const [x, y, z, w] = pose.orientation;
        const rotation = new THREE.Quaternion(x, y, z, w);
        const at = (along: number, across: number) =>
          new THREE.Vector3(along, across, 0)
            .applyQuaternion(rotation)
            .add(new THREE.Vector3(...(pose.position as [number, number, number])));
        const [base, tip] = [at(0, 0), at(headingLength, 0)];
        const head = headingLength * 0.3;
        for (const [from, to] of [
          [base, tip],
          [tip, at(headingLength - head, head / 2)],
          [tip, at(headingLength - head, -head / 2)],
        ])
          segments.push(from.x, from.y, from.z, to.x, to.y, to.z);
      }
    lines.geometry.dispose();
    lines.geometry = new THREE.BufferGeometry();
    lines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
    stage.invalidate();
  }, [lines, value, stage]);
  useEffect(() => {
    if (!settled) return;
    lines.visible = !series.hidden && !!value && !!frameId && (!target || !!placement);
    lines.material.color.set(series.color);
    lines.matrix.copy(placement ?? new THREE.Matrix4());
    lines.matrixWorldNeedsUpdate = true;
    stage.invalidate();
  }, [lines, value, frameId, target, placement, series.hidden, series.color, stage, settled]);
  const omitted = value?.kind === "poses" ? value.omitted : 0;
  const problem =
    error ||
    frame?.error ||
    transformError ||
    (value && !frameId ? "Poses have no frame ID" : "") ||
    (missing ? `No transform from ${frameId} to ${target} at this time` : "") ||
    (omitted
      ? `${omitted.toLocaleString()} ${omitted === 1 ? "pose" : "poses"} left out: not finite or unreadable`
      : "") ||
    (estimated ? estimatedPlacement : "");
  return <ReportSeriesProblem series={series} problem={problem} />;
}

/** The 12 edges of a unit cube centered on the origin, as segment end points. */
const cubeEdges = (() => {
  const corners = [-0.5, 0.5].flatMap((x) =>
    [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z) => [x, y, z])),
  );
  const edges: number[] = [];
  // Corners one axis apart share an edge.
  for (const [i, a] of corners.entries())
    for (const b of corners.slice(i + 1))
      if (a.filter((v, k) => v !== b[k]).length === 1) edges.push(...a, ...b);
  return edges;
})();

/**
 * The latest boxes, such as detected objects, as outlines. A new message replaces
 * them all; boxes are never joined across messages, even by their id (ADR 0005).
 */
export function BoxesLayer({
  series,
  info,
  target,
  stage,
}: {
  series: Selected;
  info: Info | null;
  target: string | null;
  stage: Stage;
}) {
  const { frame, error } = useViewFrame(series, info, true);
  const value = frame?.value?.kind === "bbox3d" ? frame.value : undefined;
  const frameId = value?.frame_id;
  const {
    matrix: placement,
    missing,
    error: transformError,
    settled,
    estimated,
  } = useFramePlacement(series.source, frameId, target, frame);
  const lines = useMemo(() => {
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    lines.matrixAutoUpdate = false;
    return lines;
  }, []);
  useEffect(() => {
    stage.scene.add(lines);
    return () => {
      stage.scene.remove(lines);
      lines.geometry.dispose();
      lines.material.dispose();
      stage.invalidate();
    };
  }, [lines, stage]);
  useEffect(() => {
    if (!value) return;
    const points: number[] = [];
    const corner = new THREE.Vector3();
    for (const box of value.boxes) {
      const matrix = matrixOf({ translation: box.pose.position, rotation: box.pose.orientation });
      matrix.scale(new THREE.Vector3(...(box.size as [number, number, number])));
      for (let i = 0; i < cubeEdges.length; i += 3) {
        corner.set(cubeEdges[i], cubeEdges[i + 1], cubeEdges[i + 2]).applyMatrix4(matrix);
        points.push(corner.x, corner.y, corner.z);
      }
    }
    lines.geometry.dispose();
    lines.geometry = new THREE.BufferGeometry();
    lines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    stage.invalidate();
  }, [lines, value, stage]);
  useEffect(() => {
    if (!settled) return;
    lines.visible = !series.hidden && !!value && !!frameId && (!target || !!placement);
    lines.material.color.set(series.color);
    lines.matrix.copy(placement ?? new THREE.Matrix4());
    lines.matrixWorldNeedsUpdate = true;
    stage.invalidate();
  }, [lines, value, frameId, target, placement, series.hidden, series.color, stage, settled]);
  const omitted = value?.omitted ?? 0;
  const problem =
    error ||
    frame?.error ||
    transformError ||
    (value && !frameId ? "Boxes have no frame ID" : "") ||
    (missing ? `No transform from ${frameId} to ${target} at this time` : "") ||
    (omitted
      ? `${omitted.toLocaleString()} ${omitted === 1 ? "box" : "boxes"} left out: not finite or unreadable`
      : "") ||
    (estimated ? estimatedPlacement : "");
  return <ReportSeriesProblem series={series} problem={problem} />;
}

/** An image on its camera's pinhole image plane, one meter from the origin. */
export function CameraLayer({
  series,
  info,
  target,
  stage,
  index,
}: {
  series: Selected;
  info: Info | null;
  target: string | null;
  stage: Stage;
  index: FieldIndex;
}) {
  const { frame, error } = useViewFrame(series, info);
  const [imageError, setImageError] = useState("");
  const image = frame?.value?.kind === "image" ? frame.value : undefined;
  const { calibration, error: calibrationError } = useCameraCalibration(
    series,
    frame,
    image,
    index,
  );
  const geometryKey =
    calibration &&
    JSON.stringify([
      calibration.width,
      calibration.height,
      calibration.intrinsics,
      calibration.distortion_model,
      calibration.distortion,
    ]);
  const {
    matrix: placement,
    missing: unresolved,
    error: transformError,
    settled,
    estimated,
  } = useFramePlacement(series.source, image?.frame_id, target, frame);
  const group = useMemo(() => {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    return group;
  }, []);
  const fitted = useRef(false);
  const latest = useRef({ frame, image });
  latest.current = { frame, image };
  const kick = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    kick.current?.();
  }, [frame, image]);
  useEffect(() => {
    stage.scene.add(group);
    return () => {
      stage.scene.remove(group);
      stage.invalidate();
    };
  }, [stage, group]);
  useEffect(() => {
    if (!calibration) return;
    let surface: ReturnType<typeof cameraSurface>;
    try {
      surface = cameraSurface(calibration);
    } catch (error) {
      setImageError(errorMessage(error));
      return;
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute("position", new THREE.Float32BufferAttribute(surface.outline, 3));
    const outline = new THREE.LineSegments(
      lines,
      new THREE.LineBasicMaterial({ color: series.color }),
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(surface.vertices, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(surface.uvs, 2));
    geometry.setIndex(surface.indices);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const plane = new THREE.Mesh(geometry, material);
    group.add(outline, plane);
    plane.visible = false;
    let cancelled = false;
    let busy = false;
    let decodedFrame: typeof frame;
    let bitmap: ImageBitmap | undefined;
    let texture: THREE.Texture | undefined;
    const load = async () => {
      if (busy || cancelled) return;
      busy = true;
      while (!cancelled) {
        const next = latest.current;
        if (!next.frame || !next.image || next.frame === decodedFrame) break;
        decodedFrame = next.frame;
        try {
          const decoded = await decodeImage(next.frame, next.image, true);
          if (cancelled) {
            decoded.close();
            break;
          }
          const nextTexture = new THREE.Texture(decoded);
          nextTexture.colorSpace = THREE.SRGBColorSpace;
          nextTexture.needsUpdate = true;
          material.map = nextTexture;
          material.needsUpdate = true;
          plane.visible = true;
          texture?.dispose();
          bitmap?.close();
          texture = nextTexture;
          bitmap = decoded;
          setImageError("");
          stage.invalidate();
        } catch {
          if (!cancelled) setImageError("Could not decode image");
        }
      }
      busy = false;
    };
    kick.current = () => void load();
    kick.current();
    stage.invalidate();
    return () => {
      cancelled = true;
      kick.current = undefined;
      group.remove(outline, plane);
      lines.dispose();
      outline.material.dispose();
      geometry.dispose();
      material.dispose();
      texture?.dispose();
      bitmap?.close();
      stage.invalidate();
    };
  }, [geometryKey, group, stage, series.color]);
  useEffect(() => {
    const distance = series.imageDistance;
    const scale =
      distance !== undefined && Number.isFinite(distance) && distance > 0
        ? distance
        : defaultImageDistance;
    for (const object of group.children) object.scale.setScalar(scale);
    stage.invalidate();
  }, [group, stage, geometryKey, series.color, series.imageDistance]);
  useEffect(() => {
    if (!settled) return;
    group.visible =
      !series.hidden && !!calibration && !!image?.frame_id && (!target || !!placement);
    group.matrix.copy(placement ?? new THREE.Matrix4());
    group.matrixWorldNeedsUpdate = true;
    if (!fitted.current && group.visible && group.children.length) {
      fitted.current = true;
      stage.fit(group);
    }
    stage.invalidate();
  }, [group, series.hidden, calibration, image, target, placement, stage, settled]);
  const problem =
    error ||
    frame?.error ||
    imageError ||
    calibrationError ||
    transformError ||
    (image && !image.frame_id ? "Image has no frame ID" : "") ||
    (unresolved ? `No transform from ${image?.frame_id} to ${target} at this time` : "") ||
    (estimated ? estimatedPlacement : "");
  return <ReportSeriesProblem series={series} problem={problem} />;
}

/** Unit axes, x red, y green and z blue, as segments from the origin. */
function unitAxes() {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  geometry.setColors([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]);
  return geometry;
}

/** Axes of the shown frames at the playback position. */
export function FrameAxes({
  transforms,
  stage,
  settings,
}: {
  /** Every frame placed in the fixed frame at the playback position. */
  transforms: ResolvedFrames | undefined;
  stage: Stage;
  settings: FrameAxesSettings;
}) {
  // Every frame draws the same geometry and material, so changing a setting touches one object.
  const { group, geometry, material } = useMemo(
    () => ({
      group: new THREE.Group(),
      geometry: unitAxes(),
      material: new LineMaterial({ vertexColors: true }),
    }),
    [],
  );
  useEffect(() => {
    stage.scene.add(group);
    return () => {
      stage.scene.remove(group);
      geometry.dispose();
      material.dispose();
      stage.invalidate();
    };
  }, [stage, group, geometry, material]);
  useEffect(() => {
    material.linewidth = settings.width;
    stage.invalidate();
  }, [material, settings.width, stage]);
  useEffect(() => {
    const hidden = new Set(settings.hidden);
    const frames = Object.entries(transforms?.frames ?? {}).filter(([id]) => !hidden.has(id));
    group.children.length = Math.min(group.children.length, frames.length);
    while (group.children.length < frames.length) {
      const axes = new LineSegments2(geometry, material);
      axes.matrixAutoUpdate = false;
      group.add(axes);
    }
    const scale = new THREE.Matrix4().makeScale(settings.length, settings.length, settings.length);
    frames.forEach(([, frame], i) => {
      group.children[i].matrix.copy(matrixOf(frame)).multiply(scale);
      group.children[i].matrixWorldNeedsUpdate = true;
    });
    stage.invalidate();
  }, [transforms, settings.hidden, settings.length, group, geometry, material, stage]);
  return null;
}
