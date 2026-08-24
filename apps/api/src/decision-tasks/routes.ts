import {
  createContractRejectedDecisionTaskResultV1,
  createDecisionTaskNotFoundResultV1,
  createIdempotencyConflictResultV1,
  createPersistenceUnavailableResultV1,
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  decodeDecisionTaskSnapshotV1,
  decodeExecuteDecisionTaskCommandV1,
  decodePersistedRunEventV1,
  getDecisionTaskResultHttpStatusV1,
  isPersistedRunEventCursorV1
} from "@choicemind/contracts/decision/v1";
import type { FastifyInstance } from "fastify";

import type { DecisionTaskEventNotificationsPort } from "./event-notifications-port.js";
import type { DecisionTaskPersistencePort } from "./persistence-port.js";

export function registerDecisionTaskRoutes(
  app: FastifyInstance,
  persistence: DecisionTaskPersistencePort | undefined,
  now: () => Date,
  eventNotifications: DecisionTaskEventNotificationsPort | undefined,
  eventPollIntervalMs: number
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

  app.get<{ Params: { decisionTaskId: string } }>(
    "/api/v1/decision-tasks/:decisionTaskId/events",
    async (request, reply) => {
      if (persistence === undefined) {
        return reply.code(503).send(
          createUnknownDecisionExecutionResultV1({
            errorId: "error-decision-task-persistence-unavailable",
            occurredAt: now().toISOString()
          })
        );
      }

      const decisionTaskId = request.params.decisionTaskId;
      const lastEventId = request.headers["last-event-id"];

      if (!isValidLastEventId(lastEventId)) {
        const result = createContractRejectedDecisionTaskResultV1({
          errorId: "error-decision-task-event-cursor-invalid",
          code: "CONTRACT_INVALID",
          issues: [
            {
              path: "Last-Event-ID",
              message: "Last-Event-ID 必须是 Postgres bigint 范围内的正十进制字符串"
            }
          ],
          occurredAt: now().toISOString()
        });

        return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
      }

      try {
        const task = await persistence.get(decisionTaskId);

        if (task === undefined) {
          return reply.code(404).send(
            createDecisionTaskNotFoundResultV1({
              errorId: "error-decision-task-not-found",
              occurredAt: now().toISOString()
            })
          );
        }

        let cursor = typeof lastEventId === "string" ? lastEventId : undefined;
        const initialEvents = await persistence.listEvents(decisionTaskId, cursor);
        let closed = false;
        reply.hijack();
        reply.raw.writeHead(200, {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8"
        });
        reply.raw.flushHeaders();
        reply.raw.on("close", () => {
          closed = true;
        });

        for (const event of initialEvents) {
          cursor = writePersistedEvent(reply.raw, decisionTaskId, event);
        }

        while (!closed) {
          await waitForNextEvent(
            reply.raw,
            decisionTaskId,
            eventNotifications,
            eventPollIntervalMs
          );

          if (closed) {
            break;
          }

          const events = await persistence.listEvents(decisionTaskId, cursor);

          if (events.length === 0) {
            reply.raw.write(": heartbeat\n\n");
          }

          for (const event of events) {
            cursor = writePersistedEvent(reply.raw, decisionTaskId, event);
          }
        }

        if (!reply.raw.destroyed) {
          reply.raw.end();
        }

        return reply;
      } catch (error) {
        if (reply.raw.headersSent) {
          reply.raw.end();
          return reply;
        }

        if (hasErrorCode(error, "PERSISTENCE_UNAVAILABLE")) {
          return reply.code(503).send(
            createPersistenceUnavailableResultV1({
              errorId: "error-decision-task-persistence-unavailable",
              occurredAt: now().toISOString()
            })
          );
        }

        return reply.code(503).send(
          createUnknownDecisionExecutionResultV1({
            errorId: "error-decision-task-persistence-unavailable",
            occurredAt: now().toISOString()
          })
        );
      }
    }
  );
}

async function waitForNextEvent(
  response: import("node:http").ServerResponse,
  decisionTaskId: string,
  eventNotifications: DecisionTaskEventNotificationsPort | undefined,
  pollIntervalMs: number
): Promise<void> {
  if (eventNotifications === undefined) {
    await waitForStreamPoll(response, pollIntervalMs);
    return;
  }

  const controller = new AbortController();

  try {
    await Promise.race([
      waitForStreamPoll(response, pollIntervalMs),
      eventNotifications
        .waitFor(decisionTaskId, controller.signal)
        .catch(() => waitForAbort(controller.signal))
    ]);
  } finally {
    controller.abort();
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function isValidLastEventId(value: string | string[] | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  return isPersistedRunEventCursorV1(value);
}

function writePersistedEvent(
  response: import("node:http").ServerResponse,
  decisionTaskId: string,
  input: unknown
): string {
  const decoded = decodePersistedRunEventV1(input);

  if (!decoded.ok || decoded.value.event.decisionTaskId !== decisionTaskId) {
    throw Object.assign(new Error("持久事件不符合任务合同"), {
      code: "PERSISTENCE_UNAVAILABLE"
    });
  }

  response.write(`id: ${decoded.value.cursor}\n`);
  response.write(`data: ${JSON.stringify(decoded.value)}\n\n`);
  return decoded.value.cursor;
}

async function waitForStreamPoll(
  response: import("node:http").ServerResponse,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, timeoutMs);

    function finish() {
      clearTimeout(timeout);
      response.off("close", finish);
      resolve();
    }

    response.once("close", finish);
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
