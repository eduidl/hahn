import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  useContext,
} from "react";
import { DisplayTimeMode, useTimeFormatter } from "../timeDisplay";
import { playbackSpeeds, usePlayback, usePlaybackStore } from "./playback";
import type { Info } from "../types";

type Props = {
  info: Info | null;
  fullEnd: number;
  busy: boolean;
};

const stepSeconds = 0.1;
const largeStepSeconds = 1;
const seconds = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });

/** Whether a focused control already uses the key, so the shortcut must not also fire. */
function ownsKey(target: EventTarget | null, key: string) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // The seek slider handles its own keys; buttons and summaries activate on Space natively.
  const owners =
    key === " "
      ? "input, select, textarea, button, summary, [role=button], [role=slider]"
      : "input, select, textarea, [role=slider]";
  return target.closest(owners) !== null;
}

const icon = (path: string) => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} fill="currentColor" />
  </svg>
);

export function PlaybackBar({ info, fullEnd, busy }: Props) {
  const store = usePlaybackStore();
  const time = usePlayback((s) => s.time);
  const playing = usePlayback((s) => s.playing);
  const preview = usePlayback((s) => s.preview);
  const buffering = useSyncExternalStore(store.subscribe, store.isBuffering);
  const waiting = playing && buffering;
  const active = busy || waiting;
  const status = waiting ? "Buffering…" : busy ? "Receiving data" : "Ready";
  const speed = usePlayback((s) => s.speed);
  const loop = usePlayback((s) => s.loop);
  const disabled = info === null;
  const clock = useTimeFormatter(info?.start_ns ?? null, "absolute");
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Playback resumes after a scrub only if it was playing when the scrub began.
  const scrub = useRef<{ resume: boolean } | null>(null);

  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || ownsKey(event.target, event.key)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === " ") store.toggle();
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const step = event.shiftKey ? largeStepSeconds : stepSeconds;
        store.step(event.key === "ArrowLeft" ? -step : step);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, store]);

  const timeAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = track.current!.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    return ratio * fullEnd;
  };
  const percent = (value: number) =>
    `${disabled ? 0 : Math.max(0, Math.min(100, (value / fullEnd) * 100))}%`;
  const label = clock.tooltip(time);
  const now = clock.tick(time);
  // Both are always shown; the workspace's choice comes first.
  const mode = useContext(DisplayTimeMode);
  const clockText = `${now.date} ${now.time}`;
  const offsetText = `${seconds(time)} / ${seconds(fullEnd)} s`;

  return (
    <footer className="playback-bar" aria-label="Playback">
      <div className="playback-controls">
        <button
          aria-label="Go to start"
          title="Go to start"
          disabled={disabled}
          onClick={() => store.seek(0)}
        >
          {icon("M6 5h2v14H6zM20 5v14L9 12z")}
        </button>
        <button
          aria-label="Back"
          title={`Back ${stepSeconds}s (Left; Shift+Left: ${largeStepSeconds}s)`}
          disabled={disabled}
          onClick={() => store.step(-stepSeconds)}
        >
          {icon("M11 5v14L4 12zM20 5v14l-7-7z")}
        </button>
        <button
          className="playback-toggle"
          aria-label={playing ? "Pause" : "Play"}
          title={`${playing ? "Pause" : "Play"} (Space)`}
          disabled={disabled}
          onClick={store.toggle}
        >
          {playing ? icon("M6 5h4v14H6zM14 5h4v14h-4z") : icon("M7 4v16l13-8z")}
        </button>
        <button
          aria-label="Forward"
          title={`Forward ${stepSeconds}s (Right; Shift+Right: ${largeStepSeconds}s)`}
          disabled={disabled}
          onClick={() => store.step(stepSeconds)}
        >
          {icon("M4 5v14l7-7zM13 5v14l7-7z")}
        </button>
        <button
          aria-label="Go to end"
          title="Go to end"
          disabled={disabled}
          onClick={() => store.seek(fullEnd)}
        >
          {icon("M4 5v14l11-7zM16 5h2v14h-2z")}
        </button>
      </div>
      <div className="playback-time" aria-live="off">
        <span title={label}>{disabled ? "—" : mode === "offset" ? offsetText : clockText}</span>
        <small>{disabled ? "—" : mode === "offset" ? clockText : offsetText}</small>
      </div>
      <div
        ref={track}
        className={`playback-track ${disabled ? "disabled" : ""}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={fullEnd}
        aria-valuenow={time}
        aria-valuetext={label}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if (disabled) return;
          const step = event.shiftKey ? largeStepSeconds : stepSeconds;
          if (event.key === "ArrowLeft") store.step(-step);
          else if (event.key === "ArrowRight") store.step(step);
          else if (event.key === "Home") store.seek(0);
          else if (event.key === "End") store.seek(fullEnd);
          else if (event.key === " ") store.toggle();
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          scrub.current = { resume: store.getState().playing };
          store.pause();
          store.seek(timeAt(event));
        }}
        onPointerMove={(event) => {
          if (disabled) return;
          const at = timeAt(event);
          setHover(at);
          if (scrub.current) store.seek(at);
        }}
        onPointerUp={() => {
          if (scrub.current?.resume) store.play();
          scrub.current = null;
        }}
        onPointerCancel={() => {
          scrub.current = null;
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div className="playback-rail">
          <div className="playback-progress" style={{ width: percent(time) }} />
        </div>
        {preview !== null && !disabled && preview >= 0 && preview <= fullEnd && (
          <div className="playback-preview" style={{ left: percent(preview) }} />
        )}
        <div className="playback-thumb" style={{ left: percent(time) }} />
        {hover !== null && !disabled && (
          <div className="playback-hover" style={{ left: percent(hover) }}>
            {clock.tick(hover).time}
            <small>{seconds(hover)} s</small>
          </div>
        )}
      </div>
      <label className="playback-speed">
        <span className="sr-only">Playback speed</span>
        <select
          value={speed}
          disabled={disabled}
          onChange={(event) => store.setSpeed(Number(event.target.value))}
        >
          {playbackSpeeds.map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
      </label>
      <button
        className="playback-loop"
        aria-label="Loop playback"
        aria-pressed={loop}
        title="Loop playback"
        disabled={disabled}
        onClick={() => store.setLoop(!loop)}
      >
        {icon("M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z")}
      </button>
      <div className="playback-status">
        <span role="status" title={status}>
          <i className={active ? "pulse" : ""} />
          <span className="sr-only">{status}</span>
        </span>
      </div>
    </footer>
  );
}
