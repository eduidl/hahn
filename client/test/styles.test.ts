/// <reference types="vite/client" />
// @ts-expect-error The project has no Node type definitions.
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Read directly: under Vitest, stylesheets imported through Vite come back empty.
const sourceRoot = new URL("../src/", import.meta.url);
const stylesheets: string[] = readdirSync(sourceRoot, { recursive: true }).filter((path: string) =>
  path.endsWith(".css"),
);
const css = stylesheets.map((path) => readFileSync(new URL(path, sourceRoot), "utf8")).join("\n");
const sources = Object.entries(
  import.meta.glob<string>("../src/**/*.tsx", { query: "?raw", import: "default", eager: true }),
);
// Hooks for structure or tests, which need no styling of their own.
const unstyled = new Set(["app", "series-ref-path", "series-ref-topic"]);

it("finds the stylesheets", () => {
  expect(stylesheets).toContain("styles/base.css");
});

it("defines every fixed class name the components use", () => {
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]));
  const missing = sources.flatMap(([path, text]) =>
    [...text.matchAll(/className="([^"]+)"/g)]
      .flatMap((match) => match[1].split(" "))
      .filter((name) => !defined.has(name) && !unstyled.has(name))
      .map((name) => `${path}: ${name}`),
  );
  expect(missing).toEqual([]);
});

it("writes no text smaller than 12px", () => {
  const small = [...css.matchAll(/font(?:-size)?:[^;]*?\b(\d+(?:\.\d+)?)px/g)].filter(
    (match) => Number(match[1]) < 12,
  );
  expect(small.map((match) => match[0])).toEqual([]);
});
