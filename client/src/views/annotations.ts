import type { Schemas } from "../types";
import type { ViewFrame } from "../data/viewFrames";

export type AnnotationsValue = Schemas["ImageAnnotationsValue"];
type Annotation = AnnotationsValue["annotations"][number];

/** Recording time searched around an image for its marks: they are recorded after it. */
export const annotationWindowNs = 2_000_000_000n;

export type MatchedAnnotations = {
  frame: ViewFrame;
  value: AnnotationsValue;
  /** Matched by recording time for want of measurement times, so perhaps not this image's. */
  estimated: boolean;
};

const annotations = (frame: ViewFrame) =>
  frame.value?.kind === "image_annotations" ? (frame.value as AnnotationsValue) : undefined;

/**
 * The marks to show over `image` among `frames`, in recording order (ADR 0005). With
 * stamps on both, only marks of the same stamp: those of another image would land in
 * the wrong place, so none is better. Without, the latest recorded at or before the
 * image, which is a guess.
 */
export function matchAnnotations(
  frames: ViewFrame[],
  image: ViewFrame,
): MatchedAnnotations | undefined {
  const stamp = image.value && "stamp_ns" in image.value ? image.value.stamp_ns : undefined;
  const stamped = frames.filter((frame) => annotations(frame)?.stamp_ns !== undefined);
  if (stamp !== undefined && stamped.length) {
    const same = stamped.filter((frame) => annotations(frame)!.stamp_ns === stamp).at(-1);
    return same && { frame: same, value: annotations(same)!, estimated: false };
  }
  const at = BigInt(image.time_ns);
  const before = frames.filter((frame) => annotations(frame) && BigInt(frame.time_ns) <= at).at(-1);
  return before && { frame: before, value: annotations(before)!, estimated: true };
}

/** Draws the marks in `color`, labeled with what they mark and how sure it is. */
export function drawAnnotations(
  context: CanvasRenderingContext2D,
  marks: Annotation[],
  color: string,
) {
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2;
  context.font = "14px sans-serif";
  for (const mark of marks) {
    const points = mark.points ?? [];
    switch (mark.type) {
      case "points":
        for (const [x, y] of points) context.fillRect(x - 2, y - 2, 4, 4);
        break;
      case "line_strip":
      case "line_loop":
        context.beginPath();
        for (const [i, [x, y]] of points.entries()) {
          if (i) context.lineTo(x, y);
          else context.moveTo(x, y);
        }
        if (mark.type === "line_loop") context.closePath();
        context.stroke();
        break;
      case "line_list":
        context.beginPath();
        for (let i = 0; i + 1 < points.length; i += 2) {
          context.moveTo(points[i][0], points[i][1]);
          context.lineTo(points[i + 1][0], points[i + 1][1]);
        }
        context.stroke();
        break;
      case "circle":
        if (!mark.position) break;
        context.beginPath();
        context.arc(mark.position[0], mark.position[1], (mark.diameter ?? 0) / 2, 0, 2 * Math.PI);
        context.stroke();
        break;
      case "text":
        if (mark.position) context.fillText(mark.text ?? "", mark.position[0], mark.position[1]);
        break;
      default:
        // A type this client does not know is skipped (ADR 0007).
        continue;
    }
    const caption = [mark.label, mark.score === undefined ? undefined : mark.score.toFixed(2)]
      .filter((part) => part !== undefined)
      .join(" ");
    const anchor = points[0] ?? mark.position;
    if (caption && anchor) context.fillText(caption, anchor[0], anchor[1] - 4);
  }
}
