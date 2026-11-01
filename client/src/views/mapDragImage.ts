/**
 * Prepares the maps inside `root` for a drag image, returning how to undo it.
 * A browser sizes that image to include descendants that overflow, and Leaflet keeps
 * tiles beyond the view. So each map shows a canvas of its visible tiles for the moment
 * the image is taken. Markers are left out of it.
 */
export function flattenMapsForDragImage(root: Element): () => void {
  const undo = [...root.querySelectorAll<HTMLElement>(".view-map")].map((map) => {
    const area = map.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.className = "view-map-drag-image";
    canvas.width = area.width;
    canvas.height = area.height;
    const context = canvas.getContext("2d");
    for (const tile of map.querySelectorAll<HTMLImageElement>("img.leaflet-tile")) {
      if (!tile.complete || !tile.naturalWidth) continue;
      const rect = tile.getBoundingClientRect();
      context?.drawImage(tile, rect.left - area.left, rect.top - area.top, rect.width, rect.height);
    }
    const panes = [...map.children].filter((child) => child instanceof HTMLElement);
    for (const pane of panes) pane.style.display = "none";
    map.append(canvas);
    return () => {
      canvas.remove();
      for (const pane of panes) pane.style.display = "";
    };
  });
  return () => {
    for (const restore of undo) restore();
  };
}
