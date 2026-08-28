import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000"
  },
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 3000",
    env: {
      CHOICEMIND_API_URL: "http://127.0.0.1:3199",
      CHOICEMIND_API_AUTHORIZATION: "Bearer web-test-token"
    },
    reuseExistingServer: false,
    timeout: 60_000,
    url: "http://127.0.0.1:3000/health/live"
  }
});
