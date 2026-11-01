import { useEffect, useMemo, useRef, useState } from "react";
import { get } from "../data/sources";
import { usePlaybackNs, useTransforms, type FrameInfo } from "../data/useViewData";
import { errorMessage, type Info, type Schemas } from "../types";

type Node = { id: string; parent: string | null; x: number; y: number };

/** Break cycles deterministically, then lay out each level left to right. */
export function layoutFrames(frames: FrameInfo[]): Node[] {
  const parents = new Map(frames.map(({ id, parent }) => [id, parent]));
  const ids = [...parents.keys()].sort();
  for (const id of ids) {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current !== null && parents.has(current)) {
      if (seen.has(current)) {
        parents.set(current, null);
        break;
      }
      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }
  const levels = new Map<number, string[]>();
  for (const id of ids) {
    let depth = 0;
    let parent = parents.get(id) ?? null;
    while (parent !== null && parents.has(parent)) {
      depth++;
      parent = parents.get(parent) ?? null;
    }
    const level = levels.get(depth) ?? [];
    level.push(id);
    levels.set(depth, level);
  }
  const width = Math.max(1, ...[...levels.values()].map((level) => level.length));
  return [...levels.entries()].flatMap(([depth, level]) =>
    level.map((id, i) => ({
      id,
      parent: parents.has(parents.get(id) ?? "") ? parents.get(id)! : null,
      x: (i + (width - level.length) / 2) * 220 + 110,
      y: depth * 90 + 40,
    })),
  );
}

