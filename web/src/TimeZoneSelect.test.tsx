// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeZoneSelect } from "./TimeZoneSelect";
import { browserTimeZone } from "./timeDisplay";

const select = () => screen.getByLabelText("タイムゾーン") as HTMLSelectElement;
afterEach(cleanup);

describe("TimeZoneSelect", () => {
  it("names where each timezone comes from", () => {
    render(<TimeZoneSelect source="browser" serverZone="Asia/Tokyo" onChange={() => {}} />);
    expect([...select().options].map((o) => o.textContent)).toEqual([
      `ブラウザ: ${browserTimeZone()}`,
      "サーバ: Asia/Tokyo",
    ]);
  });

  it("reports the choice", () => {
    const onChange = vi.fn();
    render(<TimeZoneSelect source="browser" serverZone="Asia/Tokyo" onChange={onChange} />);
    fireEvent.change(select(), { target: { value: "server" } });
    expect(onChange).toHaveBeenCalledWith("server");
  });

  it("falls back to the browser when the server declares none", () => {
    render(<TimeZoneSelect source="server" serverZone={null} onChange={() => {}} />);
    expect(select().value).toBe("browser");
    const server = select().options[1];
    expect(server.textContent).toBe("サーバ: 未設定");
    expect(server.disabled).toBe(true);
  });
});
