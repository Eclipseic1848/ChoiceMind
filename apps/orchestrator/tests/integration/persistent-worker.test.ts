import { createClient } from "@redis/client";
import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import {
  openOutboxPublisher,
  openPersistentDecisionTaskModule,
  openPersistentDecisionTaskWorker,
  type OutboxPublisher,
  type PersistentDecisionTaskModule,
  type PersistentDecisionTaskWorker
} from "@choicemind/task-persistence";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDecisionTaskExecutor } from "../../src/decision-tasks/executor.js";
import { createFakeAgentRuntimeAdapter } from "../../src/runtime/fake-agent-runtime-adapter.js";
import { resetPersistentDecisionTaskTestData } from "../../../../packages/task-persistence/tests/integration/support.js";

const openModules: Array<
  PersistentDecisionTaskModule | OutboxPublisher | PersistentDecisionTaskWorker
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
    const accepted = await taskModule.submit(command);
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
    }) => executor.execute(claim.command, { agentRunId: claim.agentRunId });
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
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toMatchObject({
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
    await taskModule.submit(command);
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
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toMatchObject({
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
    await taskModule.submit(command);
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
    await taskModule.submit(command);
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
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toMatchObject({
      state: "FAILED_RETRYABLE",
      terminal: false
    });
    expect(await secondWorker.runOnce()).toEqual({
      acknowledged: 1,
      executed: 1,
      received: 1
    });
    expect(executions).toBe(2);
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toMatchObject({
      state: "FAILED_FINAL",
      terminal: true
    });
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
    await taskModule.submit(command);
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
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toMatchObject({
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
