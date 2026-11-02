/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { widget, widgetSpecs, widgetTypes } from "../src/workspace/widgets";

// Enforces the mechanical part of "UI wording" in DEVELOPMENT.md.
const files = import.meta.glob<string>(["../src/**/*.{ts,tsx}", "!../src/api.gen.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const sources = Object.entries(files).map(([path, text]) => ({ path, text }));
const matches = (pattern: RegExp) =>
  sources.flatMap(({ path, text }) =>
    text
      .split("\n")
      .filter((line) => pattern.test(line))
      .map((line) => `${path}: ${line.trim()}`),
  );

describe("UI wording", () => {
  it("names widgets in sentence case, keeping abbreviations", () => {
    for (const type of widgetTypes) {
      const [first, ...rest] = widgetSpecs[type].label.split(" ");
      expect(first[0]).toBe(first[0].toUpperCase());
      for (const word of rest) expect(word).toBe(word === "TF" ? word : word.toLowerCase());
    }
  });
  it("titles every widget with its one name", () => {
    for (const type of widgetTypes) expect(widget(1, type).title).toBe(widgetSpecs[type].label);
  });
  it("lists widgets alphabetically by name", () => {
    expect(widgetTypes.map((type) => widgetSpecs[type].label)).toEqual([
      "3D",
      "Data source info",
      "Image",
      "Map",
      "Plot",
      "Raw message",
      "State table",
      "State timeline",
      "Table",
      "Tabs",
      "TF tree",
    ]);
  });
  it("does not use the retired word for a widget", () => {
    // ARIA's tabpanel role, and elements with that role, are the only exception.
    const others = sources.flatMap(({ path, text }) =>
      text
        .replace(/tabpanel|errors-panel|widget-tab-panel|-panel`/g, "")
        .split("\n")
        .filter((line) => /panel/i.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(others).toEqual([]);
  });
  it("does not show the retired words for a run", () => {
    expect(matches(/["`>]\s*[^"`<]*\b[Rr]ecordings?\b[^"`<]*["`<]/)).toEqual([]);
  });
  it("labels add buttons with a plus and a noun", () => {
    expect(matches(/\+ Add\b/)).toEqual([]);
  });
});
