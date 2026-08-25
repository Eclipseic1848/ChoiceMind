import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { inspect } from "node:util";

export type EncryptedCredentialRecord = Readonly<{
  encryptionVersion: "AES_256_GCM_ENVELOPE_V1";
  credentialId: string;
  ownerUserId: string;
  secretType: "PROVIDER_CREDENTIAL" | "SOURCE_CREDENTIAL";
  ciphertext: string;
  ciphertextIv: string;
  ciphertextTag: string;
  wrappedDataKey: string;
  wrappedDataKeyIv: string;
  wrappedDataKeyTag: string;
}>;

export interface CredentialStoragePort {
  save(record: EncryptedCredentialRecord): Promise<void>;
  load(
    credentialId: string,
    ownerUserId: string
  ): Promise<EncryptedCredentialRecord | undefined>;
}

export type StoreCredentialInput = Readonly<{
  credentialId: string;
  ownerUserId: string;
  secret: string;
  secretType: EncryptedCredentialRecord["secretType"];
  actor: SecurityActor;
  correlationId: string;
}>;

export type SecurityActor = Readonly<{
  userId: string;
  role: "USER" | "ADMIN" | "SUPERADMIN";
}>;

export type CredentialAuditRecord = Readonly<{
  actor: SecurityActor;
  action: "CREDENTIAL_STORE" | "CREDENTIAL_USE";
  object: Readonly<{ type: "CREDENTIAL"; id: string }>;
  result: "STARTED" | "ALLOWED" | "DENIED" | "FAILED";
  correlationId: string;
  occurredAt: string;
}>;

export type CredentialVault = Readonly<{
  store(input: StoreCredentialInput): Promise<Readonly<{
    credentialId: string;
    status: "STORED";
  }>>;
  use(
    input: Readonly<{
      credentialId: string;
      ownerUserId: string;
      actor: SecurityActor;
      correlationId: string;
    }>,
    operation: (secret: SecretValue) => Promise<unknown> | unknown
  ): Promise<void>;
}>;

export class SecretValue {
  #plaintext: Buffer | undefined;

  constructor(plaintext: Buffer) {
    this.#plaintext = plaintext;
  }

  reveal(): string {
    if (this.#plaintext === undefined) {
      throw new Error("SECRET_LEASE_EXPIRED");
    }

    return this.#plaintext.toString("utf8");
  }

  toJSON(): never {
    throw new Error("SECRET_SERIALIZATION_FORBIDDEN");
  }

  toString(): string {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "[REDACTED]";
  }

  dispose(): void {
    this.#plaintext?.fill(0);
    this.#plaintext = undefined;
  }
}

export function createCredentialVault(options: Readonly<{
  masterKey: Uint8Array;
  storage: CredentialStoragePort;
  appendAuditRecord(record: CredentialAuditRecord): Promise<void>;
  now?: () => Date;
}>): CredentialVault {
  if (options.masterKey.byteLength !== 32) {
    throw new Error("CredentialVault 主密钥必须是 32 字节");
  }

  const masterKey = Buffer.from(options.masterKey);
  const now = options.now ?? (() => new Date());

  return {
    async store(input) {
      if (input.actor.userId !== input.ownerUserId) {
        await appendCredentialAudit(options, input, "CREDENTIAL_STORE", "DENIED", now());
        throw new Error("CREDENTIAL_OWNER_MISMATCH");
      }
      await appendCredentialAudit(options, input, "CREDENTIAL_STORE", "STARTED", now());
      const dataKey = randomBytes(32);
      const aad = Buffer.from(
        `${input.credentialId}\u0000${input.ownerUserId}\u0000${input.secretType}`,
        "utf8"
      );

      try {
        const encryptedSecret = encrypt(Buffer.from(input.secret, "utf8"), dataKey, aad);
        const encryptedDataKey = encrypt(dataKey, masterKey, aad);
        await options.storage.save({
          encryptionVersion: "AES_256_GCM_ENVELOPE_V1",
          credentialId: input.credentialId,
          ownerUserId: input.ownerUserId,
          secretType: input.secretType,
          ciphertext: encryptedSecret.ciphertext,
          ciphertextIv: encryptedSecret.iv,
          ciphertextTag: encryptedSecret.tag,
          wrappedDataKey: encryptedDataKey.ciphertext,
          wrappedDataKeyIv: encryptedDataKey.iv,
          wrappedDataKeyTag: encryptedDataKey.tag
        });
      } catch {
        await appendCredentialAudit(options, input, "CREDENTIAL_STORE", "FAILED", now());
        throw new Error("CREDENTIAL_STORE_FAILED");
      } finally {
        dataKey.fill(0);
      }
      await appendCredentialAudit(options, input, "CREDENTIAL_STORE", "ALLOWED", now());

      return { credentialId: input.credentialId, status: "STORED" };
    },
    async use(input, operation) {
      if (input.actor.userId !== input.ownerUserId) {
        await appendCredentialAudit(options, input, "CREDENTIAL_USE", "DENIED", now());
        throw new Error("CREDENTIAL_NOT_FOUND");
      }
      await appendCredentialAudit(options, input, "CREDENTIAL_USE", "STARTED", now());
      let record: EncryptedCredentialRecord | undefined;

      try {
        record = await options.storage.load(input.credentialId, input.ownerUserId);
      } catch {
        await appendCredentialAudit(options, input, "CREDENTIAL_USE", "FAILED", now());
        throw new Error("CREDENTIAL_USE_FAILED");
      }

      if (
        record === undefined ||
        record.ownerUserId !== input.ownerUserId ||
        record.credentialId !== input.credentialId
      ) {
        await appendCredentialAudit(options, input, "CREDENTIAL_USE", "DENIED", now());
        throw new Error("CREDENTIAL_NOT_FOUND");
      }

      const aad = Buffer.from(
        `${record.credentialId}\u0000${record.ownerUserId}\u0000${record.secretType}`,
        "utf8"
      );
      let dataKey: Buffer | undefined;
      let secret: SecretValue | undefined;
      let operationError: Error | undefined;

      try {
        dataKey = decrypt(
          record.wrappedDataKey,
          record.wrappedDataKeyIv,
          record.wrappedDataKeyTag,
          masterKey,
          aad
        );
        const plaintext = decrypt(
          record.ciphertext,
          record.ciphertextIv,
          record.ciphertextTag,
          dataKey,
          aad
        );
        secret = new SecretValue(plaintext);
        try {
          await operation(secret);
        } catch {
          operationError = new Error("SECRET_OPERATION_FAILED");
        }
      } catch {
        operationError = new Error("CREDENTIAL_USE_FAILED");
      } finally {
        secret?.dispose();
        dataKey?.fill(0);
      }

      await appendCredentialAudit(
        options,
        input,
        "CREDENTIAL_USE",
        operationError === undefined ? "ALLOWED" : "FAILED",
        now()
      );
      if (operationError !== undefined) {
        throw operationError;
      }
    }
  };
}

