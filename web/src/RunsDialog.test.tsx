// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsDialog } from "./RunsDialog";

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

