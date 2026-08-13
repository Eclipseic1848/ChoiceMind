import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: "http://127.0.0.1:3000"
  },
  webServer: {
    command: "pnpm dev",
    env: {
      CHOICEMIND_API_URL: "http://127.0.0.1:3199"
    },
    reuseExistingServer: false,
    timeout: 60_000,
    url: "http://127.0.0.1:3000/health/live"
  }
});
