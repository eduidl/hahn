import { changeWidget, expect, openRun, test } from "./support";

test("3D batches small views while keeping the scene visible", async ({ page }) => {
  await openRun(page, "scene.mcap");
  await changeWidget(page.getByRole("main").getByRole("region", { name: "Plot" }), "3D");
  const widget = page.getByRole("main").getByRole("region", { name: "3D" });
  for (const topic of ["/pose", "/objects"])
    await page
      .getByRole("tabpanel", { name: "Topics" })
      .getByText(topic, { exact: true })
      .dragTo(widget);
  await expect(widget.locator("canvas")).toBeVisible();
  const batch = page.waitForResponse(
    (response) => response.url().endsWith("/views/batch") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Go to end" }).click();
  const response = await batch;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().views).toHaveLength(2);
  await expect(page.getByRole("tab", { name: /^Errors/ })).toHaveText("Errors");
  await expect(widget.locator("canvas")).toBeVisible();
});
