import { type Stage, PointsLayer, PoseLayer, CameraLayer, FrameAxes } from "./sceneLayers";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { errorMessage, topicKey, type Info, type Schemas } from "../types";
import { get, runUrl } from "../data/sources";
import { usePlaybackStore } from "../workspace/playback";
import { type FieldIndex } from "../workspace/fieldIndex";
import { fixedFrameOf, useFrames, useViewFrame } from "../data/useViewData";
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
