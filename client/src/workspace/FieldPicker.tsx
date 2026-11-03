// The search popover that adds fields to a widget.
import type { WidgetSettingsProps } from "./WidgetSettings";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { pickableFields } from "./drop";
import { SeriesName } from "../SeriesName";
import { matchesTerms, searchTerms } from "../search";
import type { IndexedField } from "./fieldIndex";
import { addFieldAction, viewFor, widgetSpecs } from "./widgets";

/** Rows rendered at once; the search narrows the rest. */
export const pickerLimit = 100;

const alreadyAdded = "Already added";
/** Why these cannot be added. Being added already is the least useful thing to say. */
function explain(items: { reason: string }[]) {
  const reasons = new Set(items.map((item) => item.reason));
  if (reasons.size > 1) reasons.delete(alreadyAdded);
  return [...reasons].join(" ");
}

/** A button opening a searchable list of the fields this widget can take now; picking one closes it. */
export function FieldPicker({
  widget,
  dispatch,
  index,
  kind,
}: WidgetSettingsProps & {
  /** Only images, or only what is drawn over one: point clouds and annotations. */
  kind?: "image" | "overlay";
}) {
  const singleTarget = widgetSpecs[widget.type].maxSeries === 1 || kind === "image";
  // Widgets fed by converted views take whole topics, never individual fields.
  const takesTopics = Boolean(widgetSpecs[widget.type].viewKinds);
  const label =
    kind === "image"
      ? "Select image topic"
      : takesTopics
        ? "Add topic"
        : singleTarget
          ? "Select target"
          : "Add field";
  const pickerId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const { candidates, unavailable } = useMemo(() => {
    const fits = (entry: IndexedField) => {
      const found = viewFor(widgetSpecs[widget.type], entry.topic)?.kind;
      if (kind === "overlay") return found === "pointcloud" || found === "image_annotations";
      return !kind || found === kind;
    };
    const { addable, unavailable } = pickableFields(index, widget);
    return {
      candidates: addable.filter(fits),
      unavailable: unavailable.filter((item) => fits(item.entry)),
    };
  }, [index, widget, kind]);
  const nounFor = (count: number) =>
    takesTopics
      ? count === 1
        ? "topic"
        : "topics"
      : singleTarget
        ? count === 1
          ? "topic or field"
          : "topics and fields"
        : count === 1
          ? "field"
          : "fields";
  const candidateNoun = nounFor(candidates.length);
  const terms = searchTerms(query);
  const matches = candidates.filter((entry) => matchesTerms(entry.label, terms));
  const shown = matches.slice(0, pickerLimit);
  const unavailableMatches = unavailable.filter((item) => matchesTerms(item.entry.label, terms));
  // Fields that are already in the widget explain themselves in its series list.
  const hiddenMatches = unavailableMatches.filter((item) => item.reason !== alreadyAdded);
  // Candidates can shrink while the list is open, so never point past the end.
  const activeIndex = Math.min(active, shown.length - 1);
  useEffect(() => {
    results.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);
  useEffect(() => {
    // The popover focuses its `autofocus` descendant when shown; React's
    // autoFocus prop only focuses on mount and emits no attribute.
    input.current?.setAttribute("autofocus", "");
    // React's onToggle does not cover popovers, so listen to the native event.
    const node = popover.current;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== "closed") return;
      setQuery("");
      setActive(0);
    };
    node?.addEventListener("toggle", onToggle);
    return () => node?.removeEventListener("toggle", onToggle);
  }, []);
  const pick = (entry: IndexedField) => {
    dispatch(addFieldAction(widget, entry.topic, entry.field, index));
    popover.current?.hidePopover();
  };
  return (
    <>
      <button
        type="button"
        className="add-field"
        aria-label={label}
        popoverTarget={pickerId}
        disabled={!candidates.length}
        title={
          candidates.length
            ? undefined
            : explain(unavailable) || `No ${nounFor(0)} are available in the open groups.`
        }
      >
        {singleTarget ? label : takesTopics ? "+ Topic" : "+ Field"}
      </button>
      <div
        id={pickerId}
        ref={popover}
        className="popover-surface field-picker"
        popover="auto"
        role="dialog"
        aria-label={label}
      >
        <input
          ref={input}
          className="text-input search"
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${pickerId}-results`}
          aria-activedescendant={shown.length ? `${pickerId}-${activeIndex}` : undefined}
          aria-label={
            kind === "image"
              ? "Search for a topic to select"
              : takesTopics
                ? "Search for a topic to add"
                : singleTarget
                  ? "Search for a topic or field to select"
                  : "Search for a field to add"
          }
          placeholder={`Search ${candidates.length.toLocaleString()} ${candidateNoun}…`}
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
            pick(shown[activeIndex]);
          }}
        />
        <div
          ref={results}
          id={`${pickerId}-results`}
          className="field-picker-results"
          role="listbox"
          aria-label={label}
        >
          {shown.map((entry, i) => (
            <button
              type="button"
              key={entry.key}
              id={`${pickerId}-${i}`}
              className="field-option"
              role="option"
              aria-selected={i === activeIndex}
              // Focus stays in the search box; the arrow keys move the selection.
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(entry)}
            >
              <SeriesName
                source={entry.topic.source}
                topic={entry.topic.topicName ?? entry.topic.topic}
                path={entry.field.path}
                type={entry.typeLabel}
              />
            </button>
          ))}
          {matches.length > pickerLimit && (
            <p className="muted">
              {(matches.length - pickerLimit).toLocaleString()} more. Refine your search.
            </p>
          )}
          {candidates.length > 0 && !matches.length && (
            <p className="muted">{explain(unavailableMatches) || "No matching fields"}</p>
          )}
        </div>
        {matches.length > 0 && hiddenMatches.length > 0 && (
          <p className="muted field-picker-note">
            {hiddenMatches.length.toLocaleString()} more {nounFor(hiddenMatches.length)} not shown.{" "}
            {explain(hiddenMatches)}
          </p>
        )}
      </div>
    </>
  );
}
