import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { errorMessage, topicKey, type Info, type Schemas, type Selected } from "../types";
import { get, runUrl } from "../data/sources";
import { decodeImage } from "../data/imagePixels";
import { usePlaybackStore } from "../workspace/playback";
import type { FieldIndex } from "../workspace/fieldIndex";
import {
  fixedFrameOf,
  useFrames,
  usePlaybackNs,
  useTransforms,
  useViewFrame,
} from "../data/useViewData";
import {
  fetchViewHistory,
  pointBuffers,
  type PointCloudValue,
  type Transform,
  type ViewFrame,
} from "../data/viewFrames";
import type { Widget } from "../workspace/widgets";
import { cameraSurface, defaultImageDistance } from "./camera";
import { useCameraCalibration } from "./useCameraCalibration";
import { reframeCamera } from "./sceneCamera";
import { poseTrail, trailWindow } from "./poseTrail";

type Stage = {
  scene: THREE.Scene;
  invalidate: () => void;
  fit: (object: THREE.Object3D) => void;
  reframe: (transform: Transform) => void;
  resetView: () => void;
};

const matrixOf = ({ translation, rotation }: Transform) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(...(translation as [number, number, number])),
    new THREE.Quaternion(...(rotation as [number, number, number, number])),
    new THREE.Vector3(1, 1, 1),
  );

/**
 * Where the latest data of `frameId` sits in `target`, by the transform at the data's own time.
 * It counts as the present, so what is rigid to `target` stays still between messages.
 */
function useFramePlacement(
  source: string | undefined,
  frameId: string | null | undefined,
  target: string | null,
  dataNs: string | null,
) {
  const placed = !!frameId && !!target;
  const { transforms, error } = useTransforms(
    source,
    placed && frameId !== target ? target : null,
    dataNs,
    true,
  );
  const transform = frameId ? transforms?.frames[frameId] : undefined;
  const matrix = useMemo(() => {
    if (!placed) return undefined;
    if (frameId === target) return new THREE.Matrix4();
    return transform ? matrixOf(transform) : undefined;
  }, [placed, frameId, target, transform]);
  // Data arrives ahead of its transform; placed by the previous one, it would jump and return.
  const settled = !placed || frameId === target || transforms?.time_ns === dataNs || !!error;
  return {
    matrix,
    missing: placed && frameId !== target && !!transforms && !transform,
    error,
    settled,
  };
}

/** Dark to bright, so that intensity reads on the dark background. */
function intensityColors(intensities: Float32Array) {
  const colors = new Float32Array(intensities.length * 3);
  const color = new THREE.Color();
  intensities.forEach((value, i) => {
    color.setHSL(0.66 * (1 - value), 1, 0.5);
    color.toArray(colors, i * 3);
  });
  return colors;
}

