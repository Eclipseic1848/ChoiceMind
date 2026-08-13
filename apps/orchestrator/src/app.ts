import Fastify from "fastify";

export function buildOrchestratorApp() {
  const app = Fastify({ logger: false });

  app.get("/health/live", async () => ({
    service: "orchestrator",
    status: "healthy"
  }));

  return app;
}
