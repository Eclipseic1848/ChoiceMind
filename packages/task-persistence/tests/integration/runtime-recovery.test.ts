import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import type {
  EffectReceiptV1,
  RuntimeSnapshotV1
} from "@choicemind/contracts/decision/v1";
import { decodeEffectReceiptV1 } from "@choicemind/contracts/decision/v1";

import {
  openRuntimeRecoveryStore,
  openPersistentDecisionTaskModule,
  type PersistentDecisionTaskModule,
  type RuntimeRecoveryStore
} from "../../src/index.js";
import { resetPersistentDecisionTaskTestData } from "./support.js";

const openStores: Array<RuntimeRecoveryStore | PersistentDecisionTaskModule> = [];

beforeEach(async () => {
  await resetPersistentDecisionTaskTestData(requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"));
});

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

describe("RuntimeRecoveryStore", () => {
  it("跨进程实例保留内容寻址原始快照及 Snapshot/Receipt/Checkpoint 关联", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const first = await openRuntimeRecoveryStore({ databaseUrl });
    openStores.push(first);
    const rawSnapshot = {
      schemaVersion: 1,
      runId: "coremind-run-1",
      operation: { state: "paused", transitionSequence: 3 },
      resumable: true
    };
    const rawSnapshotRef = await first.putRawSnapshot(rawSnapshot);
    const snapshot = buildRuntimeSnapshot(rawSnapshotRef);
    const receipts = [buildEffectReceipt()];

    await first.saveRecoveryFacts(snapshot, receipts);
    await first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const reopened = await openRuntimeRecoveryStore({ databaseUrl });
    openStores.push(reopened);

    await expect(reopened.loadRawSnapshot(rawSnapshotRef)).resolves.toEqual(rawSnapshot);
    await expect(reopened.loadRecoveryFacts(snapshot.snapshotId)).resolves.toEqual({
      snapshot,
      effectReceipts: receipts
    });
    expect(rawSnapshotRef).toMatchObject({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      objectKey: expect.stringMatching(/^runtime-snapshots\/sha256\/[0-9a-f]{64}$/)
    });
  });

  it("相同原始快照写入幂等且返回同一内容地址", async () => {
    const store = await openRuntimeRecoveryStore({
      databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL")
    });
    openStores.push(store);
    const rawSnapshot = { schemaVersion: 1, runId: "coremind-run-idempotent" };

    const first = await store.putRawSnapshot(rawSnapshot);
    const repeated = await store.putRawSnapshot({ runId: "coremind-run-idempotent", schemaVersion: 1 });

    expect(repeated).toEqual(first);
  });

  it("跨进程实例保留绑定权威身份的内容寻址副作用结果", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const first = await openRuntimeRecoveryStore({ databaseUrl });
    openStores.push(first);
    const result = { accepted: true, source: "synthetic-effect" };

    const reference = await first.putEffectResult(
      {
        decisionTaskId: "task-effect-result-1",
        agentRunId: "run-effect-result-1",
        checkpointId: "checkpoint-effect-result-1",
        effectId: "effect-result-1"
      },
      result
    );
    await first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const reopened = await openRuntimeRecoveryStore({ databaseUrl });
    openStores.push(reopened);

    await expect(reopened.loadEffectResult(reference)).resolves.toEqual(result);
    expect(reference).toMatchObject({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      objectKey: expect.stringMatching(/^effect-results\/sha256\/[0-9a-f]{64}$/),
      decisionTaskId: "task-effect-result-1",
      agentRunId: "run-effect-result-1",
      checkpointId: "checkpoint-effect-result-1",
      effectId: "effect-result-1"
    });
  });

  it("跨 Store 实例保持 resume/cancel 原子幂等状态", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    let currentTime = new Date("2026-08-24T12:00:00.000Z");
    const now = () => currentTime;
    const first = await openRuntimeRecoveryStore({ databaseUrl, now });
    openStores.push(first);
    const reference = await first.putRawSnapshot({
      schemaVersion: 1,
      runId: "coremind-run-control"
    });
    const snapshot = buildRuntimeSnapshot(reference);
    const safeReceipt = await buildCommittedEffectReceipt(first, buildEffectReceipt());
    expect(decodeEffectReceiptV1(safeReceipt)).toEqual({ ok: true, value: safeReceipt });
    await first.recordRuntimeRunning(snapshot.agentRunId, "controller-initial", 10_000);
    await first.saveRecoveryFacts(snapshot, [safeReceipt]);
    await first.completeRuntimeControl(
      snapshot.agentRunId,
      "controller-initial",
      snapshot.snapshotId,
      snapshot.snapshotId,
      "PAUSED_PERMISSION",
      []
    );
    await first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const resumedStore = await openRuntimeRecoveryStore({ databaseUrl, now });
    openStores.push(resumedStore);
    await expect(
      resumedStore.claimRuntimeResume(
        snapshot.agentRunId,
        snapshot.snapshotId,
        "controller-resume-a",
        10_000
      )
    ).resolves.toMatchObject({ status: "ACQUIRED", state: "RUNNING" });
    await resumedStore.close();
    openStores.splice(openStores.indexOf(resumedStore), 1);

    const afterRestart = await openRuntimeRecoveryStore({ databaseUrl, now });
    openStores.push(afterRestart);
    await expect(
      afterRestart.claimRuntimeResume(
        snapshot.agentRunId,
        snapshot.snapshotId,
        "controller-resume-b",
        10_000
      )
    ).resolves.toMatchObject({ status: "BUSY", state: "RUNNING" });
    currentTime = new Date("2026-08-24T12:00:11.000Z");
    await expect(
      afterRestart.claimRuntimeResume(
        snapshot.agentRunId,
        snapshot.snapshotId,
        "controller-resume-b",
        10_000
      )
    ).resolves.toMatchObject({ status: "ACQUIRED", state: "RUNNING" });
    await expect(
      afterRestart.completeRuntimeControl(
        snapshot.agentRunId,
        "controller-resume-a",
        snapshot.snapshotId,
        snapshot.snapshotId,
        "COMPLETED",
        []
      )
    ).rejects.toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
    const resumedPauseReference = await afterRestart.putRawSnapshot({
      schemaVersion: 1,
      runId: "coremind-run-control-repaused"
    });
    const resumedPauseSnapshot = buildRuntimeSnapshot(resumedPauseReference);
    const resumedPauseReceipt = {
      ...safeReceipt,
      effectReceiptId: "receipt-resumed-pause"
    };
    await afterRestart.saveRecoveryFacts(resumedPauseSnapshot, [resumedPauseReceipt]);
    await afterRestart.completeRuntimeControl(
      snapshot.agentRunId,
      "controller-resume-b",
      snapshot.snapshotId,
      resumedPauseSnapshot.snapshotId,
      "PAUSED_PERMISSION",
      []
    );
    await expect(
      afterRestart.claimRuntimeResume(
        snapshot.agentRunId,
        resumedPauseSnapshot.snapshotId,
        "controller-resume-c",
        10_000
      )
    ).resolves.toMatchObject({ status: "ACQUIRED", state: "RUNNING" });
    await afterRestart.completeRuntimeControl(
      snapshot.agentRunId,
      "controller-resume-c",
      resumedPauseSnapshot.snapshotId,
      resumedPauseSnapshot.snapshotId,
      "COMPLETED",
      []
    );
    await expect(
      afterRestart.claimRuntimeCancel(snapshot.agentRunId, "cancel-after-complete", [])
    ).resolves.toMatchObject({ status: "DENIED", state: "COMPLETED" });
  });

  it("故障注入篡改原始快照后按 SHA-256 失败关闭", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const store = await openRuntimeRecoveryStore({ databaseUrl });
    openStores.push(store);
    const reference = await store.putRawSnapshot({
      schemaVersion: 1,
      runId: "coremind-run-before-corruption"
    });
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(
        `UPDATE runtime_snapshot_objects
         SET snapshot_payload = '{"schemaVersion":1,"runId":"tampered"}'::jsonb
         WHERE digest = $1`,
        [reference.digest]
      );
    } finally {
      await client.end();
    }

    await expect(store.loadRawSnapshot(reference)).rejects.toMatchObject({
      code: "PERSISTENCE_UNAVAILABLE"
    });
  });

  it("故障注入篡改副作用结果后报告结构化完整性错误", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const store = await openRuntimeRecoveryStore({ databaseUrl });
    openStores.push(store);
    const reference = await store.putEffectResult(
      {
        decisionTaskId: "task-effect-corrupt",
        agentRunId: "run-effect-corrupt",
        checkpointId: "checkpoint-effect-corrupt",
        effectId: "effect-corrupt"
      },
      { accepted: true }
    );
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(
        `UPDATE runtime_effect_result_objects
         SET result_payload = '{"accepted":false}'::jsonb
         WHERE digest = $1`,
        [reference.digest]
      );
    } finally {
      await client.end();
    }

    await expect(store.loadEffectResult(reference)).rejects.toMatchObject({
      code: "EFFECT_RESULT_INVALID"
    });
  });

  it("持久任务把 Runtime 暂停保存为 PAUSED 而不是失败或完成", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const module = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-24T12:00:00.000Z")
    });
    const store = await openRuntimeRecoveryStore({ databaseUrl });
    openStores.push(module, store);
    const command = buildCommand();
    const accepted = await module.submit(command, "owner-1");
    const operationId = await readOperationId(databaseUrl, accepted.agentRunId);
    const claim = await module.claimNext(operationId, "worker-1", 30_000);
    if (claim.status !== "CLAIMED") {
      throw new Error("测试任务必须被 Worker 领取");
    }
    const rawSnapshot = {
      schemaVersion: 1,
      runId: "coremind-run-pause",
      operation: { state: "paused", transitionSequence: 3 },
      resumable: true
    };
    const rawSnapshotRef = await store.putRawSnapshot(rawSnapshot);
    const snapshot = {
      ...buildRuntimeSnapshot(rawSnapshotRef),
      agentRunId: claim.agentRunId,
      checkpoint: {
        ...buildRuntimeSnapshot(rawSnapshotRef).checkpoint,
        agentRunId: claim.agentRunId
      }
    };
    const receiptBase = {
      ...buildEffectReceipt(),
      agentRunId: claim.agentRunId
    };
    const receipt = await buildCommittedEffectReceipt(store, receiptBase);
    expect(decodeEffectReceiptV1(receipt)).toEqual({ ok: true, value: receipt });
    await store.saveRecoveryFacts(snapshot, [receipt]);

    const completion = await module.complete(operationId, "worker-1", {
      contractType: "runtime-paused-outcome",
      contractVersion: "1.0",
      state: "PAUSED_PERMISSION",
      summary: "等待必要权限",
      snapshot,
      effectReceipts: [receipt],
      runEvents: [
        {
          contractType: "run-event",
          contractVersion: "1.0",
          eventId: "event-runtime-paused",
          decisionTaskId: "task-1",
          agentRunId: claim.agentRunId,
          sequence: 1,
          occurredAt: "2026-08-24T12:00:00.000Z",
          eventType: "TASK_STATE_CHANGED",
          taskState: "PAUSED_PERMISSION",
          summary: "等待必要权限",
          synthetic: true
        }
      ]
    });

    expect(completion).toMatchObject({
      status: "COMMITTED",
      snapshot: {
        state: "PAUSED_PERMISSION",
        terminal: false,
        runtimeSnapshotId: snapshot.snapshotId
      }
    });
    await module.close();
    openStores.splice(openStores.indexOf(module), 1);
    let recoveryTime = new Date("2026-08-24T12:01:00.000Z");
    const reopened = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => recoveryTime
    });
    openStores.push(reopened);
    await expect(reopened.get("task-1", "owner-1")).resolves.toMatchObject({
      state: "PAUSED_PERMISSION",
      terminal: false,
      runtimeSnapshotId: snapshot.snapshotId
    });
    const events = await reopened.listEvents("task-1", "owner-1");
    expect(events.at(-1)?.event).toMatchObject({ taskState: "PAUSED_PERMISSION" });
    expect(events.map((event) => event.event.taskState)).not.toContain("COMPLETED");
    expect(events.map((event) => event.event.taskState)).not.toContain("FAILED");

    await expect(
      reopened.requestRuntimeResume({
        controlRequestId: "control-resume-persisted-1",
        decisionTaskId: "task-1",
        ownerUserId: "owner-1",
        runtimeSnapshotId: snapshot.snapshotId,
        correlationId: "correlation-resume-persisted-1",
        egressConfirmation: {
          operationId: "control-resume-persisted-1",
          userId: "owner-1"
        }
      })
    ).resolves.toEqual({
      contractType: "runtime-control-status",
      contractVersion: "1.0",
      controlRequestId: "control-resume-persisted-1",
      decisionTaskId: "task-1",
      agentRunId: claim.agentRunId,
      action: "RESUME",
      state: "ACCEPTED",
      updatedAt: "2026-08-24T12:01:00.000Z"
    });
    await expect(
      reopened.requestRuntimeResume({
        controlRequestId: "control-resume-persisted-1",
        decisionTaskId: "task-1",
        ownerUserId: "owner-1",
        runtimeSnapshotId: snapshot.snapshotId,
        correlationId: "correlation-resume-persisted-1",
        egressConfirmation: {
          operationId: "control-resume-persisted-1",
          userId: "owner-1"
        }
      })
    ).resolves.toMatchObject({
      controlRequestId: "control-resume-persisted-1",
      state: "ACCEPTED"
    });
    await expect(
      reopened.requestRuntimeResume({
        controlRequestId: "control-resume-hidden",
        decisionTaskId: "task-1",
        ownerUserId: "owner-2",
        runtimeSnapshotId: snapshot.snapshotId,
        correlationId: "correlation-resume-hidden",
        egressConfirmation: {
          operationId: "control-resume-hidden",
          userId: "owner-2"
        }
      })
    ).resolves.toBeUndefined();

    const controlClaim = await reopened.claimNextRuntimeControl(
      "runtime-control-worker-1",
      30_000
    );
    expect(controlClaim).toEqual({
      status: "CLAIMED",
      controlRequestId: "control-resume-persisted-1",
      operationId,
      action: "RESUME",
      decisionTaskId: "task-1",
      agentRunId: claim.agentRunId,
      ownerUserId: "owner-1",
      correlationId: "correlation-resume-persisted-1",
      egressConfirmation: {
        operationId: "control-resume-persisted-1",
        userId: "owner-1"
      },
      command,
      snapshot,
      effectReceipts: [receipt]
    });
    await expect(reopened.get("task-1", "owner-1")).resolves.toMatchObject({
      state: "RUNNING",
      terminal: false
    });
    const runningEvents = await reopened.listEvents("task-1", "owner-1");
    expect(runningEvents.at(-1)?.event).toMatchObject({
      taskState: "UNDERSTANDING",
      summary: "决策任务正在安全恢复"
    });
    recoveryTime = new Date("2026-08-24T12:01:31.000Z");
    await expect(
      reopened.claimNextRuntimeControl("runtime-control-worker-2", 30_000)
    ).resolves.toEqual(controlClaim);
    const reclaimedEvents = await reopened.listEvents("task-1", "owner-1");
    expect(
      reclaimedEvents.filter(
        ({ event }) =>
          event.taskState === "UNDERSTANDING" && event.summary === "决策任务正在安全恢复"
      )
    ).toHaveLength(1);
    await expect(
      reopened.complete(
        operationId,
        "runtime-control-worker-2",
        {
          contractType: "runtime-paused-outcome",
          contractVersion: "1.0",
          state: "PAUSED_PERMISSION",
          summary: "已提交副作用的权威结果不可用",
          snapshot,
          effectReceipts: [receipt],
          runEvents: [
            {
              contractType: "run-event",
              contractVersion: "1.0",
              eventId: "event-runtime-repaused",
              decisionTaskId: "task-1",
              agentRunId: claim.agentRunId,
              sequence: 2,
              occurredAt: "2026-08-24T12:01:31.000Z",
              eventType: "TASK_STATE_CHANGED",
              taskState: "PAUSED_PERMISSION",
              summary: "已提交副作用的权威结果不可用（EFFECT_RESULT_UNAVAILABLE）",
              synthetic: true
            }
          ]
        },
        "control-resume-persisted-1"
      )
    ).resolves.toMatchObject({
      status: "COMMITTED",
      snapshot: { state: "PAUSED_PERMISSION", terminal: false }
    });
    await expect(
      reopened.requestRuntimeResume({
        controlRequestId: "control-resume-persisted-1",
        decisionTaskId: "task-1",
        ownerUserId: "owner-1",
        runtimeSnapshotId: snapshot.snapshotId,
        correlationId: "correlation-resume-persisted-1",
        egressConfirmation: {
          operationId: "control-resume-persisted-1",
          userId: "owner-1"
        }
      })
    ).resolves.toMatchObject({
      state: "FAILED",
      error: {
        code: "RUNTIME_RESUME_DENIED",
        message: "已提交副作用的权威结果不可用"
      }
    });
    await expect(reopened.get("task-1", "owner-1")).resolves.toMatchObject({
      state: "PAUSED_PERMISSION",
      terminal: false
    });
    const resultUnavailableEvents = await reopened.listEvents("task-1", "owner-1");
    expect(resultUnavailableEvents.at(-1)?.event).toMatchObject({
      taskState: "PAUSED_PERMISSION",
      summary: "已提交副作用的权威结果不可用（EFFECT_RESULT_UNAVAILABLE）"
    });
    await expect(
      reopened.requestRuntimeResume({
        controlRequestId: "control-resume-unsafe-1",
        decisionTaskId: "task-1",
        ownerUserId: "owner-1",
        runtimeSnapshotId: snapshot.snapshotId,
        correlationId: "correlation-resume-unsafe-1",
        egressConfirmation: {
          operationId: "control-resume-unsafe-1",
          userId: "owner-1"
        }
      })
    ).resolves.toMatchObject({ state: "ACCEPTED" });
    await setEffectReceiptState(databaseUrl, receipt.effectReceiptId, "started");
    await expect(
      reopened.claimNextRuntimeControl("runtime-control-worker-unsafe", 30_000)
    ).resolves.toEqual({ status: "EMPTY" });
    await expect(
      reopened.requestRuntimeResume({
        controlRequestId: "control-resume-unsafe-1",
        decisionTaskId: "task-1",
        ownerUserId: "owner-1",
        runtimeSnapshotId: snapshot.snapshotId,
        correlationId: "correlation-resume-unsafe-1",
        egressConfirmation: {
          operationId: "control-resume-unsafe-1",
          userId: "owner-1"
        }
      })
    ).resolves.toMatchObject({
      state: "FAILED",
      error: { code: "RUNTIME_RESUME_DENIED" }
    });
    const manualVerificationEvents = await reopened.listEvents("task-1", "owner-1");
    expect(manualVerificationEvents.at(-1)?.event).toMatchObject({
      taskState: "PAUSED_PERMISSION",
      summary: "副作用状态需要人工核验"
    });
    await setEffectReceiptState(databaseUrl, receipt.effectReceiptId, "committed", receipt.result);
    await expect(
      reopened.requestRuntimeCancel({
        controlRequestId: "control-cancel-persisted-1",
        decisionTaskId: "task-1",
        ownerUserId: "owner-1",
        cancellationId: "cancel-persisted-1",
        correlationId: "correlation-cancel-persisted-1"
      })
    ).resolves.toMatchObject({
      action: "CANCEL",
      state: "COMPLETED"
    });
    await expect(reopened.get("task-1", "owner-1")).resolves.toMatchObject({
      state: "CANCELLED",
      terminal: true
    });
    const cancelledEvents = await reopened.listEvents("task-1", "owner-1");
    expect(cancelledEvents.at(-1)?.event).toMatchObject({
      taskState: "CANCELLED",
      summary: "决策任务已取消"
    });
    await expect(
      reopened.requestRuntimeCancel({
        controlRequestId: "control-cancel-persisted-1",
        decisionTaskId: "task-1",
        ownerUserId: "owner-1",
        cancellationId: "cancel-persisted-1",
        correlationId: "correlation-cancel-persisted-1"
      })
    ).resolves.toMatchObject({ action: "CANCEL", state: "COMPLETED" });
    await expect(
      reopened.requestRuntimeCancel({
        controlRequestId: "control-cancel-racing-1",
        decisionTaskId: "task-1",
        ownerUserId: "owner-1",
        cancellationId: "cancel-racing-1",
        correlationId: "correlation-cancel-racing-1"
      })
    ).rejects.toMatchObject({ code: "RUNTIME_CANCEL_RACE" });
  });
});

