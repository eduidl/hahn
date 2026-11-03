import { defineConfig, devices } from "@playwright/test";

// Run through scripts/e2e.sh, which serves synthetic recordings and sets BASE_URL.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL,
    ...devices["Desktop Chrome"],
    viewport: { width: 1400, height: 900 },
    // Fixed so that times and number formats render the same everywhere.
    timezoneId: "UTC",
    locale: "en-US",
    trace: "on",
    screenshot: "on",
  },
});
