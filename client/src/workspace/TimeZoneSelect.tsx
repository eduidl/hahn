import "./TimeZoneSelect.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  browserTimeZone,
  chosenTimeZone,
  namedTimeZones,
  zoneOffset,
  type TimeDisplay,
  type TimeZoneSource,
} from "../timeDisplay";

/** Zone names write spaces as underscores; a search should not have to. */
const searchable = (text: string) => text.toLowerCase().replaceAll("_", " ");

/** The workspace's timezone: the browser's, the server's, or any named zone. */
export function TimeZoneSelect({
  source,
  serverZone,
  atMs,
  onChange,
}: {
  source: TimeZoneSource;
  serverZone: string | null;
  /** When to read offsets, which change with the date; absent means now. */
  atMs?: number;
  onChange: (source: TimeZoneSource) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [now] = useState(Date.now);
  const at = atMs ?? now;
  const browserZone = browserTimeZone();
  const zone = chosenTimeZone(source, serverZone) ?? browserZone;
  const offset = zoneOffset(zone, at);
  const options = useMemo(
    () =>
      [
        { value: "browser", label: `Browser: ${browserZone}`, zone: browserZone },
        ...(serverZone
          ? [{ value: "server", label: `Server: ${serverZone}`, zone: serverZone }]
          : []),
        ...namedTimeZones().map((name) => ({ value: name, label: name, zone: name })),
      ].map((option) => ({ ...option, offset: zoneOffset(option.zone, at) })),
    [browserZone, serverZone, at],
  );
  const needle = searchable(query.trim());
  const shown = needle
    ? options.filter((option) =>
        // Every offset starts with UTC, so only a number searches them.
        searchable(/\d/.test(needle) ? `${option.label} ${option.offset}` : option.label).includes(
          needle,
        ),
      )
    : options;
  const activeIndex = Math.min(active, shown.length - 1);
  // The list is the one place that names the zone, so it opens on the current one.
  const currentIndex = useRef(0);
  currentIndex.current = Math.max(
    0,
    options.findIndex((option) => option.value === source),
  );
  useEffect(() => {
    results.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);
  useEffect(() => {
    // The popover focuses its `autofocus` descendant when shown.
    input.current?.setAttribute("autofocus", "");
    // React's onToggle does not cover popovers, so listen to the native event.
    const node = popover.current;
    const onToggle = (event: Event) => {
      setQuery("");
      setActive((event as ToggleEvent).newState === "open" ? currentIndex.current : 0);
    };
    node?.addEventListener("toggle", onToggle);
    return () => node?.removeEventListener("toggle", onToggle);
  }, []);
  const pick = (value: TimeZoneSource) => {
    onChange(value);
    popover.current?.hidePopover();
  };
  return (
    <>
      <button
        className="timezone-trigger"
        aria-label={`Time zone: ${zone} (${offset})`}
        title="Time zone"
        popoverTarget={id}
      >
        {offset}
        <span>▾</span>
      </button>
      <div
        id={id}
        ref={popover}
        className="popover-surface timezone-picker"
        popover="auto"
        role="dialog"
        aria-label="Time zone"
      >
        <input
          ref={input}
          className="text-input"
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-results`}
          aria-activedescendant={shown.length ? `${id}-${activeIndex}` : undefined}
          aria-label="Search for a time zone"
          placeholder="Search time zones…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((activeIndex + step + shown.length) % shown.length);
              return;
            }
            // A search input's native Escape only clears the text; close instead.
            if (event.key === "Escape") {
              event.preventDefault();
              popover.current?.hidePopover();
              return;
            }
            if (event.key !== "Enter" || !shown.length) return;
            // Closing returns focus to the opener; without this the same
            // Enter would press it and reopen the list.
            event.preventDefault();
            pick(shown[activeIndex].value);
          }}
        />
        <div
          ref={results}
          id={`${id}-results`}
          className="field-picker-results"
          role="listbox"
          aria-label="Time zones"
        >
          {shown.map((option, i) => (
            <button
              key={option.value}
              id={`${id}-${i}`}
              className="field-option"
              role="option"
              aria-selected={i === activeIndex}
              aria-current={option.value === source ? "true" : undefined}
              // Focus stays in the search box; the arrow keys move the selection.
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(option.value)}
            >
              <span className="timezone-name">{option.label}</span>
              <span className="timezone-offset">{option.offset}</span>
            </button>
          ))}
          {!shown.length && <p className="muted">No matching time zones</p>}
        </div>
      </div>
    </>
  );
}

/** Whether times read as clock times or as offsets from the start of the run. */
export function TimeDisplayToggle({
  value,
  onChange,
}: {
  value: TimeDisplay;
  onChange: (value: TimeDisplay) => void;
}) {
  const next = value === "offset" ? "absolute" : "offset";
  const action = `Switch to ${next} time`;
  return (
    <button
      className="time-display-toggle"
      aria-label={action}
      title={action}
      onClick={() => onChange(next)}
    >
      {/* A clock, so the setting reads as being about time. */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      {value === "offset" ? "Offset" : "Absolute"}
    </button>
  );
}