/** One point cloud topic. Draws into the stage, and renders only its problems. */
function PointsLayer({
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
  } = useFramePlacement(series.source, value?.frame_id, target, frame?.time_ns ?? null);
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
    (unresolved ? `No transform from ${frameId} to ${target} at this time` : "");
  return problem ? (
    <p className="view-error">
      {series.topicName ?? series.topic}: {problem}
    </p>
  ) : null;
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
  const identity = JSON.stringify([series.key, series.view, info?.start_ns, world]);
  // The whole trail is then seen from where the fixed frame is now.
  const { transforms, error: transformError } = useTransforms(
    series.source,
    target,
    ns === null ? null : String(ns),
    true,
  );
  const placement = world ? transforms?.frames[world] : undefined;
  const [loaded, setLoaded] = useState<{ identity: string; frames: ViewFrame[]; error: string }>();
  useEffect(() => {
    if (!info) return;
    const controller = new AbortController();
    fetchViewHistory(series, controller.signal, world ?? undefined)
      .then((frames) => {
        if (!controller.signal.aborted) setLoaded({ identity, frames, error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLoaded({ identity, frames: [], error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [identity]);
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
  return problem ? (
    <p className="view-error">
      {series.topicName ?? series.topic}: {problem}
    </p>
  ) : null;
}

/** The latest pose, with the arrow pointing along the body's positive x axis. */
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
  const { frame, error } = useViewFrame(series, info);
  const value = frame?.value?.kind === "pose" ? frame.value : undefined;
  const frameId = value?.frame_id;
  const {
    matrix: placement,
    missing,
    error: transformError,
    settled,
  } = useFramePlacement(series.source, frameId, target, frame?.time_ns ?? null);
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
  useEffect(() => {
    stage.scene.add(arrow);
    return () => {
      stage.scene.remove(arrow);
      arrow.dispose();
      stage.invalidate();
    };
  }, [arrow, stage]);
  useEffect(() => {
    if (!settled) return;
    arrow.visible = !series.hidden && !!value && !!frameId && (!target || !!placement);
    arrow.setColor(new THREE.Color(series.color));
    if (value) {
      const pose = matrixOf({ translation: value.pose.position, rotation: value.pose.orientation });
      arrow.matrix.copy(placement ? placement.clone().multiply(pose) : pose);
      arrow.matrixWorldNeedsUpdate = true;
    }
    stage.invalidate();
  }, [arrow, value, frameId, target, placement, series.hidden, series.color, stage, settled]);
  const problem =
    error ||
    frame?.error ||
    transformError ||
    (value && !frameId ? "Pose has no frame ID" : "") ||
    (missing ? `No transform from ${frameId} to ${target} at this time` : "");
  return (
    <>
      {info && (
        <PoseTrail series={series} info={info} target={target} world={world} stage={stage} />
      )}
      {problem && (
        <p className="view-error">
          {series.topicName ?? series.topic}: {problem}
        </p>
      )}
    </>
  );
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
  } = useFramePlacement(series.source, image?.frame_id, target, frame?.time_ns ?? null);
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
    (unresolved ? `No transform from ${image?.frame_id} to ${target} at this time` : "");
  return problem ? (
    <p className="view-error">
      {series.topicName ?? series.topic}: {problem}
    </p>
  ) : null;
}

/** Axes of every frame at the playback position. */
function FrameAxes({
  source,
  target,
  info,
  stage,
}: {
  source: string | undefined;
  target: string | null;
  info: Info | null;
  stage: Stage;
}) {
  const ns = usePlaybackNs(info);
  const { transforms } = useTransforms(source, target, ns === null ? null : String(ns), true);
  const group = useMemo(() => new THREE.Group(), []);
  useEffect(() => {
    stage.scene.add(group);
    return () => {
      stage.scene.remove(group);
      stage.invalidate();
    };
  }, [stage, group]);
  useEffect(() => {
    const frames = Object.values(transforms?.frames ?? {});
    while (group.children.length > frames.length) {
      const axes = group.children.pop() as THREE.AxesHelper;
      axes.dispose();
    }
    while (group.children.length < frames.length) {
      const axes = new THREE.AxesHelper(1);
      axes.matrixAutoUpdate = false;
      group.add(axes);
    }
    frames.forEach((frame, i) => {
      group.children[i].matrix.copy(matrixOf(frame));
      group.children[i].matrixWorldNeedsUpdate = true;
    });
    stage.invalidate();
  }, [transforms, group, stage]);
  return null;
}

function createStage(host: HTMLDivElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#101317");
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1e6);
  // Recorded coordinates have z up.
  camera.up.set(0, 0, 1);
  const homePosition = new THREE.Vector3(-20, -20, 20);
  camera.position.copy(homePosition);
  const grid = new THREE.GridHelper(20, 20, "#5b6570", "#343a42");
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  let controls = new OrbitControls(camera, renderer.domElement);
  let pending = 0;
  const invalidate = () => {
    pending ||= requestAnimationFrame(() => {
      pending = 0;
      renderer.render(scene, camera);
    });
  };
  controls.addEventListener("change", invalidate);
  const resize = new ResizeObserver(() => {
    const { clientWidth: width, clientHeight: height } = host;
    if (!width || !height) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    invalidate();
  });
  resize.observe(host);
  const fit = (object: THREE.Object3D) => {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = Math.max(sphere.radius, 1) * 2;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).add(new THREE.Vector3(-distance, -distance, distance));
    // Cells of a round number of meters, whatever the size of what is shown.
    grid.scale.setScalar(10 ** Math.ceil(Math.log10(distance) - 1));
    grid.position.set(sphere.center.x, sphere.center.y, 0);
    controls.update();
    invalidate();
  };
  // Controls take the camera's up direction when created, so changing it needs new ones.
  const replaceControls = (target: THREE.Vector3) => {
    controls.dispose();
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.addEventListener("change", invalidate);
    controls.update();
    invalidate();
  };
  const reframe = (transform: Transform) => {
    const target = controls.target.clone();
    reframeCamera(camera, target, transform);
    replaceControls(target);
  };
  const resetView = () => {
    camera.up.set(0, 0, 1);
    camera.position.copy(homePosition);
    grid.scale.setScalar(1);
    replaceControls(new THREE.Vector3());
  };
  invalidate();
  return {
    stage: { scene, invalidate, fit, reframe, resetView },
    dispose: () => {
      cancelAnimationFrame(pending);
      resize.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Switch the scene and viewpoint together after resolving the frame change. */
export function useSceneFrame(
  stage: Stage | undefined,
  source: string | undefined,
  target: string | null,
  info: Info | null,
) {
  const playback = usePlaybackStore();
  const run = source ? runUrl(source) : null;
  const previous = useRef<{ stage: Stage; run: string; frame: string }>(undefined);
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!stage || !run || !target || !info) return;
    const old = previous.current;
    if (!old || old.stage !== stage || old.run !== run) {
      previous.current = { stage, run, frame: target };
      setShown(target);
      setError("");
      return;
    }
    if (old.frame === target) {
      setError("");
      return;
    }
    const controller = new AbortController();
    const time = String(BigInt(info.start_ns) + BigInt(Math.round(playback.getState().time * 1e9)));
    get<Schemas["Transforms"]>(
      `${run}/transforms?${new URLSearchParams({ target, time_ns: time })}`,
      controller.signal,
    )
      .then((transforms) => {
        if (controller.signal.aborted) return;
        const transform = transforms.frames[old.frame];
        // Frames have samples for different spans of time. Without one here, the view
        // cannot be carried over, which is no reason to stay in the old frame.
        if (transform) stage.reframe(transform);
        else stage.resetView();
        previous.current = { stage, run, frame: target };
        setShown(target);
        setError("");
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(`Could not change fixed frame: ${errorMessage(error)}`);
      });
    return () => controller.abort();
  }, [stage, run, target, info?.start_ns, playback]);
  return { target: shown, error };
}

/** Point clouds and frames in a fixed frame, at the playback position. */
export default function Scene3D({
  widget,
  info,
  index,
  onFixedFrame,
  resetCount,
}: {
  widget: Widget;
  info: Info | null;
  index: FieldIndex;
  onFixedFrame: (frame: string) => void;
  /** Each change returns the camera to its starting place in the current frame. */
  resetCount: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>();
  const [failure, setFailure] = useState("");
  useEffect(() => {
    try {
      const created = createStage(host.current!);
      setStage(created.stage);
      return created.dispose;
    } catch (error) {
      setFailure(`Could not start 3D view: ${error instanceof Error ? error.message : error}`);
    }
  }, []);
  useEffect(() => {
    if (resetCount) stage?.resetView();
  }, [resetCount]);
  const sources = widget.series.map((s) => s.source);
  const { frames, error } = useFrames(sources);
  // Unless one was chosen, the scene follows the frame of the first topic added.
  const { frame: firstFrame } = useViewFrame(
    widget.fixedFrame === null ? widget.series[0] : undefined,
    info,
  );
  const firstFrameId =
    firstFrame?.value && "frame_id" in firstFrame.value ? firstFrame.value.frame_id : null;
  useEffect(() => {
    if (firstFrameId && frames.some((frame) => frame.id === firstFrameId))
      onFixedFrame(firstFrameId);
  }, [firstFrameId, frames]);
  const world = fixedFrameOf(null, frames);
  const adopted = firstFrameId && frames.some((frame) => frame.id === firstFrameId);
  // Held back until the first topic's frame is known: starting from another frame would
  // carry its view over, away from the data.
  const deciding = widget.fixedFrame === null && !!widget.series[0] && firstFrame === undefined;
  const requested = deciding
    ? null
    : fixedFrameOf(widget.fixedFrame ?? (adopted ? firstFrameId : null), frames);
  const { target, error: frameError } = useSceneFrame(stage, sources[0], requested, info);
  const problem = failure || error || frameError;
  return (
    <div className="view-scene" ref={host}>
      {stage && <FrameAxes source={sources[0]} target={target} info={info} stage={stage} />}
      <div className="view-problems">
        {problem && <p className="view-error">{problem}</p>}
        {stage &&
          widget.series.map((series) => {
            const kind = index.topics
              .get(topicKey(series.source, series.topic))
              ?.views.find((view) => view.id === series.view)?.kind;
            return kind === "image" ? (
              <CameraLayer
                key={series.key}
                series={series}
                info={info}
                target={target}
                stage={stage}
                index={index}
              />
            ) : kind === "pose" ? (
              <PoseLayer
                key={series.key}
                series={series}
                info={info}
                target={target}
                world={world}
                stage={stage}
              />
            ) : (
              <PointsLayer
                key={series.key}
                series={series}
                info={info}
                target={target}
                stage={stage}
              />
            );
          })}
      </div>
    </div>
  );
}
