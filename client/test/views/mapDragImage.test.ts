// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { flattenMapsForDragImage } from "../../src/views/mapDragImage";

afterEach(() => vi.restoreAllMocks());

it("swaps a map's panes for a canvas of its visible tiles, and back", () => {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as never);
  const root = document.createElement("div");
  root.innerHTML = `<div class="view-map"><div class="leaflet-pane">
    <img class="leaflet-tile" /><img class="leaflet-tile" /></div></div>`;
  const [loaded, pending] = root.querySelectorAll("img");
  Object.defineProperty(loaded, "complete", { value: true });
  Object.defineProperty(loaded, "naturalWidth", { value: 256 });
  const pane = root.querySelector<HTMLElement>(".leaflet-pane")!;

  const restore = flattenMapsForDragImage(root);
  expect(pane.style.display).toBe("none");
  expect(root.querySelector("canvas")).not.toBeNull();
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(drawImage.mock.calls[0][0]).toBe(loaded);
  expect(drawImage.mock.calls[0][0]).not.toBe(pending);

  restore();
  expect(pane.style.display).toBe("");
  expect(root.querySelector("canvas")).toBeNull();
});
