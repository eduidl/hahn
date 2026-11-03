import {
  type Stage,
  PointsLayer,
  PoseSetLayer,
  PoseLayer,
  CameraLayer,
  FrameAxes,
  FollowContext,
  PlacementContext,
} from "./sceneLayers";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { errorMessage, topicKey, type Info } from "../types";
import { runUrl } from "../data/sources";
import { runTransforms } from "../data/runTransforms";
import { usePlaybackStore } from "../workspace/playback";
import type { FieldIndex } from "../workspace/fieldIndex";
import {
  fixedFrameOf,
  useFrames,
  usePlaybackNs,
  useTransforms,
  useViewFrame,
} from "../data/useViewData";
import type { Transform } from "../data/viewFrames";
import type { Widget } from "../workspace/widgets";
import { gridOffset, lookCamera, reframeCamera, walkCamera } from "./sceneCamera";

function createStage(host: HTMLDivElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#171a1e");
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1e6);
  // The scene is oriented as the graph's root, taken to be fixed to the ground with z up.
  camera.up.set(0, 0, 1);
  const homePosition = new THREE.Vector3(-20, -20, 20);
  camera.position.copy(homePosition);
  const grid = new THREE.GridHelper(20, 20, "#5b6570", "#343a42");
  // A level plane through the origin, the followed frame's position; see gridOffset.
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  // Layers draw here in the root, shifted to keep coordinates near the camera small.
  const content = new THREE.Group();
  scene.add(content);
  const origin = new THREE.Vector3();
  let originSet = false;
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
    // The middle button looks around instead of zooming, which the wheel does.
    created.mouseButtons.MIDDLE = -1 as unknown as THREE.MOUSE;
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
  // WASD moves the view along the ground while the canvas, focused by a click, has the keys.
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  const walkKeys: Record<string, [number, number]> = {
    KeyW: [1, 0],
    KeyS: [-1, 0],
    KeyA: [0, -1],
    KeyD: [0, 1],
  };
  const held = new Set<string>();
  let fast = false;
  let walking = 0;
  let lastStep = 0;
  const walk = (now: number) => {
    walking = 0;
    pivot.visible = held.size > 0;
    if (held.size) {
      // Capped, so a stalled frame does not throw the view far away.
      const seconds = Math.min((now - lastStep) / 1000, 0.1);
      lastStep = now;
      let forward = 0;
      let right = 0;
      for (const code of held) {
        forward += walkKeys[code][0];
        right += walkKeys[code][1];
      }
      walkCamera(camera, controls.target, forward, right, seconds, fast);
      controls.update();
      walking = requestAnimationFrame(walk);
    }
    invalidate();
  };
  const onWalkKey = (event: KeyboardEvent) => {
    const down = event.type === "keydown";
    if (event.key === "Shift") fast = down;
    if (!(event.code in walkKeys) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (!down) {
      held.delete(event.code);
      return;
    }
    held.add(event.code);
    if (!walking) {
      lastStep = performance.now();
      walking = requestAnimationFrame(walk);
    }
  };
  const stopWalking = () => {
    held.clear();
    fast = false;
  };
  // Dragging with the middle button looks around from where the camera is.
  let looking: { id: number; x: number; y: number } | null = null;
  const onLookStart = (event: PointerEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    looking = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onLookMove = (event: PointerEvent) => {
    if (looking?.id !== event.pointerId) return;
    // As far per pixel as turning around the target with a drag.
    const perPixel = (2 * Math.PI) / Math.max(canvas.clientHeight, 1);
    const yaw = -(event.clientX - looking.x) * perPixel;
    const pitch = -(event.clientY - looking.y) * perPixel;
    looking.x = event.clientX;
    looking.y = event.clientY;
    lookCamera(camera, controls.target, yaw, pitch);
    controls.update();
    invalidate();
  };
  const onLookEnd = (event: PointerEvent) => {
    if (looking?.id === event.pointerId) looking = null;
  };
  // Keeps a middle click from pasting or starting to scroll on some systems.
  const onAuxClick = (event: MouseEvent) => {
    if (event.button === 1) event.preventDefault();
  };
  canvas.addEventListener("pointerdown", onLookStart);
  canvas.addEventListener("pointermove", onLookMove);
  canvas.addEventListener("pointerup", onLookEnd);
  canvas.addEventListener("pointercancel", onLookEnd);
  canvas.addEventListener("auxclick", onAuxClick);
  const focusCanvas = () => canvas.focus({ preventScroll: true });
  canvas.addEventListener("pointerdown", focusCanvas);
  canvas.addEventListener("keydown", onWalkKey);
  canvas.addEventListener("keyup", onWalkKey);
  canvas.addEventListener("blur", stopWalking);
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
    // Following no frame, the scene is drawn around the first thing shown instead.
    if (!originSet) {
      setOrigin(sphere.center.clone().add(origin).toArray());
      sphere.center.set(0, 0, 0);
    }
    // Turning around a point on the grid, below or above the middle of what is shown.
    sphere.center.z = 0;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).add(new THREE.Vector3(-distance, -distance, distance));
    // Cells of a round number of meters, whatever the size of what is shown.
    grid.scale.setScalar(10 ** Math.ceil(Math.log10(distance) - 1));
    placeGrid();
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
    placeGrid();
    controls.target.set(0, 0, 0);
    controls.update();
    invalidate();
  };
  const setOrigin = (position: number[], keepView = false) => {
    originSet = true;
    const previous = origin.clone();
    origin.set(...(position as [number, number, number]));
    if (keepView) {
      // Shifted by as much as the content is, so nothing appears to move.
      const moved = origin.clone().sub(previous);
      camera.position.sub(moved);
      controls.target.sub(moved);
      controls.update();
    }
    content.position.copy(origin).negate();
    placeGrid();
    invalidate();
  };
  invalidate();
  return {
    stage: { scene: content, invalidate, fit, reframe, resetView, setOrigin },
    dispose: () => {
      cancelAnimationFrame(pending);
      cancelAnimationFrame(walking);
      canvas.removeEventListener("pointerdown", focusCanvas);
      canvas.removeEventListener("pointerdown", onLookStart);
      canvas.removeEventListener("pointermove", onLookMove);
      canvas.removeEventListener("pointerup", onLookEnd);
      canvas.removeEventListener("pointercancel", onLookEnd);
      canvas.removeEventListener("auxclick", onAuxClick);
      canvas.removeEventListener("keydown", onWalkKey);
      canvas.removeEventListener("keyup", onWalkKey);
      canvas.removeEventListener("blur", stopWalking);
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
    const time = BigInt(info.start_ns) + BigInt(Math.round(playback.getState().time * 1e9));
    const transforms = runTransforms(run);
    transforms
      .ensure(time)
      .then(() => {
        if (controller.signal.aborted) return;
        const failure = transforms.error();
        if (failure) throw new Error(failure);
        const transform = transforms.graph().resolve(target, time)[old.frame];
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
  onFollowFrame,
  resetCount,
}: {
  widget: Widget;
  info: Info | null;
  index: FieldIndex;
  onFollowFrame: (frame: string) => void;
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
  // Unless one was chosen, the camera follows the frame of the first topic added.
  const { frame: firstFrame } = useViewFrame(
    widget.followFrame === null ? widget.series[0] : undefined,
    info,
  );
  const firstFrameId =
    firstFrame?.value && "frame_id" in firstFrame.value ? firstFrame.value.frame_id : null;
  useEffect(() => {
    if (firstFrameId && frames.some((frame) => frame.id === firstFrameId))
      onFollowFrame(firstFrameId);
  }, [firstFrameId, frames]);
  const world = fixedFrameOf(null, frames);
  const { target, error: frameError } = useSceneFrame(stage, sources[0], world, info);
  const ns = usePlaybackNs(info);
  const { transforms } = useTransforms(sources[0], target, ns === null ? null : String(ns), true);
  const followed = fixedFrameOf(widget.followFrame, frames);
  // Following the root itself is not following anything.
  const pose =
    followed !== null && followed !== target && transforms?.target === target
      ? (transforms.frames[followed] ?? null)
      : null;
  // Changing the followed frame changes only what the view moves with: the view stays, as
  // a frame fixed to the ground such as odom may have its origin far from anything shown.
  // Without a frame to follow, the scene stays around where it was. Resetting the view
  // brings it to the followed frame.
  const lastFollowed = useRef<string | null>(null);
  useEffect(() => {
    if (!stage || followed === null) return;
    const switched = lastFollowed.current !== null && lastFollowed.current !== followed;
    if (followed === target) lastFollowed.current = followed;
    if (!pose) return;
    stage.setOrigin(pose.translation, switched);
    lastFollowed.current = followed;
  }, [stage, followed, target, pose]);
  const anchor = useMemo(
    () => (pose && followed !== null ? { frame: followed, pose } : null),
    [followed, pose],
  );
  const problem = failure || error || frameError;
  return (
    <div className="view-scene" ref={host}>
      {stage && <FrameAxes transforms={transforms} stage={stage} settings={widget.frameAxes} />}
      <PlacementContext.Provider value={widget.placement}>
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
                ) : kind === "pose" || kind === "position" ? (
                  <PoseLayer
                    key={series.key}
                    series={series}
                    info={info}
                    target={target}
                    world={world}
                    stage={stage}
                  />
                ) : kind === "poses" || kind === "path" ? (
                  <PoseSetLayer
                    key={series.key}
                    series={series}
                    info={info}
                    target={target}
                    stage={stage}
                  />
                ) : kind === "pointcloud" ? (
                  <PointsLayer
                    key={series.key}
                    series={series}
                    info={info}
                    target={target}
                    stage={stage}
                  />
                ) : // A kind this client does not know is not drawn (ADR 0007).
                null;
              })}
          </div>
        </FollowContext.Provider>
      </PlacementContext.Provider>
    </div>
  );
}
