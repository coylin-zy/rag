import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "output/playwright/test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5176",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm dev:worker",
      url: "http://127.0.0.1:8787/healthz",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "pnpm exec vite --host 127.0.0.1 --port 5176",
      url: "http://127.0.0.1:5176/healthz",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: "desktop-chromium",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-375",
      use: {
        browserName: "chromium",
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
