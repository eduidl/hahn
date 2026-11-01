import { browserTimeZone, type TimeDisplay, type TimeZoneSource } from "../timeDisplay";

/** The workspace's timezone, naming which side each choice comes from. */
export function TimeZoneSelect({
  source,
  serverZone,
  onChange,
  disabled = false,
}: {
  source: TimeZoneSource;
  serverZone: string | null;
  onChange: (source: TimeZoneSource) => void;
  /** Offsets do not depend on a time zone. */
  disabled?: boolean;
}) {
  const browserZone = browserTimeZone();
  // With nothing to choose between, just say which zone times are shown in.
  if (!serverZone || serverZone === browserZone)
    return (
      <div className="timezone-select">
        <span>Time zone</span>
        <span className={`timezone-name ${disabled ? "disabled" : ""}`}>{browserZone}</span>
      </div>
    );
  return (
    <label className="timezone-select">
      <span>Time zone</span>
      <select
        disabled={disabled}
        value={source}
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
