// Queries and edits on the mosaic layout trees of the workspace and its tabs.
import type { Container, WorkspaceState } from "./widgetModel";
import type { MosaicDirection, MosaicNode } from "react-mosaic-component";

export type DropEdge = "left" | "right" | "top" | "bottom";

/** The tile edge nearest to a pointer, given its position relative to the tile. */
export function dropEdge(x: number, y: number, width: number, height: number): DropEdge {
  const distances: [DropEdge, number][] = [
    ["left", x / width],
    ["right", 1 - x / width],
    ["top", y / height],
    ["bottom", 1 - y / height],
  ];
  return distances.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

export function replaceLeaf(
  node: MosaicNode<string>,
  id: string,
  replacement: MosaicNode<string>,
): MosaicNode<string> {
  if (typeof node === "string") return node === id ? replacement : node;
  if (node.type === "tabs") return node;
  return {
    ...node,
    children: node.children.map((child) => replaceLeaf(child, id, replacement)),
  };
}

export function removeLeaf(node: MosaicNode<string>, id: string): MosaicNode<string> | null {
  if (typeof node === "string") return node === id ? null : node;
  if (node.type === "tabs") return node;
  const remaining = node.children
    .map((child, i) => ({
      node: removeLeaf(child, id),
      weight: node.splitPercentages?.[i] ?? 100 / node.children.length,
    }))
    .filter((child) => child.node !== null);
  if (!remaining.length) return null;
  if (remaining.length === 1) return remaining[0].node;
  const total = remaining.reduce((sum, child) => sum + child.weight, 0);
  return {
    ...node,
    children: remaining.map((child) => child.node!),
    splitPercentages: remaining.map((child) => (child.weight / total) * 100),
  };
}

/**
 * The layout that goes on without a widget being dragged. The widget stays at no
 * size rather than leaving: unmounted, it would lose its state and never report the
 * end of its drag. A layout it does not belong to, or would leave empty, stays as it is.
 */
export function withoutLifted(
  layout: MosaicNode<string> | null,
  id: string,
): MosaicNode<string> | null {
  if (!layout || !leaves(layout).includes(id)) return layout;
  const rest = removeLeafNullable(layout, id);
  if (rest === null) return layout;
  return { type: "split", direction: "row", splitPercentages: [100, 0], children: [rest, id] };
}

export function leaves(node: MosaicNode<string> | null): string[] {
  if (node === null) return [];
  if (typeof node === "string") return [node];
  return node.type === "tabs" ? node.tabs : node.children.flatMap(leaves);
}

export function hasTabs(node: MosaicNode<string> | null): boolean {
  return (
    node !== null &&
    typeof node !== "string" &&
    (node.type === "tabs" || node.children.some(hasTabs))
  );
}

export function mapLeaves(
  node: MosaicNode<string> | null,
  map: (id: string) => string,
): MosaicNode<string> | null {
  if (node === null) return null;
  if (typeof node === "string") return map(node);
  if (node.type === "tabs") return { ...node, tabs: node.tabs.map(map) };
  return { ...node, children: node.children.map((child) => mapLeaves(child, map)!) };
}

export function removeLeafNullable(layout: MosaicNode<string> | null, id: string) {
  return layout === null ? null : removeLeaf(layout, id);
}

export function insertLeaf(
  layout: MosaicNode<string> | null,
  id: string,
  target?: string,
  direction: MosaicDirection = "row",
  before = false,
): MosaicNode<string> {
  if (layout === null) return id;
  const split = (node: MosaicNode<string>): MosaicNode<string> => ({
    type: "split",
    direction,
    children: before ? [id, node] : [node, id],
    splitPercentages: [50, 50],
  });
  return target && leaves(layout).includes(target)
    ? replaceLeaf(layout, target, split(target))
    : split(layout);
}

/**
 * Adds a column at the left with an equal share of the width. The other columns
 * keep their proportions, so that repeated adding does not halve any of them.
 */
export function insertLeadingColumn(
  layout: MosaicNode<string> | null,
  id: string,
): MosaicNode<string> {
  if (layout === null) return id;
  const columns =
    typeof layout !== "string" && layout.type === "split" && layout.direction === "row"
      ? layout
      : null;
  if (!columns)
    return { type: "split", direction: "row", children: [id, layout], splitPercentages: [50, 50] };
  const count = columns.children.length;
  const percentages = columns.splitPercentages ?? columns.children.map(() => 100 / count);
  return {
    ...columns,
    children: [id, ...columns.children],
    splitPercentages: [
      100 / (count + 1),
      ...percentages.map((percentage) => (percentage * count) / (count + 1)),
    ],
  };
}

export function containerLayout(
  state: WorkspaceState,
  container?: Container,
): MosaicNode<string> | null {
  if (!container) return state.layout;
  const owner = state.widgets[container.widgetId];
  return owner?.type === "tabs"
    ? (owner.tabs.find((tab) => tab.id === container.tabId)?.layout ?? null)
    : null;
}

export function containerExists(state: WorkspaceState, container?: Container): boolean {
  if (!container) return true;
  const owner = state.widgets[container.widgetId];
  return owner?.type === "tabs" && owner.tabs.some((tab) => tab.id === container.tabId);
}

export function ownerOf(state: WorkspaceState, id: string): Container | undefined {
  for (const w of Object.values(state.widgets)) {
    if (w.type !== "tabs") continue;
    const tab = w.tabs.find((tab) => leaves(tab.layout).includes(id));
    if (tab) return { widgetId: w.id, tabId: tab.id };
  }
  return undefined;
}
