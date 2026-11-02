// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Selected } from "../src/types";
import {
  ReportSeriesProblem,
  ViewWidget,
  useSeriesViewProblem,
  useSeriesViewProblems,
} from "../src/views/seriesViewProblem";

const series = { key: "k", topic: "/t", source: "r/0", path: [] } as unknown as Selected;

function Settings({ widgetId }: { widgetId: string }) {
  return <output data-testid={widgetId}>{useSeriesViewProblem(widgetId, "k") ?? "none"}</output>;
}
function View({ widgetId, problems }: { widgetId: string; problems: string[] }) {
  return (
    <ViewWidget.Provider value={{ id: widgetId, title: `Widget ${widgetId}` }}>
      {problems.map((problem, i) => (
        <ReportSeriesProblem key={i} series={series} problem={problem} />
      ))}
    </ViewWidget.Provider>
  );
}
function List() {
  return (
    <output data-testid="list">
      {useSeriesViewProblems()
        .map((item) => `${item.widgetTitle}: ${item.problem}`)
        .join("|")}
    </output>
  );
}
const shown = (id: string) => screen.getByTestId(id).textContent;

describe("series view problems", () => {
  afterEach(cleanup);

  it("passes a problem to that widget's settings only, and lists it once", () => {
    render(
      <>
        <View widgetId="a" problems={["Broken", "Broken"]} />
        <Settings widgetId="a" />
        <Settings widgetId="b" />
        <List />
      </>,
    );
    expect(shown("list")).toBe("Widget a: Broken");
    expect(shown("a")).toBe("Broken");
    expect(shown("b")).toBe("none");
  });
  it("clears once fixed or gone, and keeps another part's report", () => {
    const tree = (problems: string[] | null) => (
      <>
        {problems && <View widgetId="a" problems={problems} />}
        <Settings widgetId="a" />
      </>
    );
    const { rerender } = render(tree(["One", "Two"]));
    rerender(tree(["", "Two"]));
    expect(shown("a")).toBe("Two");
    rerender(tree(["", ""]));
    expect(shown("a")).toBe("none");
    rerender(tree(["Again"]));
    expect(shown("a")).toBe("Again");
    rerender(tree(null));
    expect(shown("a")).toBe("none");
  });
});
