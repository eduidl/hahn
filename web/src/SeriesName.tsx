import { Fragment } from "react";

/** Allow line breaks only after `/` and `.`, so names wrap between segments. */
function breakable(text: string) {
  return text.split(/(?<=[/.])/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

/** The one way a series is written: topic over field path, optionally its type below. */
export function SeriesName({
  topic,
  path,
  type,
}: {
  topic: string;
  path: string[];
  type?: string;
}) {
  return (
    <span className="series-ref">
      <span className="series-ref-topic">{breakable(topic)}</span>
      {path.length > 0 && (
        <span className="series-ref-path">{breakable(path.join("."))}</span>
      )}
      {type && <span className="series-ref-type">{breakable(type)}</span>}
    </span>
  );
}
