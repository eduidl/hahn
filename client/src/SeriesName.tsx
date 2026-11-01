import "./SeriesName.css";
import { Fragment } from "react";
import { useSourceLabel } from "./data/sources";

/** Allow line breaks only after `/` and `.`, so names wrap between segments. */
function breakable(text: string) {
  return text.split(/(?<=[/.])/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

/**
 * The one way a series is written: topic over field path, optionally its type
 * below. The recording is named above when several are open.
 */
export function SeriesName({
  source,
  topic,
  path,
  type,
  inline = false,
}: {
  source: string;
  topic: string;
  path: string[];
  type?: string;
  /** One line, for tight spots such as a plot legend. */
  inline?: boolean;
}) {
  const label = useSourceLabel(source);
  if (inline) {
    const field = path.join(".");
    const parent = label ? `${label} · ${topic}` : topic;
    // When space runs out the parent gives way, because the field tells series apart.
    return (
      <span className="series-ref-inline" title={field ? `${parent} · ${field}` : parent}>
        <span className="series-ref-parent">{field ? `${parent} · ` : parent}</span>
        {field && <span className="series-ref-field">{field}</span>}
      </span>
    );
  }
  return (
    <span className="series-ref">
      {label && <span className="series-ref-source">{breakable(label)}</span>}
      <span className="series-ref-topic">{breakable(topic)}</span>
      {path.length > 0 && <span className="series-ref-path">{breakable(path.join("."))}</span>}
      {type && <span className="series-ref-type">{breakable(type)}</span>}
    </span>
  );
}
