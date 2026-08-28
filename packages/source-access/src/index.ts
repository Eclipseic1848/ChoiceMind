import { randomUUID } from "node:crypto";

import type { CredentialVault, SecretValue, SecurityActor } from "@choicemind/security";
import { Pool } from "pg";

export type SourceCredentialStatus =
  | "ACTIVE"
  | "INVALID"
  | "REVOKED";

export type SourceStatus = Readonly<{
  ownerUserId: string;
  sourceId: string;
  sourceAccountId: string;
  status: SourceCredentialStatus;
  updatedAt: string;
}>;

export type SourceLoginSession = Readonly<{
  loginSessionId: string;
  officialLoginUrl: string;
  ownerUserId: string;
  sourceId: string;
  sourceAccountId: string;
  status: "WAITING_CHALLENGE" | "COMPLETED";
  createdAt: string;
  updatedAt: string;
}>;

export type SourceAccessCommand =
  | Readonly<{
      type: "BEGIN_LOGIN";
      ownerUserId: string;
      sourceId: string;
      sourceAccountId: string;
      officialLoginUrl: string;
      correlationId: string;
    }>
  | Readonly<{
      type: "COMPLETE_LOGIN";
      ownerUserId: string;
      loginSessionId: string;
      credentialSecret: string;
      correlationId: string;
      actor: SecurityActor;
    }>
  | Readonly<{
      type: "MARK_INVALID" | "REVOKE_CREDENTIAL";
      ownerUserId: string;
      sourceId: string;
      sourceAccountId: string;
      correlationId: string;
      actor: SecurityActor;
    }>;

export type SourceAccessQuery =
  | Readonly<{
      type: "GET_SOURCE_STATUS";
      ownerUserId: string;
      sourceId: string;
      sourceAccountId: string;
    }>
  | Readonly<{
      type: "LIST_SOURCE_STATUSES";
      ownerUserId: string;
    }>;

export interface SourceAccess {
  execute(command: Extract<SourceAccessCommand, { type: "BEGIN_LOGIN" }>): Promise<SourceLoginSession>;
  execute(command: Extract<SourceAccessCommand, { type: "COMPLETE_LOGIN" }>): Promise<SourceStatus>;
  execute(
    command: Extract<SourceAccessCommand, { type: "MARK_INVALID" | "REVOKE_CREDENTIAL" }>
  ): Promise<SourceStatus | undefined>;
  read(query: Extract<SourceAccessQuery, { type: "GET_SOURCE_STATUS" }>): Promise<SourceStatus | undefined>;
  read(query: Extract<SourceAccessQuery, { type: "LIST_SOURCE_STATUSES" }>): Promise<readonly SourceStatus[]>;
  withCredential(
    input: Readonly<{
      ownerUserId: string;
      sourceId: string;
      sourceAccountId: string;
      correlationId: string;
      actor: SecurityActor;
    }>,
    operation: (secret: SecretValue) => Promise<unknown> | unknown
  ): Promise<void>;
  purgePrivateDataForOwner(ownerUserId: string): Promise<Readonly<{ deleted: number }>>;
  close(): Promise<void>;
}

type CredentialRow = Readonly<{
  credential_id: string;
  owner_user_id: string;
  source_id: string;
  source_account_id: string;
  status: SourceCredentialStatus;
  updated_at: Date;
}>;

type LoginRow = Readonly<{
  login_session_id: string;
  official_login_url: string;
  owner_user_id: string;
  source_id: string;
  source_account_id: string;
  status: "WAITING_CHALLENGE" | "COMPLETED";
  replaced_credential_id: string | null;
  created_at: Date;
  updated_at: Date;
}>;

