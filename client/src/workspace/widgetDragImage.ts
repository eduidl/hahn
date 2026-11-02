/**
 * Prepares a widget for use as a drag image, returning how to undo it. A browser
 * sizes that image to include descendants even where they are clipped, which would
 * show beyond the frame of a narrow widget. So whatever reaches outside the frame is
 * left out for the moment the image is taken.
 */
export function hideOverflowForDragImage(frame: Element): () => void {
  const outer = frame.getBoundingClientRect();
  const undo: (() => void)[] = [];
  for (const node of frame.querySelectorAll<HTMLElement | SVGElement>("*")) {
    const inner = node.getBoundingClientRect();
    // Also true of whatever is inside an element that was just hidden.
    if (!inner.width || !inner.height) continue;
    if (
      inner.left >= outer.left - 1 &&
      inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 &&
      inner.bottom <= outer.bottom + 1
    )
      continue;
    const display = node.style.getPropertyValue("display");
    const priority = node.style.getPropertyPriority("display");
    node.style.setProperty("display", "none", "important");
    undo.push(() => node.style.setProperty("display", display, priority));
  }
  return () => {
    for (const restore of undo) restore();
  };
}
