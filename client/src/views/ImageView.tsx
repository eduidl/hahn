import "./ImageView.css";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { secondsFrom } from "../data/data";
import { runUrl } from "../data/sources";
import { runTransforms } from "../data/runTransforms";
import { ReportSeriesProblem } from "./seriesViewProblem";
import { decodeImage } from "../data/imagePixels";
import { useLatestOnly, useViewFrame } from "../data/useViewData";
import {
  fetchLatestFrame,
  fetchViewHistory,
  pointBuffers,
  type ViewFrame,
} from "../data/viewFrames";
import {
  annotationWindowNs,
  drawAnnotations,
  matchAnnotations,
  type MatchedAnnotations,
} from "./annotations";
import { useTimeFormatter } from "../timeDisplay";
import { errorMessage, topicKey, type Info, type Schemas, type Selected } from "../types";
import type { FieldIndex } from "../workspace/fieldIndex";
import type { Widget } from "../workspace/widgets";
import { cameraDistortionError, cloudToCameraMatrix, projectCameraPoint } from "./camera";
import { wheelZoomFactor } from "./Plot";
import { applyCalibration, calibrationChoice, fetchCalibration } from "./useCameraCalibration";

const mimeTypes: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};
type Calibration = Schemas["CameraCalibrationValue"];
type Cloud = {
  series: Selected;
  frame: ViewFrame | null;
  placement?: Schemas["Transform"];
  error?: string;
};
type Marks = { series: Selected; matched?: MatchedAnnotations; error?: string };
type Bundle = {
  frame: ViewFrame;
  calibration?: Calibration;
  clouds: Cloud[];
  marks: Marks[];
  error?: string;
};

/** The marks of one topic over the shown image, and why there are none or few. */
function Overlay({ marks, width, height }: { marks: Marks; width: number; height: number }) {
  const { series, matched } = marks;
  const omitted = matched?.value.omitted ?? 0;
  const problem =
    marks.error ||
    matched?.frame.error ||
    (omitted
      ? `${omitted.toLocaleString()} ${omitted === 1 ? "mark" : "marks"} left out: not finite or of no known type`
      : "") ||
    (matched?.estimated ? "No measurement time: matched to the image by log time" : "");
  const canvas = (element: HTMLCanvasElement | null) => {
    const context = element?.getContext("2d");
    if (!context || !matched) return;
    context.clearRect(0, 0, width, height);
    drawAnnotations(context, matched.value.annotations, series.color);
  };
  return (
    <>
      {matched && !series.hidden && <canvas ref={canvas} width={width} height={height} />}
      <ReportSeriesProblem series={series} problem={problem} />
    </>
  );
}

/** Magnification and offset, the offset as a fraction of the view so that it survives resizing. */
export type ImageZoom = { zoom: number; x: number; y: number };
export const fullImage: ImageZoom = { zoom: 1, x: 0, y: 0 };
const maxImageZoom = 32;

/** Keeps the image covering the whole view, however it was moved. */
const clampImage = ({ zoom, x, y }: ImageZoom): ImageZoom => ({
  zoom,
  x: Math.max(1 - zoom, Math.min(0, x)),
  y: Math.max(1 - zoom, Math.min(0, y)),
});

/** Zooms while the image point under `pointer`, a fraction of the view, stays put. */
export function zoomImage(view: ImageZoom, factor: number, pointer: { x: number; y: number }) {
  const zoom = Math.max(1, Math.min(maxImageZoom, view.zoom * factor));
  const ratio = zoom / view.zoom;
  return clampImage({
    zoom,
    x: pointer.x - (pointer.x - view.x) * ratio,
    y: pointer.y - (pointer.y - view.y) * ratio,
  });
}

export const panImage = (view: ImageZoom, dx: number, dy: number) =>
  clampImage({ ...view, x: view.x + dx, y: view.y + dy });

function Projection({ cloud, calibration }: { cloud: Cloud; calibration: Calibration }) {
  const { series, frame, placement } = cloud;
  const value = frame?.value?.kind === "pointcloud" ? frame.value : undefined;
  const problem =
    cloud.error ||
    frame?.error ||
    (!frame ? "No point cloud at this image time" : "") ||
    (value && !value.frame_id ? "Point cloud has no frame ID" : "") ||
    cameraDistortionError(calibration);
  const canvas = (element: HTMLCanvasElement | null) => {
    if (!element || !value || !frame || problem || series.hidden) return;
    const context = element.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, element.width, element.height);
    const matrix = cloudToCameraMatrix(value.pose, placement);
    const positions = pointBuffers(value, frame.blob).positions;
    const point = new THREE.Vector3();
    context.fillStyle = series.color;
    for (let i = 0; i < positions.length; i += 3) {
      point.fromArray(positions, i).applyMatrix4(matrix);
      const pixel = projectCameraPoint([point.x, point.y, point.z], calibration);
      if (pixel) context.fillRect(pixel[0] - 1.5, pixel[1] - 1.5, 3, 3);
    }
  };
  return (
    <>
      {value && !problem && !series.hidden && (
        <canvas ref={canvas} width={calibration.width} height={calibration.height} />
      )}
      <ReportSeriesProblem series={series} problem={problem} />
    </>
  );
}

