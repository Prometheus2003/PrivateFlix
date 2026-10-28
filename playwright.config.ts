import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  // Development endpoints compile on demand; wait within their UI deadlines.
  expect: {
    timeout: process.env.PRIVATEFLIX_E2E_MODE === "development" ? 20000 : 5000,
  },
  use: { baseURL: "http://127.0.0.1:3319", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
