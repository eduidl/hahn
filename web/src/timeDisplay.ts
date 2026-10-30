import { createContext, useContext, useMemo } from "react";

export type TimeDisplay = "absolute" | "relative";

/** Where the displayed timezone comes from, chosen once for the whole workspace. */
export type TimeZoneSource = "browser" | "server";

/** The timezone clock times are shown in; undefined means the browser's. */
export const DisplayTimeZone = createContext<string | undefined>(undefined);

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

export function useTimeFormatter(originNs: string | null, mode: TimeDisplay) {
  const zone = useContext(DisplayTimeZone);
  return useMemo(() => timeFormatter(originNs, mode, zone), [originNs, mode, zone]);
}

/** Format only the labels; all plotting and hit testing stays relative to the recording. */
export function timeFormatter(
  originNs: string | null,
  mode: TimeDisplay,
  timeZone?: string,
) {
  const relative = (seconds: number) =>
    Number.isFinite(seconds)
      ? seconds.toLocaleString(undefined, { maximumSignificantDigits: 6 })
      : "—";
  if (mode === "relative")
    return {
      tick: (seconds: number) => ({ time: relative(seconds), date: "" }),
      tooltip: (seconds: number) => `${relative(seconds)} s`,
      axisLabel: "録画開始からの秒数",
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
  const tick = (seconds: number) => {
    if (originNs === null || !Number.isFinite(seconds * 1e9))
      return { time: "—", date: "" };
    const date = new Date(
      Number(
        (BigInt(originNs) + BigInt(Math.round(seconds * 1e9))) / 1_000_000n,
      ),
    );
    if (!Number.isFinite(date.getTime())) return { time: "—", date: "" };
    const parts = calendar.formatToParts(date);
    const part = (name: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === name)?.value ?? "";
    return {
      time: clock.format(date),
      date: `${part("year")}-${part("month")}-${part("day")}`,
    };
  };
  return {
    tick,
    tooltip: (seconds: number) => {
      const label = tick(seconds);
      return label.date ? `${label.date} ${label.time} (${zone})` : "—";
    },
    axisLabel: `実時刻（${zone}）`,
  };
}
