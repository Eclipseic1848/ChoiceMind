import { randomUUID } from "node:crypto";
import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import { createClient } from "@redis/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openPersistentDecisionTaskModule,
  openRunEventNotificationPublisher,
  openRunEventNotificationSubscriber,
  type PersistentDecisionTaskModule,
  type RunEventNotificationPublisher,
  type RunEventNotificationSubscriber
} from "../../src/index.js";
import { resetPersistentDecisionTaskTestData } from "./support.js";

const openModules: Array<
  PersistentDecisionTaskModule | RunEventNotificationPublisher | RunEventNotificationSubscriber
> = [];

beforeEach(async () => {
  await resetPersistentDecisionTaskTestData(requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"));
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("RunEventNotificationPublisher", () => {
  it("notifies Redis with only the task identity and authoritative cursor", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const channelName = `choicemind:test:run-events:${randomUUID()}`;
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openRunEventNotificationPublisher({
      databaseUrl,
      redisUrl,
      channelName
    });
    openModules.push(taskModule, publisher);
    const subscriber = createClient({ url: redisUrl });
    subscriber.on("error", () => undefined);
    await subscriber.connect();
    let resolveNotification: ((message: string) => void) | undefined;
    const notification = new Promise<string>((resolve) => {
      resolveNotification = resolve;
    });
    await subscriber.subscribe(channelName, (message) => resolveNotification?.(message));

    try {
      const accepted = await taskModule.submit(buildCommand(randomUUID()), "test-owner");
      const persisted = await taskModule.listEvents(accepted.decisionTaskId, "test-owner");

      expect(await publisher.runOnce()).toEqual({
        attempted: 1,
        failed: 0,
        published: 1
      });
      await expect(notification).resolves.toBe(
        JSON.stringify({
          decisionTaskId: accepted.decisionTaskId,
          cursor: persisted[0]?.cursor
        })
      );
    } finally {
      await subscriber.close();
    }
  });

  it("wakes a task-specific waiter without returning event content", async () => {
    const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const channelName = `choicemind:test:run-events:subscriber:${randomUUID()}`;
    const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
    const publisher = await openRunEventNotificationPublisher({
      databaseUrl,
      redisUrl,
      channelName
    });
    const subscriber = await openRunEventNotificationSubscriber({
      redisUrl,
      channelName
    });
    openModules.push(taskModule, publisher, subscriber);
    const command = buildCommand(randomUUID());
    const waiting = subscriber.waitFor(
      command.requirementRevision.decisionTaskId,
      AbortSignal.timeout(2_000)
    );

    await taskModule.submit(command, "test-owner");
    expect(await publisher.runOnce()).toMatchObject({ published: 1 });

    await expect(waiting).resolves.toBeUndefined();
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
    executionRequestId: `exec-event-publisher-${suffix}`,
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: `requirement-event-publisher-${suffix}-r1`,
      decisionTaskId: `task-event-publisher-${suffix}`,
      revision: 1,
      submittedText: "验证 Redis 只承载事件通知",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["事件通知集成测试"],
      mustHaves: [],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: ["budget.maxAmountMinor"]
    }
  };
}
