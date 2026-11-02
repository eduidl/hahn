// What follows the pointer while a widget is moved.

/** Whether anything inside reaches outside, even if it is clipped on screen. */
function overflows(frame: Element) {
  const outer = frame.getBoundingClientRect();
  for (const node of frame.querySelectorAll("*")) {
    const inner = node.getBoundingClientRect();
    if (!inner.width || !inner.height) continue;
    if (
      inner.left < outer.left - 1 ||
      inner.right > outer.right + 1 ||
      inner.top < outer.top - 1 ||
      inner.bottom > outer.bottom + 1
    )
      return true;
  }
  return false;
}

/**
 * The element to use as the drag image, and how to clean up after the browser
 * has taken it. Chrome sizes an element's image to include its descendants even
 * where they are clipped, which would show beyond the frame of a narrow widget,
 * so such a widget is shown as a plain box of its own size instead.
 */
export function widgetDragImage(frame: Element, title: string) {
  if (!overflows(frame)) return { image: frame, cleanup: () => {} };
  const { width, height } = frame.getBoundingClientRect();
  const image = document.createElement("div");
  image.className = "widget-drag-image";
  image.textContent = title;
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  document.body.append(image);
  return { image, cleanup: () => image.remove() };
}
