import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { secondsFrom } from "../data/data";
import { get, runUrl } from "../data/sources";
import { decodeImage } from "../data/imagePixels";
import { useLatestOnly, useViewFrame } from "../data/useViewData";
import { fetchLatestFrame, pointBuffers, type ViewFrame } from "../data/viewFrames";
import { useTimeFormatter } from "../timeDisplay";
import { topicKey, type Info, type Schemas, type Selected } from "../types";
import type { FieldIndex } from "../workspace/fieldIndex";
import type { Widget } from "../workspace/widgets";
import { cameraDistortionError, cloudToCameraMatrix, projectCameraPoint } from "./camera";
import { cameraCandidates } from "./useCameraCalibration";

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
type Bundle = { frame: ViewFrame; calibration?: Calibration; clouds: Cloud[]; error?: string };

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
      {problem && (
        <p className="view-error projection-error">
          {series.topicName ?? series.topic}: {problem}
        </p>
      )}
    </>
  );
}

/** The image and its projections advance together after all are ready. */
export function ImageView({
  widget,
  info,
  index,
}: {
  widget: Widget;
  info: Info | null;
  index: FieldIndex;
}) {
  const kind = (series: Selected) =>
    index.topics
      .get(topicKey(series.source, series.topic))
      ?.views.find((view) => view.id === series.view)?.kind;
  const series = widget.series.find((item) => kind(item) === "image");
  const clouds = widget.series.filter((item) => kind(item) === "pointcloud" && !item.hidden);
  const { frame, error } = useViewFrame(series, info);
  const formatter = useTimeFormatter(info?.start_ns ?? null, widget.timeDisplay);
  const candidates = useMemo(() => cameraCandidates(index, series), [index, series?.source]);
  const identity =
    series && info
      ? JSON.stringify([series.key, info.start_ns, candidates, clouds.map((c) => [c.key, c.view])])
      : null;
  const loaded = useLatestOnly<Bundle>(
    identity,
    frame?.value?.kind === "image" ? frame.time_ns : null,
    async (time, known, signal) => {
      const imageFrame = frame!;
      const image = imageFrame.value;
      if (!image || image.kind !== "image") throw new Error("Image is unavailable");
      if (!clouds.length) return { frame: imageFrame, clouds: [] };
      if (!image.frame_id) return { frame: imageFrame, clouds: [], error: "Image has no frame ID" };
      const calibrations = await Promise.all(
        candidates.map((candidate) => fetchLatestFrame(candidate, time, null, signal)),
      );
      const matches = calibrations.flatMap((item) =>
        item?.value?.kind === "camera_calibration" && item.value.frame_id === image.frame_id
          ? [item.value]
          : [],
      );
      if (matches.length !== 1)
        return {
          frame: imageFrame,
          clouds: [],
          error: matches.length
            ? "Multiple camera calibrations match this frame"
            : calibrations.find((item) => item?.error)?.error ||
              "No camera calibration for this frame",
        };
      const resolved = await Promise.all(
        clouds.map(async (series) => {
          const previous = known?.clouds.find((item) => item.series.key === series.key)?.frame;
          const cloud = await fetchLatestFrame(series, time, previous, signal);
          const frameId = cloud?.value?.kind === "pointcloud" ? cloud.value.frame_id : null;
          if (!frameId || frameId === image.frame_id) return { series, frame: cloud };
          const transforms = await get<Schemas["Transforms"]>(
            `${runUrl(series.source)}/transforms?${new URLSearchParams({ target: image.frame_id!, time_ns: time })}`,
            signal,
          );
          const placement = transforms.frames[frameId];
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
      return { frame: imageFrame, calibration: matches[0], clouds: resolved };
    },
  );
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
  return (
    <div className="view-image">
      {shown && !problem && shown.url && (
        <img src={shown.url} alt={series?.topicName ?? series?.topic} />
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
      {projectionProblem && <p className="view-error projection-error">{projectionProblem}</p>}
      {problem ? (
        <p className="view-status view-error">{problem}</p>
      ) : !series ? (
        <p className="view-status">Select an image topic</p>
      ) : frame === undefined || (frame && !shown) ? (
        <p className="view-status">Loading…</p>
      ) : frame === null ? (
        <p className="view-status">No messages</p>
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
