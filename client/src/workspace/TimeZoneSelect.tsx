import { browserTimeZone, type TimeZoneSource } from "../timeDisplay";

/** The workspace's timezone, naming which side each choice comes from. */
export function TimeZoneSelect({
  source,
  serverZone,
  onChange,
}: {
  source: TimeZoneSource;
  serverZone: string | null;
  onChange: (source: TimeZoneSource) => void;
}) {
  return (
    <label className="timezone-select">
      <span>Time zone</span>
      <select
        value={serverZone ? source : "browser"}
        onChange={(event) => onChange(event.target.value === "server" ? "server" : "browser")}
      >
        <option value="browser">Browser: {browserZone}</option>
        <option value="server">Server: {serverZone}</option>
      </select>
    </label>
  );
}

/** Whether times read as clock times or as offsets from the start of the run. */
export function TimeDisplaySelect({
  value,
  onChange,
}: {
  value: TimeDisplay;
  onChange: (value: TimeDisplay) => void;
}) {
  return (
    <label className="timezone-select">
      <span>Time</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value === "offset" ? "offset" : "absolute")}
      >
        <option value="absolute">Absolute</option>
        <option value="offset">Offset</option>
      </select>
    </label>
  );
}
