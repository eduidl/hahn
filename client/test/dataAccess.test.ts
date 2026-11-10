import { expect, it } from "vitest";

// ADR 0010: widgets ask the store for data, and only the data layer reaches the server.
const sources = Object.entries(
  import.meta.glob<string>("../src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).map(([path, text]) => [path.replace("../src/", ""), text] as const);

/** What is read before a run is open, and so before there is a store of it. */
const beforeRun = new Set(["workspace/RunsDialog.tsx", "workspace/useRunSources.ts"]);

it("sends requests only from the data layer", () => {
  const outside = sources.filter(([path]) => !path.startsWith("data/") && !beforeRun.has(path));
  expect(outside.length).toBeGreaterThan(10);
  const offending = outside.flatMap(([path, text]) =>
    [
      /\bfetch\(/,
      /from "\.\.?\/(?:\.\.\/)*data\/request"/,
      /\b(?:fetchLatestFrame|fetchViewHistory|ViewBatches)\b/,
    ]
      .filter((pattern) => pattern.test(text))
      .map((pattern) => `${path}: ${pattern}`),
  );
  expect(offending).toEqual([]);
});
