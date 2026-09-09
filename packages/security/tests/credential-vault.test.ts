import { describe, expect, it } from "vitest";
import { createDecipheriv } from "node:crypto";
import { inspect } from "node:util";

import {
  createCredentialVault,
  type EncryptedCredentialRecord
} from "../src/index.js";

describe("CredentialVault", () => {
  it("stores equal secrets with independent encrypted material and no plaintext or master key", async () => {
    const records: EncryptedCredentialRecord[] = [];
    const auditRecords: unknown[] = [];
    const masterKey = Buffer.alloc(32, 7);
    const vault = createCredentialVault({
      masterKey,
      appendAuditRecord: async (record) => { auditRecords.push(record); },
      now: () => new Date("2026-08-24T00:10:00.000Z"),
      storage: {
        async save(record) {
          records.push(record);
        },
        async load() { return undefined; }
      }
    });

    await vault.store({
      credentialId: "credential-a",
      ownerUserId: "user-a",
      secret: "same-private-secret",
      secretType: "PROVIDER_CREDENTIAL",
      actor: { userId: "user-a", role: "USER" },
      correlationId: "correlation-store-a"
    });
    await vault.store({
      credentialId: "credential-b",
      ownerUserId: "user-a",
      secret: "same-private-secret",
      secretType: "PROVIDER_CREDENTIAL",
      actor: { userId: "user-a", role: "USER" },
      correlationId: "correlation-store-b"
    });

    expect(records).toHaveLength(2);
    const [firstRecord, secondRecord] = records;

    if (firstRecord === undefined || secondRecord === undefined) {
      throw new Error("测试必须生成两条凭据密文记录");
    }

    expect(firstRecord.ciphertext).not.toBe(secondRecord.ciphertext);
    expect(firstRecord.wrappedDataKey).not.toBe(secondRecord.wrappedDataKey);
    const firstDataKey = unwrapDataKey(firstRecord, masterKey);
    const secondDataKey = unwrapDataKey(secondRecord, masterKey);
    expect(firstDataKey.equals(secondDataKey)).toBe(false);
    firstDataKey.fill(0);
    secondDataKey.fill(0);
    expect(JSON.stringify(records)).not.toContain("same-private-secret");
    expect(JSON.stringify(records)).not.toContain(masterKey.toString("base64"));
    expect(auditRecords).toEqual([
      expect.objectContaining({ action: "CREDENTIAL_STORE", result: "STARTED" }),
      expect.objectContaining({ action: "CREDENTIAL_STORE", result: "ALLOWED" }),
      expect.objectContaining({ action: "CREDENTIAL_STORE", result: "STARTED" }),
      expect.objectContaining({ action: "CREDENTIAL_STORE", result: "ALLOWED" })
    ]);
    expect(JSON.stringify(auditRecords)).not.toContain("same-private-secret");
  });

  it("keeps a decrypted secret non-serializable, redacted and limited to its use scope", async () => {
    let stored: EncryptedCredentialRecord | undefined;
    const auditRecords: unknown[] = [];
    const vault = createCredentialVault({
      masterKey: Buffer.alloc(32, 9),
      appendAuditRecord: async (record) => { auditRecords.push(record); },
      now: () => new Date("2026-08-24T00:11:00.000Z"),
      storage: {
        async save(record) { stored = record; },
        async load() { return stored; }
      }
    });
    await vault.store({
      credentialId: "credential-scoped",
      ownerUserId: "user-a",
      secret: "private-value-never-serialize",
      secretType: "SOURCE_CREDENTIAL",
      actor: { userId: "user-a", role: "USER" },
      correlationId: "correlation-store-scoped"
    });
    let leasedSecret: { reveal(): string } | undefined;

    const escapedResult = await vault.use(
      {
        credentialId: "credential-scoped",
        ownerUserId: "user-a",
        actor: { userId: "user-a", role: "USER" },
        correlationId: "correlation-use-scoped"
      },
      async (secret) => {
        leasedSecret = secret;
        expect(secret.reveal()).toBe("private-value-never-serialize");
        expect(() => JSON.stringify({ secret })).toThrowError("SECRET_SERIALIZATION_FORBIDDEN");
        expect(String(secret)).toBe("[REDACTED]");
        expect(inspect(secret)).toBe("[REDACTED]");
        expect(new Error(String(secret)).message).toBe("[REDACTED]");
        expect(() =>
          JSON.stringify({ contractType: "run-event", summary: secret })
        ).toThrowError("SECRET_SERIALIZATION_FORBIDDEN");
        return secret.reveal();
      }
    );

    expect(escapedResult).toBeUndefined();
    expect(() => leasedSecret?.reveal()).toThrowError("SECRET_LEASE_EXPIRED");

    await expect(
      vault.use(
        {
          credentialId: "credential-scoped",
          ownerUserId: "user-a",
          actor: { userId: "user-a", role: "USER" },
          correlationId: "correlation-use-failed"
        },
        async (secret) => {
          throw new Error(secret.reveal());
        }
      )
    ).rejects.toThrowError("SECRET_OPERATION_FAILED");
    expect(auditRecords).toEqual([
      expect.objectContaining({ action: "CREDENTIAL_STORE", result: "STARTED" }),
      expect.objectContaining({ action: "CREDENTIAL_STORE", result: "ALLOWED" }),
      expect.objectContaining({ action: "CREDENTIAL_USE", result: "STARTED" }),
      expect.objectContaining({ action: "CREDENTIAL_USE", result: "ALLOWED" }),
      expect.objectContaining({ action: "CREDENTIAL_USE", result: "STARTED" }),
      expect.objectContaining({ action: "CREDENTIAL_USE", result: "FAILED" })
    ]);
    expect(JSON.stringify(auditRecords)).not.toContain("private-value-never-serialize");
  });

  it("does not let an elevated role claim another user's credential owner scope", async () => {
    let stored: EncryptedCredentialRecord | undefined;
    const auditRecords: unknown[] = [];
    const vault = createCredentialVault({
      masterKey: Buffer.alloc(32, 13),
      appendAuditRecord: async (record) => { auditRecords.push(record); },
      storage: {
        async save(record) { stored = record; },
        async load() { return stored; }
      }
    });
    await vault.store({
      credentialId: "credential-owner-a",
      ownerUserId: "user-a",
      secret: "owner-a-secret",
      secretType: "PROVIDER_CREDENTIAL",
      actor: { userId: "user-a", role: "USER" },
      correlationId: "correlation-owner-store"
    });

    await expect(
      vault.use(
        {
          credentialId: "credential-owner-a",
          ownerUserId: "user-a",
          actor: { userId: "admin-b", role: "SUPERADMIN" },
          correlationId: "correlation-owner-denied"
        },
        async () => undefined
      )
    ).rejects.toThrowError("CREDENTIAL_NOT_FOUND");
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        actor: { userId: "admin-b", role: "SUPERADMIN" },
        action: "CREDENTIAL_USE",
        result: "DENIED"
      })
    );
  });

  it("limits configured system access to source credential use and delete", async () => {
    const records = new Map<string, EncryptedCredentialRecord>();
    const systemActor = Object.freeze({
      userId: "source-worker:worker-a",
      role: "SYSTEM" as const
    });
    const vault = createCredentialVault({
      masterKey: Buffer.alloc(32, 21),
      systemAccess: {
        actor: systemActor,
        secretType: "SOURCE_CREDENTIAL",
        actions: ["USE", "DELETE"]
      },
      appendAuditRecord: async () => undefined,
      storage: {
        async save(record) { records.set(record.credentialId, record); },
        async load(credentialId, ownerUserId) {
          const record = records.get(credentialId);
          return record?.ownerUserId === ownerUserId ? record : undefined;
        },
        async delete(credentialId, ownerUserId) {
          const record = records.get(credentialId);
          if (record?.ownerUserId !== ownerUserId) return false;
          return records.delete(credentialId);
        }
      }
    });
    await vault.store({
      credentialId: "source-a",
      ownerUserId: "user-a",
      secret: "source-secret",
      secretType: "SOURCE_CREDENTIAL",
      actor: { userId: "user-a", role: "USER" },
      correlationId: "store-source"
    });
    await vault.store({
      credentialId: "provider-a",
      ownerUserId: "user-a",
      secret: "provider-secret",
      secretType: "PROVIDER_CREDENTIAL",
      actor: { userId: "user-a", role: "USER" },
      correlationId: "store-provider"
    });

    await expect(
      vault.store({
        credentialId: "system-store",
        ownerUserId: "user-a",
        secret: "forbidden",
        secretType: "SOURCE_CREDENTIAL",
        actor: systemActor,
        correlationId: "system-store"
      })
    ).rejects.toThrowError("CREDENTIAL_OWNER_MISMATCH");
    await expect(
      vault.use(
        {
          credentialId: "provider-a",
          ownerUserId: "user-a",
          actor: systemActor,
          correlationId: "system-provider-use"
        },
        async () => undefined
      )
    ).rejects.toThrowError("CREDENTIAL_NOT_FOUND");
    await expect(
      vault.use(
        {
          credentialId: "source-a",
          ownerUserId: "user-a",
          actor: { userId: "source-worker:worker-a", role: "SYSTEM" },
          correlationId: "wrong-system-use"
        },
        async () => undefined
      )
    ).rejects.toThrowError("CREDENTIAL_NOT_FOUND");
    await expect(
      vault.use(
        {
          credentialId: "source-a",
          ownerUserId: "user-a",
          actor: systemActor,
          correlationId: "system-source-use"
        },
        async (secret) => expect(secret.reveal()).toBe("source-secret")
      )
    ).resolves.toBeUndefined();
    await expect(
      vault.delete({
        credentialId: "source-a",
        ownerUserId: "user-a",
        actor: systemActor,
        correlationId: "system-source-delete"
      })
    ).resolves.toEqual({ deleted: true });
    expect(records.has("provider-a")).toBe(true);
  });

  it("limits Provider Routing system access to provider credentials", async () => {
    const records = new Map<string, EncryptedCredentialRecord>();
    const systemActor = Object.freeze({
      userId: "provider-routing:runtime",
      role: "SYSTEM" as const
    });
    const vault = createCredentialVault({
      masterKey: Buffer.alloc(32, 22),
      systemAccess: {
        actor: systemActor,
        secretType: "PROVIDER_CREDENTIAL",
        actions: ["USE", "DELETE"]
      },
      appendAuditRecord: async () => undefined,
      storage: {
        async save(record) { records.set(record.credentialId, record); },
        async load(credentialId, ownerUserId) {
          const record = records.get(credentialId);
          return record?.ownerUserId === ownerUserId ? record : undefined;
        },
        async delete(credentialId, ownerUserId) {
          const record = records.get(credentialId);
          if (record?.ownerUserId !== ownerUserId) return false;
          return records.delete(credentialId);
        }
      }
    });
    await vault.store({
      credentialId: "provider-system-a",
      ownerUserId: "admin-a",
      secret: "provider-secret",
      secretType: "PROVIDER_CREDENTIAL",
      actor: { userId: "admin-a", role: "SUPERADMIN" },
      correlationId: "store-provider-system"
    });
    await vault.store({
      credentialId: "source-system-a",
      ownerUserId: "admin-a",
      secret: "source-secret",
      secretType: "SOURCE_CREDENTIAL",
      actor: { userId: "admin-a", role: "SUPERADMIN" },
      correlationId: "store-source-system"
    });

    await expect(
      vault.use(
        {
          credentialId: "provider-system-a",
          ownerUserId: "admin-a",
          actor: systemActor,
          correlationId: "use-provider-system"
        },
        async (secret) => expect(secret.reveal()).toBe("provider-secret")
      )
    ).resolves.toBeUndefined();
    await expect(
      vault.use(
        {
          credentialId: "source-system-a",
          ownerUserId: "admin-a",
          actor: systemActor,
          correlationId: "deny-source-system"
        },
        async () => undefined
      )
    ).rejects.toThrowError("CREDENTIAL_NOT_FOUND");
  });

  it("does not save or release a secret when the initial audit record fails", async () => {
    let saves = 0;
    let operations = 0;
    let stored: EncryptedCredentialRecord | undefined;
    const vault = createCredentialVault({
      masterKey: Buffer.alloc(32, 15),
      appendAuditRecord: async () => { throw new Error("AUDIT_UNAVAILABLE"); },
      storage: {
        async save(record) { saves += 1; stored = record; },
        async load() { return stored; }
      }
    });

    await expect(
      vault.store({
        credentialId: "credential-audit-required",
        ownerUserId: "user-a",
        secret: "must-not-save",
        secretType: "SOURCE_CREDENTIAL",
        actor: { userId: "user-a", role: "USER" },
        correlationId: "correlation-audit-unavailable-store"
      })
    ).rejects.toThrowError("AUDIT_UNAVAILABLE");
    expect(saves).toBe(0);

    stored = {
      encryptionVersion: "AES_256_GCM_ENVELOPE_V1",
      credentialId: "credential-audit-required",
      ownerUserId: "user-a",
      secretType: "SOURCE_CREDENTIAL",
      ciphertext: "unused",
      ciphertextIv: "unused",
      ciphertextTag: "unused",
      wrappedDataKey: "unused",
      wrappedDataKeyIv: "unused",
      wrappedDataKeyTag: "unused"
    };
    await expect(
      vault.use(
        {
          credentialId: "credential-audit-required",
          ownerUserId: "user-a",
          actor: { userId: "user-a", role: "USER" },
          correlationId: "correlation-audit-unavailable-use"
        },
        async () => { operations += 1; }
      )
    ).rejects.toThrowError("AUDIT_UNAVAILABLE");
    expect(operations).toBe(0);
  });
});

function unwrapDataKey(record: EncryptedCredentialRecord, masterKey: Buffer): Buffer {
  const aad = Buffer.from(
    `${record.credentialId}\u0000${record.ownerUserId}\u0000${record.secretType}`,
    "utf8"
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey,
    Buffer.from(record.wrappedDataKeyIv, "base64")
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(record.wrappedDataKeyTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.wrappedDataKey, "base64")),
    decipher.final()
  ]);
}
