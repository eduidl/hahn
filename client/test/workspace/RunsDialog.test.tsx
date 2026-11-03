// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsDialog } from "../../src/workspace/RunsDialog";

const runs = [
  { id: "a", name: "Morning drive" },
  { id: "b", name: "Night drive" },
  { id: "c", name: "Parking" },
];
const names = () => screen.getAllByRole("option", { hidden: true }).map((li) => li.textContent);
const props = { current: null, onSelect: () => {}, onClose: () => {} };
const fetchMock = vi.fn();

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
  fetchMock.mockReset();
  // A stand-in for the server's filter.
  fetchMock.mockImplementation(async (url: string) => {
    const q = new URL(url, "http://x").searchParams.get("q")?.toLowerCase() ?? "";
    const items = runs.filter((run) => run.name.toLowerCase().includes(q));
    return new Response(JSON.stringify({ items, truncated: false }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RunsDialog", () => {
  it("asks the server for a limited list", async () => {
    render(<RunsDialog {...props} open />);
    await screen.findByText("Parking");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/runs?limit=50");
  });

  it("searches on the server once typing settles", async () => {
    render(<RunsDialog {...props} open />);
    await screen.findByText("Parking");
    fetchMock.mockClear();
    const search = screen.getByLabelText("Search runs");
    fireEvent.change(search, { target: { value: "dri" } });
    fireEvent.change(search, { target: { value: "drive" } });
    await vi.waitFor(() => expect(names()).toEqual(["Morning drive", "Night drive"]));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/runs?limit=50&q=drive"]);
  });

  it("selects on click and with Enter on the first match", async () => {
    const onSelect = vi.fn();
    render(<RunsDialog {...props} onSelect={onSelect} open />);
    fireEvent.click(await screen.findByRole("option", { name: "Parking", hidden: true }));
    expect(onSelect).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(screen.getByLabelText("Search runs"), { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("a");
  });

  it("moves with the arrow keys, wrapping at the ends, and selects with Enter", async () => {
    const onSelect = vi.fn();
    render(<RunsDialog {...props} onSelect={onSelect} open />);
    await screen.findByText("Parking");
    const search = screen.getByLabelText("Search runs");
    const selected = () =>
      screen
        .getAllByRole("option", { hidden: true })
        .filter((o) => o.getAttribute("aria-selected") === "true")
        .map((o) => o.textContent);
    expect(selected()).toEqual(["Morning drive"]);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(selected()).toEqual(["Night drive"]);
    expect(search.getAttribute("aria-activedescendant")).toBe("run-option-1");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(selected()).toEqual(["Parking"]);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(selected()).toEqual(["Morning drive"]);
  });

  it("returns to the first match when the results change", async () => {
    render(<RunsDialog {...props} open />);
    await screen.findByText("Parking");
    const search = screen.getByLabelText("Search runs");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.change(search, { target: { value: "drive" } });
    await vi.waitFor(() => expect(names()).toHaveLength(2));
    expect(search.getAttribute("aria-activedescendant")).toBe("run-option-0");
  });

  it("asks to narrow down a truncated list", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ items: runs, truncated: true })),
    );
    render(<RunsDialog {...props} open />);
    await screen.findByText("Showing 3 results. Refine your search.");
  });

  it("shows the server's error", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: "disk failure" }), { status: 500 }),
    );
    render(<RunsDialog {...props} open />);
    expect((await screen.findByRole("alert")).textContent).toBe("disk failure");
  });

  it("marks the current run and clears the search when reopened", async () => {
    const { rerender } = render(<RunsDialog {...props} current="b" open />);
    const night = await screen.findByRole("option", { name: "Night drive", hidden: true });
    expect(night.getAttribute("aria-current")).toBe("true");
    fireEvent.change(screen.getByLabelText("Search runs"), { target: { value: "night" } });
    await vi.waitFor(() => expect(names()).toEqual(["Night drive"]));
    rerender(<RunsDialog {...props} current="b" open={false} />);
    rerender(<RunsDialog {...props} current="b" open />);
    expect((screen.getByLabelText("Search runs") as HTMLInputElement).value).toBe("");
    await vi.waitFor(() => expect(names()).toHaveLength(3));
  });
});
