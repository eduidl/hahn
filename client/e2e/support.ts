import { expect, test as base, type Locator, type Page } from "@playwright/test";

/** A page with no network outside the app, so map tiles and the like cannot vary. */
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    await page.route(
      (url) => !url.href.startsWith(baseURL!),
      (route) => route.abort(),
    );
    await use(page);
  },
});
export { expect };

/** Opens a synthetic recording from the run dialog shown on first load. */
export async function openRun(page: Page, name: "demo.mcap" | "visual.mcap" | "scene.mcap") {
  await page.goto("/");
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("button", { name: `Select run: ${name}` })).toBeVisible();
  await page.getByRole("tab", { name: "Topics" }).click();
}

/** Expands a topic in the sidebar so that its fields are listed. */
export async function expandTopic(page: Page, topic: string) {
  await page.getByRole("tabpanel", { name: "Topics" }).getByText(topic, { exact: true }).click();
}

/** Chooses an action from a widget's menu, e.g. "Split right" or "Delete". */
export async function widgetAction(widget: Locator, action: string) {
  await widget
    .getByRole("button", { name: / menu$/ })
    .first()
    .click();
  await widget.getByRole("menuitem", { name: action }).first().click();
}

/** Changes a widget's type from its menu. */
export async function changeWidget(widget: Locator, type: string) {
  await widgetAction(widget, "Change widget");
  await widget.getByRole("menuitemradio", { name: new RegExp(`^${type} `) }).click();
}
