import { describe, expect, it } from "vitest";

import {
  decodeCheckpointRefV1,
  decodeEffectReceiptV1,
  decodeRuntimeRecoveryPermissionV1,
  decodeRuntimePausedOutcomeV1,
  decodeRuntimeSnapshotV1,
  decodeDecisionTaskSnapshotV1,
  decodeRuntimeResumeRequestV1,
  decodeRuntimeCancelRequestV1,
  decodeRuntimeControlStatusV1,
  evaluateRuntimeRecoveryPermissionV1
} from "./index.js";

describe("Runtime 恢复合同 v1", () => {
  it("严格解析版本化 resume、cancel 与控制状态合同", () => {
    expect(
      decodeRuntimeResumeRequestV1({
        contractType: "runtime-resume-request",
        contractVersion: "1.0",
        controlRequestId: "control-resume-1",
        runtimeSnapshotId: "snapshot-1"
      })
    ).toMatchObject({ ok: true });
    expect(
      decodeRuntimeCancelRequestV1({
        contractType: "runtime-cancel-request",
        contractVersion: "1.0",
        controlRequestId: "control-cancel-1",
        cancellationId: "cancel-1"
      })
    ).toMatchObject({ ok: true });
    expect(
      decodeRuntimeControlStatusV1({
        contractType: "runtime-control-status",
        contractVersion: "1.0",
        controlRequestId: "control-resume-1",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        action: "RESUME",
        state: "ACCEPTED",
        updatedAt: "2026-08-24T12:00:00.000Z"
      })
    ).toMatchObject({ ok: true });
    expect(
      decodeRuntimeControlStatusV1({
        contractType: "runtime-control-status",
        contractVersion: "1.0",
        controlRequestId: "control-failed-1",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        action: "RESUME",
        state: "FAILED",
        error: { code: "RUNTIME_SNAPSHOT_INVALID", message: "快照不合法" },
        updatedAt: "2026-08-24T12:00:00.000Z"
      })
    ).toMatchObject({ ok: true });
    expect(
      decodeRuntimeResumeRequestV1({
        contractType: "runtime-resume-request",
        contractVersion: "2.0",
        controlRequestId: "control-resume-1",
        runtimeSnapshotId: "snapshot-1"
      })
    ).toMatchObject({ ok: false, code: "CONTRACT_VERSION_UNSUPPORTED" });
    expect(
      decodeRuntimeCancelRequestV1({
        contractType: "runtime-cancel-request",
        contractVersion: "1.0",
        controlRequestId: "control-cancel-1",
        cancellationId: "cancel-1",
        userId: "不得由客户端提供"
      })
    ).toMatchObject({ ok: false, code: "CONTRACT_INVALID" });
  });

  it("接受带内容寻址原始快照和持久 Checkpoint 引用的权威快照", () => {
    const snapshot = buildRuntimeSnapshot();

    expect(decodeRuntimeSnapshotV1(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it("独立校验 Checkpoint 引用但不把它当作恢复许可", () => {
    const checkpoint = buildRuntimeSnapshot().checkpoint;

    expect(decodeCheckpointRefV1(checkpoint)).toEqual({ ok: true, value: checkpoint });
    expect(checkpoint).not.toHaveProperty("resumable");
  });

  it("拒绝未知 Runtime Protocol 版本", () => {
    expect(
      decodeRuntimeSnapshotV1(
        buildRuntimeSnapshot({
          runtimeProtocol: { name: "agent-runtime-protocol", version: "2" }
        })
      )
    ).toEqual({
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [
        {
          path: "runtimeProtocol.version",
          message: "Runtime Protocol 版本不受支持"
        }
      ]
    });
  });

  it("拒绝不能证明内容寻址完整性的原始快照引用", () => {
    expect(
      decodeRuntimeSnapshotV1(
        buildRuntimeSnapshot({
          rawSnapshot: {
            algorithm: "sha256",
            digest: "not-a-sha256",
            objectKey: "runtime-snapshots/sha256/not-a-sha256"
          }
        })
      )
    ).toMatchObject({
      ok: false,
      code: "CONTRACT_INVALID",
      issues: [{ path: "rawSnapshot.digest" }]
    });
  });

  it.each(["not_started", "started", "committed", "unknown"] as const)(
    "接受 %s Effect Receipt 权威状态",
    (state) => {
      const receipt = buildEffectReceipt(state);

      expect(decodeEffectReceiptV1(receipt)).toEqual({ ok: true, value: receipt });
    }
  );

  it("只允许暂停、可恢复且副作用安全的运行原位恢复", () => {
    const permission = evaluateRuntimeRecoveryPermissionV1({
        snapshot: buildRuntimeSnapshot(),
        effectReceipts: [buildEffectReceipt("not_started"), buildEffectReceipt("committed")]
      });

    expect(permission).toMatchObject({
      contractType: "runtime-recovery-permission",
      contractVersion: "1.0",
      decision: "RESUME_ALLOWED",
      reason: "SAFE_TO_RESUME"
    });
    expect(decodeRuntimeRecoveryPermissionV1(permission)).toEqual({
      ok: true,
      value: permission
    });
  });

  it.each(["started", "unknown"] as const)(
    "%s 副作用必须进入人工核验而不是自动重放",
    (state) => {
      expect(
        evaluateRuntimeRecoveryPermissionV1({
          snapshot: buildRuntimeSnapshot(),
          effectReceipts: [buildEffectReceipt(state)]
        })
      ).toMatchObject({
        decision: "MANUAL_VERIFICATION_REQUIRED",
        reason: "EFFECT_STATUS_UNSAFE"
      });
    }
  );

  it("终态即使快照声称 resumable 也不得原位恢复", () => {
    expect(
      evaluateRuntimeRecoveryPermissionV1({
        snapshot: buildRuntimeSnapshot({ taskState: "FAILED" }),
        effectReceipts: []
      })
    ).toMatchObject({
      decision: "RESUME_DENIED",
      reason: "TASK_NOT_PAUSED"
    });
  });

  it("暂停 Outcome 和持久任务 Snapshot 保留 Runtime 快照关联且不伪装为失败", () => {
    const snapshot = buildRuntimeSnapshot();
    const outcome = {
      contractType: "runtime-paused-outcome",
      contractVersion: "1.0",
      state: "PAUSED_PERMISSION",
      summary: "等待外部操作授权",
      snapshot,
      effectReceipts: [buildEffectReceipt("started")],
      runEvents: [
        {
          contractType: "run-event",
          contractVersion: "1.0",
          eventId: "event-paused-1",
          decisionTaskId: "task-1",
          agentRunId: "run-1",
          sequence: 1,
          occurredAt: "2026-08-24T12:00:00.000Z",
          eventType: "TASK_STATE_CHANGED",
          taskState: "PAUSED_PERMISSION",
          summary: "等待外部操作授权",
          synthetic: true
        }
      ]
    };

    expect(decodeRuntimePausedOutcomeV1(outcome)).toEqual({ ok: true, value: outcome });
    expect(
      decodeDecisionTaskSnapshotV1({
        contractType: "decision-task-snapshot",
        contractVersion: "1.0",
        executionRequestId: "execution-1",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        state: "PAUSED_PERMISSION",
        terminal: false,
        runtimeSnapshotId: "snapshot-run-1-3",
        updatedAt: "2026-08-24T12:00:00.000Z"
      })
    ).toMatchObject({
      ok: true,
      value: {
        state: "PAUSED_PERMISSION",
        terminal: false,
        runtimeSnapshotId: "snapshot-run-1-3"
      }
    });
  });

  it("暂停 Outcome 不能绕过嵌套 Snapshot 的 Checkpoint 归属校验", () => {
    const snapshot = buildRuntimeSnapshot();
    const invalidSnapshot = {
      ...snapshot,
      checkpoint: {
        ...(snapshot.checkpoint as Record<string, unknown>),
        agentRunId: "run-other"
      }
    };

    expect(
      decodeRuntimePausedOutcomeV1({
        contractType: "runtime-paused-outcome",
        contractVersion: "1.0",
        state: "PAUSED_PERMISSION",
        summary: "等待外部操作授权",
        snapshot: invalidSnapshot,
        effectReceipts: [buildEffectReceipt("not_started")],
        runEvents: [
          {
            contractType: "run-event",
            contractVersion: "1.0",
            eventId: "event-paused-invalid",
            decisionTaskId: "task-1",
            agentRunId: "run-1",
            sequence: 1,
            occurredAt: "2026-08-24T12:00:00.000Z",
            eventType: "TASK_STATE_CHANGED",
            taskState: "PAUSED_PERMISSION",
            summary: "等待外部操作授权",
            synthetic: true
          }
        ]
      })
    ).toMatchObject({
      ok: false,
      code: "CONTRACT_INVALID",
      issues: [{ path: "snapshot.checkpoint" }]
    });
  });
});

function buildRuntimeSnapshot(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    contractType: "runtime-snapshot",
    contractVersion: "1.0",
    snapshotId: "snapshot-run-1-3",
    decisionTaskId: "task-1",
    agentRunId: "run-1",
    taskState: "PAUSED_PERMISSION",
    resumable: true,
    runtimeProtocol: {
      name: "agent-runtime-protocol",
      version: "1"
    },
    rawSnapshot: {
      algorithm: "sha256",
      digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      objectKey:
        "runtime-snapshots/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    checkpoint: {
      contractType: "checkpoint-ref",
      contractVersion: "1.0",
      checkpointId: "checkpoint-run-1-3",
      decisionTaskId: "task-1",
      agentRunId: "run-1",
      sequence: 3,
      persistedAt: "2026-08-24T12:00:00.000Z"
    },
    capturedAt: "2026-08-24T12:00:00.000Z",
    ...overrides
  };
}

function buildEffectReceipt(state: "not_started" | "started" | "committed" | "unknown") {
  return {
    contractType: "effect-receipt",
    contractVersion: "1.0",
    effectReceiptId: `receipt-${state}`,
    decisionTaskId: "task-1",
    agentRunId: "run-1",
    checkpointId: "checkpoint-run-1-3",
    effectId: `provider-call-${state}`,
    state,
    recordedAt: "2026-08-24T12:00:00.000Z"
  };
}
