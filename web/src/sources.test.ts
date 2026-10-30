import { describe, expect, it } from "vitest";
import { mergeInfo, type LoadedSource } from "./sources";

const source = (start: string, end: string, count: number | null = 1): LoadedSource => ({
  info: { start_ns: start, end_ns: end, message_count: count },
  topics: [],
  error: "",
  loading: false,
});
const failed: LoadedSource = { info: null, topics: [], error: "bad", loading: false };
const loading: LoadedSource = { ...failed, error: "", loading: true };

describe("merged time axis", () => {
  it("spans the earliest start to the latest end, comparing exact nanoseconds", () => {
    expect(
      mergeInfo([
        source("1760000000000000002", "1760000000000000005", 2),
        source("1760000000000000001", "1760000000000000003", 3),
      ]),
    ).toEqual({
      start_ns: "1760000000000000001",
      end_ns: "1760000000000000005",
      message_count: 5,
    });
    expect(mergeInfo([source("1", "2"), source("3", "4", null)])?.message_count).toBeNull();
  });

  it("waits for every recording and leaves out the ones that failed", () => {
    expect(mergeInfo([source("1", "2"), loading])).toBeNull();
    expect(mergeInfo([source("1", "2"), undefined])).toBeNull();
    expect(mergeInfo([failed, source("5", "6")])?.start_ns).toBe("5");
    expect(mergeInfo([failed])).toBeNull();
    expect(mergeInfo([])).toBeNull();
  });
});

describe("sourceUrl", () => {
  it("addresses a group of a run", () => {
    expect(sourceUrl(sourceOf("r", "g"))).toBe("/api/runs/r/groups/g");
  });
});

