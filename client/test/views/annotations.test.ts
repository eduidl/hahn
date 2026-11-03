import { describe, expect, it } from "vitest";
import type { ViewFrame } from "../../src/data/viewFrames";
import { drawAnnotations, matchAnnotations } from "../../src/views/annotations";

const frame = (time: string, value: object): ViewFrame => ({
  time_ns: time,
  value: value as ViewFrame["value"],
  blob: () => new Uint8Array(),
});
const image = (time: string, stamp?: string) =>
  frame(time, {
    kind: "image",
    frame_id: "camera",
    format: "png",
    data: { $blob: { offset: 0, length: 1 } },
    ...(stamp ? { stamp_ns: stamp } : {}),
  });
const marks = (time: string, stamp?: string, text = time) =>
  frame(time, {
    kind: "image_annotations",
    annotations: [{ type: "text", position: [0, 0], text }],
    omitted: 0,
    ...(stamp ? { stamp_ns: stamp } : {}),
  });

describe("matching marks to an image", () => {
  it("takes the marks of the same stamp, even recorded after the image", () => {
    const matched = matchAnnotations([marks("9", "4"), marks("12", "5")], image("10", "5"));
    expect(matched?.frame.time_ns).toBe("12");
    expect(matched?.estimated).toBe(false);
  });
  it("shows none rather than another image's marks", () => {
    expect(matchAnnotations([marks("9", "4"), marks("12", "6")], image("10", "5"))).toBeUndefined();
  });
  it("without stamps, guesses the latest recorded at or before the image", () => {
    const matched = matchAnnotations([marks("9"), marks("10"), marks("12")], image("10"));
    expect(matched?.frame.time_ns).toBe("10");
    expect(matched?.estimated).toBe(true);
  });
});

it("draws each known mark with its caption and skips an unknown one", () => {
  const calls: string[] = [];
  const context = new Proxy(
    {},
    {
      get: (_, name) =>
        typeof name === "string" &&
        !["strokeStyle", "fillStyle", "lineWidth", "font"].includes(name)
          ? (...args: unknown[]) => calls.push(`${name}(${args.join(",")})`)
          : undefined,
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  drawAnnotations(
    context,
    [
      {
        type: "line_loop",
        points: [
          [0, 10],
          [5, 10],
          [5, 20],
        ],
        label: "cat",
        score: 0.8,
      },
      { type: "circle", position: [3, 4], diameter: 2 },
      { type: "hologram", points: [[1, 1]] },
    ],
    "red",
  );
  expect(calls).toEqual([
    "beginPath()",
    "moveTo(0,10)",
    "lineTo(5,10)",
    "lineTo(5,20)",
    "closePath()",
    "stroke()",
    "fillText(cat 0.80,0,6)",
    "beginPath()",
    `arc(3,4,1,0,${2 * Math.PI})`,
    "stroke()",
  ]);
});
