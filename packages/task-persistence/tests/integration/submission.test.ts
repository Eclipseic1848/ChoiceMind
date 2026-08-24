import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  openPersistentDecisionTaskModule,
  PersistenceUnavailableError,
  type PersistentDecisionTaskModule
} from "../../src/index.js";
import { resetPersistentDecisionTaskTestData } from "./support.js";

const openModules: PersistentDecisionTaskModule[] = [];

beforeEach(async () => {
  await resetPersistentDecisionTaskTestData(requireDatabaseUrl());
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("PersistentDecisionTaskModule submission", () => {
  it("keeps an accepted task readable after the Module is reopened", async () => {
    const databaseUrl = requireDatabaseUrl();
    const command = buildCommand(`reopen-${randomUUID()}`);
    const firstModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T20:10:00.000Z")
    });
    openModules.push(firstModule);

    const accepted = await firstModule.submit(command);

    expect(accepted).toMatchObject({
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: command.executionRequestId,
      decisionTaskId: command.requirementRevision.decisionTaskId,
      agentRunId: expect.stringMatching(/^agent-run-/),
      state: "ACCEPTED",
      terminal: false,
      updatedAt: "2026-08-23T20:10:00.000Z"
    });

    await firstModule.close();
    openModules.splice(openModules.indexOf(firstModule), 1);

    const reopenedModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T20:11:00.000Z")
    });
    openModules.push(reopenedModule);

    expect(await reopenedModule.get(command.requirementRevision.decisionTaskId)).toEqual(
      accepted
    );
  });

  it("returns the original task when the same request is submitted again", async () => {
    const module = await openPersistentDecisionTaskModule({
      databaseUrl: requireDatabaseUrl(),
      now: () => new Date("2026-08-23T20:12:00.000Z")
    });
    openModules.push(module);
    const command = buildCommand("duplicate");

    const first = await module.submit(command);
    const duplicate = await module.submit(structuredClone(command));

    expect(duplicate).toEqual(first);
  });

  it("rejects the same request identifier when its command changes", async () => {
    const module = await openPersistentDecisionTaskModule({
      databaseUrl: requireDatabaseUrl(),
      now: () => new Date("2026-08-23T20:13:00.000Z")
    });
    openModules.push(module);
    const command = buildCommand("conflict");
    await module.submit(command);

    const changedCommand: ExecuteDecisionTaskCommandV1 = {
      ...command,
      requirementRevision: {
        ...command.requirementRevision,
        submittedText: "同一标识下被篡改的另一条需求"
      }
    };

    await expect(module.submit(changedCommand)).rejects.toEqual(
      new IdempotencyConflictError(command.executionRequestId)
    );
  });

  it("rolls back the accepted task when its Outbox fact cannot be written", async () => {
    const databaseUrl = requireDatabaseUrl();
    const module = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T20:14:00.000Z")
    });
    openModules.push(module);
    const command = buildCommand(`outbox-rollback-${randomUUID()}`);
    const faultClient = await installOutboxInsertFailure(databaseUrl);

    try {
      await expect(module.submit(command)).rejects.toEqual(
        new PersistenceUnavailableError()
      );
      expect(await module.get(command.requirementRevision.decisionTaskId)).toBeUndefined();
    } finally {
      await removeOutboxInsertFailure(faultClient);
    }
  });

  it("converges concurrent duplicate submissions on one persisted task", async () => {
    const module = await openPersistentDecisionTaskModule({
      databaseUrl: requireDatabaseUrl(),
      now: () => new Date("2026-08-23T20:15:00.000Z")
    });
    openModules.push(module);
    const command = buildCommand(`concurrent-${randomUUID()}`);

    const snapshots = await Promise.all(
      Array.from({ length: 8 }, async () => module.submit(structuredClone(command)))
    );

    expect(new Set(snapshots.map((snapshot) => snapshot.agentRunId)).size).toBe(1);
    expect(snapshots.every((snapshot) => snapshot.state === "ACCEPTED")).toBe(true);
  });
});

function requireDatabaseUrl(): string {
  const value = process.env.CHOICEMIND_TEST_DATABASE_URL;

  if (value === undefined || value.length === 0) {
    throw new Error("CHOICEMIND_TEST_DATABASE_URL 必须指向隔离的真实 Postgres 测试库");
  }

  return value;
}

function buildCommand(suffix: string): ExecuteDecisionTaskCommandV1 {
  return {
    contractType: "execute-decision-task-command",
    contractVersion: "1.0",
    executionRequestId: `exec-persistent-${suffix}`,
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: `requirement-persistent-${suffix}-r1`,
      decisionTaskId: `task-persistent-${suffix}`,
      revision: 1,
      submittedText: "验证持久任务在进程重启后仍可读取",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["持久化集成测试"],
      mustHaves: [],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: ["budget.maxAmountMinor"]
    }
  };
}

async function installOutboxInsertFailure(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`
    CREATE OR REPLACE FUNCTION test_reject_outbox_insert()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'test_outbox_insert_failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query("DROP TRIGGER IF EXISTS test_reject_outbox_insert ON outbox_messages");
  await client.query(`
    CREATE TRIGGER test_reject_outbox_insert
    BEFORE INSERT ON outbox_messages
    FOR EACH ROW EXECUTE FUNCTION test_reject_outbox_insert()
  `);
  return client;
}

async function removeOutboxInsertFailure(client: Client): Promise<void> {
  try {
    await client.query("DROP TRIGGER IF EXISTS test_reject_outbox_insert ON outbox_messages");
    await client.query("DROP FUNCTION IF EXISTS test_reject_outbox_insert()");
  } finally {
    await client.end();
  }
}
