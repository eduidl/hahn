import type { Page } from "@playwright/test";
import { changeWidget, expect, openRun, test } from "./support";

/** Turns the initial plot into the given widget and drops topics on it. */
async function show(page: Page, type: string, topics: string[]) {
  await openRun(page, "visual.mcap");
  await changeWidget(page.getByRole("main").getByRole("region", { name: "Plot" }), type);
  const widget = page.getByRole("main").getByRole("region", { name: type });
  for (const topic of topics)
    await page
      .getByRole("tabpanel", { name: "Topics" })
      .getByText(topic, { exact: true })
      .dragTo(widget);
  return widget;
}

const errors = (page: Page) => page.getByRole("tab", { name: /^Errors/ });

test("an image shows, and a point cloud without calibration is explained", async ({ page }) => {
  const widget = await show(page, "Image", ["/camera"]);
  await expect(widget.getByRole("img", { name: "/camera" })).toBeVisible();
  await expect(widget.getByText("2025-10-09 08:53:20.123 (UTC)")).toBeVisible();
  await expect(errors(page)).toHaveText("Errors");
  await expect(widget).toHaveScreenshot("image.png");

  // The synthetic recording has no camera calibration to project the cloud with.
  await page
    .getByRole("tabpanel", { name: "Topics" })
    .getByText("/lidar", { exact: true })
    .dragTo(widget);
  await errors(page).click();
  await expect(page.getByRole("tabpanel", { name: /^Errors/ })).toContainText("calibration");
});

test("the 3D view starts with a point cloud", async ({ page }) => {
  const widget = await show(page, "3D", ["/lidar"]);
  await expect(widget.locator("canvas")).toBeVisible();
  await expect(widget.getByText("Could not start 3D view")).toHaveCount(0);
  await expect(errors(page)).toHaveText("Errors");
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: "Toggle visibility for /lidar" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Frame" })).toHaveValue("lidar");
});

test("the map draws the location track", async ({ page }) => {
  const widget = await show(page, "Map", ["/gps"]);
  const paths = widget.locator(".leaflet-overlay-pane path");
  await expect(paths).toHaveCount(2);
  await page.getByRole("button", { name: "Go to end" }).click();
  await expect(paths).toHaveCount(3);
  await expect(errors(page)).toHaveText("Errors");
  await expect(widget).toHaveScreenshot("map.png");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("spinbutton", { name: /Trail duration for/ }).fill("0");
  await expect(paths).toHaveCount(2);
  await page.getByRole("spinbutton", { name: /Trail duration for/ }).fill("");
  await expect(paths).toHaveCount(3);
  await page.getByRole("button", { name: "Go to start" }).click();
  await expect(paths).toHaveCount(2);
});

test("the TF tree shows frames and the selected one's pose", async ({ page }) => {
  const widget = await show(page, "TF tree", []);
  const tree = widget.getByRole("img", { name: "Transform tree" });
  await expect(tree.getByRole("button")).toHaveCount(3);
  await tree.getByRole("button", { name: "base_link, parent map" }).click();
  await expect(widget.getByText("Parent Frame: map")).toBeVisible();
  await expect(widget).toHaveScreenshot("tf-tree.png");
});
