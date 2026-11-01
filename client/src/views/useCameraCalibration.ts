import { useMemo } from "react";
import { runUrl } from "../data/sources";
import { useLatestOnly } from "../data/useViewData";
import { fetchLatestFrame, type ViewFrame, type ImageValue } from "../data/viewFrames";
import type { Selected } from "../types";
import type { FieldIndex } from "../workspace/fieldIndex";

export function useCameraCalibration(
  series: Selected | undefined,
  frame: ViewFrame | null | undefined,
  image: ImageValue | undefined,
  index: FieldIndex,
) {
  const candidates = useMemo(() => cameraCandidates(index, series), [index, series?.source]);
  const loaded = useLatestOnly<{ time: string; frames: (ViewFrame | null)[] }>(
    series ? JSON.stringify(candidates) : null,
    frame?.time_ns ?? null,
    async (time, known, signal) => ({
      time,
      frames: await Promise.all(
        candidates.map((candidate, i) =>
          fetchLatestFrame(candidate, time, known?.frames[i], signal),
        ),
      ),
    }),
  );
  const current = loaded?.value?.frames;
  const matches =
    current?.flatMap((item) =>
      item?.value?.kind === "camera_calibration" &&
      image?.frame_id &&
      item.value.frame_id === image.frame_id
        ? [item.value]
        : [],
    ) ?? [];
  const error =
    loaded?.error ||
    (!matches.length ? current?.find((item) => item?.error)?.error : "") ||
    (image && current && !matches.length ? "No camera calibration for this frame" : "") ||
    (matches.length > 1 ? "Multiple camera calibrations match this frame" : "");
  return { calibration: matches.length === 1 ? matches[0] : undefined, error };
}

export function cameraCandidates(index: FieldIndex, series: Selected | undefined) {
  return [...index.topics.values()]
    .filter((topic) => series && runUrl(topic.source) === runUrl(series.source))
    .flatMap((topic) =>
      topic.views
        .filter((view) => view.kind === "camera_calibration")
        .map((view) => ({ source: topic.source, topic: topic.topic, view: view.id })),
    );
}
