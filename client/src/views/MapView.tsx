import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./MapView.css";
import { errorMessage, type Info, type Selected } from "../types";
import { usePlaybackNs, useViewHistory } from "../data/useViewData";
import {
  frameIndexAt,
  type GeoLocationValue,
  type GeoValue,
  type ViewFrame,
} from "../data/viewFrames";
import type { Widget } from "../workspace/widgets";
import { trailWindow } from "./poseTrail";

const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const shapes = (frame: ViewFrame) =>
  frame.value?.kind === "geo" ? (frame.value as GeoValue) : undefined;
const location = (frame: ViewFrame) =>
  frame.value?.kind === "geo_location" ? (frame.value as GeoLocationValue) : undefined;
/** Leaflet's order: latitude first. */
const latLng = (value: GeoLocationValue): [number, number] => [
  value.position[1],
  value.position[0],
];

/**
 * One topic on the map at the playback position. Locations draw their history as a
 * trail; shapes replace each other and are never joined (ADR 0005).
 */
function GeoLayer({ series, info, map }: { series: Selected; info: Info | null; map: L.Map }) {
  const ns = usePlaybackNs(info);
  const readHistory = useViewHistory(series);
  const [history, setHistory] = useState<{ frames: ViewFrame[]; error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    readHistory(controller.signal)
      .then((all) =>
        setHistory({ frames: all.filter((frame) => shapes(frame) || location(frame)), error: "" }),
      )
      .catch((error) => {
        if (!controller.signal.aborted) setHistory({ frames: [], error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [series.key, series.view, info?.start_ns, readHistory]);
  const frames = history?.frames;
  const trail = useMemo(() => {
    const points = frames?.filter((frame) => location(frame)) ?? [];
    return {
      starts: points.slice(0, -1),
      ends: points.slice(1),
      positions: points
        .slice(1)
        .flatMap((frame, i) => [
          ...latLng(location(points[i])!),
          0,
          ...latLng(location(frame)!),
          0,
        ]),
    };
  }, [frames]);
  const visible = useMemo(() => {
    const window = trailWindow(trail, ns, series.trailDuration);
    if (!window.count) return [];
    const positions = trail.positions;
    const first = window.point ?? positions.slice(window.start * 6, window.start * 6 + 3);
    const points: [number, number][] = [[first[0], first[1]]];
    for (let i = window.start; i < window.start + window.count; i++)
      points.push([positions[i * 6 + 3], positions[i * 6 + 4]]);
    return points;
  }, [trail, ns, series.trailDuration]);
  const fitted = useRef(false);
  const fittedTrail = useRef(false);
  useEffect(() => {
    if (series.hidden || !visible.length) return;
    const line = L.polyline(visible, { color: series.color, weight: 2, opacity: 0.6 }).addTo(map);
    if (!fittedTrail.current) {
      fittedTrail.current = true;
      fitted.current = true;
      map.fitBounds(line.getBounds(), { maxZoom: 18, padding: [24, 24] });
    }
    return () => void line.remove();
  }, [map, visible, series.color, series.hidden]);
  const index = frames && ns !== null ? frameIndexAt(frames, ns) : -1;
  const currentShapes = index >= 0 ? shapes(frames![index]) : undefined;
  const currentLocation = index >= 0 ? location(frames![index]) : undefined;
  useEffect(() => {
    if (series.hidden || !currentLocation) return;
    const at = latLng(currentLocation);
    if (!fitted.current) {
      fitted.current = true;
      map.fitBounds(L.latLngBounds([at]), { maxZoom: 18, padding: [24, 24] });
    }
    const layer = L.layerGroup().addTo(map);
    if (currentLocation.accuracy_m)
      L.circle(at, {
        radius: currentLocation.accuracy_m,
        color: series.color,
        weight: 1,
        fillOpacity: 0.15,
      }).addTo(layer);
    L.circleMarker(at, {
      radius: 6,
      color: "#fff",
      weight: 2,
      fillColor: series.color,
      fillOpacity: 1,
    }).addTo(layer);
    return () => void layer.remove();
  }, [map, currentLocation, series.color, series.hidden]);
  useEffect(() => {
    if (series.hidden || !currentShapes) return;
    const layer = L.geoJSON(currentShapes.features as unknown as GeoJSON.Feature[], {
      style: { color: series.color },
      pointToLayer: (_, position) =>
        L.circleMarker(position, {
          radius: 6,
          color: "#fff",
          weight: 2,
          fillColor: series.color,
          fillOpacity: 1,
        }),
    }).addTo(map);
    return () => void layer.remove();
  }, [map, currentShapes, series.color, series.hidden]);
  if (history?.error)
    return (
      <p className="view-error">
        {series.topicName ?? series.topic}: {history.error}
      </p>
    );
  if (!history) return <p className="view-status">{series.topicName ?? series.topic}: Loading…</p>;
  if (!frames?.length)
    return <p className="view-status">{series.topicName ?? series.topic}: No location</p>;
  return null;
}

/** Locations on a map, over tiles unless the tile URL is empty. */
export default function MapView({ widget, info }: { widget: Widget; info: Info | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map>();
  useEffect(() => {
    const created = L.map(host.current!, { center: [0, 0], zoom: 2, zoomControl: true });
    const resize = new ResizeObserver(() => created.invalidateSize());
    resize.observe(host.current!);
    setMap(created);
    return () => {
      resize.disconnect();
      created.remove();
    };
  }, []);
  const { tileUrl } = widget;
  useEffect(() => {
    if (!map || !tileUrl) return;
    const tiles = L.tileLayer(tileUrl, {
      maxZoom: 19,
      attribution: tileUrl.includes("openstreetmap.org") ? osmAttribution : undefined,
    }).addTo(map);
    return () => void tiles.remove();
  }, [map, tileUrl]);
  return (
    <div className="view-map">
      <div className="view-map-canvas" ref={host} />
      <div className="view-problems">
        {map &&
          widget.series.map((series) => (
            <GeoLayer key={series.key} series={series} info={info} map={map} />
          ))}
      </div>
    </div>
  );
}
