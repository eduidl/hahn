export type AxisTicks = {
  values: number[];
  labels: string[];
  /** Shared part factored out of the labels (`+1,769,410,500` or `×10⁹`), drawn once. */
  annotation: string | null;
};

/** Labels longer than this switch to an offset or a shared exponent. */
const maxLabelLength = 8;
/** Offset notation pays off when values sit this far from zero relative to their spread. */
const offsetRatio = 1e3;

const superscript = (n: number) =>
  String(n).replace(/[-0-9]/g, (c) => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(c)]);

/** 1, 2 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

const decimalsFor = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

function plain(value: number, decimals: number) {
  // Avoid "-0" for values that round to zero.
  const rounded = Number(value.toFixed(decimals)) || 0;
  return rounded.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Labels for `values`, scaled by a shared power of ten when plain ones are too long. */
function scaled(values: number[], step: number, force: boolean) {
  const decimals = decimalsFor(step);
  const labels = values.map((value) => plain(value, decimals));
  if (!force && Math.max(...labels.map((label) => label.length)) <= maxLabelLength)
    return { labels, exponent: null };
  const largest = Math.max(...values.map(Math.abs), step);
  const exponent = Math.floor(Math.log10(largest));
  const scale = 10 ** exponent;
  const scaledDecimals = Math.max(0, exponent - Math.floor(Math.log10(step) + 1e-9));
  return {
    labels: values.map((value) => plain(value / scale, scaledDecimals)),
    exponent,
  };
}

/** `+1,769,410,500`, or `+1.7694565e18` when the digits would not fit. */
function offsetText(offset: number, unit: number) {
  const sign = offset < 0 ? "−" : "+";
  const digits = plain(Math.abs(offset), 0);
  if (digits.length <= 14) return sign + digits;
  const significant = Math.floor(Math.log10(Math.abs(offset))) - Math.floor(Math.log10(unit)) + 1;
  return sign + Math.abs(offset).toExponential(Math.max(0, significant - 1)).replace("e+", "e");
}

/**
 * Round-numbered ticks for a linear axis. Long labels are shortened like
 * matplotlib: an offset when values vary little around a large magnitude,
 * a shared power of ten otherwise, or both when the deltas are still long.
 */
export function linearTicks(min: number, max: number, count = 6): AxisTicks {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max))
    return { values: [], labels: [], annotation: null };
  const step = niceStep((max - min) / Math.max(1, count - 1));
  const values: number[] = [];
  for (let i = Math.ceil(min / step); i * step <= max + step * 1e-9; i++)
    values.push(i * step);
  const plainLabels = scaled(values, step, false);
  if (plainLabels.exponent === null)
    return { values, labels: plainLabels.labels, annotation: null };

  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  if (magnitude / (max - min) < offsetRatio) {
    const { labels, exponent } = scaled(values, step, true);
    return { values, labels, annotation: `×10${superscript(exponent!)}` };
  }
  // Round the offset to the order of the visible spread, so ticks read as small deltas.
  const unit = 10 ** Math.ceil(Math.log10(max - min));
  const offset = Math.floor(min / unit) * unit;
  const { labels, exponent } = scaled(values.map((value) => value - offset), step, false);
  const scale = exponent === null ? "" : `×10${superscript(exponent)} `;
  return { values, labels, annotation: scale + offsetText(offset, unit) };
}
