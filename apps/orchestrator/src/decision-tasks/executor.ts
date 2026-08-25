import type {
  DecisionTaskResultV1,
  ExecuteDecisionTaskCommandV1,
  FailedDecisionTaskResultV1
} from "@choicemind/contracts/decision/v1";
import { finalizeSuccessfulDecisionTaskResultV1 } from "@choicemind/contracts/decision/v1";

import type {
  AgentRuntimeRunPort,
  AgentRuntimeSecurityContext
} from "../runtime/port.js";

type DecisionTaskExecutorOptions = Readonly<{
  runtime: AgentRuntimeRunPort;
}>;

type DecisionTaskExecutionContext = Readonly<{
  agentRunId: string;
  userId?: string;
  operationId?: string;
  correlationId?: string;
  egressConfirmation?: Readonly<{ operationId: string; userId: string }>;
}>;

export interface DecisionTaskExecutor {
  execute(
    command: ExecuteDecisionTaskCommandV1,
    context?: DecisionTaskExecutionContext
  ): Promise<DecisionTaskResultV1>;
}

export interface PersistentDecisionTaskExecutor extends DecisionTaskExecutor {
  executePersistent(
    command: ExecuteDecisionTaskCommandV1,
    context: DecisionTaskExecutionContext
  ): Promise<DecisionTaskExecutionOutcome>;
}

export type DecisionTaskExecutionOutcome =
  | Extract<DecisionTaskResultV1, Readonly<{ taskStatus: unknown }>>
  | Readonly<{
      state: "FAILED_RETRYABLE" | "FAILED_FINAL" | "PARTIAL";
      summary: string;
    }>;

type DecisionTaskExecutionAttempt = Readonly<{
  result: DecisionTaskResultV1;
  persistentOutcome: DecisionTaskExecutionOutcome;
}>;

export function createDecisionTaskExecutor(
  options: DecisionTaskExecutorOptions
): PersistentDecisionTaskExecutor {
  const receipts = new Map<
    string,
    Readonly<{
      fingerprint: string;
      attempt?: Promise<DecisionTaskExecutionAttempt>;
    }>
  >();

  return {
    execute(command, context) {
      return executeAttempt(command, context, false).then(
        (attempt) => attempt.result
      );
    },
    executePersistent(command, context) {
      return executeAttempt(command, context, true).then(
        (attempt) => attempt.persistentOutcome
      );
    }
  };

  function executeAttempt(
    command: ExecuteDecisionTaskCommandV1,
    context: DecisionTaskExecutionContext | undefined,
    forPersistence: boolean
  ): Promise<DecisionTaskExecutionAttempt> {
      const fingerprint = canonicalize(command);
      const receipt = receipts.get(command.executionRequestId);

      if (receipt?.fingerprint === fingerprint && receipt.attempt !== undefined) {
        return receipt.attempt;
      }

      if (receipt !== undefined && receipt.fingerprint !== fingerprint) {
        const result: DecisionTaskResultV1 = {
          contractType: "decision-task-result",
          contractVersion: "1.0",
          ok: false,
          error: {
            contractType: "choice-mind-error",
            contractVersion: "1.0",
            errorId: "error-execution-request-conflict",
            code: "CONTRACT_INVALID",
            category: "VALIDATION",
            message: "执行标识与原命令不一致",
            retryMode: "NONE",
            issues: [
              {
                path: "executionRequestId",
                message: "同一执行标识不能绑定不同命令"
              }
            ],
            occurredAt: "2026-08-12T12:00:00.000Z"
          }
        };

        return Promise.resolve({
          result,
          persistentOutcome: {
            state: "FAILED_FINAL",
            summary: "执行标识与原命令不一致"
          }
        });
      }

      const attempt = executeOnce(command, context, forPersistence);
      const activeReceipt = { fingerprint, attempt };
      receipts.set(command.executionRequestId, activeReceipt);
      void attempt.then((completedAttempt) => {
        if (
          isRetryableOutcome(completedAttempt.persistentOutcome) &&
          receipts.get(command.executionRequestId) === activeReceipt
        ) {
          receipts.set(command.executionRequestId, { fingerprint });
        }
      });
      return attempt;
  }

  async function executeOnce(
    command: ExecuteDecisionTaskCommandV1,
    context: DecisionTaskExecutionContext | undefined,
    forPersistence: boolean
  ): Promise<DecisionTaskExecutionAttempt> {
    const agentRunId = context?.agentRunId ?? `agent-run-${command.executionRequestId}`;
    const decisionTaskId = command.requirementRevision.decisionTaskId;

    try {
      const runtimeCommand = {
        contractVersion: "1.0",
        decisionTaskId,
        agentRunId,
        requirementRevision: command.requirementRevision
      } as const;
      const securityContext = toRuntimeSecurityContext(context);
      const runtimeOutput: unknown = await (forPersistence && options.runtime.runPersistent
        ? options.runtime.runPersistent(runtimeCommand, securityContext)
        : options.runtime.run(runtimeCommand, securityContext));

      if (isExplicitRuntimeOutcome(runtimeOutput)) {
        return {
          result: createRuntimeFailedResult(
            decisionTaskId,
            agentRunId,
            runtimeOutput.state === "FAILED_RETRYABLE"
              ? "SAME_EXECUTION_ONLY"
              : "NEW_EXECUTION_ALLOWED"
          ),
          persistentOutcome: runtimeOutput
        };
      }

      if (
        !isRecord(runtimeOutput) ||
        !Array.isArray(runtimeOutput.runEvents) ||
        !Array.isArray(runtimeOutput.candidates) ||
        !Array.isArray(runtimeOutput.claims) ||
        !Array.isArray(runtimeOutput.evidence) ||
        !Array.isArray(runtimeOutput.claimEvidenceLinks) ||
        !isRecord(runtimeOutput.decision)
      ) {
        return createFailedExecutionAttempt(decisionTaskId, agentRunId);
      }

      const completedEvent = runtimeOutput.runEvents[runtimeOutput.runEvents.length - 1];

      if (!isRecord(completedEvent)) {
        return createFailedExecutionAttempt(decisionTaskId, agentRunId);
      }

      const result = {
        contractType: "decision-task-result",
        contractVersion: "1.0",
        ok: true,
        taskStatus: {
          contractType: "decision-task-status",
          contractVersion: "1.0",
          decisionTaskId,
          agentRunId,
          state: "COMPLETED",
          terminal: true,
          latestEventSequence: completedEvent.sequence,
          decisionRevisionId: runtimeOutput.decision.decisionRevisionId,
          updatedAt: completedEvent.occurredAt
        },
        runEvents: runtimeOutput.runEvents,
        bundle: {
          requirementRevision: command.requirementRevision,
          candidates: runtimeOutput.candidates,
          claims: runtimeOutput.claims,
          evidence: runtimeOutput.evidence,
          claimEvidenceLinks: runtimeOutput.claimEvidenceLinks,
          decision: runtimeOutput.decision
        }
      };
      const decoded = finalizeSuccessfulDecisionTaskResultV1(result);

      return decoded.ok
        ? { result: decoded.value, persistentOutcome: decoded.value }
        : createFailedExecutionAttempt(decisionTaskId, agentRunId);
    } catch {
      return createFailedExecutionAttempt(decisionTaskId, agentRunId);
    }
  }
}

