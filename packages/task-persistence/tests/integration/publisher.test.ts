import { createClient } from "@redis/client";
import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openOutboxPublisher,
  openPersistentDecisionTaskModule,
  type OutboxPublisher,
  type PersistentDecisionTaskModule
} from "../../src/index.js";
import { resetPersistentDecisionTaskTestData } from "./support.js";

const execFileAsync = promisify(execFile);
const openModules: Array<PersistentDecisionTaskModule | OutboxPublisher> = [];

beforeEach(async () => {
  await resetPersistentDecisionTaskTestData(
    requireEnvironment("CHOICEMIND_TEST_DATABASE_URL")
  );
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("Outbox Publisher", () => {
  it("publishes a retained task once after Redis recovers", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const redisContainer = requireEnvironment("CHOICEMIND_TEST_REDIS_CONTAINER");
    const streamName = `choicemind:test:decision-tasks:${randomUUID()}`;
    const command = buildCommand(randomUUID());
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T20:16:00.000Z")
    });
    const publisher = await openOutboxPublisher({
      databaseUrl,
      redisUrl,
      streamName,
      retryDelayMs: 0,
      now: () => new Date("2026-08-23T20:17:00.000Z")
    });
    openModules.push(taskModule, publisher);

    await stopContainer(redisContainer);

    try {
      const accepted = await taskModule.submit(command, "test-owner");

      expect(await publisher.runOnce()).toEqual({
        attempted: 1,
        failed: 1,
        published: 0
      });
      expect(
        await taskModule.get(command.requirementRevision.decisionTaskId, "test-owner")
      ).toEqual(
        accepted
      );
    } finally {
      await startContainer(redisContainer);
      await waitForRedis(redisUrl);
    }

    expect(await publisher.runOnce()).toEqual({
      attempted: 1,
      failed: 0,
      published: 1
    });
    expect(await publisher.runOnce()).toEqual({
      attempted: 0,
      failed: 0,
      published: 0
    });

    const redis = createClient({ url: redisUrl });
    redis.on("error", () => undefined);
    await redis.connect();

    try {
      const messages = await redis.xRange(streamName, "-", "+");

      expect(messages).toHaveLength(1);
      expect(messages[0]?.message).toMatchObject({
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        payloadType: "decision-task-ready",
        payloadVersion: "1.0"
      });
    } finally {
      await redis.close();
    }
  });

  it("keeps one operation identity when publication is retried after marking fails", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const streamName = `choicemind:test:decision-tasks:${randomUUID()}`;
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openOutboxPublisher({
      databaseUrl,
      redisUrl,
      streamName,
      retryDelayMs: 0
    });
    openModules.push(taskModule, publisher);
    await taskModule.submit(buildCommand(randomUUID()), "test-owner");
    const faultClient = await installPublishedMarkFailure(databaseUrl);

    try {
      expect(await publisher.runOnce()).toEqual({
        attempted: 1,
        failed: 1,
        published: 0
      });
    } finally {
      await removePublishedMarkFailure(faultClient);
    }

    expect(await publisher.runOnce()).toEqual({
      attempted: 1,
      failed: 0,
      published: 1
    });

    const redis = createClient({ url: redisUrl });
    redis.on("error", () => undefined);
    await redis.connect();

    try {
      const messages = await redis.xRange(streamName, "-", "+");
      const operationIds = messages.map((message) => message.message.operationId);

      expect(messages).toHaveLength(2);
      expect(new Set(operationIds).size).toBe(1);
      expect(operationIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      await redis.close();
    }
  });

  it("rebuilds a lost Redis stream from an unfinished Postgres operation", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const streamName = `choicemind:test:decision-tasks:rebuild:${randomUUID()}`;
    const command = buildCommand(randomUUID());
    let currentTime = new Date("2026-08-23T21:40:00.000Z");
    const taskModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => currentTime
    });
    const publisher = await openOutboxPublisher({
      databaseUrl,
      redisUrl,
      streamName,
      republishDelayMs: 1_000,
      now: () => currentTime
    });
    openModules.push(taskModule, publisher);
    const accepted = await taskModule.submit(command, "test-owner");

    expect(await publisher.runOnce()).toMatchObject({ published: 1 });

    const redis = createClient({ url: redisUrl });
    redis.on("error", () => undefined);
    await redis.connect();

    try {
      expect(await redis.del(streamName)).toBe(1);
    } finally {
      await redis.close();
    }

    currentTime = new Date("2026-08-23T21:40:02.000Z");
    expect(await publisher.runOnce()).toEqual({
      attempted: 1,
      failed: 0,
      published: 1
    });
    expect(
      await taskModule.get(command.requirementRevision.decisionTaskId, "test-owner")
    ).toEqual(accepted);

    const recoveredRedis = createClient({ url: redisUrl });
    recoveredRedis.on("error", () => undefined);
    await recoveredRedis.connect();

    try {
      const messages = await recoveredRedis.xRange(streamName, "-", "+");

      expect(messages).toHaveLength(1);
      expect(messages[0]?.message.operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      await recoveredRedis.close();
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
    executionRequestId: `exec-publisher-${suffix}`,
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: `requirement-publisher-${suffix}-r1`,
      decisionTaskId: `task-publisher-${suffix}`,
      revision: 1,
      submittedText: "验证 Redis 故障恢复后 Outbox 仅发布一次",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["Publisher 集成测试"],
      mustHaves: [],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: ["budget.maxAmountMinor"]
    }
  };
}

async function stopContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["stop", name], { encoding: "utf8" });
}

async function startContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["start", name], { encoding: "utf8" });
}

async function waitForRedis(redisUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const client = createClient({
      url: redisUrl,
      socket: { connectTimeout: 250, reconnectStrategy: false }
    });
    client.on("error", () => undefined);

    try {
      await client.connect();
      await client.ping();
      await client.close();
      return;
    } catch {
      if (client.isOpen) {
        client.destroy();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error("Redis 容器未在 10 秒内恢复健康");
}

async function installPublishedMarkFailure(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`
    CREATE OR REPLACE FUNCTION test_reject_outbox_published_mark()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.published_at IS NOT NULL THEN
        RAISE EXCEPTION 'test_outbox_published_mark_failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(
    "DROP TRIGGER IF EXISTS test_reject_outbox_published_mark ON outbox_messages"
  );
  await client.query(`
    CREATE TRIGGER test_reject_outbox_published_mark
    BEFORE UPDATE ON outbox_messages
    FOR EACH ROW EXECUTE FUNCTION test_reject_outbox_published_mark()
  `);
  return client;
}

async function removePublishedMarkFailure(client: Client): Promise<void> {
  try {
    await client.query(
      "DROP TRIGGER IF EXISTS test_reject_outbox_published_mark ON outbox_messages"
    );
    await client.query("DROP FUNCTION IF EXISTS test_reject_outbox_published_mark()");
  } finally {
    await client.end();
  }
}