async function appendCredentialAudit(
  options: Readonly<{ appendAuditRecord(record: CredentialAuditRecord): Promise<void> }>,
  input: Readonly<{
    credentialId: string;
    actor: SecurityActor;
    correlationId: string;
  }>,
  action: CredentialAuditRecord["action"],
  result: CredentialAuditRecord["result"],
  occurredAt: Date
): Promise<void> {
  await options.appendAuditRecord({
    actor: input.actor,
    action,
    object: { type: "CREDENTIAL", id: input.credentialId },
    result,
    correlationId: input.correlationId,
    occurredAt: occurredAt.toISOString()
  });
}

function encrypt(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function decrypt(
  ciphertext: string,
  iv: string,
  tag: string,
  key: Uint8Array,
  aad: Uint8Array
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final()
  ]);
}

export type RiskPolicyDecision = Readonly<{
  decision: "ALLOW" | "DENY" | "REQUIRE_CONFIRMATION";
  policyVersion: "p0-v1";
}>;

export function evaluateRiskPolicy(input: Readonly<{
  operation:
    | "READ_PUBLIC_SOURCE"
    | "READ_PRIVATE_SOURCE"
    | "INVOKE_PROVIDER"
    | "WRITE_EXTERNAL";
  operationId: string;
  userId: string;
  confirmation?: Readonly<{ operationId: string; userId: string }>;
}>): RiskPolicyDecision {
  if (input.operation === "WRITE_EXTERNAL") {
    return { decision: "DENY", policyVersion: "p0-v1" };
  }

  if (input.operation === "READ_PUBLIC_SOURCE") {
    return { decision: "ALLOW", policyVersion: "p0-v1" };
  }

  const confirmed =
    input.confirmation?.operationId === input.operationId &&
    input.confirmation.userId === input.userId;

  return {
    decision: confirmed ? "ALLOW" : "REQUIRE_CONFIRMATION",
    policyVersion: "p0-v1"
  };
}

export type EgressRecord = Readonly<{
  egressId: string;
  userId: string;
  operationId: string;
  correlationId: string;
  destinationOrigin: string;
  method: string;
  policyVersion: "p0-v1";
  state: "STARTED";
  occurredAt: string;
}>;

export type EgressGuard = ReturnType<typeof createEgressGuard>;

export function createEgressGuard(options: Readonly<{
  appendRecord(record: EgressRecord): Promise<void>;
  nextId: () => string;
  now: () => Date;
}>) {
  return {
    async execute<T>(input: Readonly<{
      userId: string;
      operationId: string;
      operation:
        | "READ_PUBLIC_SOURCE"
        | "READ_PRIVATE_SOURCE"
        | "INVOKE_PROVIDER"
        | "WRITE_EXTERNAL";
      confirmation?: Readonly<{ operationId: string; userId: string }>;
      correlationId: string;
      destinationUrl: string;
      method: string;
      perform: () => Promise<T>;
    }>): Promise<
      | Readonly<{ status: "COMPLETED"; value: T }>
      | Readonly<{ status: "DENY" | "REQUIRE_CONFIRMATION" }>
    > {
      const normalizedMethod = input.method.toUpperCase();
      let operation = input.operation;
      if (
        normalizedMethod !== "GET" &&
        normalizedMethod !== "HEAD" &&
        input.operation !== "INVOKE_PROVIDER"
      ) {
        operation = "WRITE_EXTERNAL";
      }
      const policy = evaluateRiskPolicy({
        operation,
        operationId: input.operationId,
        userId: input.userId,
        ...(input.confirmation === undefined ? {} : { confirmation: input.confirmation })
      });

      if (policy.decision !== "ALLOW") {
        return { status: policy.decision };
      }

      const destination = new URL(input.destinationUrl);
      await options.appendRecord({
        egressId: options.nextId(),
        userId: input.userId,
        operationId: input.operationId,
        correlationId: input.correlationId,
        destinationOrigin: destination.origin,
        method: normalizedMethod,
        policyVersion: policy.policyVersion,
        state: "STARTED",
        occurredAt: options.now().toISOString()
      });

      return { status: "COMPLETED", value: await input.perform() };
    }
  };
}
