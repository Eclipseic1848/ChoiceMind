import Fastify from "fastify";
import {
  createContractRejectedDecisionTaskResultV1,
  getDecisionTaskResultHttpStatusV1
} from "@choicemind/contracts/decision/v1";

import type { DecisionTaskExecutor } from "./decision-tasks/executor.js";
import { registerDecisionTaskRoutes } from "./decision-tasks/routes.js";

type OrchestratorAppOptions = Readonly<{
  decisionTaskExecutor?: DecisionTaskExecutor;
}>;

export function buildOrchestratorApp(options: OrchestratorAppOptions = {}) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
        error.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
        error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ||
        error.code === "FST_ERR_CTP_BODY_TOO_LARGE")
    ) {
      const result = createContractRejectedDecisionTaskResultV1({
        errorId: "error-orchestrator-json-invalid",
        code: "CONTRACT_INVALID",
        issues: [{ path: "", message: "请求正文必须是有效 JSON" }],
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    return reply.send(error);
  });

  app.get("/health/live", async () => ({
    service: "orchestrator",
    status: "healthy"
  }));

  if (options.decisionTaskExecutor !== undefined) {
    registerDecisionTaskRoutes(app, options.decisionTaskExecutor);
  }

  return app;
}
