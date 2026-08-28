import { randomBytes, randomUUID } from "node:crypto";

import { createCredentialVault } from "@choicemind/security";
import {
  openPersistentDecisionTaskModule,
  type PersistentDecisionTaskModule
} from "@choicemind/task-persistence";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openPostgresSourceAccess,
  type SourceAccess
} from "../../src/index.js";

const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
const auditActor = { userId: "user-a", role: "USER" as const };
const openModules: Array<SourceAccess | PersistentDecisionTaskModule> = [];

beforeEach(async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "TRUNCATE source_login_sessions, source_credentials, encrypted_credentials, audit_records"
    ).catch(() => undefined);
  } finally {
    await client.end();
  }
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("Postgres Source Access", () => {
  it("隔离用户、平台账号与来源，并且普通表不保存 Cookie", async () => {
    const sourceAccess = await openSourceAccess();
    const login = await sourceAccess.execute({
      type: "BEGIN_LOGIN",
      ownerUserId: "user-a",
      sourceId: "xiaohongshu",
      sourceAccountId: "account-a",
      officialLoginUrl: "https://www.xiaohongshu.com/explore",
      correlationId: randomUUID()
    });

    expect(login.status).toBe("WAITING_CHALLENGE");
    const activated = await sourceAccess.execute({
      type: "COMPLETE_LOGIN",
      ownerUserId: "user-a",
      loginSessionId: login.loginSessionId,
      credentialSecret: "sessionid=raw-cookie-must-not-leak",
      correlationId: randomUUID(),
      actor: auditActor
    });
    await expect(
      sourceAccess.execute({
        type: "COMPLETE_LOGIN",
        ownerUserId: "user-a",
        loginSessionId: login.loginSessionId,
        credentialSecret: "sessionid=raw-cookie-must-not-leak",
        correlationId: randomUUID(),
        actor: auditActor
      })
    ).resolves.toEqual(activated);

    await expect(
      sourceAccess.read({
        type: "GET_SOURCE_STATUS",
        ownerUserId: "user-b",
        sourceId: "xiaohongshu",
        sourceAccountId: "account-a"
      })
    ).resolves.toBeUndefined();
    await expect(
      sourceAccess.read({
        type: "GET_SOURCE_STATUS",
        ownerUserId: "user-a",
        sourceId: "xiaohongshu",
        sourceAccountId: "account-a"
      })
    ).resolves.toMatchObject({ status: "ACTIVE" });

    const crossUserActor = { userId: "user-b", role: "USER" as const };
    await expect(
      sourceAccess.execute({
        type: "COMPLETE_LOGIN",
        ownerUserId: "user-a",
        loginSessionId: login.loginSessionId,
        credentialSecret: "must-not-be-used",
        correlationId: randomUUID(),
        actor: crossUserActor
      })
    ).rejects.toThrow("CREDENTIAL_OWNER_MISMATCH");
    await expect(
      sourceAccess.execute({
        type: "REVOKE_CREDENTIAL",
        ownerUserId: "user-a",
        sourceId: "xiaohongshu",
        sourceAccountId: "account-a",
        correlationId: randomUUID(),
        actor: crossUserActor
      })
    ).rejects.toThrow("CREDENTIAL_OWNER_MISMATCH");
    await expect(
      sourceAccess.execute({
        type: "MARK_INVALID",
        ownerUserId: "user-a",
        sourceId: "xiaohongshu",
        sourceAccountId: "account-a",
        correlationId: randomUUID(),
        actor: { userId: "source-worker:worker-a", role: "SYSTEM" }
      })
    ).rejects.toThrow("CREDENTIAL_OWNER_MISMATCH");
    await expect(
      sourceAccess.read({
        type: "GET_SOURCE_STATUS",
        ownerUserId: "user-a",
        sourceId: "xiaohongshu",
        sourceAccountId: "account-a"
      })
    ).resolves.toMatchObject({ status: "ACTIVE" });

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const metadata = JSON.stringify(
        (await client.query("SELECT * FROM source_credentials")).rows
      );
      expect(metadata).not.toContain("raw-cookie-must-not-leak");
      expect(metadata).not.toContain("sessionid=");
      expect((await client.query("SELECT count(*)::int AS count FROM encrypted_credentials")).rows[0]?.count).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("只在回调期间提供短时凭据，并允许失效与主动撤销", async () => {
    const sourceAccess = await openSourceAccess();
    const login = await sourceAccess.execute({
      type: "BEGIN_LOGIN",
      ownerUserId: "user-a",
      sourceId: "douyin",
      sourceAccountId: "primary",
      officialLoginUrl: "https://www.douyin.com/",
      correlationId: randomUUID()
    });
    await sourceAccess.execute({
      type: "COMPLETE_LOGIN",
      ownerUserId: "user-a",
      loginSessionId: login.loginSessionId,
      credentialSecret: "opaque-cookie",
      correlationId: randomUUID(),
      actor: auditActor
    });
    let revealAfterLease: (() => string) | undefined;
    await sourceAccess.withCredential(
      {
        ownerUserId: "user-a",
        sourceId: "douyin",
        sourceAccountId: "primary",
        correlationId: randomUUID(),
        actor: auditActor
      },
      (secret) => {
        expect(secret.reveal()).toBe("opaque-cookie");
        revealAfterLease = () => secret.reveal();
      }
    );
    expect(revealAfterLease).toBeDefined();
    expect(() => revealAfterLease?.()).toThrow("SECRET_LEASE_EXPIRED");

    await sourceAccess.execute({
      type: "MARK_INVALID",
      ownerUserId: "user-a",
      sourceId: "douyin",
      sourceAccountId: "primary",
      correlationId: randomUUID(),
      actor: auditActor
    });
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      expect(
        (await client.query("SELECT count(*)::int AS count FROM encrypted_credentials"))
          .rows[0]?.count
      ).toBe(0);
    } finally {
      await client.end();
    }
    await expect(
      sourceAccess.withCredential(
        {
          ownerUserId: "user-a",
          sourceId: "douyin",
          sourceAccountId: "primary",
          correlationId: randomUUID(),
          actor: auditActor
        },
        () => undefined
      )
    ).rejects.toThrow("SOURCE_LOGIN_REQUIRED");

    const replacementLogin = await sourceAccess.execute({
      type: "BEGIN_LOGIN",
      ownerUserId: "user-a",
      sourceId: "douyin",
      sourceAccountId: "primary",
      officialLoginUrl: "https://www.douyin.com/",
      correlationId: randomUUID()
    });
    await sourceAccess.execute({
      type: "COMPLETE_LOGIN",
      ownerUserId: "user-a",
      loginSessionId: replacementLogin.loginSessionId,
      credentialSecret: "replacement-cookie",
      correlationId: randomUUID(),
      actor: auditActor
    });

    await sourceAccess.execute({
      type: "REVOKE_CREDENTIAL",
      ownerUserId: "user-a",
      sourceId: "douyin",
      sourceAccountId: "primary",
      correlationId: randomUUID(),
      actor: auditActor
    });
    await expect(
      sourceAccess.read({
        type: "GET_SOURCE_STATUS",
        ownerUserId: "user-a",
        sourceId: "douyin",
        sourceAccountId: "primary"
      })
    ).resolves.toMatchObject({ status: "REVOKED" });
    const revokedClient = new Client({ connectionString: databaseUrl });
    await revokedClient.connect();
    try {
      expect(
        (await revokedClient.query("SELECT count(*)::int AS count FROM encrypted_credentials"))
          .rows[0]?.count
      ).toBe(0);
    } finally {
      await revokedClient.end();
    }
  });

  it("同一账号并发完成两个登录时只保留最后一份加密凭据", async () => {
    const sourceAccess = await openSourceAccess();
    const [first, second] = await Promise.all(
      ["first", "second"].map((suffix) =>
        sourceAccess.execute({
          type: "BEGIN_LOGIN",
          ownerUserId: "user-a",
          sourceId: "fixture",
          sourceAccountId: "default",
          officialLoginUrl: `https://example.test/${suffix}`,
          correlationId: randomUUID()
        })
      )
    );
    if (first === undefined || second === undefined) throw new Error("登录会话未创建");
    await Promise.all([
      sourceAccess.execute({
        type: "COMPLETE_LOGIN",
        ownerUserId: "user-a",
        loginSessionId: first.loginSessionId,
        credentialSecret: "first-cookie",
        correlationId: randomUUID(),
        actor: auditActor
      }),
      sourceAccess.execute({
        type: "COMPLETE_LOGIN",
        ownerUserId: "user-a",
        loginSessionId: second.loginSessionId,
        credentialSecret: "second-cookie",
        correlationId: randomUUID(),
        actor: auditActor
      })
    ]);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      expect(
        (await client.query("SELECT count(*)::int AS count FROM encrypted_credentials"))
          .rows[0]?.count
      ).toBe(1);
    } finally {
      await client.end();
    }
  });
});

async function openSourceAccess(): Promise<SourceAccess> {
  const persistence = await openPersistentDecisionTaskModule({ databaseUrl });
  openModules.push(persistence);
  const vault = createCredentialVault({
    masterKey: randomBytes(32),
    storage: {
      save: async (record) => persistence.saveEncryptedCredential(record),
      load: async (credentialId, ownerUserId) =>
        persistence.loadEncryptedCredential(credentialId, ownerUserId),
      delete: async (credentialId, ownerUserId) =>
        persistence.deleteEncryptedCredential(credentialId, ownerUserId)
    },
    appendAuditRecord: async (record) =>
      persistence.appendAuditRecord({
        actor: {
          principalId: record.actor.userId,
          role: record.actor.role,
          userId: record.actor.userId
        },
        action: record.action,
        object: record.object,
        result: record.result,
        correlationId: record.correlationId
      })
  });
  const sourceAccess = await openPostgresSourceAccess({ databaseUrl, vault });
  openModules.push(sourceAccess);
  return sourceAccess;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} 未配置`);
  }
  return value;
}
