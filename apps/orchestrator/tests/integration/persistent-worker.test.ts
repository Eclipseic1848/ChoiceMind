import { createClient } from "@redis/client";
import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import {
  openOutboxPublisher,
  openPersistentDecisionTaskModule,
  openPersistentDecisionTaskWorker,
  openRuntimeRecoveryStore,
  type OutboxPublisher,
  type PersistentDecisionTaskModule,
  type PersistentDecisionTaskWorker,
  type PersistentDecisionTaskOutcome,
  type RuntimeRecoveryStore
} from "@choicemind/task-persistence";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDecisionTaskExecutor } from "../../src/decision-tasks/executor.js";
import { createFakeAgentRuntimeAdapter } from "../../src/runtime/fake-agent-runtime-adapter.js";
import { resetPersistentDecisionTaskTestData } from "../../../../packages/task-persistence/tests/integration/support.js";

const openModules: Array<
  | PersistentDecisionTaskModule
  | OutboxPublisher
  | PersistentDecisionTaskWorker
  | RuntimeRecoveryStore
> = [];

beforeEach(async () => {
  await resetPersistentDecisionTaskTestData(
    requireEnvironment("CHOICEMIND_TEST_DATABASE_URL")
  );
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("Persistent Decision Task Worker", () => {
  it("executes one Agent Run for concurrent duplicate transport messages", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:worker:${suffix}`;
    const consumerGroup = `choicemind-test-workers-${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(command, "test-owner");
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    await duplicatePublishedMessage(redisUrl, streamName);
    const sourceRuntime = createFakeAgentRuntimeAdapter();
    let runtimeCalls = 0;
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(runtimeCommand) {
          runtimeCalls += 1;
          return sourceRuntime.run(runtimeCommand);
        }
      }
    });
    const execute = async (claim: {
      command: ExecuteDecisionTaskCommandV1;
      agentRunId: string;
    }) => {
      const outcome = await executor.execute(claim.command, {
        agentRunId: claim.agentRunId
      });

      if (!("taskStatus" in outcome)) {
        return outcome;
      }

      return {
        ...outcome,
        runEvents: outcome.runEvents.map((event) => ({
          ...event,
          summary: "不得公开的 Runtime 隐藏推理"
        }))
      };
    };
    const firstWorker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `worker-a-${suffix}`,
      pendingClaimIdleMs: 0,
      execute
    });
    const secondWorker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `worker-b-${suffix}`,
      pendingClaimIdleMs: 0,
      execute
    });
    openModules.push(firstWorker, secondWorker);

    const batches = await Promise.all([firstWorker.runOnce(), secondWorker.runOnce()]);

    expect(batches.reduce((sum, batch) => sum + batch.received, 0)).toBe(2);
    expect(batches.reduce((sum, batch) => sum + batch.executed, 0)).toBe(1);
    expect(batches.reduce((sum, batch) => sum + batch.acknowledged, 0)).toBe(1);
    expect(runtimeCalls).toBe(1);
    const persistedTask = await taskModule.get(
      command.requirementRevision.decisionTaskId,
      "test-owner"
    );
    expect(persistedTask).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: true,
      taskStatus: {
        decisionTaskId: command.requirementRevision.decisionTaskId,
        agentRunId: accepted.agentRunId,
        state: "COMPLETED",
        terminal: true
      }
    });
    const persistedEvents = await taskModule.listEvents(
      command.requirementRevision.decisionTaskId,
      "test-owner"
    );
    expect(persistedEvents).toHaveLength(9);
    expect(persistedEvents.slice(0, 2)).toMatchObject([
      { event: { sequence: 1, taskState: "CREATED" } },
      { event: { sequence: 2, taskState: "UNDERSTANDING" } }
    ]);
    expect(persistedEvents.at(-1)).toMatchObject({
      event: {
        sequence: 9,
        eventType: "RUNTIME_SUCCEEDED",
        taskState: "COMPLETED"
      }
    });
    expect(persistedEvents.map(({ event }) => event.summary)).toEqual([
      "决策任务已接受",
      "决策任务开始执行",
      "正在规划决策步骤",
      "正在收集候选与证据",
      "正在核验候选与证据",
      "正在比较可行候选",
      "正在检查风险与反例",
      "正在生成可审查决策",
      "决策任务已完成"
    ]);
    expect(persistedTask).toHaveProperty(
      "runEvents",
      persistedEvents.map((persistedEvent) => persistedEvent.event)
    );
    const deferredWorker = batches[0]?.executed === 0 ? firstWorker : secondWorker;

    expect(await deferredWorker.runOnce()).toEqual({
      acknowledged: 1,
      executed: 0,
      received: 1
    });
  });

  it("recovers a pending operation after its previous worker lease expires", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:worker-recovery:${suffix}`;
    const consumerGroup = `choicemind-test-recovery-${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    await taskModule.submit(command, "test-owner");
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await abandonPublishedMessage(
      redisUrl,
      streamName,
      consumerGroup,
      `dead-worker-${suffix}`
    );
    expect(await taskModule.claimNext(operationId, `dead-worker-${suffix}`, 1)).toMatchObject({
      status: "CLAIMED"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sourceRuntime = createFakeAgentRuntimeAdapter();
    let runtimeCalls = 0;
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(runtimeCommand) {
          runtimeCalls += 1;
          return sourceRuntime.run(runtimeCommand);
        }
      }
    });
    const worker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `recovery-worker-${suffix}`,
      pendingClaimIdleMs: 0,
      execute: async (claim) =>
        executor.execute(claim.command, { agentRunId: claim.agentRunId })
    });
    openModules.push(worker);

    expect(await worker.runOnce()).toEqual({
      acknowledged: 1,
      executed: 1,
      received: 1
    });
    expect(runtimeCalls).toBe(1);
    expect(
      await taskModule.get(command.requirementRevision.decisionTaskId, "test-owner")
    ).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED", terminal: true }
    });
  });

  it("does not acknowledge a reclaimed message while the database lease is active", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:worker-active-lease:${suffix}`;
    const consumerGroup = `choicemind-test-active-lease-${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    await taskModule.submit(command, "test-owner");
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await abandonPublishedMessage(
      redisUrl,
      streamName,
      consumerGroup,
      `active-worker-${suffix}`
    );
    expect(await taskModule.claimNext(operationId, `active-worker-${suffix}`, 30_000)).toMatchObject(
      { status: "CLAIMED" }
    );
    const recoveryWorker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `premature-recovery-worker-${suffix}`,
      pendingClaimIdleMs: 0,
      readBlockMs: 10,
      async execute() {
        throw new Error("活动租约期间不应重复执行");
      }
    });
    openModules.push(recoveryWorker);

    expect(await recoveryWorker.runOnce()).toEqual({
      acknowledged: 0,
      executed: 0,
      received: 1
    });

    const redis = createClient({ url: redisUrl });
    redis.on("error", () => undefined);
    await redis.connect();

    try {
      expect(await redis.xPending(streamName, consumerGroup)).toMatchObject({ pending: 1 });
    } finally {
      await redis.close();
    }
  });

  it("retries the same operation after a retryable failure and acknowledges its final failure", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:worker-retryable:${suffix}`;
    const consumerGroup = `choicemind-test-retryable-${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    await taskModule.submit(command, "test-owner");
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    let executions = 0;
    const firstWorker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `retryable-worker-a-${suffix}`,
      pendingClaimIdleMs: 0,
      async execute() {
        executions += 1;
        return {
          state: "FAILED_RETRYABLE",
          summary: "临时资源不足，允许重试同一执行"
        };
      }
    });
    const secondWorker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `retryable-worker-b-${suffix}`,
      pendingClaimIdleMs: 0,
      async execute() {
        executions += 1;
        return {
          state: "FAILED_FINAL",
          summary: "重试后确认无法完成"
        };
      }
    });
    openModules.push(firstWorker, secondWorker);

    expect(await firstWorker.runOnce()).toEqual({
      acknowledged: 0,
      executed: 1,
      received: 1
    });
    expect(
      await taskModule.get(command.requirementRevision.decisionTaskId, "test-owner")
    ).toMatchObject({
      state: "FAILED_RETRYABLE",
      terminal: false
    });
    expect(await secondWorker.runOnce()).toEqual({
      acknowledged: 1,
      executed: 1,
      received: 1
    });
    expect(executions).toBe(2);
    expect(
      await taskModule.get(command.requirementRevision.decisionTaskId, "test-owner")
    ).toMatchObject({
      state: "FAILED_FINAL",
      terminal: true
    });
  });

  it("creates a new Agent Run when a retryable task succeeds on retry", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:worker-retry-success:${suffix}`;
    const consumerGroup = `choicemind-test-retry-success-${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(command, "test-owner");
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const firstWorker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `retry-success-worker-a-${suffix}`,
      pendingClaimIdleMs: 0,
      async execute() {
        return {
          state: "FAILED_RETRYABLE",
          summary: "临时资源不足，允许使用新的 Agent Run 重试"
        };
      }
    });
    const executor = createDecisionTaskExecutor({
      runtime: createFakeAgentRuntimeAdapter()
    });
    const secondWorker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `retry-success-worker-b-${suffix}`,
      pendingClaimIdleMs: 0,
      execute: async (claim) =>
        executor.execute(claim.command, { agentRunId: claim.agentRunId })
    });
    openModules.push(firstWorker, secondWorker);

    expect(await firstWorker.runOnce()).toEqual({
      acknowledged: 0,
      executed: 1,
      received: 1
    });
    expect(
      await taskModule.get(command.requirementRevision.decisionTaskId, "test-owner")
    ).toMatchObject({
      agentRunId: accepted.agentRunId,
      state: "FAILED_RETRYABLE",
      terminal: false
    });
    expect(await secondWorker.runOnce()).toEqual({
      acknowledged: 1,
      executed: 1,
      received: 1
    });

    const persistedTask = await taskModule.get(
      command.requirementRevision.decisionTaskId,
      "test-owner"
    );
    expect(persistedTask).toMatchObject({
      contractType: "decision-task-result",
      ok: true,
      taskStatus: {
        state: "COMPLETED",
        terminal: true
      }
    });
    const persistedEvents = await taskModule.listEvents(
      command.requirementRevision.decisionTaskId,
      "test-owner"
    );
    const retryAgentRunId = persistedEvents[3]?.event.agentRunId;

    expect(retryAgentRunId).toBeDefined();
    expect(retryAgentRunId).not.toBe(accepted.agentRunId);
    expect(persistedEvents).toHaveLength(12);
    expect(persistedEvents.slice(0, 3)).toMatchObject([
      { event: { agentRunId: accepted.agentRunId, sequence: 1, taskState: "CREATED" } },
      {
        event: {
          agentRunId: accepted.agentRunId,
          sequence: 2,
          taskState: "UNDERSTANDING"
        }
      },
      { event: { agentRunId: accepted.agentRunId, sequence: 3, taskState: "FAILED" } }
    ]);
    expect(persistedEvents.slice(3).map(({ event }) => event.agentRunId)).toEqual(
      Array(9).fill(retryAgentRunId)
    );
    expect(persistedEvents.slice(3).map(({ event }) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9
    ]);
    expect(persistedEvents.slice(3)).toMatchObject([
      { event: { taskState: "CREATED" } },
      { event: { taskState: "UNDERSTANDING" } },
      { event: { taskState: "PLANNING" } },
      { event: { taskState: "RESEARCHING" } },
      { event: { taskState: "VERIFYING" } },
      { event: { taskState: "COMPARING" } },
      { event: { taskState: "CRITIQUING" } },
      { event: { taskState: "GENERATING" } },
      { event: { taskState: "COMPLETED" } }
    ]);
    expect(persistedTask).toHaveProperty(
      "runEvents",
      persistedEvents.slice(3).map(({ event }) => event)
    );
  });

  it("acknowledges a persisted partial outcome without presenting a successful result", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:worker-partial:${suffix}`;
    const consumerGroup = `choicemind-test-partial-${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    await taskModule.submit(command, "test-owner");
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const worker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `partial-worker-${suffix}`,
      pendingClaimIdleMs: 0,
      readBlockMs: 10,
      async execute() {
        return {
          state: "PARTIAL",
          summary: "已验证需求，但尚未形成完整 Decision"
        };
      }
    });
    openModules.push(worker);

    expect(await worker.runOnce()).toEqual({
      acknowledged: 1,
      executed: 1,
      received: 1
    });
    expect(
      await taskModule.get(command.requirementRevision.decisionTaskId, "test-owner")
    ).toMatchObject({
      contractType: "decision-task-snapshot",
      state: "PARTIAL",
      terminal: false
    });
    expect(await worker.runOnce()).toEqual({
      acknowledged: 0,
      executed: 0,
      received: 0
    });
  });

  it("优先领取恢复请求并通过同一完成事务同步任务状态", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:worker-resume:${suffix}`;
    const consumerGroup = `choicemind-test-resume-${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const recoveryStore = await openRuntimeRecoveryStore({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, recoveryStore, publisher);
    const accepted = await taskModule.submit(command, "test-owner");
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await readPublishedOperationId(redisUrl, streamName);
    const initialClaim = await taskModule.claimNext(operationId, `initial-${suffix}`, 30_000);
    if (initialClaim.status !== "CLAIMED") throw new Error("初始任务未被领取");
    const rawSnapshot = await recoveryStore.putRawSnapshot({
      schemaVersion: 1,
      runId: `coremind-${suffix}`,
      operation: { state: "paused", transitionSequence: 1 },
      resumable: true
    });
    const snapshot = {
      contractType: "runtime-snapshot" as const,
      contractVersion: "1.0" as const,
      snapshotId: `snapshot-${rawSnapshot.digest}`,
      decisionTaskId: command.requirementRevision.decisionTaskId,
      agentRunId: accepted.agentRunId,
      taskState: "PAUSED_PERMISSION" as const,
      resumable: true,
      runtimeProtocol: { name: "agent-runtime-protocol" as const, version: "1" as const },
      rawSnapshot,
      checkpoint: {
        contractType: "checkpoint-ref" as const,
        contractVersion: "1.0" as const,
        checkpointId: `checkpoint-${suffix}`,
        decisionTaskId: command.requirementRevision.decisionTaskId,
        agentRunId: accepted.agentRunId,
        sequence: 1,
        persistedAt: "2026-08-24T12:00:00.000Z"
      },
      capturedAt: "2026-08-24T12:00:00.000Z"
    };
    const pausedOutcome = {
      contractType: "runtime-paused-outcome" as const,
      contractVersion: "1.0" as const,
      state: "PAUSED_PERMISSION" as const,
      summary: "等待必要权限",
      snapshot,
      effectReceipts: [],
      runEvents: [
        {
          contractType: "run-event" as const,
          contractVersion: "1.0" as const,
          eventId: `event-paused-${suffix}`,
          decisionTaskId: command.requirementRevision.decisionTaskId,
          agentRunId: accepted.agentRunId,
          sequence: 1,
          occurredAt: "2026-08-24T12:00:00.000Z",
          eventType: "TASK_STATE_CHANGED" as const,
          taskState: "PAUSED_PERMISSION" as const,
          summary: "等待必要权限",
          synthetic: true
        }
      ]
    };
    await recoveryStore.saveRecoveryFacts(snapshot, []);
    await taskModule.complete(operationId, `initial-${suffix}`, pausedOutcome);
    await taskModule.requestRuntimeResume({
      controlRequestId: `control-${suffix}`,
      decisionTaskId: command.requirementRevision.decisionTaskId,
      ownerUserId: "test-owner",
      runtimeSnapshotId: snapshot.snapshotId,
      correlationId: `correlation-${suffix}`,
      egressConfirmation: { operationId: `control-${suffix}`, userId: "test-owner" }
    });
    let runtimeControlOutcome: PersistentDecisionTaskOutcome = pausedOutcome;
    const worker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `resume-worker-${suffix}`,
      readBlockMs: 10,
      async execute() {
        throw new Error("恢复请求不应进入普通执行入口");
      },
      async executeRuntimeControl(claim) {
        expect(claim).toMatchObject({
          ownerUserId: "test-owner",
          command
        });
        return runtimeControlOutcome;
      }
    });
    openModules.push(worker);

    expect(await worker.runOnce()).toEqual({ acknowledged: 0, executed: 1, received: 0 });
    await expect(
      taskModule.requestRuntimeResume({
        controlRequestId: `control-${suffix}`,
        decisionTaskId: command.requirementRevision.decisionTaskId,
        ownerUserId: "test-owner",
        runtimeSnapshotId: snapshot.snapshotId,
        correlationId: `correlation-${suffix}`,
        egressConfirmation: { operationId: `control-${suffix}`, userId: "test-owner" }
      })
    ).resolves.toMatchObject({ state: "COMPLETED" });
    await expect(
      taskModule.get(command.requirementRevision.decisionTaskId, "test-owner")
    ).resolves.toMatchObject({ state: "PAUSED_PERMISSION", terminal: false });
    runtimeControlOutcome = {
      state: "FAILED_FINAL",
      summary: "权威 Runtime 快照不合法",
      runtimeControlError: {
        code: "RUNTIME_SNAPSHOT_INVALID",
        message: "权威 Runtime 快照不合法"
      }
    };
    await taskModule.requestRuntimeResume({
      controlRequestId: `control-failed-${suffix}`,
      decisionTaskId: command.requirementRevision.decisionTaskId,
      ownerUserId: "test-owner",
      runtimeSnapshotId: snapshot.snapshotId,
      correlationId: `correlation-failed-${suffix}`,
      egressConfirmation: {
        operationId: `control-failed-${suffix}`,
        userId: "test-owner"
      }
    });
    expect(await worker.runOnce()).toEqual({ acknowledged: 0, executed: 1, received: 0 });
    await expect(
      taskModule.requestRuntimeResume({
        controlRequestId: `control-failed-${suffix}`,
        decisionTaskId: command.requirementRevision.decisionTaskId,
        ownerUserId: "test-owner",
        runtimeSnapshotId: snapshot.snapshotId,
        correlationId: `correlation-failed-${suffix}`,
        egressConfirmation: {
          operationId: `control-failed-${suffix}`,
          userId: "test-owner"
        }
      })
    ).resolves.toMatchObject({
      state: "FAILED",
      error: {
        code: "RUNTIME_SNAPSHOT_INVALID",
        message: "权威 Runtime 快照不合法"
      }
    });
  });

  it("acknowledges a malformed transport message without stopping the Worker", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:worker-malformed:${suffix}`;
    const consumerGroup = `choicemind-test-malformed-${suffix}`;
    const worker = await openPersistentDecisionTaskWorker({
      databaseUrl,
      redisUrl,
      streamName,
      consumerGroup,
      workerId: `malformed-worker-${suffix}`,
      readBlockMs: 10,
      async execute() {
        throw new Error("畸形 transport 消息不应进入执行阶段");
      }
    });
    openModules.push(worker);
    const redis = createClient({ url: redisUrl });
    redis.on("error", () => undefined);
    await redis.connect();

    try {
      await redis.xAdd(streamName, "*", { unexpected: "missing-operation-id" });
      await redis.xAdd(streamName, "*", { operationId: "not-a-uuid" });
    } finally {
      await redis.close();
    }

    expect(await worker.runOnce()).toEqual({
      acknowledged: 1,
      executed: 0,
      received: 1
    });
    expect(await worker.runOnce()).toEqual({
      acknowledged: 1,
      executed: 0,
      received: 1
    });

    const verificationRedis = createClient({ url: redisUrl });
    verificationRedis.on("error", () => undefined);
    await verificationRedis.connect();

    try {
      expect(await verificationRedis.xPending(streamName, consumerGroup)).toMatchObject({
        pending: 0
      });
    } finally {
      await verificationRedis.close();
    }
  });
});

function requireEnvironment(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} 必须指向隔离的真实集成测试资源`);
  }

  return value;
}

