import type {
  DecisionTaskResultV1,
  ExecuteDecisionTaskCommandV1,
  FailedDecisionTaskResultV1
} from "@choicemind/contracts/decision/v1";
import { finalizeSuccessfulDecisionTaskResultV1 } from "@choicemind/contracts/decision/v1";

import type { AgentRuntimeRunPort } from "../runtime/port.js";

type DecisionTaskExecutorOptions = Readonly<{
  runtime: AgentRuntimeRunPort;
}>;

export interface DecisionTaskExecutor {
  execute(command: ExecuteDecisionTaskCommandV1): Promise<DecisionTaskResultV1>;
}

export function createDecisionTaskExecutor(
  options: DecisionTaskExecutorOptions
): DecisionTaskExecutor {
  const receipts = new Map<
    string,
    Readonly<{ fingerprint: string; result: Promise<DecisionTaskResultV1> }>
  >();

  return {
    execute(command) {
      const fingerprint = canonicalize(command);
      const receipt = receipts.get(command.executionRequestId);

      if (receipt?.fingerprint === fingerprint) {
        return receipt.result;
      }

      if (receipt !== undefined) {
        return Promise.resolve({
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
        });
      }

      const result = executeOnce(command);
      receipts.set(command.executionRequestId, { fingerprint, result });
      return result;
    }
  };

  async function executeOnce(
    command: ExecuteDecisionTaskCommandV1
  ): Promise<DecisionTaskResultV1> {
    const agentRunId = `agent-run-${command.executionRequestId}`;
    const decisionTaskId = command.requirementRevision.decisionTaskId;

    try {
      const runtimeOutput: unknown = await options.runtime.run({
        contractVersion: "1.0",
        decisionTaskId,
        agentRunId,
        requirementRevision: command.requirementRevision
      });

      if (
        !isRecord(runtimeOutput) ||
        !Array.isArray(runtimeOutput.runEvents) ||
        !Array.isArray(runtimeOutput.candidates) ||
        !Array.isArray(runtimeOutput.claims) ||
        !Array.isArray(runtimeOutput.evidence) ||
        !Array.isArray(runtimeOutput.claimEvidenceLinks) ||
        !isRecord(runtimeOutput.decision)
      ) {
        return createRuntimeFailedResult(decisionTaskId, agentRunId);
      }

      const completedEvent = runtimeOutput.runEvents[runtimeOutput.runEvents.length - 1];

      if (!isRecord(completedEvent)) {
        return createRuntimeFailedResult(decisionTaskId, agentRunId);
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
        ? decoded.value
        : createRuntimeFailedResult(decisionTaskId, agentRunId);
    } catch {
      return createRuntimeFailedResult(decisionTaskId, agentRunId);
    }
  }
}

function createRuntimeFailedResult(
  decisionTaskId: string,
  agentRunId: string
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
      retryMode: "NEW_EXECUTION_ALLOWED",
      issues: [],
      occurredAt: failedAt
    }
  };
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
