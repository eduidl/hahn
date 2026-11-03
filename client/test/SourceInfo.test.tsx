// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SourceNames, type OpenSource } from "../src/data/sources";
import { DisplayTimeZone } from "../src/timeDisplay";
import type { Topic } from "../src/types";
import { SourceInfo, formatDuration } from "../src/views/SourceInfo";

const start = "1700000000000000000";
const info = { start_ns: start, end_ns: "1700000003250000000", message_count: 1500 };
const topic = (name: string, source: string, extra: Partial<Topic> = {}): Topic => ({
  topic: `${name}-id`,
  topicName: name,
  source,
  error: null,
  fields: [],
  message_count: 1000,
  schema_encoding: "ros2msg",
  schema_name: "demo/msg/Sample",
  views: [],
  ...extra,
});
const open = (id: string, topics: Topic[], extra: Partial<OpenSource> = {}): OpenSource => ({
  id,
  info,
  topics,
  error: "",
  loading: false,
  ...extra,
});
const show = (sources: OpenSource[], merged: typeof info | null = info) =>
  render(
    <DisplayTimeZone.Provider value="UTC">
      <SourceNames.Provider
        value={
          new Map([
            ["r/a", "Group A"],
            ["r/b", "Group B"],
          ])
        }
      >
        <SourceInfo info={merged} sources={sources} />
      </SourceNames.Provider>
    </DisplayTimeZone.Provider>,
  );

afterEach(cleanup);

describe("formatDuration", () => {
  it("keeps precision that Number would lose", () => {
    expect(formatDuration({ start_ns: start, end_ns: "1700000000001000000" })).toBe("0.001s");
  });
  it("formats each magnitude", () => {
    const later = (seconds: bigint) => String(BigInt(start) + seconds * 1_000_000_000n);
    expect(formatDuration({ start_ns: start, end_ns: start })).toBe("0.000s");
    expect(formatDuration({ start_ns: start, end_ns: later(65n) })).toBe("1m 05.000s");
    expect(formatDuration({ start_ns: start, end_ns: later(3725n) })).toBe("1h 02m 05.000s");
  });
});

describe("SourceInfo", () => {
  it("asks for a run when nothing is open and waits while loading", () => {
    const { rerender } = show([], null);
    expect(screen.getByText("Open a run from the header")).toBeTruthy();
    rerender(<SourceInfo info={null} sources={[open("r/a", [], { loading: true })]} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
  it("summarizes the range and lists topics without a group column for one group", () => {
    show([open("r/a", [topic("/a", "r/a"), topic("/b", "r/a", { schema_name: null })])]);
    expect(screen.getByText("2023-11-14 22:13:20.000 (UTC)")).toBeTruthy();
    expect(screen.getByText("2023-11-14 22:13:23.250 (UTC)")).toBeTruthy();
    expect(screen.getByText("3.250s")).toBeTruthy();
    expect(screen.getByText((1500).toLocaleString())).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Group" })).toBeNull();
    const row = screen.getByRole("row", { name: /^\/b/ });
    expect(within(row).getByText("—")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /rate/i })).toBeNull();
  });
  it("shows unknown counts as a dash", () => {
    show([open("r/a", [topic("/a", "r/a", { message_count: null })])], {
      ...info,
      message_count: null as unknown as number,
    });
    expect(within(screen.getByRole("row", { name: /^\/a/ })).getByText("—")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
  it("names the group of each topic when several are open, keeping duplicate names apart", () => {
    show([
      open("r/a", [topic("/t [1]", "r/a", { topic: "1" }), topic("/t [2]", "r/a", { topic: "2" })]),
      open("r/b", [topic("/t", "r/b", { topic: "1" })]),
    ]);
    expect(screen.getByRole("columnheader", { name: "Group" })).toBeTruthy();
    expect(screen.getByRole("row", { name: /Group A \/t \[2\]/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /Group B \/t / })).toBeTruthy();
  });
  it("reports unreadable topics and failed groups", () => {
    show([
      open("r/a", [topic("/bad", "r/a", { error: "cannot decode" })]),
      open("r/b", [], { info: null, error: "no messages" }),
    ]);
    expect(screen.getByText("cannot decode")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Group B: no messages");
  });
  it("shows only the errors when every group failed", () => {
    show([open("r/a", [], { info: null, error: "gone" })], null);
    expect(screen.getByRole("alert").textContent).toBe("Group A: gone");
    expect(screen.queryByText("Start")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
