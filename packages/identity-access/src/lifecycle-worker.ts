import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { migrateIdentityLifecycleEventTable } from "./lifecycle-schema.js";

const auditRetentionMs = 180 * 24 * 60 * 60 * 1_000;
const auditCleanupIntervalMs = 24 * 60 * 60 * 1_000;

export type IdentityLifecycleEventType = "RESTRICT_ACCOUNT" | "DELETE_ACCOUNT";

export type IdentityLifecycleEvent = Readonly<{
	accountId: string;
	attemptCount: number;
	correlationId: string;
	eventId: string;
	eventType: IdentityLifecycleEventType;
	occurredAt: string;
	scheduledAt: string;
}>;

export type IdentityLifecycleWorkerResult =
	| Readonly<{ status: "IDLE" }>
	| Readonly<{ event: IdentityLifecycleEvent; status: "PROCESSED" }>
	| Readonly<{ status: "RETRY_SCHEDULED" }>;

export type PostgresIdentityLifecycleWorker = Readonly<{
	close(): Promise<void>;
	runOnce(): Promise<IdentityLifecycleWorkerResult>;
}>;

export async function openPostgresIdentityLifecycleWorker(options: {
	databaseUrl: string;
	handle(event: IdentityLifecycleEvent): Promise<unknown>;
	now?: () => Date;
}): Promise<PostgresIdentityLifecycleWorker> {
	const pool = new Pool({ connectionString: options.databaseUrl });
	const now = options.now ?? (() => new Date());
	await migrateIdentityLifecycleEventTable(pool);
	let nextAuditCleanupAt = 0;

	return {
		async close() {
			await pool.end();
		},
		async runOnce() {
			const runAt = now();
			if (runAt.getTime() >= nextAuditCleanupAt) {
				await pool.query(
					"DELETE FROM identity_audit_records WHERE occurred_at < $1",
					[new Date(runAt.getTime() - auditRetentionMs)],
				);
				nextAuditCleanupAt = runAt.getTime() + auditCleanupIntervalMs;
			}
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				const result = await client.query<LifecycleEventRow>(
					`SELECT event_id, account_id, event_type, correlation_id,
					        occurred_at, scheduled_at, attempt_count
					 FROM identity_account_lifecycle_events
					 WHERE processed_at IS NULL
					   AND cancelled_at IS NULL
					   AND scheduled_at <= $1
					 ORDER BY scheduled_at, occurred_at, event_id
					 LIMIT 1
					 FOR UPDATE SKIP LOCKED`,
					[runAt],
				);
				const row = result.rows[0];
				if (row === undefined) {
					await client.query("COMMIT");
					return { status: "IDLE" };
				}

				const event = toIdentityLifecycleEvent(row);
				try {
					await options.handle(event);
				} catch {
					await client.query(
						`UPDATE identity_account_lifecycle_events
						 SET attempt_count = attempt_count + 1, last_attempt_at = $2
						 WHERE event_id = $1`,
						[event.eventId, now()],
					);
					await client.query("COMMIT");
					return { status: "RETRY_SCHEDULED" };
				}

				if (event.eventType === "DELETE_ACCOUNT") {
					await eraseIdentityAccount(client, event.accountId, now());
				}
				await client.query(
					`UPDATE identity_account_lifecycle_events
					 SET processed_at = $2,
					     attempt_count = attempt_count + 1,
					     last_attempt_at = $2
					 WHERE event_id = $1`,
					[event.eventId, now()],
				);
				await client.query("COMMIT");
				return { event, status: "PROCESSED" };
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			} finally {
				client.release();
			}
		},
	};
}

type LifecycleEventRow = Readonly<{
	account_id: string;
	attempt_count: number;
	correlation_id: string;
	event_id: string;
	event_type: IdentityLifecycleEventType;
	occurred_at: Date;
	scheduled_at: Date;
}>;

function toIdentityLifecycleEvent(
	row: LifecycleEventRow,
): IdentityLifecycleEvent {
	return {
		accountId: row.account_id,
		attemptCount: row.attempt_count,
		correlationId: row.correlation_id,
		eventId: row.event_id,
		eventType: row.event_type,
		occurredAt: row.occurred_at.toISOString(),
		scheduledAt: row.scheduled_at.toISOString(),
	};
}

async function eraseIdentityAccount(
	client: PoolClient,
	accountId: string,
	now: Date,
): Promise<void> {
	const accountResult = await client.query<{
		status: string;
		username_key: string;
	}>(
		`SELECT status, username_key
		 FROM identity_accounts
		 WHERE account_id = $1
		 FOR UPDATE`,
		[accountId],
	);
	const account = accountResult.rows[0];
	if (account === undefined || account.status === "DELETED") return;
	if (account.status !== "PENDING_DELETION") {
		throw new Error("只有等待删除的账号可以执行到期擦除");
	}

	const pseudonym = `deleted_${createHash("sha256").update(accountId).digest("hex").slice(0, 16)}`;
	await client.query(
		"DELETE FROM identity_recovery_codes WHERE account_id = $1",
		[accountId],
	);
	await client.query(
		"DELETE FROM identity_login_sessions WHERE account_id = $1",
		[accountId],
	);
	await client.query(
		"DELETE FROM identity_login_throttles WHERE username_key = $1",
		[account.username_key],
	);
	await client.query(
		"UPDATE identity_invitations SET used_by_account_id = NULL WHERE used_by_account_id = $1",
		[accountId],
	);
	await client.query(
		"DELETE FROM identity_invitations WHERE created_by_account_id = $1",
		[accountId],
	);
	await client.query(
		"UPDATE identity_audit_records SET actor_account_id = $2 WHERE actor_account_id = $1",
		[accountId, pseudonym],
	);
	await client.query(
		`UPDATE identity_audit_records
		 SET object_id = $2
		 WHERE object_type = 'ACCOUNT' AND object_id = $1`,
		[accountId, pseudonym],
	);
	await client.query(
		`UPDATE identity_accounts
		 SET username = $2,
		     username_key = $2,
		     status = 'DELETED',
		     password_hash = $3,
		     password_kind = 'PERMANENT',
		     deletion_requested_at = NULL,
		     deletion_due_at = NULL,
		     updated_at = $4
		 WHERE account_id = $1`,
		[accountId, pseudonym, `deleted:${pseudonym}`, now],
	);
}
