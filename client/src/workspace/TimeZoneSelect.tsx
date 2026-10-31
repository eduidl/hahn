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
        <option value="browser">Browser: {browserTimeZone()}</option>
        <option value="server" disabled={!serverZone}>
          Server: {serverZone ?? "Not set"}
        </option>
      </select>
    </label>
  );
}
