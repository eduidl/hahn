// The shapes of widgets and of the workspace, and the actions that change it.
import { type DropEdge } from "./layoutTree";
import { type MosaicDirection, type MosaicNode } from "react-mosaic-component";
import { type DragMode, type PlotView } from "../views/Plot";
import { type Selected, type Topic } from "../types";

export type LegendPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type LegendSettings = { visible: boolean; position: LegendPosition };

export const legendPositions: Record<LegendPosition, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};

export type WidgetBase = {
  id: string;
  title: string;
  series: Selected[];
  mode: DragMode;
  legend: LegendSettings;
  /** JSON-encoded column paths relative to the Table target. Time stays visible. */
  hiddenColumns: string[];
  columnWidths: Record<string, number>;
  view: PlotView;
  /** The frame a 3D widget renders in; null follows the graph's root. */
  fixedFrame: string | null;
  /** Map tile URL template. Empty shows no background and requests no tiles. */
  tileUrl: string;
  /** How a 3D widget draws the axes of coordinate frames. */
  frameAxes: FrameAxesSettings;
};

export type FrameAxesSettings = {
  /** Frames whose axes are not drawn. Frames seen later are drawn until hidden. */
  hidden: string[];
  /** Axis length in meters. */
  length: number;
  /** Line width in screen pixels, whatever the distance. */
  width: number;
};

export const defaultFrameAxes = (): FrameAxesSettings => ({
  hidden: [],
  length: 1,
  width: 2,
});

export const osmTiles = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const defaultTabTitle = "";

export type WidgetTab = { id: string; title: string; layout: MosaicNode<string> | null };

export type Widget = WidgetBase &
  (
    | {
        type:
          | "plot"
          | "state"
          | "raw"
          | "value-changes"
          | "table"
          | "image"
          | "scene"
          | "map"
          | "tf-tree"
          | "source-info";
      }
    | { type: "tabs"; tabs: WidgetTab[]; activeTabId: string; nextTabNumber: number }
  );

export type TabWidget = Extract<Widget, { type: "tabs" }>;

/** Omitted for the root workspace. */
export type Container = { widgetId: string; tabId: string };

export type WorkspaceState = {
  widgets: Record<string, Widget>;
  layout: MosaicNode<string> | null;
  activeId: string | null;
  expandedId: string | null;
  nextNumber: number;
};

export type WorkspaceAction =
  | {
      type: "add";
      target?: string;
      container?: Container;
      direction?: MosaicDirection;
      /** A new column at the left of the container, instead of a split of `target`. */
      leading?: boolean;
      /** Place the new widget left of / above the target instead of after it. */
      before?: boolean;
      duplicate?: boolean;
      widgetType?: Widget["type"];
    }
  | { type: "remove"; id: string }
  | { type: "clear"; id: string }
  | { type: "change-type"; id: string; widgetType: Widget["type"] }
  | { type: "select"; id: string }
  | { type: "expand"; id: string | null }
  | { type: "layout"; layout: MosaicNode<string> | null; container?: Container }
  | { type: "move"; id: string; target?: string; container?: Container; edge?: DropEdge }
  | { type: "tab-add"; id: string }
  | {
      type: "tab-move";
      id: string;
      tabId: string;
      targetId: string;
      beforeId?: string;
      after?: boolean;
    }
  | { type: "tab-select" | "tab-remove"; id: string; tabId: string }
  | { type: "tab-rename"; id: string; tabId: string; title: string }
  | { type: "tab-reorder"; id: string; tabId: string; beforeId: string; after?: boolean }
  | { type: "series"; id: string; update: (series: Selected[]) => Selected[] }
  | { type: "view"; id: string; update: (view: PlotView) => PlotView }
  | { type: "mode"; id: string; mode: DragMode }
  | { type: "legend"; id: string; value: Partial<LegendSettings> }
  | { type: "fixed-frame"; id: string; value: string | null }
  | { type: "tile-url"; id: string; value: string }
  | { type: "frame-axes"; id: string; value: Partial<FrameAxesSettings> }
  | { type: "table-column"; id: string; path: string[]; visible: boolean }
  | { type: "table-columns"; id: string; paths: string[][]; visible: boolean }
  | { type: "table-column-width"; id: string; path: string[] | null; width: number }
  /**
   * The open recordings changed: drop series of recordings that are no
   * longer open and reset every view to the new full range. `keepViews` skips
   * the reset, for restoring a saved session over the same time axis.
   */
  /** Topic ids differ between runs, so a series that moved finds its topic again by name. */
  | {
      type: "topic-ids";
      topics: readonly (Pick<Topic, "source" | "topic"> & { topicName?: string })[];
    }
  | {
      type: "sources";
      open: ReadonlySet<string>;
      keepViews?: boolean;
      /** The group of the newly opened run that takes over the series of a group. */
      rebind?: (source: string) => string;
    };

export const widgetMoveMime = "application/x-hahn-widget-move";

export const tabDragMime = "application/x-hahn-tab";

export const widgetDragMime = "application/x-hahn-widget";
