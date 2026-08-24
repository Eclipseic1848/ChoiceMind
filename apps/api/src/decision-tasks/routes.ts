import {
  createContractRejectedDecisionTaskResultV1,
  createDecisionTaskNotFoundResultV1,
  createIdempotencyConflictResultV1,
  createPersistenceUnavailableResultV1,
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  decodeDecisionTaskSnapshotV1,
  decodeExecuteDecisionTaskCommandV1,
  getDecisionTaskResultHttpStatusV1
} from "@choicemind/contracts/decision/v1";
import type { FastifyInstance } from "fastify";

import type { DecisionTaskPersistencePort } from "./persistence-port.js";

export function registerDecisionTaskRoutes(
  app: FastifyInstance,
  persistence: DecisionTaskPersistencePort | undefined,
  now: () => Date
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

    if (persistence === undefined) {
      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-decision-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    let decodedSnapshot: ReturnType<typeof decodeDecisionTaskSnapshotV1>;

    try {
      decodedSnapshot = decodeDecisionTaskSnapshotV1(await persistence.submit(decoded.value));
    } catch (error) {
      if (hasErrorCode(error, "IDEMPOTENCY_CONFLICT")) {
        return reply.code(409).send(
          createIdempotencyConflictResultV1({
            errorId: "error-decision-task-idempotency-conflict",
            occurredAt: now().toISOString()
          })
        );
      }

      if (hasErrorCode(error, "PERSISTENCE_UNAVAILABLE")) {
        return reply.code(503).send(
          createPersistenceUnavailableResultV1({
            errorId: "error-decision-task-persistence-unavailable",
            occurredAt: now().toISOString()
          })
        );
      }

      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-decision-execution-status-unknown",
        occurredAt: now().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    if (!decodedSnapshot.ok) {
      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-decision-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
    }

    return reply.code(202).send(decodedSnapshot.value);
  });

  app.get<{ Params: { decisionTaskId: string } }>(
    "/api/v1/decision-tasks/:decisionTaskId",
    async (request, reply) => {
      if (persistence === undefined) {
        return reply
          .code(503)
          .send(
            createUnknownDecisionExecutionResultV1({
              errorId: "error-decision-task-persistence-unavailable",
              occurredAt: new Date().toISOString()
            })
          );
      }

      try {
        const persistedTask = await persistence.get(request.params.decisionTaskId);

        if (persistedTask === undefined) {
          return reply.code(404).send(
            createDecisionTaskNotFoundResultV1({
              errorId: "error-decision-task-not-found",
              occurredAt: now().toISOString()
            })
          );
        }

        if (persistedTask.contractType === "decision-task-result") {
          const decodedResult = decodeDecisionTaskResultV1(persistedTask);

          if (
            !decodedResult.ok ||
            !("taskStatus" in decodedResult.value) ||
            decodedResult.value.taskStatus.decisionTaskId !==
              request.params.decisionTaskId
          ) {
            return reply.code(503).send(
              createUnknownDecisionExecutionResultV1({
                errorId: "error-decision-task-persistence-invalid",
                occurredAt: new Date().toISOString()
              })
            );
          }

          return reply.code(200).send(decodedResult.value);
        }

        const decodedSnapshot = decodeDecisionTaskSnapshotV1(persistedTask);

        if (
          !decodedSnapshot.ok ||
          decodedSnapshot.value.decisionTaskId !== request.params.decisionTaskId
        ) {
          return reply
            .code(503)
            .send(
              createUnknownDecisionExecutionResultV1({
                errorId: "error-decision-task-persistence-invalid",
                occurredAt: new Date().toISOString()
              })
            );
        }

        return reply.code(200).send(decodedSnapshot.value);
      } catch (error) {
        if (hasErrorCode(error, "PERSISTENCE_UNAVAILABLE")) {
          return reply.code(503).send(
            createPersistenceUnavailableResultV1({
              errorId: "error-decision-task-persistence-unavailable",
              occurredAt: now().toISOString()
            })
          );
        }

        return reply
          .code(503)
          .send(
            createUnknownDecisionExecutionResultV1({
              errorId: "error-decision-task-persistence-unavailable",
              occurredAt: now().toISOString()
            })
          );
      }
    }
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