export function TfTree({ runId, info }: { runId: string | null; info: Info | null }) {
  const [loaded, setLoaded] = useState<{ run: string; frames: FrameInfo[]; error: string }>();
  const [selected, setSelected] = useState<{ run: string; id: string }>();
  const [view, setView] = useState<{ x: number; y: number; width: number; height: number }>();
  const drag = useRef<{ x: number; y: number }>(undefined);
  const [poseOffset, setPoseOffset] = useState({ x: 0, y: 0 });
  const poseDrag = useRef<{ x: number; y: number }>(undefined);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    setView(undefined);
    get<Schemas["FrameList"]>(`/api/runs/${runId}/frames`, controller.signal)
      .then(({ frames }) => {
        if (!controller.signal.aborted) setLoaded({ run: runId, frames, error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLoaded({ run: runId, frames: [], error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [runId]);
  const state = loaded?.run === runId ? loaded : undefined;
  const nodes = useMemo(() => layoutFrames(state?.frames ?? []), [state]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const frame =
    selected?.run === runId ? state?.frames.find((item) => item.id === selected.id) : undefined;
  const parent = frame?.parent && byId.has(frame.parent) ? frame.parent : null;
  const ns = usePlaybackNs(info);
  const { transforms, error: transformError } = useTransforms(
    runId && parent ? `${runId}/` : undefined,
    parent,
    ns === null ? null : String(ns),
  );
  const pose = frame && parent ? transforms?.frames[frame.id] : undefined;
  const bounds = {
    x: 0,
    y: 0,
    width: Math.max(220, ...nodes.map((n) => n.x + 110)),
    height: Math.max(80, ...nodes.map((n) => n.y + 40)),
  };
  const viewport = view ?? bounds;
  const zoom = (factor: number) =>
    setView((current) => {
      const old = current ?? bounds;
      const width = Math.max(100, Math.min(bounds.width * 8, old.width * factor));
      const ratio = width / old.width;
      const height = old.height * ratio;
      return {
        x: old.x + (old.width - width) / 2,
        y: old.y + (old.height - height) / 2,
        width,
        height,
      };
    });
  const movePose = (handle: HTMLElement, dx: number, dy: number) => {
    const box = handle.parentElement!.getBoundingClientRect();
    const container = handle.parentElement!.parentElement!.getBoundingClientRect();
    if (container.width && container.height) {
      dx = Math.max(container.left - box.left, Math.min(dx, container.right - box.right));
      dy = Math.max(container.top - box.top, Math.min(dy, container.bottom - box.bottom));
    }
    setPoseOffset((offset) => ({ x: offset.x + dx, y: offset.y + dy }));
  };
  if (!runId) return <p className="tf-tree-status">Open a run from the header</p>;
  if (!state) return <p className="tf-tree-status">Loading…</p>;
  if (state.error)
    return (
      <p className="tf-tree-status raw-error" role="alert">
        {state.error}
      </p>
    );
  if (!nodes.length) return <p className="tf-tree-status">No frames</p>;
  return (
    <div className="tf-tree">
      <div className="tf-tree-controls">
        <button onClick={() => zoom(0.8)} aria-label="Zoom in TF tree">
          +
        </button>
        <button onClick={() => zoom(1.25)} aria-label="Zoom out TF tree">
          −
        </button>
        <button onClick={() => setView(undefined)}>Fit</button>
      </div>
      <svg
        aria-label="Transform tree"
        viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
        onWheel={(event) => {
          event.preventDefault();
          zoom(event.deltaY < 0 ? 0.8 : 1.25);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const rect = event.currentTarget.getBoundingClientRect();
          // The tree keeps its aspect ratio, so both axes share the scale of the tighter one.
          const unitsPerPixel = Math.max(
            viewport.width / Math.max(rect.width, 1),
            viewport.height / Math.max(rect.height, 1),
          );
          const dx = (event.clientX - drag.current.x) * unitsPerPixel;
          const dy = (event.clientY - drag.current.y) * unitsPerPixel;
          drag.current = { x: event.clientX, y: event.clientY };
          setView((current) => ({
            ...(current ?? bounds),
            x: (current ?? bounds).x - dx,
            y: (current ?? bounds).y - dy,
          }));
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
      >
        {nodes.map((node) => {
          const parent = node.parent && byId.get(node.parent);
          return parent ? (
            <line key={node.id} x1={parent.x} y1={parent.y + 16} x2={node.x} y2={node.y - 16} />
          ) : null;
        })}
        {nodes.map((node) => (
          <g
            key={node.id}
            tabIndex={0}
            role="button"
            aria-label={node.parent ? `${node.id}, parent ${node.parent}` : node.id}
            aria-pressed={frame?.id === node.id}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setSelected({ run: runId, id: node.id })}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelected({ run: runId, id: node.id });
              }
            }}
            transform={`translate(${node.x} ${node.y})`}
          >
            <title>{node.id}</title>
            <rect x={-95} y={-16} width={190} height={32} rx={4} />
            <text textAnchor="middle" dominantBaseline="central">
              {node.id.length > 24 ? `${node.id.slice(0, 23)}…` : node.id}
            </text>
          </g>
        ))}
      </svg>
      {frame && (
        <div
          className="tf-tree-pose"
          style={{ transform: `translate(${poseOffset.x}px, ${poseOffset.y}px)` }}
        >
          <strong
            className="tf-tree-pose-handle"
            role="button"
            tabIndex={0}
            aria-label={`Move details for ${frame.id}`}
            title="Drag or use arrow keys to move"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              poseDrag.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerMove={(event) => {
              if (!poseDrag.current) return;
              const dx = event.clientX - poseDrag.current.x;
              const dy = event.clientY - poseDrag.current.y;
              poseDrag.current = { x: event.clientX, y: event.clientY };
              movePose(event.currentTarget, dx, dy);
            }}
            onPointerUp={() => {
              poseDrag.current = undefined;
            }}
            onPointerCancel={() => {
              poseDrag.current = undefined;
            }}
            onKeyDown={(event) => {
              const delta: Record<string, [number, number]> = {
                ArrowLeft: [-10, 0],
                ArrowRight: [10, 0],
                ArrowUp: [0, -10],
                ArrowDown: [0, 10],
              };
              const movement = delta[event.key];
              if (!movement) return;
              event.preventDefault();
              movePose(event.currentTarget, movement[0], movement[1]);
            }}
          >
            {frame.id}
          </strong>
          {frame.parent === null ? (
            <span>Root frame</span>
          ) : !parent ? (
            <span>Parent frame unavailable: {frame.parent}</span>
          ) : (
            <>
              <span>Parent Frame: {parent}</span>
              {transformError ? (
                <span role="alert">{transformError}</span>
              ) : !info ? (
                <span>No playback time</span>
              ) : !transforms ? (
                <span>Loading…</span>
              ) : !pose ? (
                <span>Transform unavailable at this time</span>
              ) : (
                <>
                  <span>Time: {transforms.time_ns} ns</span>
                  <span>Translation (m):</span>
                  {pose.translation.map((value, i) => (
                    <span key={i}>
                      {["x", "y", "z"][i]}: {value}
                    </span>
                  ))}
                  <span>Rotation:</span>
                  {pose.rotation.map((value, i) => (
                    <span key={i}>
                      {["x", "y", "z", "w"][i]}: {value}
                    </span>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