/** The image and its projections advance together after all are ready. */
export function ImageView({
  widget,
  info,
  index,
  resetCount = 0,
  onCanReset,
}: {
  widget: Widget;
  info: Info | null;
  index: FieldIndex;
  /** Returns to the full image whenever this changes. */
  resetCount?: number;
  onCanReset?: (canReset: boolean) => void;
}) {
  const kind = (series: Selected) =>
    index.topics
      .get(topicKey(series.source, series.topic))
      ?.views.find((view) => view.id === series.view)?.kind;
  const series = widget.series.find((item) => kind(item) === "image");
  const clouds = widget.series.filter((item) => kind(item) === "pointcloud" && !item.hidden);
  const overlays = widget.series.filter(
    (item) => kind(item) === "image_annotations" && !item.hidden,
  );
  const { frame, error } = useViewFrame(series, info);
  const formatter = useTimeFormatter(info?.start_ns ?? null);
  const choice = calibrationChoice(index, series);
  const identity =
    series && info
      ? JSON.stringify([
          series.key,
          info.start_ns,
          choice,
          clouds.map((c) => [c.key, c.view]),
          overlays.map((o) => [o.key, o.view]),
        ])
      : null;
  const loaded = useLatestOnly<Bundle>(
    identity,
    frame?.value?.kind === "image" ? frame.time_ns : null,
    async (time, known, signal) => {
      const imageFrame = frame!;
      const image = imageFrame.value;
      if (image?.kind !== "image") throw new Error("Image is unavailable");
      // Marks are recorded after their image, so they are sought on both sides of it.
      const at = BigInt(time);
      const range = {
        start_ns: String(at > annotationWindowNs ? at - annotationWindowNs : 0n),
        end_ns: String(at + annotationWindowNs),
      };
      const marks = await Promise.all(
        overlays.map(async (overlay): Promise<Marks> => {
          try {
            const frames = await fetchViewHistory(overlay, signal, range);
            return { series: overlay, matched: matchAnnotations(frames, imageFrame) };
          } catch (error) {
            if (signal.aborted) throw error;
            return { series: overlay, error: errorMessage(error) };
          }
        }),
      );
      if (!clouds.length) return { frame: imageFrame, clouds: [], marks };
      if (!image.frame_id)
        return { frame: imageFrame, clouds: [], marks, error: "Image has no frame ID" };
      const failed = (error: string) => ({ frame: imageFrame, clouds: [], marks, error });
      if (!choice.target) return failed("No camera calibration chosen for this image");
      const found = await fetchCalibration(choice.target, imageFrame, signal);
      if (found?.error) return failed(found.error);
      if (found?.value?.kind !== "camera_calibration")
        return failed("No camera calibration for this image");
      const applied = applyCalibration(found.value, choice.rectified);
      if (!applied.calibration) return failed(applied.error!);
      const resolved = await Promise.all(
        clouds.map(async (series) => {
          const previous = known?.clouds.find((item) => item.series.key === series.key)?.frame;
          const cloud = await fetchLatestFrame(series, time, previous, signal);
          const frameId = cloud?.value?.kind === "pointcloud" ? cloud.value.frame_id : null;
          if (!frameId || frameId === image.frame_id) return { series, frame: cloud };
          // At the image's measurement time when it has one, else its log time (ADR 0002).
          const transforms = runTransforms(runUrl(series.source));
          await transforms.ensure(BigInt(time));
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          const failure = transforms.error();
          if (failure) throw new Error(failure);
          const stamp = image.stamp_ns;
          const placement = transforms
            .graph()
            .resolve(image.frame_id!, BigInt(stamp ?? time), { axis: stamp ? "stamp" : "time" })[
            frameId
          ];
          return {
            series,
            frame: cloud,
            placement,
            error: placement
              ? undefined
              : `No transform from ${frameId} to ${image.frame_id} at this time`,
          };
        }),
      );
      return { frame: imageFrame, calibration: applied.calibration, clouds: resolved, marks };
    },
  );
  const [view, setView] = useState(fullImage);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number }>(undefined);
  useEffect(() => setView(fullImage), [identity]);
  useEffect(() => {
    if (resetCount) setView(fullImage);
  }, [resetCount]);
  useEffect(() => {
    const node = root.current!;
    // Non-passive to stop the scroll, which React's onWheel cannot do.
    const onWheel = (event: WheelEvent) => {
      if (!node.querySelector(".view-image-stage > img, .view-image-stage > canvas")) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const pointer = {
        x: (event.clientX - rect.left) / Math.max(rect.width, 1),
        y: (event.clientY - rect.top) / Math.max(rect.height, 1),
      };
      const factor = event.deltaY < 0 ? wheelZoomFactor : 1 / wheelZoomFactor;
      setView((current) => zoomImage(current, factor, pointer));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);
  const [decodeError, setDecodeError] = useState("");
  const [display, setDisplay] = useState<{
    bundle: Bundle;
    url?: string;
    bitmap?: ImageBitmap;
    width: number;
    height: number;
    identity: string;
  }>();
  useEffect(() => {
    const bundle = loaded?.value;
    const value = bundle?.frame.value;
    if (!bundle || !value || value.kind !== "image" || !identity) return;
    if (value.format === "raw") {
      let cancelled = false;
      setDecodeError("");
      void decodeImage(bundle.frame, value)
        .then((bitmap) => {
          if (cancelled) {
            bitmap.close();
            return;
          }
          setDisplay({ bundle, bitmap, width: bitmap.width, height: bitmap.height, identity });
        })
        .catch((error) => {
          if (!cancelled)
            setDecodeError(error instanceof Error ? error.message : "Could not decode image");
        });
      return () => {
        cancelled = true;
      };
    }
    const mime = mimeTypes[value.format];
    if (!mime) return;
    const url = URL.createObjectURL(
      new Blob([bundle.frame.blob(value.data).slice()], { type: mime }),
    );
    const image = new Image();
    setDecodeError("");
    let shown = false;
    image.onload = () => {
      shown = true;
      setDisplay({ bundle, url, width: image.naturalWidth, height: image.naturalHeight, identity });
    };
    image.onerror = () => setDecodeError("Could not decode image");
    image.src = url;
    return () => {
      image.onload = null;
      image.onerror = null;
      if (!shown) URL.revokeObjectURL(url);
    };
  }, [loaded?.value, identity]);
  useEffect(
    () => () => {
      if (display?.url) URL.revokeObjectURL(display.url);
      display?.bitmap?.close();
    },
    [display],
  );
  const shown = frame !== null && display?.identity === identity ? display : undefined;
  const value = shown?.bundle.frame.value;
  const calibration = shown?.bundle.calibration;
  const problem =
    error ||
    frame?.error ||
    loaded?.error ||
    decodeError ||
    (frame?.value?.kind === "image" &&
    frame.value.format !== "raw" &&
    !mimeTypes[frame.value.format]
      ? `Unsupported image format: ${frame.value.format}`
      : "");
  const projectionProblem =
    shown?.bundle.error ||
    (calibration && (shown.width !== calibration.width || shown.height !== calibration.height)
      ? "Image and calibration dimensions differ"
      : "");
  const zoomed = view.zoom > 1;
  useEffect(() => onCanReset?.(zoomed), [zoomed, onCanReset]);
  return (
    <div
      className={zoomed ? "view-image zoomed" : "view-image"}
      ref={root}
      onPointerDown={(event) => {
        if (event.button !== 0 || !zoomed) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const dx = (event.clientX - drag.current.x) / Math.max(rect.width, 1);
        const dy = (event.clientY - drag.current.y) / Math.max(rect.height, 1);
        drag.current = { x: event.clientX, y: event.clientY };
        setView((current) => panImage(current, dx, dy));
      }}
      onPointerUp={() => {
        drag.current = undefined;
      }}
      onPointerCancel={() => {
        drag.current = undefined;
      }}
    >
      <div
        className="view-image-stage"
        style={{
          transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.zoom})`,
        }}
      >
        {shown && !problem && shown.url && (
          <img src={shown.url} alt={series?.topicName ?? series?.topic} draggable={false} />
        )}
        {shown && !problem && shown.bitmap && (
          <canvas
            role="img"
            aria-label={series?.topicName ?? series?.topic}
            width={shown.width}
            height={shown.height}
            ref={(element) => {
              if (element && shown.bitmap) element.getContext("2d")?.drawImage(shown.bitmap, 0, 0);
            }}
          />
        )}
        {shown &&
          value?.kind === "image" &&
          calibration &&
          !projectionProblem &&
          shown.bundle.clouds.map((cloud) => (
            <Projection key={cloud.series.key} cloud={cloud} calibration={calibration} />
          ))}
        {shown &&
          !problem &&
          shown.bundle.marks.map((marks) => (
            <Overlay
              key={marks.series.key}
              marks={marks}
              width={shown.width}
              height={shown.height}
            />
          ))}
      </div>
      {/* A problem with the projection as a whole applies to each topic to project. */}
      {clouds.map((cloud) => (
        <ReportSeriesProblem key={cloud.key} series={cloud} problem={projectionProblem ?? ""} />
      ))}
      {problem ? (
        <p className="view-status view-error">{problem}</p>
      ) : (
        shown && (
          <p className="view-time">
            {formatter.tooltip(secondsFrom(shown.bundle.frame.time_ns, info!.start_ns))}
          </p>
        )
      )}
    </div>
  );
}
