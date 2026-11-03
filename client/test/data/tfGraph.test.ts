import { describe, expect, it } from "vitest";
import { TfGraph, type DynamicTransform } from "../../src/data/tfGraph";

const still = [0, 0, 0, 1];
/** A quarter turn about z. */
const turn = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const sample = (
  child: string,
  parent: string,
  x: number,
  time: number,
  stamp?: number,
  rotation = still,
): DynamicTransform => ({
  child,
  parent,
  translation: [x, 0, 0],
  rotation,
  time_ns: String(time),
  ...(stamp === undefined ? {} : { stamp_ns: String(stamp) }),
});
const x = (frames: Record<string, { translation: number[] }>, id: string) =>
  frames[id]?.translation[0];

describe("TfGraph", () => {
  it("interpolates between samples and never extrapolates", () => {
    const graph = new TfGraph([], [sample("base", "map", 0, 10), sample("base", "map", 10, 20)]);
    expect(x(graph.resolve("map", 15n), "base")).toBeCloseTo(5);
    expect(x(graph.resolve("map", 20n), "base")).toBe(10);
    expect(graph.resolve("map", 9n).base).toBeUndefined();
    expect(graph.resolve("map", 21n).base).toBeUndefined();
  });

  it("holds the earlier sample when interpolation is off or the parent changes", () => {
    const graph = new TfGraph(
      [],
      [sample("base", "map", 0, 10), sample("base", "map", 10, 20), sample("base", "odom", 50, 30)],
    );
    expect(x(graph.resolve("map", 15n, { interpolate: false }), "base")).toBe(0);
    // Off, the span is still bounded by the samples: no holding past the last.
    expect(graph.resolve("map", 31n, { interpolate: false }).base).toBeUndefined();
    const switching = graph.resolve("map", 25n);
    expect(x(switching, "base")).toBe(10);
    expect(graph.resolve("odom", 30n).base).toBeDefined();
  });

  it("resolves on the measurement axis by stamps, leaving out samples without one", () => {
    const graph = new TfGraph(
      [],
      [
        sample("base", "map", 0, 100, 10),
        sample("base", "map", 5, 105),
        sample("base", "map", 10, 110, 20),
      ],
    );
    // By stamp, the unstamped sample takes no part.
    expect(x(graph.resolve("map", 15n, { axis: "stamp" }), "base")).toBeCloseTo(5);
    expect(x(graph.resolve("map", 105n, { axis: "stamp" }), "base")).toBeUndefined();
    // By recording time, it does.
    expect(x(graph.resolve("map", 105n), "base")).toBe(5);
  });

  it("takes the last recorded of equal times", () => {
    const graph = new TfGraph([], [sample("base", "map", 1, 10), sample("base", "map", 2, 10)]);
    expect(x(graph.resolve("map", 10n), "base")).toBe(2);
  });

  it("chains static and dynamic frames in both directions", () => {
    const graph = new TfGraph(
      [{ child: "lidar", parent: "base", translation: [1, 0, 0], rotation: still }],
      [
        sample("base", "map", 10, 0, undefined, turn),
        sample("base", "map", 10, 10, undefined, turn),
      ],
    );
    const inMap = graph.resolve("map", 5n);
    // The lidar is 1 m along the base's x, which faces the map's y.
    expect(inMap.lidar.translation[0]).toBeCloseTo(10);
    expect(inMap.lidar.translation[1]).toBeCloseTo(1);
    const inLidar = graph.resolve("lidar", 5n);
    expect(inLidar.map.translation[0]).toBeCloseTo(-1);
    expect(inLidar.map.translation[1]).toBeCloseTo(10);
    // Static frames hold at any time; the dynamic link does not.
    expect(graph.resolve("base", 100n).lidar).toBeDefined();
    expect(graph.resolve("map", 100n).lidar).toBeUndefined();
  });

  it("rotates the short way round", () => {
    const graph = new TfGraph(
      [],
      [
        sample("base", "map", 0, 0, undefined, turn),
        sample(
          "base",
          "map",
          0,
          10,
          undefined,
          turn.map((v) => -v),
        ),
      ],
    );
    const rotation = graph.resolve("map", 5n).base.rotation;
    expect(Math.abs(rotation[2])).toBeCloseTo(Math.SQRT1_2);
    expect(Math.abs(rotation[3])).toBeCloseTo(Math.SQRT1_2);
  });

  it("treats any frame name as a name", () => {
    const graph = new TfGraph(
      [{ child: "__proto__", parent: "constructor", translation: [1, 0, 0], rotation: still }],
      [],
    );
    expect(x(graph.resolve("constructor", 0n), "__proto__")).toBe(1);
  });
});
