import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import { createCredentialVault, createEgressGuard } from "@choicemind/security";
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
  it("persists an EgressRecord without external content", async () => {
    const module = await openPersistentDecisionTaskModule({ databaseUrl: requireDatabaseUrl() });
    openModules.push(module);
    const guard = createEgressGuard({
      appendRecord: async (record) => module.appendEgressRecord(record),
      nextId: () => "egress-persistent-1",
      now: () => new Date("2026-08-24T00:08:00.000Z")
    });

    await guard.execute({
      userId: "user-a",
      operationId: "operation-egress-persistent-1",
      operation: "READ_PUBLIC_SOURCE",
      correlationId: "correlation-egress-persistent-1",
      destinationUrl: "https://example.com/private?secret=never-store",
      method: "GET",
      perform: async () => "response-never-store"
    });

    const records = await module.listEgressRecords("correlation-egress-persistent-1");
    expect(records).toEqual([
      {
        egressId: "egress-persistent-1",
        userId: "user-a",
        operationId: "operation-egress-persistent-1",
        correlationId: "correlation-egress-persistent-1",
        destinationOrigin: "https://example.com",
        method: "GET",
        policyVersion: "p0-v1",
        state: "STARTED",
        occurredAt: "2026-08-24T00:08:00.000Z"
      }
    ]);
    expect(JSON.stringify(records)).not.toContain("never-store");
  });

  it("keeps an encrypted credential private to its owner", async () => {
    const module = await openPersistentDecisionTaskModule({ databaseUrl: requireDatabaseUrl() });
    openModules.push(module);
    const vault = createCredentialVault({
      masterKey: Buffer.alloc(32, 11),
      appendAuditRecord: async (record) => {
        await module.appendAuditRecord({
          actor: {
            principalId: `principal-${record.actor.userId}`,
            userId: record.actor.userId,
            role: record.actor.role
          },
          action: record.action,
          object: record.object,
          result: record.result,
          correlationId: record.correlationId
        });
      },
      storage: {
        save: async (record) => module.saveEncryptedCredential(record),
        load: async (credentialId, ownerUserId) =>
          module.loadEncryptedCredential(credentialId, ownerUserId)
      }
    });
    await vault.store({
      credentialId: "credential-private",
      ownerUserId: "user-a",
      secret: "provider-secret-a",
      secretType: "PROVIDER_CREDENTIAL",
      actor: { userId: "user-a", role: "USER" },
      correlationId: "correlation-credential-store"
    });

    await expect(
      vault.use(
        {
          credentialId: "credential-private",
          ownerUserId: "user-b",
          actor: { userId: "user-b", role: "USER" },
          correlationId: "correlation-credential-denied"
        },
        async () => undefined
      )
    ).rejects.toThrowError("CREDENTIAL_NOT_FOUND");
    let ownerUsedCredential = false;
    await vault.use(
      {
        credentialId: "credential-private",
        ownerUserId: "user-a",
        actor: { userId: "user-a", role: "USER" },
        correlationId: "correlation-credential-use"
      },
      async (secret) => {
        expect(secret.reveal()).toBe("provider-secret-a");
        ownerUsedCredential = true;
      }
    );
    expect(ownerUsedCredential).toBe(true);
    const deniedAuditRecords = await module.listAuditRecords(
      "correlation-credential-denied"
    );
    expect(deniedAuditRecords).toHaveLength(2);
    expect(deniedAuditRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "CREDENTIAL_USE", result: "STARTED" }),
        expect.objectContaining({
          action: "CREDENTIAL_USE",
          result: "DENIED",
          object: { id: "credential-private", type: "CREDENTIAL" }
        })
      ])
    );
    const useAuditRecords = await module.listAuditRecords("correlation-credential-use");
    expect(useAuditRecords).toHaveLength(2);
    expect(useAuditRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "CREDENTIAL_USE", result: "STARTED" }),
        expect.objectContaining({ action: "CREDENTIAL_USE", result: "ALLOWED" })
      ])
    );
  });

  it("persists a complete audit record without request content", async () => {
    const module = await openPersistentDecisionTaskModule({
      databaseUrl: requireDatabaseUrl(),
      now: () => new Date("2026-08-24T00:09:00.000Z")
    });
    openModules.push(module);

    await module.appendAuditRecord({
      actor: { principalId: "principal-user-a", role: "USER", userId: "user-a" },
      action: "DECISION_TASK_READ",
      object: { id: "task-private", type: "DECISION_TASK" },
      result: "NOT_FOUND",
      correlationId: "correlation-audit-1"
    });

    await expect(module.listAuditRecords("correlation-audit-1")).resolves.toEqual([
      {
        actor: { principalId: "principal-user-a", role: "USER", userId: "user-a" },
        action: "DECISION_TASK_READ",
        object: { id: "task-private", type: "DECISION_TASK" },
        result: "NOT_FOUND",
        correlationId: "correlation-audit-1",
        occurredAt: "2026-08-24T00:09:00.000Z"
      }
    ]);
  });

  it("keeps a persisted task private to its owner", async () => {
    const module = await openPersistentDecisionTaskModule({
      databaseUrl: requireDatabaseUrl(),
      now: () => new Date("2026-08-24T00:10:00.000Z")
    });
    openModules.push(module);
    const command = buildCommand(`owned-${randomUUID()}`);

    const accepted = await module.submit(command, "user-a");

    await expect(
      module.get(command.requirementRevision.decisionTaskId, "user-a")
    ).resolves.toEqual(accepted);
    await expect(
      module.get(command.requirementRevision.decisionTaskId, "user-b")
    ).resolves.toBeUndefined();
  });

  it("keeps persisted events private when two owners use the same task identifier", async () => {
    const module = await openPersistentDecisionTaskModule({
      databaseUrl: requireDatabaseUrl(),
      now: () => new Date("2026-08-24T00:11:00.000Z")
    });
    openModules.push(module);
    const sharedTaskId = `task-persistent-shared-${randomUUID()}`;
    const firstBase = buildCommand(`first-${randomUUID()}`);
    const secondBase = buildCommand(`second-${randomUUID()}`);
    const firstCommand: ExecuteDecisionTaskCommandV1 = {
      ...firstBase,
      requirementRevision: { ...firstBase.requirementRevision, decisionTaskId: sharedTaskId }
    };
    const secondCommand: ExecuteDecisionTaskCommandV1 = {
      ...secondBase,
      requirementRevision: { ...secondBase.requirementRevision, decisionTaskId: sharedTaskId }
    };

    await module.submit(firstCommand, "user-a");
    await module.submit(secondCommand, "user-b");

    await expect(module.listEvents(sharedTaskId, "user-a")).resolves.toHaveLength(1);
    await expect(module.listEvents(sharedTaskId, "user-b")).resolves.toHaveLength(1);
  });

  it("keeps an accepted task readable after the Module is reopened", async () => {
    const databaseUrl = requireDatabaseUrl();
    const command = buildCommand(`reopen-${randomUUID()}`);
    const firstModule = await openPersistentDecisionTaskModule({
      databaseUrl,
      now: () => new Date("2026-08-23T20:10:00.000Z")
    });
    openModules.push(firstModule);

    const accepted = await firstModule.submit(command, "test-owner");

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

    expect(await reopenedModule.get(command.requirementRevision.decisionTaskId, "test-owner")).toEqual(
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

    const first = await module.submit(command, "test-owner");
    const duplicate = await module.submit(structuredClone(command), "test-owner");

    expect(duplicate).toEqual(first);
  });

  it("does not return another owner's task for a reused execution request", async () => {
    const module = await openPersistentDecisionTaskModule({
      databaseUrl: requireDatabaseUrl()
    });
    openModules.push(module);
    const command = buildCommand(`cross-owner-${randomUUID()}`);
    await module.submit(command, "user-a");

    await expect(module.submit(structuredClone(command), "user-b")).rejects.toEqual(
      new IdempotencyConflictError(command.executionRequestId)
    );
    await expect(
      module.get(command.requirementRevision.decisionTaskId, "user-b")
    ).resolves.toBeUndefined();
  });

  it("rejects the same request identifier when its command changes", async () => {
    const module = await openPersistentDecisionTaskModule({
      databaseUrl: requireDatabaseUrl(),
      now: () => new Date("2026-08-23T20:13:00.000Z")
    });
    openModules.push(module);
    const command = buildCommand("conflict");
    await module.submit(command, "test-owner");

    const changedCommand: ExecuteDecisionTaskCommandV1 = {
      ...command,
      requirementRevision: {
        ...command.requirementRevision,
        submittedText: "同一标识下被篡改的另一条需求"
      }
    };

    await expect(module.submit(changedCommand, "test-owner")).rejects.toEqual(
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
      await expect(module.submit(command, "test-owner")).rejects.toEqual(
        new PersistenceUnavailableError()
      );
      expect(
        await module.get(command.requirementRevision.decisionTaskId, "test-owner")
      ).toBeUndefined();
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
      Array.from({ length: 8 }, async () =>
        module.submit(structuredClone(command), "test-owner")
      )
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
