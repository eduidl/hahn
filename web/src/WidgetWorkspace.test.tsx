// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReducer, useState, type ReactNode } from "react";
import type { MosaicNode } from "react-mosaic-component";
import { createPlaybackStore, PlaybackContext } from "./playback";
import { WidgetWorkspace } from "./WidgetWorkspace";
import { PanelSettings } from "./PanelSettings";
import { buildFieldIndex } from "./fieldIndex";
import {
  initialWorkspace, workspaceReducer as reduce, widgetDragMime, widgetMoveMime, tabDragMime,
  type Widget, type WorkspaceState,
} from "./widgets";

// Exercise workspace interactions without the library's browser-only DnD backend.
vi.mock("react-mosaic-component", () => ({
  Mosaic: ({ value, renderTile, zeroStateView }: { value: MosaicNode<string> | null; renderTile: (id: string, path: number[]) => ReactNode; zeroStateView: ReactNode }) => {
    const renderNode = (node: MosaicNode<string> | null): ReactNode => node === null ? zeroStateView : typeof node === "string" ? renderTile(node, []) : node.type === "split" ? node.children.map((n, i) => <div key={i}>{renderNode(n)}</div>) : null;
    return <div>{renderNode(value)}</div>;
  },
  MosaicWindow: (props: { children: ReactNode; toolbarControls: ReactNode; renderToolbar: (props: unknown) => ReactNode }) =>
    <div>{props.renderToolbar(props)}{props.children}</div>,
}));
vi.mock("./Plot", () => ({
  defaultPlotView: () => ({ x: { center: 0, zoom: 1 }, y: { center: 0, zoom: 1 }, pinnedYBase: null }),
  Plot: () => <div>Plot</div>,
}));
const index = buildFieldIndex([]);
const first = { widgetId: "widget-1", tabId: "tab-1" };
const initial = () => reduce(initialWorkspace(), { type: "change-type", id: "widget-1", widgetType: "tabs" });
function Harness({ initialState = initial(), catalog = null }: { initialState?: WorkspaceState; catalog?: Widget["type"] | null }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [playback] = useState(createPlaybackStore);
  const selected = state.activeId ? state.widgets[state.activeId] : null;
  return <PlaybackContext.Provider value={playback}>
    <WidgetWorkspace state={state} dispatch={dispatch} data={[]} messageRecords={[]} fieldIndex={index}
      info={null} fullEnd={1} revision={0} dragVerdict={() => null} widgetDrag={catalog} drop={vi.fn()} openSettings={vi.fn()} />
    {selected && <aside aria-label="設定"><PanelSettings widget={selected} dispatch={dispatch} index={index} records={[]} pointCount={0} /></aside>}
  </PlaybackContext.Provider>;
}
function transfer(type: string, value = "") {
  return { types: [type], getData: (key: string) => key === type ? value : "", setData: vi.fn(), effectAllowed: "all", dropEffect: "none" };
}
const tab = (id: string) => document.getElementById(`widget-1-${id}`)!;
const panel = (widgetId = "widget-1") => document.getElementById(`${widgetId}-tab-1-panel`)!;

