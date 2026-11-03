/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", exclude: [...configDefaults.exclude, "test/visual/**", "e2e/**"] },
      },
      {
        extends: true,
        test: {
          name: "visual",
          include: ["test/visual/**/*.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            // Fixed so that times and number formats render the same everywhere.
            provider: playwright({ contextOptions: { timezoneId: "UTC", locale: "en-US" } }),
            instances: [{ browser: "chromium", viewport: { width: 1000, height: 700 } }],
          },
        },
      },
    ],
  },
});
