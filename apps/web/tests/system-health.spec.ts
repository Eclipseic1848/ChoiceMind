import { createServer, type Server } from "node:http";

import { expect, test } from "@playwright/test";

let apiServer: Server;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  apiServer = createServer((request, response) => {
    if (request.url !== "/api/v1/system/health") {
      response.writeHead(404).end();
      return;
    }

    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        checkedAt: "2026-08-12T20:40:00.000Z",
        components: [
          { service: "web", status: "healthy", latencyMs: 3 },
          { service: "api", status: "healthy", latencyMs: 0 },
          { service: "orchestrator", status: "healthy", latencyMs: 6 },
          { service: "data-worker", status: "healthy", latencyMs: 9 }
        ],
        status: "healthy"
      })
    );
  });

  await new Promise<void>((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(3199, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await closeApiServer();
});

test("shows the four process states returned by the API", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "系统健康" })).toBeVisible();
  await expect(page.getByText("全部正常")).toBeVisible();
  await expect(page.getByText("Web", { exact: true })).toBeVisible();
  await expect(page.getByText("API", { exact: true })).toBeVisible();
  await expect(page.getByText("Orchestrator", { exact: true })).toBeVisible();
  await expect(page.getByText("Data Worker", { exact: true })).toBeVisible();
});

test("shows an explicit failure when the API cannot be reached", async ({ page }) => {
  await closeApiServer();

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "系统健康" })).toBeVisible();
  await expect(page.getByText("健康状态不可用")).toBeVisible();
});

async function closeApiServer() {
  if (!apiServer.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    apiServer.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
