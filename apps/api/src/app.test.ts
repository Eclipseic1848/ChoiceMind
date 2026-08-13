import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApiApp } from "./app.js";

const openApps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("GET /health/live", () => {
  it("reports the API process as healthy", async () => {
    const app = buildApiApp();
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "api",
      status: "healthy"
    });
  });
});

describe("GET /api/v1/system/health", () => {
  it("reports all four processes when every health probe succeeds", async () => {
    const probeResults = {
      web: { service: "web" as const, status: "healthy" as const, latencyMs: 12 },
      orchestrator: {
        service: "orchestrator" as const,
        status: "healthy" as const,
        latencyMs: 8
      },
      "data-worker": {
        service: "data-worker" as const,
        status: "healthy" as const,
        latencyMs: 5
      }
    };
    const app = buildApiApp({
      now: () => new Date("2026-08-12T20:30:00.000Z"),
      probe: async (service) => probeResults[service]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      checkedAt: "2026-08-12T20:30:00.000Z",
      components: [
        { service: "web", status: "healthy", latencyMs: 12 },
        { service: "api", status: "healthy", latencyMs: 0 },
        { service: "orchestrator", status: "healthy", latencyMs: 8 },
        { service: "data-worker", status: "healthy", latencyMs: 5 }
      ],
      status: "healthy"
    });
  });

  it("probes the configured health URLs instead of returning static data", async () => {
    const web = await listenToHealthApp("web");
    const orchestrator = await listenToHealthApp("orchestrator");
    const dataWorker = await listenToHealthApp("data-worker");
    openApps.push(web.app, orchestrator.app, dataWorker.app);

    const app = buildApiApp({
      healthUrls: {
        web: `${web.url}/health/live`,
        orchestrator: `${orchestrator.url}/health/live`,
        "data-worker": `${dataWorker.url}/health/live`
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().components).toEqual([
      expect.objectContaining({ service: "web", status: "healthy" }),
      { service: "api", status: "healthy", latencyMs: 0 },
      expect.objectContaining({ service: "orchestrator", status: "healthy" }),
      expect.objectContaining({ service: "data-worker", status: "healthy" })
    ]);
  });

  it("returns 503 and identifies a dependency that cannot be reached", async () => {
    const probeResults = {
      web: { service: "web" as const, status: "healthy" as const, latencyMs: 10 },
      orchestrator: {
        service: "orchestrator" as const,
        status: "unhealthy" as const,
        latencyMs: 1,
        error: "connection_refused"
      },
      "data-worker": {
        service: "data-worker" as const,
        status: "healthy" as const,
        latencyMs: 4
      }
    };
    const app = buildApiApp({
      now: () => new Date("2026-08-12T20:31:00.000Z"),
      probe: async (service) => probeResults[service]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      checkedAt: "2026-08-12T20:31:00.000Z",
      components: [
        { service: "web", status: "healthy", latencyMs: 10 },
        { service: "api", status: "healthy", latencyMs: 0 },
        {
          service: "orchestrator",
          status: "unhealthy",
          latencyMs: 1,
          error: "connection_refused"
        },
        { service: "data-worker", status: "healthy", latencyMs: 4 }
      ],
      status: "unhealthy"
    });
  });
});

async function listenToHealthApp(service: "web" | "orchestrator" | "data-worker") {
  const app = buildTestHealthApp(service);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });

  return { app, url };
}

function buildTestHealthApp(service: "web" | "orchestrator" | "data-worker") {
  const app = Fastify({ logger: false });

  app.get("/health/live", async () => ({ service, status: "healthy" }));

  return app;
}
