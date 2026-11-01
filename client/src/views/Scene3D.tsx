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
import { pointBuffers, type PointCloudValue, type Transform } from "../data/viewFrames";
import type { Widget } from "../workspace/widgets";
import { cameraSurface, defaultImageDistance } from "./camera";
import { useCameraCalibration } from "./useCameraCalibration";
import { reframeCamera } from "./sceneCamera";

type Stage = { scene: THREE.Scene; invalidate: () => void; fit: (object: THREE.Object3D) => void };

const matrixOf = ({ translation, rotation }: Transform) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(...(translation as [number, number, number])),
    new THREE.Quaternion(...(rotation as [number, number, number, number])),
    new THREE.Vector3(1, 1, 1),
  );

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
  const { transforms, error: transformError } = useTransforms(
    series.source,
    target,
    frame?.time_ns ?? null,
  );
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
  const placement = target && frameId ? transforms?.frames[frameId] : undefined;
  // Without a graph the cloud can only be shown where it was recorded.
  const unresolved = !!target && !!frameId && !!transforms && !placement;
  useEffect(() => {
    points.visible = !series.hidden && !!value && !unresolved;
    if (value) {
      const pose = matrixOf({ translation: value.pose.position, rotation: value.pose.orientation });
      points.matrix.copy(placement ? matrixOf(placement).multiply(pose) : pose);
      points.matrixWorldNeedsUpdate = true;
    }
    stage.invalidate();
  }, [points, value, placement, unresolved, series.hidden, stage]);
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
  const { transforms, error: transformError } = useTransforms(
    series.source,
    target,
    frame?.time_ns ?? null,
  );
  const placement = target && image?.frame_id ? transforms?.frames[image.frame_id] : undefined;
  const unresolved = !!target && !!image?.frame_id && !!transforms && !placement;
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
    group.visible =
      !series.hidden && !!calibration && !!image?.frame_id && (!target || !!placement);
    group.matrix.copy(placement ? matrixOf(placement) : new THREE.Matrix4());
    group.matrixWorldNeedsUpdate = true;
    if (!fitted.current && group.visible && group.children.length) {
      fitted.current = true;
      stage.fit(group);
    }
    stage.invalidate();
  }, [group, series.hidden, calibration, image, target, placement, stage]);
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
  const { transforms } = useTransforms(source, target, ns === null ? null : String(ns));
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
  camera.position.set(-20, -20, 20);
  const grid = new THREE.GridHelper(20, 20, "#5b6570", "#343a42");
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
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
  invalidate();
  return {
    stage: { scene, invalidate, fit },
    dispose: () => {
      cancelAnimationFrame(pending);
      resize.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Point clouds and frames in a fixed frame, at the playback position. */
export default function Scene3D({
  widget,
  info,
  index,
}: {
  widget: Widget;
  info: Info | null;
  index: FieldIndex;
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
  const sources = widget.series.map((s) => s.source);
  const { frames, error } = useFrames(sources);
  const target = fixedFrameOf(widget.fixedFrame, frames);
  const problem = failure || error;
  return (
    <div className="view-scene" ref={host}>
      {stage && <FrameAxes source={sources[0]} target={target} info={info} stage={stage} />}
      <div className="view-problems">
        {problem && <p className="view-error">{problem}</p>}
        {stage &&
          widget.series.map((series) =>
            index.topics
              .get(topicKey(series.source, series.topic))
              ?.views.find((view) => view.id === series.view)?.kind === "image" ? (
              <CameraLayer
                key={series.key}
                series={series}
                info={info}
                target={target}
                stage={stage}
                index={index}
              />
            ) : (
              <PointsLayer
                key={series.key}
                series={series}
                info={info}
                target={target}
                stage={stage}
              />
            ),
          )}
      </div>
    </div>
  );
}
