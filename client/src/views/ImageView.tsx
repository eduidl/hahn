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

/** The selected image topic as it was at the playback position. */
export function ImageView({ widget, info }: { widget: Widget; info: Info | null }) {
  const series = widget.series[0];
  const { frame, error } = useViewFrame(series, info);
  const formatter = useTimeFormatter(info?.start_ns ?? null, widget.timeDisplay);
  const [url, setUrl] = useState<string>();
  const value = frame?.value?.kind === "image" ? (frame.value as ImageValue) : undefined;
  const mime = value && mimeTypes[value.format];
  useEffect(() => {
    if (!frame || !value || !mime) return setUrl(undefined);
    const next = URL.createObjectURL(new Blob([frame.blob(value.data).slice()], { type: mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [frame, value, mime]);
  if (!series) return null;
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
