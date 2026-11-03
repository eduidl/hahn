import type { Page } from "@playwright/test";
import { changeWidget, expect, openRun, test } from "./support";

const offset = (page: Page) =>
  page.getByRole("region", { name: "Playback" }).getByText(/ \/ 21\.990 s$/);
const control = (page: Page, name: string) =>
  page.getByRole("region", { name: "Playback" }).getByRole("button", { name, exact: true });
const seconds = async (page: Page) => Number((await offset(page).textContent())!.split(" / ")[0]);

/** A Raw message widget showing the whole /telemetry message. */
async function rawTelemetry(page: Page) {
  await openRun(page, "demo.mcap");
  await changeWidget(page.getByRole("region", { name: "Plot" }), "Raw message");
  const raw = page.getByRole("region", { name: "Raw message" });
  await page
    .getByRole("tabpanel", { name: "Topics" })
    .getByText("/telemetry", { exact: true })
    .dragTo(raw);
  return raw;
}

test("the raw message follows the step and jump buttons", async ({ page }) => {
  const raw = await rawTelemetry(page);
  await expect(raw.getByText("2025-10-09 08:53:20.123 (UTC)")).toBeVisible();
  await expect(raw.getByText("9007199254740993")).toBeVisible();

  await control(page, "Forward").click();
  await expect(offset(page)).toHaveText("0.100 / 21.990 s");
  await expect(raw.getByText("2025-10-09 08:53:20.223 (UTC)")).toBeVisible();
  await expect(raw.getByText("9007199254741003")).toBeVisible();

  await control(page, "Go to end").click();
  await expect(offset(page)).toHaveText("21.990 / 21.990 s");
  await control(page, "Back").click();
  await expect(offset(page)).toHaveText("21.890 / 21.990 s");
  await control(page, "Go to start").click();
  await expect(offset(page)).toHaveText("0.000 / 21.990 s");
  await expect(raw).toHaveScreenshot("raw-message.png");
});

test("the position bar seeks by click and by keyboard", async ({ page }) => {
  await rawTelemetry(page);
  const slider = page.getByRole("slider", { name: "Playback position" });
  const box = (await slider.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await seconds(page)).toBeGreaterThan(9);
  expect(await seconds(page)).toBeLessThan(13);

  await slider.press("End");
  await expect(offset(page)).toHaveText("21.990 / 21.990 s");
  await slider.press("Home");
  await expect(offset(page)).toHaveText("0.000 / 21.990 s");
});

test("play advances time until paused", async ({ page }) => {
  await rawTelemetry(page);
  await control(page, "Play").click();
  await expect.poll(() => seconds(page)).toBeGreaterThan(0.5);
  await control(page, "Pause").click();
  const paused = await seconds(page);
  await page.waitForTimeout(300);
  expect(await seconds(page)).toBe(paused);
});

test("a faster speed advances time faster", async ({ page }) => {
  await rawTelemetry(page);
  await page.getByRole("combobox", { name: "Playback speed" }).selectOption("10×");
  await control(page, "Play").click();
  await expect.poll(() => seconds(page), { timeout: 3000 }).toBeGreaterThan(5);
});