function buildRuntimeSnapshot(
  rawSnapshot: RuntimeSnapshotV1["rawSnapshot"]
): RuntimeSnapshotV1 {
  return {
    contractType: "runtime-snapshot",
    contractVersion: "1.0",
    snapshotId: `snapshot-${rawSnapshot.digest}`,
    decisionTaskId: "task-1",
    agentRunId: "run-1",
    taskState: "PAUSED_PERMISSION",
    resumable: true,
    runtimeProtocol: { name: "agent-runtime-protocol", version: "1" },
    rawSnapshot,
    checkpoint: {
      contractType: "checkpoint-ref",
      contractVersion: "1.0",
      checkpointId: "checkpoint-1",
      decisionTaskId: "task-1",
      agentRunId: "run-1",
      sequence: 3,
      persistedAt: "2026-08-24T12:00:00.000Z"
    },
    capturedAt: "2026-08-24T12:00:00.000Z"
  };
}

function buildEffectReceipt(): Exclude<EffectReceiptV1, Readonly<{ state: "committed" }>> {
  return {
    contractType: "effect-receipt",
    contractVersion: "1.0",
    effectReceiptId: "receipt-1",
    decisionTaskId: "task-1",
    agentRunId: "run-1",
    checkpointId: "checkpoint-1",
    effectId: "provider-call-1",
    state: "started",
    recordedAt: "2026-08-24T12:00:00.000Z"
  };
}

