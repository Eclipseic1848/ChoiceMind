import { randomUUID } from "node:crypto";
import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import { createClient } from "@redis/client";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type OutboxPublisher,
  openOutboxPublisher,
  openPersistentDecisionTaskModule,
  type PersistentDecisionTaskModule
} from "../../src/index.js";
import { resetPersistentDecisionTaskTestData } from "./support.js";

const openModules: Array<PersistentDecisionTaskModule | OutboxPublisher> = [];

beforeEach(async () => {
  await resetPersistentDecisionTaskTestData(requireDatabaseUrl());
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("PersistentDecisionTaskModule events", () => {
  it("replays the submitted task event after the Module is reopened", async () => {
    const databaseUrl = requireDatabaseUrl();
    const command = buildCommand(randomUUID());
    const firstModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-24T01:10:00.000Z")
    });
    openModules.push(firstModule);

    const accepted = await firstModule.submit(command);
    await firstModule.close();
    openModules.splice(openModules.indexOf(firstModule), 1);

    const reopenedModule = await openPersistentDecisionTaskModule({
      databaseUrl
    });
    openModules.push(reopenedModule);

    expect(await reopenedModule.listEvents(accepted.decisionTaskId)).toEqual([
      {
        contractType: "persisted-run-event",
        contractVersion: "1.0",
        cursor: expect.stringMatching(/^[1-9]\d*$/),
        event: {
          contractType: "run-event",
          contractVersion: "1.0",
          eventId: expect.stringMatching(/^event-persistent-/),
          decisionTaskId: accepted.decisionTaskId,
          agentRunId: accepted.agentRunId,
          sequence: 1,
          occurredAt: "2026-08-24T01:10:00.000Z",
          eventType: "TASK_STATE_CHANGED",
          taskState: "CREATED",
          summary: "决策任务已接受",
          synthetic: true
        }
      }
    ]);
  });

  it("persists one submitted event for concurrent idempotent submissions", async () => {
    const databaseUrl = requireDatabaseUrl();
    const command = buildCommand(randomUUID());
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    openModules.push(taskModule);

    const [first, second] = await Promise.all([
      taskModule.submit(command),
      taskModule.submit(command)
    ]);

    expect(second).toEqual(first);
    expect(await taskModule.listEvents(command.requirementRevision.decisionTaskId)).toMatchObject([
      { event: { sequence: 1, taskState: "CREATED" } }
    ]);
  });

  it("appends the running event when a worker claims the task", async () => {
    const suffix = randomUUID();
    const databaseUrl = requireDatabaseUrl();
    const redisUrl = requireRedisUrl();
    const streamName = `choicemind:test:events:${suffix}`;
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-24T01:20:00.000Z")
    });
    const publisher = await openOutboxPublisher({
      databaseUrl,
      redisUrl,
      streamName
    });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(buildCommand(suffix));
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await readPublishedOperationId(redisUrl, streamName);

    expect(await taskModule.claimNext(operationId, "worker-events-1", 30_000)).toMatchObject({
      status: "CLAIMED"
    });

    expect(await taskModule.listEvents(accepted.decisionTaskId)).toMatchObject([
      { event: { sequence: 1, taskState: "CREATED" } },
      {
        event: {
          decisionTaskId: accepted.decisionTaskId,
          agentRunId: accepted.agentRunId,
          sequence: 2,
          occurredAt: "2026-08-24T01:20:00.000Z",
          eventType: "TASK_STATE_CHANGED",
          taskState: "UNDERSTANDING",
          summary: "决策任务开始执行"
        }
      }
    ]);
  });

  it("replays only the terminal event after the supplied cursor", async () => {
    const suffix = randomUUID();
    const databaseUrl = requireDatabaseUrl();
    const redisUrl = requireRedisUrl();
    const streamName = `choicemind:test:events:terminal:${suffix}`;
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-24T01:30:00.000Z")
    });
    const publisher = await openOutboxPublisher({
      databaseUrl,
      redisUrl,
      streamName
    });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(buildCommand(suffix));
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });
    const operationId = await readPublishedOperationId(redisUrl, streamName);
    expect(await taskModule.claimNext(operationId, "worker-events-terminal", 30_000)).toMatchObject(
      {
        status: "CLAIMED"
      }
    );
    const runningEvents = await taskModule.listEvents(accepted.decisionTaskId);
    const runningCursor = runningEvents[1]?.cursor;

    expect(runningCursor).toMatch(/^[1-9]\d*$/);
    expect(
      await taskModule.complete(operationId, "worker-events-terminal", {
        state: "FAILED_FINAL",
        summary: "任务无法继续执行"
      })
    ).toMatchObject({
      status: "COMMITTED",
      snapshot: { state: "FAILED_FINAL" }
    });

    expect(await taskModule.listEvents(accepted.decisionTaskId, runningCursor)).toMatchObject([
      {
        event: {
          decisionTaskId: accepted.decisionTaskId,
          agentRunId: accepted.agentRunId,
          sequence: 3,
          occurredAt: "2026-08-24T01:30:00.000Z",
          eventType: "RUNTIME_FAILED",
          taskState: "FAILED",
          summary: "决策任务执行失败，已结束"
        }
      }
    ]);
  });

  it("commits only one terminal event for concurrent completion attempts", async () => {
    const suffix = randomUUID();
    const databaseUrl = requireDatabaseUrl();
    const redisUrl = requireRedisUrl();
    const streamName = `choicemind:test:events:concurrent-complete:${suffix}`;
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    const command = buildCommand(suffix);
    await taskModule.submit(command);
    await publisher.runOnce();
    const operationId = await readPublishedOperationId(redisUrl, streamName);
    await taskModule.claimNext(operationId, "worker-events-concurrent", 30_000);

    const completions = await Promise.all([
      taskModule.complete(operationId, "worker-events-concurrent", {
        state: "FAILED_FINAL",
        summary: "并发完成测试"
      }),
      taskModule.complete(operationId, "worker-events-concurrent", {
        state: "FAILED_FINAL",
        summary: "并发完成测试"
      })
    ]);

    expect(completions.map((completion) => completion.status).sort()).toEqual([
      "COMMITTED",
      "NOT_COMPLETABLE"
    ]);
    expect(await taskModule.listEvents(command.requirementRevision.decisionTaskId)).toMatchObject([
      { event: { sequence: 1, taskState: "CREATED" } },
      { event: { sequence: 2, taskState: "UNDERSTANDING" } },
      { event: { sequence: 3, taskState: "FAILED" } }
    ]);
  });

  it("rolls back the terminal state when its notification cannot be inserted", async () => {
    const suffix = randomUUID();
    const databaseUrl = requireDatabaseUrl();
    const redisUrl = requireRedisUrl();
    const streamName = `choicemind:test:events:rollback:${suffix}`;
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
    openModules.push(taskModule, publisher);
    const command = buildCommand(suffix);
    await taskModule.submit(command);
    await publisher.runOnce();
    const operationId = await readPublishedOperationId(redisUrl, streamName);
    await taskModule.claimNext(operationId, "worker-events-rollback", 30_000);
    await installRejectNotificationTrigger(databaseUrl);

    await expect(
      taskModule.complete(operationId, "worker-events-rollback", {
        state: "FAILED_FINAL",
        summary: "该终态必须回滚"
      })
    ).rejects.toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
    expect(await taskModule.get(command.requirementRevision.decisionTaskId)).toMatchObject({
      state: "RUNNING",
      terminal: false
    });
    expect(await taskModule.listEvents(command.requirementRevision.decisionTaskId)).toMatchObject([
      { event: { sequence: 1, taskState: "CREATED" } },
      { event: { sequence: 2, taskState: "UNDERSTANDING" } }
    ]);
  });
});

