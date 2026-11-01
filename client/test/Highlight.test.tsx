// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Highlight } from "../src/Highlight";

afterEach(cleanup);
const marks = (text: string, query: string) => {
  const { container } = render(<Highlight text={text} query={query} />);
  expect(container.textContent).toBe(text);
  return [...container.querySelectorAll("mark")].map((mark) => mark.textContent);
};

it("marks the match and keeps the rest of the text", () => {
  expect(marks("position.x", "pos")).toEqual(["pos"]);
  expect(marks("/a/position", "position")).toEqual(["position"]);
});
it("ignores case and keeps the original spelling", () => {
  expect(marks("Position", "pos")).toEqual(["Pos"]);
  expect(marks("position", "POS")).toEqual(["pos"]);
});
it("marks every occurrence", () => {
  expect(marks("pose.pos", "pos")).toEqual(["pos", "pos"]);
});
it("marks nothing without a query or a match", () => {
  expect(marks("position", "")).toEqual([]);
  expect(marks("position", "zzz")).toEqual([]);
});
