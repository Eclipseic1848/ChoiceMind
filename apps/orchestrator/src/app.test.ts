import { afterEach, describe, expect, it } from "vitest";

import { buildOrchestratorApp } from "./app.js";

const openApps: Array<ReturnType<typeof buildOrchestratorApp>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("GET /health/live", () => {
  it("reports the Orchestrator process as healthy", async () => {
    const app = buildOrchestratorApp();
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "orchestrator",
      status: "healthy"
    });
  });
});
