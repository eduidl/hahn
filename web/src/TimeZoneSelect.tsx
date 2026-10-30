import { browserTimeZone, type TimeZoneSource } from "./timeDisplay";

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
      <span>タイムゾーン</span>
      <select
        value={serverZone ? source : "browser"}
        onChange={(event) => onChange(event.target.value === "server" ? "server" : "browser")}
      >
        <option value="browser">ブラウザ: {browserTimeZone()}</option>
        <option value="server" disabled={!serverZone}>
          サーバ: {serverZone ?? "未設定"}
        </option>
      </select>
    </label>
  );
}
