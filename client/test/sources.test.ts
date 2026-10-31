import { describe, expect, it } from "vitest";
import {
  initialSources,
  mergeInfo,
  messagesUrl,
  sourceTopics,
  sourceOf,
  sourceUrl,
  type LoadedSource,
} from "../src/data/sources";

it("keeps same-name channels distinct for display, selection and requests", () => {
  const common = {
    topic: "/tf",
    schema_name: null,
    schema_encoding: null,
    message_count: 1,
    fields: [],
    meta_fields: [],
    views: [],
    error: null,
  };
  const topics = sourceTopics("r/g", [
    { ...common, id: "first" },
    { ...common, id: "second" },
  ]);
  expect(topics.map((topic) => [topic.topic, topic.topicName])).toEqual([
    ["first", "/tf [1]"],
    ["second", "/tf [2]"],
  ]);
  expect(
    new URL(
      messagesUrl({ source: "r/g", topic: topics[1].topic, path: [] }),
      "http://localhost",
    ).searchParams.get("topic"),
  ).toBe("second");
});

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

describe("initialSources", () => {
  const group = (id: string, default_open: boolean) => ({ id, name: id, default_open });
  const run = (...groups: ReturnType<typeof group>[]) => ({
    id: "r",
    name: "r",
    timezone: null,
    groups,
  });

  it("opens what the server marks as default", () => {
    expect(initialSources(run(group("a", true), group("b", false)))).toEqual(["r/a"]);
    expect(initialSources(run(group("a", false), group("b", false)))).toEqual([]);
  });

  it("always opens a lone group", () => {
    expect(initialSources(run(group("a", false)))).toEqual(["r/a"]);
  });

  it("opens nothing without groups", () => {
    expect(initialSources(run())).toEqual([]);
  });
});

describe("messagesUrl", () => {
  const params = (path: string[], exact = false) =>
    new URL(messagesUrl({ source: "r/g", topic: "/t", path }, { exact }), "http://x").searchParams;

  it("selects a message field exactly", () => {
    const query = params(["a", "b"], true);
    expect(query.get("path")).toBe('["a","b"]');
    expect(query.get("preview")).toBe("false");
  });

  it("reads a meta field instead of the message", () => {
    const query = params(["$meta", "publish_time"], true);
    expect(query.get("meta")).toBe("publish_time");
    expect(query.has("path")).toBe(false);
    expect(query.has("preview")).toBe(false);
  });
});