function toRuntimeSecurityContext(
  context: DecisionTaskExecutionContext | undefined
): AgentRuntimeSecurityContext | undefined {
  if (
    context?.userId === undefined ||
    context.operationId === undefined ||
    context.correlationId === undefined ||
    context.egressConfirmation === undefined
  ) {
    return undefined;
  }

  return {
    userId: context.userId,
    operationId: context.operationId,
    correlationId: context.correlationId,
    egressConfirmation: context.egressConfirmation
  };
}

function isRetryableOutcome(outcome: DecisionTaskExecutionOutcome): boolean {
  return "state" in outcome && outcome.state === "FAILED_RETRYABLE";
}

function createFailedExecutionAttempt(
  decisionTaskId: string,
  agentRunId: string
): DecisionTaskExecutionAttempt {
  const result = createRuntimeFailedResult(decisionTaskId, agentRunId);

  return {
    result,
    persistentOutcome: {
      state: "FAILED_FINAL",
      summary: "Agent Runtime 未形成合法 Decision"
    }
  };
}

function createRuntimeFailedResult(
  decisionTaskId: string,
  agentRunId: string,
  retryMode: "SAME_EXECUTION_ONLY" | "NEW_EXECUTION_ALLOWED" = "NEW_EXECUTION_ALLOWED"
): FailedDecisionTaskResultV1 {
  const errorId = "error-synth-runtime-failure";
  const failedAt = "2026-08-12T12:00:01.000Z";

  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    taskStatus: {
      contractType: "decision-task-status",
      contractVersion: "1.0",
      decisionTaskId,
      agentRunId,
      state: "FAILED",
      terminal: true,
      latestEventSequence: 2,
      errorId,
      updatedAt: failedAt
    },
    runEvents: [
      {
        contractType: "run-event",
        contractVersion: "1.0",
        eventId: "event-synth-runtime-failure-1",
        decisionTaskId,
        agentRunId,
        sequence: 1,
        occurredAt: "2026-08-12T12:00:00.000Z",
        eventType: "TASK_STATE_CHANGED",
        taskState: "CREATED",
        summary: "已创建合成决策任务",
        synthetic: true
      },
      {
        contractType: "run-event",
        contractVersion: "1.0",
        eventId: "event-synth-runtime-failure-2",
        decisionTaskId,
        agentRunId,
        sequence: 2,
        occurredAt: failedAt,
        eventType: "RUNTIME_FAILED",
        taskState: "FAILED",
        summary: "合成 Runtime 执行失败",
        synthetic: true
      }
    ],
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId,
      code: "AGENT_RUNTIME_FAILED",
      category: "RUNTIME",
      message: "决策任务失败",
      retryMode,
      issues: [],
      occurredAt: failedAt
    }
  };
}

function isExplicitRuntimeOutcome(value: unknown): value is Exclude<
  DecisionTaskExecutionOutcome,
  DecisionTaskResultV1
> {
  return (
    isRecord(value) &&
    (value.state === "FAILED_RETRYABLE" ||
      value.state === "FAILED_FINAL" ||
      value.state === "PARTIAL") &&
    typeof value.summary === "string" &&
    value.summary.trim().length > 0
  );
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCanonicalKeys(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

// 幂等指纹的键排序使用固定码元比较,不依赖运行环境 Locale
function compareCanonicalKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