function requireDatabaseUrl(): string {
  const value = process.env.CHOICEMIND_TEST_DATABASE_URL;

  if (value === undefined || value.length === 0) {
    throw new Error("CHOICEMIND_TEST_DATABASE_URL 必须指向隔离的真实 Postgres 测试库");
  }

  return value;
}

function requireRedisUrl(): string {
  const value = process.env.CHOICEMIND_TEST_REDIS_URL;

  if (value === undefined || value.length === 0) {
    throw new Error("CHOICEMIND_TEST_REDIS_URL 必须指向隔离的真实 Redis 测试实例");
  }

  return value;
}

function buildCommand(suffix: string): ExecuteDecisionTaskCommandV1 {
  return {
    contractType: "execute-decision-task-command",
    contractVersion: "1.0",
    executionRequestId: `exec-events-${suffix}`,
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: `requirement-events-${suffix}-r1`,
      decisionTaskId: `task-events-${suffix}`,
      revision: 1,
      submittedText: "验证提交事件在重启后仍可回放",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["持久事件集成测试"],
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

async function installRejectNotificationTrigger(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE OR REPLACE FUNCTION test_reject_run_event_notification_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'test rejects run event notification';
      END;
      $$
    `);
    await client.query(`
      CREATE TRIGGER test_reject_run_event_notification_insert
      BEFORE INSERT ON decision_task_run_event_notifications
      FOR EACH ROW
      EXECUTE FUNCTION test_reject_run_event_notification_insert()
    `);
  } finally {
    await client.end();
  }
}