async function buildCommittedEffectReceipt(
  store: RuntimeRecoveryStore,
  receipt: Exclude<EffectReceiptV1, Readonly<{ state: "committed" }>>
): Promise<Extract<EffectReceiptV1, Readonly<{ state: "committed" }>>> {
  const result = await store.putEffectResult(
    {
      decisionTaskId: receipt.decisionTaskId,
      agentRunId: receipt.agentRunId,
      checkpointId: receipt.checkpointId,
      effectId: receipt.effectId
    },
    { accepted: true, effectId: receipt.effectId }
  );
  return { ...receipt, state: "committed", result };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} 未配置`);
  }
  return value;
}

function buildCommand() {
  return {
    contractType: "execute-decision-task-command" as const,
    contractVersion: "1.0" as const,
    executionRequestId: "execution-pause-1",
    requirementRevision: {
      contractType: "requirement-revision" as const,
      contractVersion: "1.0" as const,
      requirementRevisionId: "requirement-1",
      decisionTaskId: "task-1",
      revision: 1,
      submittedText: "需要一台开发用笔记本",
      market: { country: "CN" as const, currency: "CNY" as const, locale: "zh-CN" as const },
      intendedUses: ["软件开发"],
      mustHaves: [],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: []
    }
  };
}

async function readOperationId(databaseUrl: string, agentRunId: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ operation_id: string }>(
      "SELECT operation_id::text FROM agent_run_operations WHERE agent_run_id = $1",
      [agentRunId]
    );
    const operationId = result.rows[0]?.operation_id;
    if (operationId === undefined) {
      throw new Error("测试任务缺少 Operation ID");
    }
    return operationId;
  } finally {
    await client.end();
  }
}

async function setEffectReceiptState(
  databaseUrl: string,
  effectReceiptId: string,
  state: EffectReceiptV1["state"],
  result?: Extract<EffectReceiptV1, Readonly<{ state: "committed" }>>["result"]
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (state === "committed") {
      if (result === undefined) {
        throw new Error("恢复 committed 测试收据时必须提供结果引用");
      }
      await client.query(
        `UPDATE runtime_effect_receipts
         SET receipt_payload = jsonb_set(
           jsonb_set(receipt_payload, '{state}', to_jsonb($2::text)),
           '{result}',
           $3::jsonb
         )
         WHERE effect_receipt_id = $1`,
        [effectReceiptId, state, JSON.stringify(result)]
      );
      return;
    }
    await client.query(
      `UPDATE runtime_effect_receipts
       SET receipt_payload = jsonb_set(receipt_payload - 'result', '{state}', to_jsonb($2::text))
       WHERE effect_receipt_id = $1`,
      [effectReceiptId, state]
    );
  } finally {
    await client.end();
  }
}
