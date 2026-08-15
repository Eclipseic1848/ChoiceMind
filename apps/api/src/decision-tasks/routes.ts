import {
  createContractRejectedDecisionTaskResultV1,
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  decodeExecuteDecisionTaskCommandV1,
  getDecisionTaskResultHttpStatusV1
} from "@choicemind/contracts/decision/v1";
import type { FastifyInstance } from "fastify";

import type { DecisionOrchestratorPort } from "./orchestrator-port.js";

export function registerDecisionTaskRoutes(
  app: FastifyInstance,
  orchestrator: DecisionOrchestratorPort | undefined
) {
  app.post("/api/v1/decision-tasks:execute", async (request, reply) => {
    const decoded = decodeExecuteDecisionTaskCommandV1(request.body);

    if (!decoded.ok) {
      const versionError = decoded.code === "CONTRACT_VERSION_UNSUPPORTED";
      const result = createContractRejectedDecisionTaskResultV1({
        errorId: versionError ? "error-api-contract-version" : "error-api-contract-invalid",
        code: decoded.code,
        issues: decoded.issues,
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    if (orchestrator === undefined) {
      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-decision-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    let decodedResult: ReturnType<typeof decodeDecisionTaskResultV1>;

    try {
      decodedResult = decodeDecisionTaskResultV1(await orchestrator.execute(decoded.value));
    } catch {
      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-decision-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    if (!decodedResult.ok) {
      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-decision-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    const result = decodedResult.value;
    return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
  });
}
