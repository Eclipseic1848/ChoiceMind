import { expect, test } from "@playwright/test";

test("GET /health/live reports the Web process as healthy", async ({ request }) => {
  const response = await request.get("/health/live");

  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({
    service: "web",
    status: "healthy"
  });
});