export async function openPostgresSourceAccess(options: Readonly<{
  databaseUrl: string;
  vault: CredentialVault;
  systemActor?: Readonly<{ userId: string; role: "SYSTEM" }>;
  now?: () => Date;
}>): Promise<SourceAccess> {
  const pool = new Pool({ connectionString: options.databaseUrl });
  try {
    await migrateSourceAccess(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const now = options.now ?? (() => new Date());

  async function execute(command: Extract<SourceAccessCommand, { type: "BEGIN_LOGIN" }>): Promise<SourceLoginSession>;
  async function execute(command: Extract<SourceAccessCommand, { type: "COMPLETE_LOGIN" }>): Promise<SourceStatus>;
  async function execute(
    command: Extract<SourceAccessCommand, { type: "MARK_INVALID" | "REVOKE_CREDENTIAL" }>
  ): Promise<SourceStatus | undefined>;
  async function execute(command: SourceAccessCommand): Promise<SourceLoginSession | SourceStatus | undefined> {
    if (command.type === "BEGIN_LOGIN") {
      const timestamp = now();
      const loginSessionId = randomUUID();
      const result = await pool.query<LoginRow>(
        `INSERT INTO source_login_sessions (
           login_session_id, owner_user_id, source_id, source_account_id,
           official_login_url, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'WAITING_CHALLENGE', $6, $6)
         RETURNING *`,
        [
          loginSessionId,
          command.ownerUserId,
          command.sourceId,
          command.sourceAccountId,
          command.officialLoginUrl,
          timestamp
        ]
      );
      return toLoginSession(requireRow(result.rows[0]));
    }

    assertActorOwnsScope(command.actor, command.ownerUserId, options.systemActor);

    if (command.type === "COMPLETE_LOGIN") {
      const client = await pool.connect();
      let newCredentialId: string | undefined;
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`${command.ownerUserId}\u001f${command.loginSessionId}`]
        );
        const loginResult = await client.query<LoginRow>(
          `SELECT * FROM source_login_sessions
           WHERE login_session_id = $1 AND owner_user_id = $2
           FOR UPDATE`,
          [command.loginSessionId, command.ownerUserId]
        );
        const login = loginResult.rows[0];
        if (login === undefined) {
          throw new Error("SOURCE_LOGIN_SESSION_NOT_FOUND");
        }
        if (login.status === "COMPLETED") {
          const existing = await client.query<CredentialRow>(
            `SELECT * FROM source_credentials
             WHERE owner_user_id = $1 AND source_id = $2 AND source_account_id = $3`,
            [command.ownerUserId, login.source_id, login.source_account_id]
          );
          await client.query("COMMIT");
          if (login.replaced_credential_id !== null) {
            await deleteVaultCredential(
              options.vault,
              login.replaced_credential_id,
              command.ownerUserId,
              command.correlationId,
              command.actor
            );
            await pool.query(
              `UPDATE source_login_sessions SET replaced_credential_id = NULL
               WHERE login_session_id = $1 AND owner_user_id = $2`,
              [command.loginSessionId, command.ownerUserId]
            );
          }
          return toSourceStatus(requireRow(existing.rows[0]));
        }
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`${command.ownerUserId}\u001f${login.source_id}\u001f${login.source_account_id}`]
        );
        const oldCredential = await client.query<CredentialRow>(
          `SELECT * FROM source_credentials
           WHERE owner_user_id = $1 AND source_id = $2 AND source_account_id = $3
           FOR UPDATE`,
          [command.ownerUserId, login.source_id, login.source_account_id]
        );
        const credentialId = randomUUID();
        newCredentialId = credentialId;
        await options.vault.store({
          credentialId,
          ownerUserId: command.ownerUserId,
          secret: command.credentialSecret,
          secretType: "SOURCE_CREDENTIAL",
          actor: command.actor,
          correlationId: command.correlationId
        });
        const timestamp = now();
        const result = await client.query<CredentialRow>(
          `INSERT INTO source_credentials (
             owner_user_id, source_id, source_account_id, credential_id,
             status, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)
           ON CONFLICT (owner_user_id, source_id, source_account_id)
           DO UPDATE SET credential_id = EXCLUDED.credential_id,
                         status = 'ACTIVE', updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [
            command.ownerUserId,
            login.source_id,
            login.source_account_id,
            credentialId,
            timestamp
          ]
        );
        await client.query(
          `UPDATE source_login_sessions
           SET status = 'COMPLETED', replaced_credential_id = $4, updated_at = $3
           WHERE login_session_id = $1 AND owner_user_id = $2`,
          [
            command.loginSessionId,
            command.ownerUserId,
            timestamp,
            oldCredential.rows[0]?.credential_id ?? null
          ]
        );
        await client.query("COMMIT");
        newCredentialId = undefined;
        const oldCredentialId = oldCredential.rows[0]?.credential_id;
        if (oldCredentialId !== undefined && oldCredentialId !== credentialId) {
          await deleteVaultCredential(
            options.vault,
            oldCredentialId,
            command.ownerUserId,
            command.correlationId,
            command.actor
          );
          await pool.query(
            `UPDATE source_login_sessions SET replaced_credential_id = NULL
             WHERE login_session_id = $1 AND owner_user_id = $2`,
            [command.loginSessionId, command.ownerUserId]
          );
        }
        return toSourceStatus(requireRow(result.rows[0]));
      } catch (error) {
        await client.query("ROLLBACK");
        if (newCredentialId !== undefined) {
          await deleteVaultCredential(
            options.vault,
            newCredentialId,
            command.ownerUserId,
            command.correlationId,
            command.actor
          );
        }
        throw error;
      } finally {
        client.release();
      }
    }

    const status: SourceCredentialStatus =
      command.type === "MARK_INVALID" ? "INVALID" : "REVOKED";
    const result = await pool.query<CredentialRow>(
      `UPDATE source_credentials SET status = $4, updated_at = $5
       WHERE owner_user_id = $1 AND source_id = $2 AND source_account_id = $3
       RETURNING *`,
      [command.ownerUserId, command.sourceId, command.sourceAccountId, status, now()]
    );
    if (result.rows[0] !== undefined) {
      await deleteVaultCredential(
        options.vault,
        result.rows[0].credential_id,
        command.ownerUserId,
        command.correlationId,
        command.actor
      );
    }
    return result.rows[0] === undefined ? undefined : toSourceStatus(result.rows[0]);
  }

  async function read(
    query: Extract<SourceAccessQuery, { type: "GET_SOURCE_STATUS" }>
  ): Promise<SourceStatus | undefined>;
  async function read(
    query: Extract<SourceAccessQuery, { type: "LIST_SOURCE_STATUSES" }>
  ): Promise<readonly SourceStatus[]>;
  async function read(query: SourceAccessQuery): Promise<SourceStatus | undefined | readonly SourceStatus[]> {
    if (query.type === "GET_SOURCE_STATUS") {
      const result = await pool.query<CredentialRow>(
        `SELECT * FROM source_credentials
         WHERE owner_user_id = $1 AND source_id = $2 AND source_account_id = $3`,
        [query.ownerUserId, query.sourceId, query.sourceAccountId]
      );
      return result.rows[0] === undefined ? undefined : toSourceStatus(result.rows[0]);
    }
    const result = await pool.query<CredentialRow>(
      `SELECT * FROM source_credentials WHERE owner_user_id = $1
       ORDER BY source_id, source_account_id`,
      [query.ownerUserId]
    );
    return result.rows.map(toSourceStatus);
  }

  return {
    execute,
    read,
    async withCredential(input, operation) {
      assertActorOwnsScope(input.actor, input.ownerUserId, options.systemActor);
      const result = await pool.query<CredentialRow>(
        `SELECT * FROM source_credentials
         WHERE owner_user_id = $1 AND source_id = $2 AND source_account_id = $3`,
        [input.ownerUserId, input.sourceId, input.sourceAccountId]
      );
      const credential = result.rows[0];
      if (credential === undefined || credential.status !== "ACTIVE") {
        throw new Error("SOURCE_LOGIN_REQUIRED");
      }
      await options.vault.use(
        {
          credentialId: credential.credential_id,
          ownerUserId: input.ownerUserId,
          actor: input.actor,
          correlationId: input.correlationId
        },
        operation
      );
    },
    async purgePrivateDataForOwner(ownerUserId) {
      const result = await pool.query(
        `WITH deleted_logins AS (
           DELETE FROM source_login_sessions WHERE owner_user_id = $1 RETURNING 1
         ), deleted_credentials AS (
           DELETE FROM source_credentials WHERE owner_user_id = $1 RETURNING 1
         )
         SELECT (SELECT count(*) FROM deleted_logins) +
                (SELECT count(*) FROM deleted_credentials) AS deleted`,
        [ownerUserId]
      );
      return { deleted: Number(result.rows[0]?.deleted ?? 0) };
    },
    async close() {
      await pool.end();
    }
  };
}

function assertActorOwnsScope(
  actor: SecurityActor,
  ownerUserId: string,
  systemActor: Readonly<{ userId: string; role: "SYSTEM" }> | undefined
): void {
  if (
    actor.role === "SYSTEM"
      ? actor !== systemActor
      : actor.userId !== ownerUserId
  ) {
    throw new Error("CREDENTIAL_OWNER_MISMATCH");
  }
}

async function migrateSourceAccess(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('choicemind-source-access-migration', 0))"
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_login_sessions (
        login_session_id uuid PRIMARY KEY,
        owner_user_id text NOT NULL,
        source_id text NOT NULL,
        source_account_id text NOT NULL,
        official_login_url text NOT NULL,
        status text NOT NULL CHECK (status IN ('WAITING_CHALLENGE', 'COMPLETED')),
        replaced_credential_id text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
    await client.query(`
      ALTER TABLE source_login_sessions
      ADD COLUMN IF NOT EXISTS replaced_credential_id text
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_credentials (
        owner_user_id text NOT NULL,
        source_id text NOT NULL,
        source_account_id text NOT NULL,
        credential_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('ACTIVE', 'INVALID', 'REVOKED')),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (owner_user_id, source_id, source_account_id)
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function toSourceStatus(row: CredentialRow): SourceStatus {
  return {
    ownerUserId: row.owner_user_id,
    sourceId: row.source_id,
    sourceAccountId: row.source_account_id,
    status: row.status,
    updatedAt: row.updated_at.toISOString()
  };
}

function toLoginSession(row: LoginRow): SourceLoginSession {
  return {
    loginSessionId: row.login_session_id,
    officialLoginUrl: row.official_login_url,
    ownerUserId: row.owner_user_id,
    sourceId: row.source_id,
    sourceAccountId: row.source_account_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function requireRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("SOURCE_ACCESS_WRITE_FAILED");
  return row;
}

async function deleteVaultCredential(
  vault: CredentialVault,
  credentialId: string,
  ownerUserId: string,
  correlationId: string,
  actor: SecurityActor
): Promise<void> {
  await vault.delete({
    credentialId,
    ownerUserId,
    actor,
    correlationId
  });
}
