import Fastify from "fastify";

type DependencyService = "web" | "orchestrator" | "data-worker";

type ComponentHealth = {
  service: DependencyService;
  status: "healthy" | "unhealthy";
  latencyMs: number;
  error?: string;
};

type ApiAppOptions = {
  healthUrls?: Record<DependencyService, string>;
  now?: () => Date;
  probe?: (service: DependencyService) => Promise<ComponentHealth>;
};

const dependencyServices: DependencyService[] = ["web", "orchestrator", "data-worker"];

async function probeHealth(service: DependencyService, url: string): Promise<ComponentHealth> {
  const startedAt = performance.now();

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as { service?: string; status?: string };
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

    if (response.ok && body.service === service && body.status === "healthy") {
      return { service, status: "healthy", latencyMs };
    }

    return { service, status: "unhealthy", latencyMs, error: "invalid_health_response" };
  } catch {
    return {
      service,
      status: "unhealthy",
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      error: "probe_failed"
    };
  }
}

export function buildApiApp(options: ApiAppOptions = {}) {
  const app = Fastify({ logger: false });

  app.get("/health/live", async () => ({
    service: "api",
    status: "healthy"
  }));

  app.get("/api/v1/system/health", async (_request, reply) => {
    const healthUrls = options.healthUrls;
    const probe = options.probe ??
      (healthUrls === undefined
        ? undefined
        : async (service: DependencyService) => probeHealth(service, healthUrls[service]));

    if (probe === undefined) {
      return reply.code(503).send({
        checkedAt: (options.now ?? (() => new Date()))().toISOString(),
        components: [{ service: "api", status: "healthy", latencyMs: 0 }],
        status: "unhealthy"
      });
    }

    const dependencies = await Promise.all(
      dependencyServices.map(async (service) => probe(service))
    );
    const components = [
      dependencies[0],
      { service: "api" as const, status: "healthy" as const, latencyMs: 0 },
      ...dependencies.slice(1)
    ];
    const status = components.every((component) => component?.status === "healthy")
      ? "healthy"
      : "unhealthy";

    return reply.code(status === "healthy" ? 200 : 503).send({
      checkedAt: (options.now ?? (() => new Date()))().toISOString(),
      components,
      status
    });
  });

  return app;
}