function buildCommand(suffix: string): ExecuteDecisionTaskCommandV1 {
  return {
    contractType: "execute-decision-task-command",
    contractVersion: "1.0",
    executionRequestId: `exec-persistent-worker-${suffix}`,
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: `requirement-persistent-worker-${suffix}-r1`,
      decisionTaskId: `task-persistent-worker-${suffix}`,
      revision: 1,
      submittedText: "需要一台用于文档和视频会议的合成笔记本电脑",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["文档处理", "视频会议"],
      budget: {
        confirmed: true,
        currency: "CNY",
        hard: true,
        maxAmountMinor: 800_000
      },
      mustHaves: [],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: []
    }
  };
}

async function duplicatePublishedMessage(redisUrl: string, streamName: string): Promise<void> {
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();

  try {
    const messages = await redis.xRange(streamName, "-", "+");
    const message = messages[0]?.message;

    if (message === undefined) {
      throw new Error("Publisher 未产生可复制的 transport 消息");
    }

    await redis.xAdd(streamName, "*", message);
  } finally {
    await redis.close();
  }
}

async function readPublishedOperationId(redisUrl: string, streamName: string): Promise<string> {
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();
  try {
    const operationId = (await redis.xRange(streamName, "-", "+"))[0]?.message.operationId;
    if (operationId === undefined) throw new Error("Publisher 未产生 operationId");
    return operationId;
  } finally {
    await redis.close();
  }
}

async function abandonPublishedMessage(
  redisUrl: string,
  streamName: string,
  consumerGroup: string,
  consumerName: string
): Promise<string> {
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();

  try {
    await redis.xGroupCreate(streamName, consumerGroup, "0");
    const streams = await redis.xReadGroup(
      consumerGroup,
      consumerName,
      { key: streamName, id: ">" },
      { COUNT: 1 }
    );
    const operationId = streams?.[0]?.messages[0]?.message.operationId;

    if (operationId === undefined) {
      throw new Error("旧 Worker 未取得待恢复的 operationId");
    }

    return operationId;
  } finally {
    await redis.close();
  }
}
