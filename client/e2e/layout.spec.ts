import type { Page } from "@playwright/test";
import { changeWidget, expect, openRun, test, widgetAction } from "./support";

const region = (page: Page, name: string) => page.getByRole("main").getByRole("region", { name });

/** Splits the initial plot and turns the new right half into a table. */
async function plotAndTable(page: Page) {
  await openRun(page, "demo.mcap");
  await widgetAction(region(page, "Plot"), "Split right");
  await expect(region(page, "Plot")).toHaveCount(2);
  await changeWidget(region(page, "Plot").last(), "Table");
  await expect(region(page, "Table")).toBeVisible();
}

test("widgets split, change type and are deleted", async ({ page }) => {
  await plotAndTable(page);
  const plot = (await region(page, "Plot").boundingBox())!;
  const table = (await region(page, "Table").boundingBox())!;
  expect(table.x).toBeGreaterThan(plot.x + plot.width / 2);
  await expect(page.getByRole("main")).toHaveScreenshot("plot-and-table.png");

  await widgetAction(region(page, "Table"), "Delete");
  await expect(region(page, "Table")).toHaveCount(0);
  await expect(region(page, "Plot")).toHaveCount(1);
});

test("a maximized widget hides the others until restored", async ({ page }) => {
  await plotAndTable(page);
  await region(page, "Plot").getByRole("button", { name: "Maximize Plot" }).click();
  await expect(region(page, "Table")).toBeHidden();
  await region(page, "Plot")
    .getByRole("button", { name: /Restore/ })
    .click();
  await expect(region(page, "Table")).toBeVisible();
});

test("a widget dragged by its title moves to the other side", async ({ page }) => {
  await plotAndTable(page);
  const table = region(page, "Table");
  const target = (await table.boundingBox())!;
  await region(page, "Plot")
    .getByTitle("Plot", { exact: true })
    .dragTo(table, { targetPosition: { x: target.width - 20, y: target.height / 2 } });
  await expect
    .poll(async () => (await region(page, "Plot").boundingBox())!.x)
    .toBeGreaterThan((await table.boundingBox())!.x);
});

test("tabs hold their own widgets", async ({ page }) => {
  await openRun(page, "demo.mcap");
  await changeWidget(region(page, "Plot"), "Tabs");
  const tabs = region(page, "Tabs");
  await tabs.getByRole("button", { name: "Add tab", exact: true }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await tabs.getByRole("tabpanel").getByRole("button", { name: "Add Table" }).click();
  await expect(region(page, "Table")).toBeVisible();
  await tabs.getByRole("tab").first().click();
  await expect(region(page, "Table")).toBeHidden();
  await expect(tabs.getByRole("group", { name: "Widgets to add" })).toBeVisible();
});

test("the layout and run come back after a reload", async ({ page }) => {
  await plotAndTable(page);
  // The session is saved shortly after each change.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole("button", { name: "Select run: demo.mcap" })).toBeVisible();
  await expect(page.getByRole("option", { name: "demo.mcap" })).toBeHidden();
  await expect(region(page, "Plot")).toBeVisible();
  await expect(region(page, "Table")).toBeVisible();
});

test("the sidebar resizes from the keyboard and hides", async ({ page }) => {
  await openRun(page, "demo.mcap");
  const sidebar = page.getByRole("complementary");
  const before = (await sidebar.boundingBox())!.width;
  await page.getByRole("separator", { name: "Resize sidebar" }).press("ArrowRight");
  await page.getByRole("separator", { name: "Resize sidebar" }).press("ArrowRight");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(before + 40);

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar).toBeVisible();
});
