import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { errorMessage, type Info, type Selected } from "../types";
import { usePlaybackNs } from "../data/useViewData";
import {
  fetchViewHistory,
  frameIndexAt,
  geoPoints,
  type GeoValue,
  type ViewFrame,
} from "../data/viewFrames";
import type { Widget } from "../workspace/widgets";

const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const geoValue = (frame: ViewFrame) =>
  frame.value?.kind === "geo" ? (frame.value as GeoValue) : undefined;

/** One geo topic: its whole trail, and its features at the playback position. */
function GeoLayer({ series, info, map }: { series: Selected; info: Info | null; map: L.Map }) {
  const ns = usePlaybackNs(info);
  const [history, setHistory] = useState<{ frames: ViewFrame[]; error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    fetchViewHistory(series, controller.signal)
      .then((all) => setHistory({ frames: all.filter((frame) => geoValue(frame)), error: "" }))
      .catch((error) => {
        if (!controller.signal.aborted) setHistory({ frames: [], error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [series.key, series.view, info?.start_ns]);
  const frames = history?.frames;
  const trail = useMemo(
    () => frames?.flatMap((frame) => geoPoints(geoValue(frame)!)) ?? [],
    [frames],
  );
  const fitted = useRef(false);
  useEffect(() => {
    if (series.hidden || !trail.length) return;
    const line = L.polyline(trail, { color: series.color, weight: 2, opacity: 0.6 }).addTo(map);
    if (!fitted.current) {
      fitted.current = true;
      map.fitBounds(line.getBounds(), { maxZoom: 18, padding: [24, 24] });
    }
    return () => void line.remove();
  }, [map, trail, series.color, series.hidden]);
  const index = frames && ns !== null ? frameIndexAt(frames, ns) : -1;
  const current = index >= 0 ? geoValue(frames![index]) : undefined;
  useEffect(() => {
    if (series.hidden || !current) return;
    const layer = L.geoJSON(current.features as unknown as GeoJSON.Feature[], {
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
  }, [map, current, series.color, series.hidden]);
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
