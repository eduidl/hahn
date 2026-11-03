// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabBar, TabSettings } from "../../src/workspace/TabControls";
import type { TabWidget, WidgetTab, WorkspaceAction } from "../../src/workspace/widgets";

const tab = (id: string, title: string, layout: WidgetTab["layout"]): WidgetTab => ({
  id,
  title,
  layout,
});
const widgetWith = (...tabs: WidgetTab[]) =>
  ({ id: "w", title: "Tab", type: "tabs", tabs, activeTabId: tabs[0].id }) as unknown as TabWidget;
const remove: WorkspaceAction = { type: "tab-remove", id: "w", tabId: "a" };
const filled = widgetWith(
  tab("a", "Camera", { type: "split", direction: "row", children: ["x", "y"] }),
  tab("b", "Other", null),
);

const renderers = {
  "tab bar": {
    label: "Delete tab Camera",
    show: (widget: TabWidget, dispatch: (action: WorkspaceAction) => void) =>
      render(
        <TabBar
          widget={widget}
          dispatch={dispatch}
          acceptWidget={() => false}
          dropWidget={() => {}}
        />,
      ),
  },
  "tab settings": {
    label: "Delete tab Camera",
    show: (widget: TabWidget, dispatch: (action: WorkspaceAction) => void) =>
      render(<TabSettings widget={widget} dispatch={dispatch} />),
  },
};

describe.each(Object.entries(renderers))("removing a tab from the %s", (_, { label, show }) => {
  const showModal = vi.fn();
  beforeEach(() => {
    showModal.mockClear();
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
      showModal();
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it("removes an empty tab without asking", () => {
    const dispatch = vi.fn();
    show(widgetWith(tab("a", "Camera", null), tab("b", "Other", null)), dispatch);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(showModal).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(remove);
  });
  it("keeps a tab with widgets when the confirmation is cancelled", () => {
    const dispatch = vi.fn();
    show(filled, dispatch);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/removes 2 widgets in this tab/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("removes a tab with widgets after confirmation", () => {
    const dispatch = vi.fn();
    show(filled, dispatch);
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(dispatch).toHaveBeenCalledWith(remove);
  });
});
