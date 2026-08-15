import { buildApiApp } from "./app.js";
import { createHttpDecisionOrchestratorAdapter } from "./decision-tasks/http-orchestrator-adapter.js";

const app = buildApiApp({
  decisionOrchestrator: createHttpDecisionOrchestratorAdapter({
    baseUrl: process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3200"
  }),
  healthUrls: {
    "data-worker": process.env.DATA_WORKER_HEALTH_URL ?? "http://127.0.0.1:3300/health/live",
    orchestrator: process.env.ORCHESTRATOR_HEALTH_URL ?? "http://127.0.0.1:3200/health/live",
    web: process.env.WEB_HEALTH_URL ?? "http://127.0.0.1:3000/health/live"
  }
});

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ host, port });
