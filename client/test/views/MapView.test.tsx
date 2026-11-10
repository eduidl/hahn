// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MapView from "../../src/views/MapView";
import { widget } from "../../src/workspace/widgets";
import { withStore } from "../dataStore";

const mocks = vi.hoisted(() => ({
  ns: 0n as bigint | null,
  history: vi.fn(),
  lines: [] as number[][][],
  fit: vi.fn(),
}));
vi.mock("../../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../../src/data/useViewData")>()),
  usePlaybackNs: () => mocks.ns,
}));
vi.mock("../../src/data/viewFrames", async (original) => ({
  ...(await original<typeof import("../../src/data/viewFrames")>()),
  fetchViewHistory: mocks.history,
}));
vi.mock("leaflet", () => {
  const layer = () => ({
    addTo() {
      return this;
    },
    remove() {},
    getBounds: () => "bounds",
  });
  return {
    default: {
      map: () => ({ fitBounds: mocks.fit, invalidateSize() {}, remove() {} }),
      polyline: (points: number[][]) => {
        mocks.lines.push(points);
        return layer();
      },
      latLngBounds: (points: number[][]) => points,
      layerGroup: layer,
      circle: layer,
      circleMarker: layer,
      geoJSON: layer,
      tileLayer: layer,
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows only the past location trail, respects duration, and fits the current position", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const frame = (s: number) => ({
    time_ns: String(s * 1e9),
    value: { kind: "geo_location", position: [s, s + 10] },
    blob: () => new Uint8Array(),
  });
  mocks.history.mockResolvedValue([frame(1), frame(2), frame(3), frame(4)]);
  mocks.ns = 1_000_000_000n;
  const mapWidget = widget(1, "map");
  mapWidget.tileUrl = "";
  mapWidget.series = [
    {
      key: "gps",
      source: "r/0",
      topic: "/gps",
      path: [],
      color: "red",
      lineWidth: 1,
      hidden: false,
      view: "location",
    },
  ];
  const info = { start_ns: "0", end_ns: "5000000000", message_count: 4 };
  const view = render(<MapView widget={mapWidget} info={info} />, withStore("r"));
  await waitFor(() => expect(mocks.fit).toHaveBeenCalled());
  expect(mocks.fit.mock.calls[0][0]).toEqual([[11, 1]]);
  expect(mocks.lines).toEqual([]);
  mocks.ns = 3_000_000_000n;
  view.rerender(<MapView widget={mapWidget} info={info} />);
  expect(mocks.lines.at(-1)).toEqual([
    [11, 1],
    [12, 2],
    [13, 3],
  ]);
  mapWidget.series = [{ ...mapWidget.series[0], trailDuration: 1.5 }];
  view.rerender(<MapView widget={mapWidget} info={info} />);
  expect(mocks.lines.at(-1)).toEqual([
    [11.5, 1.5],
    [12, 2],
    [13, 3],
  ]);
  const count = mocks.lines.length;
  mapWidget.series = [{ ...mapWidget.series[0], trailDuration: 0 }];
  view.rerender(<MapView widget={mapWidget} info={info} />);
  expect(mocks.lines).toHaveLength(count);
  mocks.ns = 500_000_000n;
  view.rerender(<MapView widget={mapWidget} info={info} />);
  expect(mocks.lines).toHaveLength(count);
});
