import { createClient } from "@redis/client";
import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openOutboxPublisher,
  openPersistentDecisionTaskModule,
  type OutboxPublisher,
  type PersistentDecisionTaskModule
} from "../../src/index.js";
import { resetPersistentDecisionTaskTestData } from "./support.js";

const openModules: Array<PersistentDecisionTaskModule | OutboxPublisher> = [];

beforeEach(async () => {
  await resetPersistentDecisionTaskTestData(
    requireEnvironment("CHOICEMIND_TEST_DATABASE_URL")
  );
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("PersistentDecisionTaskModule execution", () => {
  it("distinguishes an unknown operation from a finished operation", async () => {
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL")
    });
    openModules.push(taskModule);

    await expect(
      taskModule.claimNext(randomUUID(), "worker-unknown", 30_000)
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("allows only one worker to claim duplicate deliveries of an operation", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const streamName = `choicemind:test:decision-tasks:${randomUUID()}`;
    const command = buildCommand(randomUUID());
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T20:18:00.000Z")
    });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(command);
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await readPublishedOperationId(redisUrl, streamName);

    const claims = await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        taskModule.claimNext(operationId, `worker-${index + 1}`, 30_000)
      )
    );
    const claimed = claims.filter((claim) => claim.status === "CLAIMED");

    expect(claimed).toEqual([
      {
        status: "CLAIMED",
        operationId,
        agentRunId: accepted.agentRunId,
        command
      }
    ]);
    expect(claims.filter((claim) => claim.status === "DEFERRED")).toHaveLength(7);
  });

  it("persists a retryable failure and allows the same operation to be claimed again", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:decision-tasks:retryable:${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T21:20:00.000Z")
    });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(command);
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await readPublishedOperationId(redisUrl, streamName);
    const firstWorkerId = `worker-retryable-a-${suffix}`;
    expect(await taskModule.claimNext(operationId, firstWorkerId, 30_000)).toMatchObject({
      status: "CLAIMED"
    });

    expect(
      await taskModule.complete(operationId, firstWorkerId, {
        state: "FAILED_RETRYABLE",
        summary: "临时资源不足，允许重试同一执行"
      })
    ).toMatchObject({
      status: "COMMITTED",
      snapshot: {
        state: "FAILED_RETRYABLE",
        terminal: false
      }
    });
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toEqual({
      ...accepted,
      state: "FAILED_RETRYABLE",
      terminal: false,
      updatedAt: "2026-08-23T21:20:00.000Z"
    });
    expect(
      await taskModule.claimNext(operationId, `worker-retryable-b-${suffix}`, 30_000)
    ).toMatchObject({ status: "CLAIMED", operationId });
  });

  it("persists a final failure as terminal and refuses another claim", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:decision-tasks:final:${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T21:25:00.000Z")
    });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(command);
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await readPublishedOperationId(redisUrl, streamName);
    const workerId = `worker-final-${suffix}`;
    expect(await taskModule.claimNext(operationId, workerId, 30_000)).toMatchObject({
      status: "CLAIMED"
    });

    expect(
      await taskModule.complete(operationId, workerId, {
        state: "FAILED_FINAL",
        summary: "输入无法形成可执行的安全任务"
      })
    ).toMatchObject({
      status: "COMMITTED",
      snapshot: {
        state: "FAILED_FINAL",
        terminal: true
      }
    });
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toEqual({
      ...accepted,
      state: "FAILED_FINAL",
      terminal: true,
      updatedAt: "2026-08-23T21:25:00.000Z"
    });
    expect(await taskModule.claimNext(operationId, `worker-final-retry-${suffix}`, 30_000)).toEqual(
      { status: "ALREADY_FINISHED" }
    );
  });

  it("persists a partial outcome without exposing it as a successful Decision", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const suffix = randomUUID();
    const streamName = `choicemind:test:decision-tasks:partial:${suffix}`;
    const command = buildCommand(suffix);
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T21:30:00.000Z")
    });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(command);
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await readPublishedOperationId(redisUrl, streamName);
    const workerId = `worker-partial-${suffix}`;
    expect(await taskModule.claimNext(operationId, workerId, 30_000)).toMatchObject({
      status: "CLAIMED"
    });

    expect(
      await taskModule.complete(operationId, workerId, {
        state: "PARTIAL",
        summary: "已验证需求，但尚未形成完整 Decision"
      })
    ).toMatchObject({
      status: "COMMITTED",
      snapshot: {
        state: "PARTIAL",
        terminal: false
      }
    });
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toEqual({
      ...accepted,
      state: "PARTIAL",
      terminal: false,
      updatedAt: "2026-08-23T21:30:00.000Z"
    });
    expect(
      await taskModule.claimNext(operationId, `worker-partial-retry-${suffix}`, 30_000)
    ).toEqual({ status: "ALREADY_FINISHED" });
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
    executionRequestId: `exec-worker-${suffix}`,
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: `requirement-worker-${suffix}-r1`,
      decisionTaskId: `task-worker-${suffix}`,
      revision: 1,
      submittedText: "验证重复 transport 消息只能领取一次",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["Worker 集成测试"],
      mustHaves: [],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: ["budget.maxAmountMinor"]
    }
  };
}

async function readPublishedOperationId(redisUrl: string, streamName: string): Promise<string> {
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();

  try {
    const messages = await redis.xRange(streamName, "-", "+");
    const operationId = messages[0]?.message.operationId;

    if (operationId === undefined) {
      throw new Error("Publisher 未产生可领取的 operationId");
    }

    return operationId;
  } finally {
    await redis.close();
  }
}
