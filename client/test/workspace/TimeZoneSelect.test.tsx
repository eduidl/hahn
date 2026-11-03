// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeDisplayToggle, TimeZoneSelect } from "../../src/workspace/TimeZoneSelect";
import { browserTimeZone } from "../../src/timeDisplay";

// Differs from the browser's zone wherever the tests run.
const otherZone = browserTimeZone() === "Asia/Tokyo" ? "UTC" : "Asia/Tokyo";
const trigger = () =>
  screen.getByRole("button", { name: /^Time zone:/, hidden: true }) as HTMLButtonElement;
const options = () =>
  screen
    .getAllByRole("option", { hidden: true })
    .map((option) => option.querySelector(".timezone-name")?.textContent);
const search = (text: string) =>
  fireEvent.change(screen.getByRole("combobox", { hidden: true }), { target: { value: text } });
beforeEach(() => {
  HTMLElement.prototype.hidePopover = vi.fn();
});
afterEach(cleanup);

describe("TimeZoneSelect", () => {
  it("offers the browser's zone, the server's, then every named zone", () => {
    render(<TimeZoneSelect source="browser" serverZone={otherZone} onChange={() => {}} />);
    expect(options().slice(0, 3)).toEqual([
      `Browser: ${browserTimeZone()}`,
      `Server: ${otherZone}`,
      "UTC",
    ]);
    expect(options()).toContain("Europe/Paris");
  });

  it("leaves the server out when it declares no zone", () => {
    render(<TimeZoneSelect source="browser" serverZone={null} onChange={() => {}} />);
    expect(options().some((label) => label?.startsWith("Server"))).toBe(false);
  });

  it("finds a zone by words, and reports it", () => {
    const onChange = vi.fn();
    render(<TimeZoneSelect source="browser" serverZone={null} onChange={onChange} />);
    search("new york");
    expect(options()).toContain("America/New_York");
    fireEvent.keyDown(screen.getByRole("combobox", { hidden: true }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("America/New_York");
  });

  it("shows the offset of the zone in use at the given time, and names the zone", () => {
    const at = Date.UTC(2025, 0, 15);
    render(
      <TimeZoneSelect source="Europe/Paris" serverZone={null} atMs={at} onChange={() => {}} />,
    );
    expect(trigger().textContent).toBe("UTC+1▾");
    expect(trigger().title).toBe("Time zone");
    cleanup();
    render(
      <TimeZoneSelect
        source="Europe/Paris"
        serverZone={null}
        atMs={Date.UTC(2025, 6, 15)}
        onChange={() => {}}
      />,
    );
    expect(trigger().textContent).toBe("UTC+2▾");
  });

  it("finds UTC itself by its name, ahead of zones that merely have an offset", () => {
    render(<TimeZoneSelect source="browser" serverZone={null} onChange={() => {}} />);
    search("utc");
    expect(options()[0]).toBe("UTC");
  });

  it("opens on the zone in use", () => {
    render(<TimeZoneSelect source="Europe/Paris" serverZone={null} onChange={() => {}} />);
    const opened = Object.assign(new Event("toggle"), { newState: "open" });
    act(() => {
      screen.getByRole("dialog", { hidden: true }).dispatchEvent(opened);
    });
    const selected = screen
      .getAllByRole("option", { hidden: true })
      .find((option) => option.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("Europe/Paris");
  });

  it("lists each zone with its offset, and finds zones by it", () => {
    render(
      <TimeZoneSelect
        source="browser"
        serverZone={null}
        atMs={Date.UTC(2025, 0, 15)}
        onChange={() => {}}
      />,
    );
    search("UTC+9");
    const tokyo = screen
      .getAllByRole("option", { hidden: true })
      .find((option) => option.textContent?.startsWith("Asia/Tokyo"));
    expect(tokyo?.textContent).toBe("Asia/TokyoUTC+9");
  });
});

describe("TimeDisplayToggle", () => {
  it("shows the current mode, and switches to the other", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TimeDisplayToggle value="absolute" onChange={onChange} />);
    const button = screen.getByRole("button", { name: "Switch to offset time" });
    expect(button.textContent).toBe("Absolute");
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith("offset");
    rerender(<TimeDisplayToggle value="offset" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to absolute time" }));
    expect(onChange).toHaveBeenLastCalledWith("absolute");
  });
});
