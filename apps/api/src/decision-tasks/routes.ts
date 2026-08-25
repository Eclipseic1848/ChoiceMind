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
  decodeRuntimeResumeRequestV1,
  decodeRuntimeCancelRequestV1,
  getDecisionTaskResultHttpStatusV1,
  isPersistedRunEventCursorV1
} from "@choicemind/contracts/decision/v1";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AuditLogPort, AuditRecord } from "../security/audit.js";
import type { DecisionTaskEventNotificationsPort } from "./event-notifications-port.js";
import type { DecisionTaskPersistencePort } from "./persistence-port.js";
import type { DecisionTaskRuntimeControlPort } from "./runtime-control-port.js";
import type { IdentityResolver } from "../security/identity.js";

export function registerDecisionTaskRoutes(
  app: FastifyInstance,
  persistence: DecisionTaskPersistencePort | undefined,
  now: () => Date,
  eventNotifications: DecisionTaskEventNotificationsPort | undefined,
  eventPollIntervalMs: number,
  identityResolver: IdentityResolver | undefined,
  auditLog: AuditLogPort | undefined,
  runtimeControl: DecisionTaskRuntimeControlPort | undefined
) {
  app.post("/api/v1/decision-tasks:execute", async (request, reply) => {
    const principal = await identityResolver?.resolve(request.headers.authorization);

    if (principal === undefined) {
      return sendAuthenticationRequired(reply, now);
    }

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
      decodedSnapshot = decodeDecisionTaskSnapshotV1(
        await persistence.submit(decoded.value, principal.userId)
      );
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

    await appendDecisionTaskAudit(auditLog, {
      actor: principal,
      action: "DECISION_TASK_SUBMIT",
      decisionTaskId: decodedSnapshot.value.decisionTaskId,
      result: "ALLOWED",
      correlationId: getCorrelationId(request.headers["x-correlation-id"], request.id)
    });
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

      const principal = await identityResolver?.resolve(request.headers.authorization);

      if (principal === undefined) {
        return sendAuthenticationRequired(reply, now);
      }

      try {
        const persistedTask = await persistence.get(request.params.decisionTaskId, principal.userId);

        if (persistedTask === undefined) {
          await appendDecisionTaskAudit(auditLog, {
            actor: principal,
            action: "DECISION_TASK_READ",
            decisionTaskId: request.params.decisionTaskId,
            result: "NOT_FOUND",
            correlationId: getCorrelationId(request.headers["x-correlation-id"], request.id)
          });
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

          await appendDecisionTaskAudit(auditLog, {
            actor: principal,
            action: "DECISION_TASK_READ",
            decisionTaskId: request.params.decisionTaskId,
            result: "ALLOWED",
            correlationId: getCorrelationId(request.headers["x-correlation-id"], request.id)
          });
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

        await appendDecisionTaskAudit(auditLog, {
          actor: principal,
          action: "DECISION_TASK_READ",
          decisionTaskId: request.params.decisionTaskId,
          result: "ALLOWED",
          correlationId: getCorrelationId(request.headers["x-correlation-id"], request.id)
        });
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
      const principal = await identityResolver?.resolve(request.headers.authorization);

      if (principal === undefined) {
        return sendAuthenticationRequired(reply, now);
      }

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
        const task = await persistence.get(decisionTaskId, principal.userId);

        if (task === undefined) {
          await appendDecisionTaskAudit(auditLog, {
            actor: principal,
            action: "DECISION_TASK_EVENTS_READ",
            decisionTaskId,
            result: "NOT_FOUND",
            correlationId: getCorrelationId(request.headers["x-correlation-id"], request.id)
          });
          return reply.code(404).send(
            createDecisionTaskNotFoundResultV1({
              errorId: "error-decision-task-not-found",
              occurredAt: now().toISOString()
            })
          );
        }

        let cursor = typeof lastEventId === "string" ? lastEventId : undefined;
        const initialEvents = await persistence.listEvents(decisionTaskId, principal.userId, cursor);
        await appendDecisionTaskAudit(auditLog, {
          actor: principal,
          action: "DECISION_TASK_EVENTS_READ",
          decisionTaskId,
          result: "ALLOWED",
          correlationId: getCorrelationId(request.headers["x-correlation-id"], request.id)
        });
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

          const events = await persistence.listEvents(decisionTaskId, principal.userId, cursor);

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

  app.post<{ Params: { decisionTaskId: string } }>(
    "/api/v1/decision-tasks/:decisionTaskId/resume",
    async (request, reply) => {
      const principal = await identityResolver?.resolve(request.headers.authorization);
      if (principal === undefined) {
        return sendAuthenticationRequired(reply, now);
      }
      if (runtimeControl === undefined) {
        return reply.code(503).send({
          ok: false,
          error: {
            code: "PERSISTENCE_UNAVAILABLE",
            category: "STORAGE",
            retryMode: "SAME_EXECUTION_ONLY",
            occurredAt: now().toISOString()
          }
        });
      }
      const decoded = decodeRuntimeResumeRequestV1(request.body);
      if (!decoded.ok) {
        return sendRuntimeControlContractRejected(reply, decoded, now);
      }
      const correlationId = getCorrelationId(request.headers["x-correlation-id"], request.id);
      let status: Awaited<ReturnType<DecisionTaskRuntimeControlPort["requestResume"]>>;
      try {
        status = await runtimeControl.requestResume({
          actor: principal,
          controlRequestId: decoded.value.controlRequestId,
          decisionTaskId: request.params.decisionTaskId,
          runtimeSnapshotId: decoded.value.runtimeSnapshotId,
          correlationId,
          egressConfirmation: {
            operationId: decoded.value.controlRequestId,
            userId: principal.userId
          }
        });
      } catch (error) {
        return sendRuntimeControlError(reply, error, now);
      }
      if (status === undefined) {
        return reply.code(404).send(
          createDecisionTaskNotFoundResultV1({
            errorId: "error-decision-task-not-found",
            occurredAt: now().toISOString()
          })
        );
      }
      await appendDecisionTaskAudit(auditLog, {
        actor: principal,
        action: "DECISION_TASK_RESUME",
        decisionTaskId: request.params.decisionTaskId,
        result: "ALLOWED",
        correlationId
      });
      return reply.code(202).send(status);
    }
  );

  app.post<{ Params: { decisionTaskId: string } }>(
    "/api/v1/decision-tasks/:decisionTaskId/cancel",
    async (request, reply) => {
      const principal = await identityResolver?.resolve(request.headers.authorization);
      if (principal === undefined) return sendAuthenticationRequired(reply, now);
      if (runtimeControl === undefined) {
        return sendRuntimeControlError(
          reply,
          Object.assign(new Error("Runtime Control 不可用"), { code: "PERSISTENCE_UNAVAILABLE" }),
          now
        );
      }
      const decoded = decodeRuntimeCancelRequestV1(request.body);
      if (!decoded.ok) return sendRuntimeControlContractRejected(reply, decoded, now);
      const correlationId = getCorrelationId(request.headers["x-correlation-id"], request.id);
      let status: Awaited<ReturnType<DecisionTaskRuntimeControlPort["requestCancel"]>>;
      try {
        status = await runtimeControl.requestCancel({
          actor: principal,
          controlRequestId: decoded.value.controlRequestId,
          decisionTaskId: request.params.decisionTaskId,
          cancellationId: decoded.value.cancellationId,
          correlationId
        });
      } catch (error) {
        return sendRuntimeControlError(reply, error, now);
      }
      if (status === undefined) {
        return reply.code(404).send(
          createDecisionTaskNotFoundResultV1({
            errorId: "error-decision-task-not-found",
            occurredAt: now().toISOString()
          })
        );
      }
      await appendDecisionTaskAudit(auditLog, {
        actor: principal,
        action: "DECISION_TASK_CANCEL",
        decisionTaskId: request.params.decisionTaskId,
        result: "ALLOWED",
        correlationId
      });
      return reply.code(200).send(status);
    }
  );
}

function sendRuntimeControlContractRejected(
  reply: FastifyReply,
  decoded: Readonly<{
    code: "CONTRACT_INVALID" | "CONTRACT_VERSION_UNSUPPORTED";
    issues: readonly Readonly<{ path: string; message: string }>[];
  }>,
  now: () => Date
) {
  const result = createContractRejectedDecisionTaskResultV1({
    errorId: "error-runtime-control-contract-rejected",
    code: decoded.code,
    issues: decoded.issues,
    occurredAt: now().toISOString()
  });
  return reply.code(getDecisionTaskResultHttpStatusV1(result)).send(result);
}

function sendRuntimeControlError(reply: FastifyReply, error: unknown, now: () => Date) {
  if (hasErrorCode(error, "PERSISTENCE_UNAVAILABLE")) {
    return reply.code(503).send(
      createPersistenceUnavailableResultV1({
        errorId: "error-runtime-control-persistence-unavailable",
        occurredAt: now().toISOString()
      })
    );
  }
  return reply.code(409).send({
    ok: false,
    error: {
      code: hasErrorCode(error, "RUNTIME_RESUME_DENIED")
        ? "RUNTIME_RESUME_DENIED"
        : hasErrorCode(error, "RUNTIME_CANCEL_RACE")
          ? "RUNTIME_CANCEL_RACE"
          : "RUNTIME_CONTROL_REJECTED",
      category: "RUNTIME",
      retryMode: "NONE",
      occurredAt: now().toISOString()
    }
  });
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

function getCorrelationId(value: string | string[] | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

async function appendDecisionTaskAudit(
  auditLog: AuditLogPort | undefined,
  input: Readonly<{
    actor: AuditRecord["actor"];
    action: AuditRecord["action"];
    decisionTaskId: string;
    result: AuditRecord["result"];
    correlationId: string;
  }>
): Promise<void> {
  await auditLog?.append({
    actor: input.actor,
    action: input.action,
    object: { id: input.decisionTaskId, type: "DECISION_TASK" },
    result: input.result,
    correlationId: input.correlationId
  });
}

function sendAuthenticationRequired(
  reply: import("fastify").FastifyReply,
  now: () => Date
) {
  return reply.code(401).send({
    ok: false,
    error: {
      code: "AUTHENTICATION_REQUIRED",
      category: "AUTHORIZATION",
      retryMode: "NONE",
      occurredAt: now().toISOString()
    }
  });
}
