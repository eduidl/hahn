import { createContext, useContext, useMemo } from "react";

/** How times are written: on the clock, or as seconds from the start of the run. */
export type TimeDisplay = "absolute" | "offset";

/**
 * The displayed timezone, chosen once for the whole workspace: the browser's,
 * the one the server declares, or a named IANA zone.
 */
export type TimeZoneSource = "browser" | "server" | (string & {});

/** The timezone clock times are shown in; undefined means the browser's. */
export const DisplayTimeZone = createContext<string | undefined>(undefined);

/** The workspace's choice of time display, which every time follows by default. */
export const DisplayTimeMode = createContext<TimeDisplay>("absolute");

export const browserTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

export function usableTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** Every zone that can be chosen by name. Browsers may leave UTC out of the list. */
export const namedTimeZones = () => [
  "UTC",
  ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC"),
];

/** The zone a choice stands for; undefined means the browser's. */
export function chosenTimeZone(source: TimeZoneSource, serverZone: string | null) {
  if (source === "browser") return undefined;
  if (source === "server") return serverZone ?? undefined;
  return usableTimeZone(source) ?? undefined;
}

/** A zone's UTC offset at a moment, such as `UTC+9` or `UTC+5:30`; it can change with the date. */
export function zoneOffset(timeZone: string, atMs: number) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(atMs)
    .find((part) => part.type === "timeZoneName")?.value;
  // `GMT+09:00`, or plain `GMT` in some browsers, with seconds in old dates.
  const [, sign, hours, rest] = name?.match(/^GMT([+-])(\d+)(?::(.+))?$/) ?? [];
  if (!sign || (Number(hours) === 0 && (!rest || /^00(:00)?$/.test(rest)))) return "UTC";
  return `UTC${sign}${Number(hours)}${rest && rest !== "00" ? `:${rest}` : ""}`;
}

/** `mode` overrides the workspace's choice, for places that always need one form. */
export function useTimeFormatter(originNs: string | null, mode?: TimeDisplay) {
  const zone = useContext(DisplayTimeZone);
  const chosen = useContext(DisplayTimeMode);
  mode ??= chosen;
  return useMemo(() => timeFormatter(originNs, mode, zone), [originNs, mode, zone]);
}

/** Format only the labels; all plotting and hit testing stays relative to the recording. */
export function timeFormatter(originNs: string | null, mode: TimeDisplay, timeZone?: string) {
  const relative = (seconds: number) =>
    Number.isFinite(seconds)
      ? seconds.toLocaleString(undefined, { maximumSignificantDigits: 6 })
      : "—";
  // A fixed width lines up in lists, and matches the milliseconds of clock times.
  const exact = (seconds: number) =>
    Number.isFinite(seconds)
      ? seconds.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })
      : "—";
  if (mode === "offset")
    return {
      tick: (seconds: number) => ({ time: exact(seconds), date: "" }),
      tooltip: (seconds: number) => `${exact(seconds)} s`,
      axisTime: (seconds: number) => relative(seconds),
      tickOffset: 0,
      minTickSpacing: 70,
      clock: false,
      axisLabel: "Offset (s)",
    };
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  const calendar = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const zone = clock.resolvedOptions().timeZone;
  const dateAt = (seconds: number) =>
    new Date(Number((BigInt(originNs!) + BigInt(Math.round(seconds * 1e9))) / 1_000_000n));
  const tick = (seconds: number) => {
    if (originNs === null || !Number.isFinite(seconds * 1e9)) return { time: "—", date: "" };
    const date = dateAt(seconds);
    if (!Number.isFinite(date.getTime())) return { time: "—", date: "" };
    const parts = calendar.formatToParts(date);
    const part = (name: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === name)?.value ?? "";
    return {
      time: clock.format(date),
      date: `${part("year")}-${part("month")}-${part("day")}`,
    };
  };
  // The clock time at the axis origin, so ticks can land on round times in this zone.
  const [hours, minutes, secs] = tick(0).time.split(":").map(Number);
  const tickOffset = hours * 3600 + minutes * 60 + secs || 0;
  return {
    tick,
    /** The clock time with only the fraction digits that `step` needs. */
    axisTime: (seconds: number, step: number) => {
      const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
      return tick(seconds).time.slice(0, digits ? 9 + digits : 8);
    },
    tickOffset,
    minTickSpacing: 110,
    clock: true,
    tooltip: (seconds: number) => {
      const label = tick(seconds);
      return label.date
        ? `${label.date} ${label.time} (${zoneOffset(zone, dateAt(seconds).getTime())})`
        : "—";
    },
    // Named at the start of the run; the ticks still follow any later clock change.
    axisLabel: `Absolute time (${zoneOffset(zone, originNs === null ? Date.now() : dateAt(0).getTime())})`,
  };
}
