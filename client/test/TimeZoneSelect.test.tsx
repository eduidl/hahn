// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeDisplaySelect, TimeZoneSelect } from "../src/workspace/TimeZoneSelect";
import { browserTimeZone } from "../src/timeDisplay";

// Differs from the browser's zone wherever the tests run.
const otherZone = browserTimeZone() === "Asia/Tokyo" ? "UTC" : "Asia/Tokyo";
const select = () => screen.getByLabelText("Time zone") as HTMLSelectElement;
afterEach(cleanup);

describe("TimeZoneSelect", () => {
  it("names where each timezone comes from", () => {
    render(<TimeZoneSelect source="browser" serverZone={otherZone} onChange={() => {}} />);
    expect([...select().options].map((o) => o.textContent)).toEqual([
      `Browser: ${browserTimeZone()}`,
      `Server: ${otherZone}`,
    ]);
  });

  it("reports the choice", () => {
    const onChange = vi.fn();
    render(<TimeZoneSelect source="browser" serverZone={otherZone} onChange={onChange} />);
    fireEvent.change(select(), { target: { value: "server" } });
    expect(onChange).toHaveBeenCalledWith("server");
  });

  it.each([
    ["declares none", null],
    ["uses the browser's zone", browserTimeZone()],
  ])("shows the zone without a choice when the server %s", (_, serverZone) => {
    render(<TimeZoneSelect source="server" serverZone={serverZone} onChange={() => {}} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(browserTimeZone())).toBeTruthy();
  });

  it("can be disabled while times do not depend on a zone", () => {
    render(<TimeZoneSelect source="browser" serverZone={otherZone} onChange={() => {}} disabled />);
    expect(select().disabled).toBe(true);
  });
});

describe("TimeDisplaySelect", () => {
  it("reports the choice", () => {
    const onChange = vi.fn();
    render(<TimeDisplaySelect value="absolute" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "offset" } });
    expect(onChange).toHaveBeenCalledWith("offset");
  });
});
