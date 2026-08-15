import {
  createContractRejectedDecisionTaskResultV1,
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  decodeExecuteDecisionTaskCommandV1,
  getDecisionTaskResultHttpStatusV1,
} from "@choicemind/contracts/decision/v1";
import type { FastifyInstance } from "fastify";

import type { DecisionTaskExecutor } from "./executor.js";

export function registerDecisionTaskRoutes(
  app: FastifyInstance,
  executor: DecisionTaskExecutor
) {
  app.post("/internal/v1/decision-tasks:execute", async (request, reply) => {
    const decoded = decodeExecuteDecisionTaskCommandV1(request.body);

    if (!decoded.ok) {
      const versionError = decoded.code === "CONTRACT_VERSION_UNSUPPORTED";
      const result = createContractRejectedDecisionTaskResultV1({
        errorId: versionError ? "error-contract-version" : "error-contract-invalid",
        code: decoded.code,
        issues: decoded.issues,
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    let decodedResult: ReturnType<typeof decodeDecisionTaskResultV1>;

    try {
      decodedResult = decodeDecisionTaskResultV1(await executor.execute(decoded.value));
    } catch {
      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-orchestrator-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    if (!decodedResult.ok) {
      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-orchestrator-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    const result = decodedResult.value;
    return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
  });
}
