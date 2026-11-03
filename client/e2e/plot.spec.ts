import { changeWidget, expandTopic, expect, openRun, test } from "./support";

test("a field dragged onto the plot is drawn with its legend", async ({ page }) => {
  await openRun(page, "demo.mcap");
  await expandTopic(page, "/telemetry");
  const plot = page.getByRole("region", { name: "Plot" });
  await page.getByRole("button", { name: "signal float64" }).dragTo(plot);
  await expect(
    plot.getByRole("button", { name: "Toggle visibility for /telemetry signal" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByText("Complete · 2,200 messages")).toBeVisible();
  await expect(page).toHaveScreenshot("plot-signal.png");
});

test("a double-clicked field is added, and its legend entry hides it", async ({ page }) => {
  await openRun(page, "demo.mcap");
  await expandTopic(page, "/telemetry");
  await page.getByRole("button", { name: "counter int64" }).dblclick();
  const legend = page
    .getByRole("main")
    .getByRole("button", { name: "Toggle visibility for /telemetry counter" });
  await expect(legend).toHaveAttribute("aria-pressed", "true");
  await legend.click();
  await expect(legend).toHaveAttribute("aria-pressed", "false");
});

test("bool and enum fields are drawn on a state timeline", async ({ page }) => {
  await openRun(page, "demo.mcap");
  await changeWidget(page.getByRole("region", { name: "Plot" }), "State timeline");
  await expandTopic(page, "/telemetry");
  const widget = page.getByRole("region", { name: "State timeline" });
  await page.getByRole("button", { name: "active bool" }).dragTo(widget);
  await page.getByRole("button", { name: "mode hahn.Mode" }).dragTo(widget);
  await expect(widget.getByText("active")).toBeVisible();
  await expect(widget.getByText("mode")).toBeVisible();
  await expect(widget).toHaveScreenshot("state-timeline.png");
});
