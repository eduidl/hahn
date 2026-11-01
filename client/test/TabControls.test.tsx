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
