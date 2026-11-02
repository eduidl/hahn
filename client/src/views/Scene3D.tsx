import { type Stage, PointsLayer, PoseLayer, CameraLayer, FrameAxes } from "./sceneLayers";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { errorMessage, topicKey, type Info, type Schemas } from "../types";
import { get, runUrl } from "../data/sources";
import { usePlaybackStore } from "../workspace/playback";
import { type FieldIndex } from "../workspace/fieldIndex";
import {
  fixedFrameOf,
  useFrames,
  usePlaybackNs,
  useTransforms,
  useViewFrame,
} from "../data/useViewData";
import { type Transform } from "../data/viewFrames";
import { type Widget } from "../workspace/widgets";
import { reframeCamera } from "./sceneCamera";

function createStage(host: HTMLDivElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#171a1e");
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1e6);
  // Recorded coordinates have z up.
  camera.up.set(0, 0, 1);
  const homePosition = new THREE.Vector3(-20, -20, 20);
  camera.position.copy(homePosition);
  const grid = new THREE.GridHelper(20, 20, "#5b6570", "#343a42");
  // Stays at the origin: the scene is in the fixed frame, so this is that frame's ground plane.
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  // Layers draw here in the root, shifted to keep coordinates near the camera small.
  const content = new THREE.Group();
  scene.add(content);
  const origin = new THREE.Vector3();
  const placeGrid = () => grid.position.copy(gridOffset(origin, grid.scale.x));
  // Marks the point the view turns around while it is being moved.
  const pivot = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8),
    new THREE.MeshBasicMaterial({ color: "#ffffff", depthTest: false, transparent: true }),
  );
  pivot.renderOrder = 1;
  pivot.visible = false;
  scene.add(pivot);
  let pending = 0;
  const invalidate = () => {
    pending ||= requestAnimationFrame(() => {
      pending = 0;
      pivot.position.copy(controls.target);
      // The same size on screen at any distance.
      pivot.scale.setScalar(camera.position.distanceTo(controls.target) * 0.006);
      renderer.render(scene, camera);
    });
  };
  const createControls = (target: THREE.Vector3) => {
    const created = new OrbitControls(camera, renderer.domElement);
    // Panning slides along the ground, so the view keeps turning around a point on it
    // rather than one lifted into the air by dragging up or down the screen.
    created.screenSpacePanning = false;
    // Zooming moves toward what is under the cursor, carrying the point turned around
    // along the ground, so a distant object can be reached without panning first.
    created.zoomToCursor = true;
    created.target.copy(target);
    created.addEventListener("change", invalidate);
    created.addEventListener("start", () => {
      pivot.visible = true;
      invalidate();
    });
    created.addEventListener("end", () => {
      pivot.visible = false;
      invalidate();
    });
    created.update();
    return created;
  };
  let controls = createControls(new THREE.Vector3());
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
    controls.update();
    invalidate();
  };
  // Controls take the camera's up direction when created, so changing it needs new ones.
  const replaceControls = (target: THREE.Vector3) => {
    controls.dispose();
    controls = createControls(target);
    invalidate();
  };
  const reframe = (transform: Transform) => {
    const target = controls.target.clone();
    reframeCamera(camera, target, transform);
    // The new fixed frame's z axis is up, whatever the old one's was.
    camera.up.set(0, 0, 1);
    replaceControls(target);
  };
  const resetView = () => {
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
      pivot.geometry.dispose();
      pivot.material.dispose();
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
  const { target, error: frameError } = useSceneFrame(stage, sources[0], world, info);
  const ns = usePlaybackNs(info);
  const { transforms } = useTransforms(sources[0], target, ns === null ? null : String(ns), true);
  const followed = fixedFrameOf(widget.followFrame, frames);
  // Following the root itself leaves the scene around the root's origin.
  const pose =
    followed !== null && followed !== target && transforms?.target === target
      ? (transforms.frames[followed] ?? null)
      : null;
  useEffect(() => {
    if (!stage) return;
    if (followed === null || followed === target) stage.setOrigin(null);
    // Until the frame is placed again, the scene stays around where it was.
    else if (pose) stage.setOrigin(pose.translation);
  }, [stage, followed, target, pose]);
  const anchor = useMemo(
    () => (pose && followed !== null ? { frame: followed, pose } : null),
    [followed, pose],
  );
  const problem = failure || error || frameError;
  return (
    <div className="view-scene" ref={host}>
      {stage && <FrameAxes transforms={transforms} stage={stage} settings={widget.frameAxes} />}
      <FollowContext.Provider value={anchor}>
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
      </FollowContext.Provider>
    </div>
  );
}
