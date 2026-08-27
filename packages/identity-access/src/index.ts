import {
	createHash,
	randomBytes,
	randomUUID,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";

import { migrateIdentityLifecycleEventTable } from "./lifecycle-schema.js";

export {
	type IdentityLifecycleEvent,
	type IdentityLifecycleEventType,
	type IdentityLifecycleWorkerResult,
	openPostgresIdentityLifecycleWorker,
	type PostgresIdentityLifecycleWorker,
} from "./lifecycle-worker.js";

const scrypt = promisify(scryptCallback);
const loginSessionLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const loginThrottleLifetimeMs = 30 * 1_000;
const accountDeletionWaitMs = 7 * 24 * 60 * 60 * 1_000;
const auditRetentionMs = 180 * 24 * 60 * 60 * 1_000;

export type AccountRole = "USER" | "ADMIN" | "SUPERADMIN";
export type AccountStatus =
	| "ACTIVE"
	| "DISABLED"
	| "PENDING_DELETION"
	| "DELETED";

export type BootstrapSuperadminCommand = Readonly<{
	type: "BOOTSTRAP_SUPERADMIN";
	correlationId: string;
	isLocalRequest: boolean;
	password: string;
	username: string;
}>;

export type CreateInvitationCommand = Readonly<{
	type: "CREATE_INVITATION";
	correlationId: string;
	sessionToken: string;
}>;

export type RegisterWithInvitationCommand = Readonly<{
	type: "REGISTER_WITH_INVITATION";
	correlationId: string;
	invitationCode: string;
	password: string;
	username: string;
}>;

export type LoginCommand = Readonly<{
	type: "LOGIN";
	correlationId: string;
	password: string;
	username: string;
}>;

export type LogoutCurrentCommand = Readonly<{
	type: "LOGOUT_CURRENT";
	correlationId: string;
	sessionToken: string;
}>;

export type LogoutAllCommand = Readonly<{
	type: "LOGOUT_ALL";
	correlationId: string;
	sessionToken: string;
}>;

export type ChangePasswordCommand = Readonly<{
	type: "CHANGE_PASSWORD";
	correlationId: string;
	currentPassword: string;
	newPassword: string;
	sessionToken: string;
}>;

export type CreateAccountCommand = Readonly<{
	type: "CREATE_ACCOUNT";
	correlationId: string;
	role: Exclude<AccountRole, "SUPERADMIN">;
	sessionToken: string;
	username: string;
}>;

export type CompleteTemporaryPasswordChangeCommand = Readonly<{
	type: "COMPLETE_TEMPORARY_PASSWORD_CHANGE";
	correlationId: string;
	newPassword: string;
	sessionToken: string;
}>;

export type ResetAccountPasswordCommand = Readonly<{
	type: "RESET_ACCOUNT_PASSWORD";
	accountId: string;
	correlationId: string;
	sessionToken: string;
}>;

export type RevokeInvitationCommand = Readonly<{
	type: "REVOKE_INVITATION";
	correlationId: string;
	invitationId: string;
	sessionToken: string;
}>;

export type SetAccountRoleCommand = Readonly<{
	type: "SET_ACCOUNT_ROLE";
	accountId: string;
	correlationId: string;
	currentPassword: string;
	role: AccountRole;
	sessionToken: string;
}>;

export type SetAccountStatusCommand = Readonly<{
	type: "SET_ACCOUNT_STATUS";
	accountId: string;
	correlationId: string;
	currentPassword?: string;
	sessionToken: string;
	status: "ACTIVE" | "DISABLED";
}>;

export type RequestSelfDeletionCommand = Readonly<{
	type: "REQUEST_SELF_DELETION";
	correlationId: string;
	currentPassword: string;
	sessionToken: string;
}>;

export type CancelSelfDeletionCommand = Readonly<{
	type: "CANCEL_SELF_DELETION";
	correlationId: string;
	sessionToken: string;
}>;

export type RecoverSuperadminCommand = Readonly<{
	type: "RECOVER_SUPERADMIN";
	correlationId: string;
	isLocalRequest: boolean;
	newPassword: string;
	recoveryCode: string;
}>;

export type RequestAccountDeletionCommand = Readonly<{
	type: "REQUEST_ACCOUNT_DELETION";
	accountId: string;
	correlationId: string;
	currentPassword: string;
	sessionToken: string;
}>;

export type IdentityCommand =
	| BootstrapSuperadminCommand
	| CreateInvitationCommand
	| RegisterWithInvitationCommand
	| LoginCommand
	| LogoutCurrentCommand
	| LogoutAllCommand
	| ChangePasswordCommand
	| CreateAccountCommand
	| CompleteTemporaryPasswordChangeCommand
	| ResetAccountPasswordCommand
	| RevokeInvitationCommand
	| SetAccountRoleCommand
	| SetAccountStatusCommand
	| RequestSelfDeletionCommand
	| CancelSelfDeletionCommand
	| RecoverSuperadminCommand
	| RequestAccountDeletionCommand;

export type IdentityCommandResult =
	| Readonly<{
			ok: true;
			access: "FULL";
			account: Readonly<{
				accountId: string;
				role: AccountRole;
				status: "ACTIVE";
				username: string;
			}>;
			sessionToken: string;
			recoveryCode?: string;
	  }>
	| Readonly<{
			ok: true;
			expiresAt: string;
			invitationCode: string;
			invitationId: string;
	  }>
	| Readonly<{
			ok: true;
			account: Readonly<{
				accountId: string;
				role: Exclude<AccountRole, "SUPERADMIN">;
				status: "ACTIVE";
				username: string;
			}>;
			temporaryPassword: string;
	  }>
	| Readonly<{
			ok: true;
			access: "PASSWORD_CHANGE_REQUIRED";
			account: Readonly<{
				accountId: string;
				role: AccountRole;
				status: "ACTIVE";
				username: string;
			}>;
			sessionToken: string;
	  }>
	| Readonly<{
			ok: true;
			accountId: string;
			temporaryPassword: string;
	  }>
	| Readonly<{
			ok: true;
			account: Readonly<{ accountId: string; role: AccountRole }>;
	  }>
	| Readonly<{
			ok: true;
			account: Readonly<{ accountId: string; status: "ACTIVE" | "DISABLED" }>;
	  }>
	| Readonly<{
			ok: true;
			access: "DELETION_PENDING";
			account: Readonly<{
				accountId: string;
				role: AccountRole;
				status: "PENDING_DELETION";
				username: string;
			}>;
			deletionDueAt: string;
			sessionToken: string;
	  }>
	| Readonly<{
			ok: true;
			accountId: string;
			deletionDueAt: string;
	  }>
	| Readonly<{ ok: true }>
	| Readonly<{
			ok: false;
			code:
				| "BOOTSTRAP_ALREADY_COMPLETE"
				| "BOOTSTRAP_LOCAL_ONLY"
				| "INVITATION_INVALID"
				| "INVALID_CREDENTIALS"
				| "INVALID_PASSWORD"
				| "INVALID_USERNAME"
				| "LOGIN_THROTTLED"
				| "LAST_SUPERADMIN"
				| "REAUTHENTICATION_FAILED"
				| "RECOVERY_INVALID"
				| "RECOVERY_LOCAL_ONLY"
				| "RECOVERY_NOT_ALLOWED"
				| "UNAUTHORIZED"
				| "USERNAME_TAKEN";
			retryAt?: string;
	  }>;

type IdentityCommandFailure = Extract<
	IdentityCommandResult,
	Readonly<{ ok: false }>
>;
type FullAccessResult = Extract<
	IdentityCommandResult,
	Readonly<{ ok: true; access: "FULL" }>
>;
type PasswordChangeRequiredResult = Extract<
	IdentityCommandResult,
	Readonly<{ ok: true; access: "PASSWORD_CHANGE_REQUIRED" }>
>;
type DeletionPendingResult = Extract<
	IdentityCommandResult,
	Readonly<{ ok: true; access: "DELETION_PENDING" }>
>;

export type BootstrapSuperadminResult =
	| (Omit<FullAccessResult, "recoveryCode"> &
			Readonly<{ recoveryCode: string }>)
	| IdentityCommandFailure;
export type CreateInvitationResult =
	| Extract<
			IdentityCommandResult,
			Readonly<{ ok: true; invitationCode: string }>
	  >
	| IdentityCommandFailure;
export type RegisterWithInvitationResult =
	| FullAccessResult
	| IdentityCommandFailure;
export type LoginResult =
	| FullAccessResult
	| PasswordChangeRequiredResult
	| DeletionPendingResult
	| IdentityCommandFailure;
export type LogoutResult = Readonly<{ ok: true }>;
export type LogoutAllResult = LogoutResult | IdentityCommandFailure;
export type ChangePasswordResult = LogoutResult | IdentityCommandFailure;
export type CreateAccountResult =
	| Extract<
			IdentityCommandResult,
			Readonly<{
				ok: true;
				account: Readonly<Record<string, unknown>>;
				temporaryPassword: string;
			}>
	  >
	| IdentityCommandFailure;
export type CompleteTemporaryPasswordChangeResult =
	| FullAccessResult
	| IdentityCommandFailure;
export type ResetAccountPasswordResult =
	| Extract<IdentityCommandResult, Readonly<{ ok: true; accountId: string }>>
	| IdentityCommandFailure;
export type RevokeInvitationResult = LogoutResult | IdentityCommandFailure;
export type SetAccountRoleResult =
	| Extract<
			IdentityCommandResult,
			Readonly<{
				ok: true;
				account: Readonly<{ accountId: string; role: AccountRole }>;
			}>
	  >
	| IdentityCommandFailure;
export type SetAccountStatusResult =
	| Readonly<{
			ok: true;
			account: Readonly<{ accountId: string; status: "ACTIVE" | "DISABLED" }>;
	  }>
	| IdentityCommandFailure;
export type RequestSelfDeletionResult =
	| Extract<
			IdentityCommandResult,
			Readonly<{ ok: true; deletionDueAt: string }>
	  >
	| IdentityCommandFailure;
export type CancelSelfDeletionResult =
	| FullAccessResult
	| IdentityCommandFailure;
export type RecoverSuperadminResult = BootstrapSuperadminResult;
export type RequestAccountDeletionResult = RequestSelfDeletionResult;

export type GetBootstrapStatusQuery = Readonly<{
	type: "GET_BOOTSTRAP_STATUS";
}>;
export type GetCurrentSessionQuery = Readonly<{
	type: "GET_CURRENT_SESSION";
	sessionToken: string;
}>;
export type ListAuditRecordsQuery = Readonly<{
	type: "LIST_AUDIT_RECORDS";
	sessionToken: string;
}>;
export type ListAccountsQuery = Readonly<{
	type: "LIST_ACCOUNTS";
	sessionToken: string;
}>;
export type ListInvitationsQuery = Readonly<{
	type: "LIST_INVITATIONS";
	sessionToken: string;
}>;
export type IdentityQuery =
	| GetBootstrapStatusQuery
	| GetCurrentSessionQuery
	| ListAuditRecordsQuery
	| ListAccountsQuery
	| ListInvitationsQuery;
export type GetBootstrapStatusResult = Readonly<{ required: boolean }>;
export type GetCurrentSessionResult =
	| Readonly<{
			access: "FULL" | "PASSWORD_CHANGE_REQUIRED" | "DELETION_PENDING";
			authenticated: true;
			account: Readonly<{
				accountId: string;
				role: AccountRole;
				status: "ACTIVE" | "PENDING_DELETION";
				username: string;
			}>;
			deletionDueAt?: string;
			principal: Readonly<{
				principalId: string;
				role: AccountRole;
				userId: string;
			}>;
	  }>
	| Readonly<{ authenticated: false }>;
export type AuditRecord = Readonly<{
	action: string;
	actorAccountId: string | null;
	auditId: string;
	correlationId: string;
	object: Readonly<{ id: string; type: string }>;
	occurredAt: string;
	result: "ALLOWED" | "DENIED";
}>;
export type ListAuditRecordsResult =
	| Readonly<{ authorized: true; records: readonly AuditRecord[] }>
	| Readonly<{ authorized: false }>;
export type ListAccountsResult =
	| Readonly<{
			authorized: true;
			accounts: readonly Readonly<{
				accountId: string;
				createdAt: string;
				deletionDueAt: string | null;
				role: AccountRole;
				status: AccountStatus;
				username: string;
			}>[];
	  }>
	| Readonly<{ authorized: false }>;
export type ListInvitationsResult =
	| Readonly<{
			authorized: true;
			invitations: readonly Readonly<{
				createdAt: string;
				expiresAt: string;
				invitationId: string;
				status: "ACTIVE" | "EXPIRED" | "REVOKED" | "USED";
			}>[];
	  }>
	| Readonly<{ authorized: false }>;
export type IdentityQueryResult =
	| GetBootstrapStatusResult
	| GetCurrentSessionResult
	| ListAuditRecordsResult
	| ListAccountsResult
	| ListInvitationsResult;

export interface IdentityAccess {
	execute(
		command: BootstrapSuperadminCommand,
	): Promise<BootstrapSuperadminResult>;
	execute(command: CreateInvitationCommand): Promise<CreateInvitationResult>;
	execute(
		command: RegisterWithInvitationCommand,
	): Promise<RegisterWithInvitationResult>;
	execute(command: LoginCommand): Promise<LoginResult>;
	execute(command: LogoutCurrentCommand): Promise<LogoutResult>;
	execute(command: LogoutAllCommand): Promise<LogoutAllResult>;
	execute(command: ChangePasswordCommand): Promise<ChangePasswordResult>;
	execute(command: CreateAccountCommand): Promise<CreateAccountResult>;
	execute(
		command: CompleteTemporaryPasswordChangeCommand,
	): Promise<CompleteTemporaryPasswordChangeResult>;
	execute(
		command: ResetAccountPasswordCommand,
	): Promise<ResetAccountPasswordResult>;
	execute(command: RevokeInvitationCommand): Promise<RevokeInvitationResult>;
	execute(command: SetAccountRoleCommand): Promise<SetAccountRoleResult>;
	execute(command: SetAccountStatusCommand): Promise<SetAccountStatusResult>;
	execute(
		command: RequestSelfDeletionCommand,
	): Promise<RequestSelfDeletionResult>;
	execute(
		command: CancelSelfDeletionCommand,
	): Promise<CancelSelfDeletionResult>;
	execute(command: RecoverSuperadminCommand): Promise<RecoverSuperadminResult>;
	execute(
		command: RequestAccountDeletionCommand,
	): Promise<RequestAccountDeletionResult>;
	read(query: GetBootstrapStatusQuery): Promise<GetBootstrapStatusResult>;
	read(query: GetCurrentSessionQuery): Promise<GetCurrentSessionResult>;
	read(query: ListAuditRecordsQuery): Promise<ListAuditRecordsResult>;
	read(query: ListAccountsQuery): Promise<ListAccountsResult>;
	read(query: ListInvitationsQuery): Promise<ListInvitationsResult>;
	close(): Promise<void>;
}

type OpenPostgresIdentityAccessOptions = Readonly<{
	databaseUrl: string;
	now?: () => Date;
}>;

export async function openPostgresIdentityAccess(
	options: OpenPostgresIdentityAccessOptions,
): Promise<IdentityAccess> {
	const pool = new Pool({ connectionString: options.databaseUrl });
	try {
		await migrateIdentityAccess(pool);
	} catch (error) {
		await pool.end();
		throw error;
	}
	const now = options.now ?? (() => new Date());
	async function execute(
		command: BootstrapSuperadminCommand,
	): Promise<BootstrapSuperadminResult>;
	async function execute(
		command: CreateInvitationCommand,
	): Promise<CreateInvitationResult>;
	async function execute(
		command: RegisterWithInvitationCommand,
	): Promise<RegisterWithInvitationResult>;
	async function execute(command: LoginCommand): Promise<LoginResult>;
	async function execute(command: LogoutCurrentCommand): Promise<LogoutResult>;
	async function execute(command: LogoutAllCommand): Promise<LogoutAllResult>;
	async function execute(
		command: ChangePasswordCommand,
	): Promise<ChangePasswordResult>;
	async function execute(
		command: CreateAccountCommand,
	): Promise<CreateAccountResult>;
	async function execute(
		command: CompleteTemporaryPasswordChangeCommand,
	): Promise<CompleteTemporaryPasswordChangeResult>;
	async function execute(
		command: ResetAccountPasswordCommand,
	): Promise<ResetAccountPasswordResult>;
	async function execute(
		command: RevokeInvitationCommand,
	): Promise<RevokeInvitationResult>;
	async function execute(
		command: SetAccountRoleCommand,
	): Promise<SetAccountRoleResult>;
	async function execute(
		command: SetAccountStatusCommand,
	): Promise<SetAccountStatusResult>;
	async function execute(
		command: RequestSelfDeletionCommand,
	): Promise<RequestSelfDeletionResult>;
	async function execute(
		command: CancelSelfDeletionCommand,
	): Promise<CancelSelfDeletionResult>;
	async function execute(
		command: RecoverSuperadminCommand,
	): Promise<RecoverSuperadminResult>;
	async function execute(
		command: RequestAccountDeletionCommand,
	): Promise<RequestAccountDeletionResult>;
	async function execute(
		command: IdentityCommand,
	): Promise<IdentityCommandResult> {
		const occurredAt = now();
		const auditActorAccountId =
			"sessionToken" in command
				? await resolveAuditActorAccountId(
						pool,
						command.sessionToken,
						occurredAt,
					)
				: null;
		async function withAudit<T extends IdentityCommandResult>(
			result: T,
			objectType: "ACCOUNT" | "INVITATION" | "LOGIN_SESSION",
			objectId: string,
			actorAccountId = auditActorAccountId,
		): Promise<T> {
			await appendAudit(pool, {
				action: command.type,
				actorAccountId,
				correlationId: command.correlationId,
				objectId,
				objectType,
				occurredAt,
				result: result.ok ? "ALLOWED" : "DENIED",
			});
			return result;
		}
		switch (command.type) {
			case "BOOTSTRAP_SUPERADMIN": {
				if (!isValidUsername(command.username)) {
					return { ok: false, code: "INVALID_USERNAME" };
				}
				if (!isValidPassword(command.password)) {
					return { ok: false, code: "INVALID_PASSWORD" };
				}
				if (!command.isLocalRequest) {
					return { ok: false, code: "BOOTSTRAP_LOCAL_ONLY" };
				}
				const client = await pool.connect();
				try {
					return await bootstrapSuperadmin(client, command, occurredAt);
				} finally {
					client.release();
				}
			}
			case "CREATE_INVITATION":
				return createInvitation(pool, command, occurredAt);
			case "REGISTER_WITH_INVITATION":
				return registerWithInvitation(pool, command, occurredAt);
			case "LOGIN":
				return login(pool, command, occurredAt);
			case "LOGOUT_CURRENT":
				await pool.query(
					`UPDATE identity_login_sessions
					 SET revoked_at = $2
					 WHERE token_hash = $1 AND revoked_at IS NULL`,
					[hashOpaqueSecret(command.sessionToken), occurredAt],
				);
				return withAudit(
					{ ok: true },
					"LOGIN_SESSION",
					auditActorAccountId ?? "unknown",
				);
			case "LOGOUT_ALL": {
				const account = await resolveFullAccessAccount(
					pool,
					command.sessionToken,
					occurredAt,
				);
				if (account === undefined) {
					return withAudit(
						{ ok: false, code: "UNAUTHORIZED" },
						"LOGIN_SESSION",
						"unknown",
					);
				}
				await pool.query(
					`UPDATE identity_login_sessions
					 SET revoked_at = $2
					 WHERE account_id = $1 AND revoked_at IS NULL`,
					[account.accountId, occurredAt],
				);
				return withAudit({ ok: true }, "LOGIN_SESSION", account.accountId);
			}
			case "CHANGE_PASSWORD":
				return withAudit(
					await changePassword(pool, command, occurredAt),
					"ACCOUNT",
					auditActorAccountId ?? "unknown",
				);
			case "CREATE_ACCOUNT": {
				const result = await createAccount(pool, command, occurredAt);
				return withAudit(
					result,
					"ACCOUNT",
					result.ok && "account" in result
						? result.account.accountId
						: normalizeUsername(command.username),
				);
			}
			case "COMPLETE_TEMPORARY_PASSWORD_CHANGE": {
				const result = await completeTemporaryPasswordChange(
					pool,
					command,
					occurredAt,
				);
				return withAudit(
					result,
					"ACCOUNT",
					result.ok && "account" in result
						? result.account.accountId
						: (auditActorAccountId ?? "unknown"),
				);
			}
			case "RESET_ACCOUNT_PASSWORD":
				return withAudit(
					await resetAccountPassword(pool, command, occurredAt),
					"ACCOUNT",
					command.accountId,
				);
			case "REVOKE_INVITATION": {
				const actor = await resolveFullAccessAccount(
					pool,
					command.sessionToken,
					occurredAt,
				);
				if (
					actor === undefined ||
					(actor.role !== "ADMIN" && actor.role !== "SUPERADMIN")
				) {
					return withAudit(
						{ ok: false, code: "UNAUTHORIZED" },
						"INVITATION",
						command.invitationId,
					);
				}
				const revoked = await pool.query(
					`UPDATE identity_invitations
					 SET revoked_at = $2
					 WHERE invitation_id = $1
					   AND revoked_at IS NULL
					   AND used_at IS NULL
					   AND expires_at > $2`,
					[command.invitationId, occurredAt],
				);
				return withAudit(
					revoked.rowCount === 1
						? { ok: true }
						: { ok: false, code: "INVITATION_INVALID" },
					"INVITATION",
					command.invitationId,
				);
			}
			case "SET_ACCOUNT_ROLE":
				return withAudit(
					await setAccountRole(pool, command, occurredAt),
					"ACCOUNT",
					command.accountId,
				);
			case "SET_ACCOUNT_STATUS":
				return withAudit(
					await setAccountStatus(pool, command, occurredAt),
					"ACCOUNT",
					command.accountId,
				);
			case "REQUEST_SELF_DELETION":
				return withAudit(
					await requestSelfDeletion(pool, command, occurredAt),
					"ACCOUNT",
					auditActorAccountId ?? "unknown",
				);
			case "CANCEL_SELF_DELETION": {
				const result = await cancelSelfDeletion(pool, command, occurredAt);
				return withAudit(
					result,
					"ACCOUNT",
					result.ok && "account" in result
						? result.account.accountId
						: (auditActorAccountId ?? "unknown"),
				);
			}
			case "RECOVER_SUPERADMIN": {
				const result = await recoverSuperadmin(pool, command, occurredAt);
				return withAudit(
					result,
					"ACCOUNT",
					result.ok && "account" in result
						? result.account.accountId
						: "unknown",
					result.ok && "account" in result ? result.account.accountId : null,
				);
			}
			case "REQUEST_ACCOUNT_DELETION":
				return withAudit(
					await requestAccountDeletion(pool, command, occurredAt),
					"ACCOUNT",
					command.accountId,
				);
		}
	}
	async function read(
		query: GetBootstrapStatusQuery,
	): Promise<GetBootstrapStatusResult>;
	async function read(
		query: GetCurrentSessionQuery,
	): Promise<GetCurrentSessionResult>;
	async function read(
		query: ListAuditRecordsQuery,
	): Promise<ListAuditRecordsResult>;
	async function read(query: ListAccountsQuery): Promise<ListAccountsResult>;
	async function read(
		query: ListInvitationsQuery,
	): Promise<ListInvitationsResult>;
	async function read(query: IdentityQuery): Promise<IdentityQueryResult> {
		switch (query.type) {
			case "GET_BOOTSTRAP_STATUS": {
				const result = await pool.query<{ account_count: string }>(
					"SELECT COUNT(*)::text AS account_count FROM identity_accounts",
				);
				return { required: result.rows[0]?.account_count === "0" };
			}
			case "GET_CURRENT_SESSION":
				return getCurrentSession(pool, query.sessionToken, now());
			case "LIST_AUDIT_RECORDS":
				return listAuditRecords(pool, query.sessionToken, now());
			case "LIST_ACCOUNTS":
				return listAccounts(pool, query.sessionToken, now());
			case "LIST_INVITATIONS":
				return listInvitations(pool, query.sessionToken, now());
		}
	}

	return {
		execute,
		read,
		async close() {
			await pool.end();
		},
	};
}

async function bootstrapSuperadmin(
	client: PoolClient,
	command: BootstrapSuperadminCommand,
	now: Date,
): Promise<IdentityCommandResult> {
	await client.query("BEGIN");
	try {
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('choicemind-identity-bootstrap', 0))",
		);
		const existing = await client.query<{ account_count: string }>(
			"SELECT COUNT(*)::text AS account_count FROM identity_accounts",
		);
		if (existing.rows[0]?.account_count !== "0") {
			await client.query("ROLLBACK");
			return { ok: false, code: "BOOTSTRAP_ALREADY_COMPLETE" };
		}

		const accountId = randomUUID();
		const sessionId = randomUUID();
		const sessionToken = randomBytes(32).toString("base64url");
		const recoveryCode = formatRecoveryCode(
			randomBytes(12).toString("hex").toUpperCase(),
		);
		const passwordHash = await hashPassword(command.password);
		const sessionExpiresAt = new Date(now.getTime() + loginSessionLifetimeMs);

		await client.query(
			`INSERT INTO identity_accounts (
			   account_id, username, username_key, role, status, password_hash,
			   password_kind, created_at, updated_at
			 ) VALUES ($1, $2, $3, 'SUPERADMIN', 'ACTIVE', $4, 'PERMANENT', $5, $5)`,
			[
				accountId,
				command.username,
				normalizeUsername(command.username),
				passwordHash,
				now,
			],
		);
		await client.query(
			`INSERT INTO identity_recovery_codes (account_id, code_hash, created_at)
			 VALUES ($1, $2, $3)`,
			[accountId, hashOpaqueSecret(recoveryCode), now],
		);
		await client.query(
			`INSERT INTO identity_login_sessions (
			   session_id, account_id, token_hash, created_at, expires_at
			 ) VALUES ($1, $2, $3, $4, $5)`,
			[
				sessionId,
				accountId,
				hashOpaqueSecret(sessionToken),
				now,
				sessionExpiresAt,
			],
		);
		await appendAudit(client, {
			action: "BOOTSTRAP_SUPERADMIN",
			actorAccountId: accountId,
			correlationId: command.correlationId,
			objectId: accountId,
			objectType: "ACCOUNT",
			occurredAt: now,
			result: "ALLOWED",
		});
		await client.query("COMMIT");

		return {
			ok: true,
			access: "FULL",
			account: {
				accountId,
				role: "SUPERADMIN",
				status: "ACTIVE",
				username: command.username,
			},
			recoveryCode,
			sessionToken,
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function recoverSuperadmin(
	pool: Pool,
	command: RecoverSuperadminCommand,
	now: Date,
): Promise<RecoverSuperadminResult> {
	if (!command.isLocalRequest)
		return { ok: false, code: "RECOVERY_LOCAL_ONLY" };
	if (!isValidPassword(command.newPassword))
		return { ok: false, code: "INVALID_PASSWORD" };
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('choicemind-superadmin-recovery', 0))",
		);
		const targetResult = await client.query<{
			account_id: string;
			role: AccountRole;
			status: AccountStatus;
			username: string;
		}>(
			`SELECT account.account_id, account.role, account.status, account.username
			 FROM identity_recovery_codes AS recovery
			 JOIN identity_accounts AS account ON account.account_id = recovery.account_id
			 WHERE recovery.code_hash = $1
			 FOR UPDATE OF recovery, account`,
			[hashOpaqueSecret(command.recoveryCode)],
		);
		const target = targetResult.rows[0];
		if (
			target === undefined ||
			target.role !== "SUPERADMIN" ||
			target.status !== "ACTIVE"
		) {
			await client.query("ROLLBACK");
			return { ok: false, code: "RECOVERY_INVALID" };
		}
		const otherSuperadmins = await client.query<{ account_count: string }>(
			`SELECT COUNT(*)::text AS account_count
			 FROM identity_accounts
			 WHERE role = 'SUPERADMIN'
			   AND status = 'ACTIVE'
			   AND password_kind = 'PERMANENT'
			   AND account_id <> $1`,
			[target.account_id],
		);
		if (otherSuperadmins.rows[0]?.account_count !== "0") {
			await client.query("ROLLBACK");
			return { ok: false, code: "RECOVERY_NOT_ALLOWED" };
		}
		const recoveryCode = formatRecoveryCode(
			randomBytes(12).toString("hex").toUpperCase(),
		);
		await client.query(
			`UPDATE identity_accounts
			 SET password_hash = $2, password_kind = 'PERMANENT', updated_at = $3
			 WHERE account_id = $1`,
			[target.account_id, await hashPassword(command.newPassword), now],
		);
		await client.query(
			"UPDATE identity_recovery_codes SET code_hash = $2, created_at = $3 WHERE account_id = $1",
			[target.account_id, hashOpaqueSecret(recoveryCode), now],
		);
		await client.query(
			`UPDATE identity_login_sessions
			 SET revoked_at = $2
			 WHERE account_id = $1 AND revoked_at IS NULL`,
			[target.account_id, now],
		);
		const sessionToken = await insertLoginSession(
			client,
			target.account_id,
			now,
		);
		await client.query("COMMIT");
		return {
			ok: true,
			access: "FULL",
			account: {
				accountId: target.account_id,
				role: "SUPERADMIN",
				status: "ACTIVE",
				username: target.username,
			},
			recoveryCode,
			sessionToken,
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function migrateIdentityAccess(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('choicemind-identity-access-migration', 0))",
		);
		await client.query(`
			CREATE TABLE IF NOT EXISTS identity_accounts (
				account_id uuid PRIMARY KEY,
				username text NOT NULL,
				username_key text NOT NULL UNIQUE,
				role text NOT NULL CHECK (role IN ('USER', 'ADMIN', 'SUPERADMIN')),
				status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED', 'PENDING_DELETION', 'DELETED')),
				password_hash text NOT NULL,
				password_kind text NOT NULL CHECK (password_kind IN ('PERMANENT', 'TEMPORARY')),
				deletion_requested_at timestamptz,
				deletion_due_at timestamptz,
				created_at timestamptz NOT NULL,
				updated_at timestamptz NOT NULL
			)
		`);
		await client.query(
			"ALTER TABLE identity_accounts ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz",
		);
		await client.query(
			"ALTER TABLE identity_accounts ADD COLUMN IF NOT EXISTS deletion_due_at timestamptz",
		);
		await client.query(`
			CREATE TABLE IF NOT EXISTS identity_recovery_codes (
				account_id uuid PRIMARY KEY REFERENCES identity_accounts(account_id),
				code_hash text NOT NULL,
				created_at timestamptz NOT NULL
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS identity_login_sessions (
				session_id uuid PRIMARY KEY,
				account_id uuid NOT NULL REFERENCES identity_accounts(account_id),
				token_hash text NOT NULL UNIQUE,
				created_at timestamptz NOT NULL,
				expires_at timestamptz NOT NULL,
				revoked_at timestamptz
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS identity_invitations (
				invitation_id uuid PRIMARY KEY,
				code_hash text NOT NULL UNIQUE,
				created_by_account_id uuid NOT NULL REFERENCES identity_accounts(account_id),
				created_at timestamptz NOT NULL,
				expires_at timestamptz NOT NULL,
				revoked_at timestamptz,
				used_at timestamptz,
				used_by_account_id uuid REFERENCES identity_accounts(account_id)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS identity_login_throttles (
				username_key text PRIMARY KEY,
				failed_count integer NOT NULL,
				locked_until timestamptz,
				updated_at timestamptz NOT NULL
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS identity_audit_records (
				audit_id uuid PRIMARY KEY,
				occurred_at timestamptz NOT NULL,
				actor_account_id text,
				action text NOT NULL,
				object_type text NOT NULL,
				object_id text NOT NULL,
				result text NOT NULL CHECK (result IN ('ALLOWED', 'DENIED')),
				correlation_id text NOT NULL
			)
		`);
		await client.query(
			"CREATE INDEX IF NOT EXISTS identity_audit_records_occurred_at_idx ON identity_audit_records (occurred_at DESC)",
		);
		await migrateIdentityLifecycleEventTable(client);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function createInvitation(
	pool: Pool,
	command: CreateInvitationCommand,
	now: Date,
): Promise<IdentityCommandResult> {
	const actor = await resolveFullAccessAccount(pool, command.sessionToken, now);
	if (
		actor === undefined ||
		(actor.role !== "ADMIN" && actor.role !== "SUPERADMIN")
	) {
		return { ok: false, code: "UNAUTHORIZED" };
	}

	const invitationId = randomUUID();
	const invitationCode = formatRecoveryCode(
		randomBytes(12).toString("hex").toUpperCase(),
	);
	const expiresAt = new Date(now.getTime() + loginSessionLifetimeMs);
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		await client.query(
			`INSERT INTO identity_invitations (
			   invitation_id, code_hash, created_by_account_id, created_at, expires_at
			 ) VALUES ($1, $2, $3, $4, $5)`,
			[
				invitationId,
				hashOpaqueSecret(invitationCode),
				actor.accountId,
				now,
				expiresAt,
			],
		);
		await appendAudit(client, {
			action: "CREATE_INVITATION",
			actorAccountId: actor.accountId,
			correlationId: command.correlationId,
			objectId: invitationId,
			objectType: "INVITATION",
			occurredAt: now,
			result: "ALLOWED",
		});
		await client.query("COMMIT");
		return {
			ok: true,
			invitationCode,
			invitationId,
			expiresAt: expiresAt.toISOString(),
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function registerWithInvitation(
	pool: Pool,
	command: RegisterWithInvitationCommand,
	now: Date,
): Promise<IdentityCommandResult> {
	if (!isValidUsername(command.username))
		return { ok: false, code: "INVALID_USERNAME" };
	if (!isValidPassword(command.password))
		return { ok: false, code: "INVALID_PASSWORD" };

	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const invitation = await client.query<{ invitation_id: string }>(
			`SELECT invitation_id
			 FROM identity_invitations
			 WHERE code_hash = $1
			   AND revoked_at IS NULL
			   AND used_at IS NULL
			   AND expires_at > $2
			 FOR UPDATE`,
			[hashOpaqueSecret(command.invitationCode), now],
		);
		const invitationId = invitation.rows[0]?.invitation_id;
		if (invitationId === undefined) {
			await client.query("ROLLBACK");
			return { ok: false, code: "INVITATION_INVALID" };
		}

		const accountId = randomUUID();
		const passwordHash = await hashPassword(command.password);
		try {
			await client.query(
				`INSERT INTO identity_accounts (
				   account_id, username, username_key, role, status, password_hash,
				   password_kind, created_at, updated_at
				 ) VALUES ($1, $2, $3, 'USER', 'ACTIVE', $4, 'PERMANENT', $5, $5)`,
				[
					accountId,
					command.username,
					normalizeUsername(command.username),
					passwordHash,
					now,
				],
			);
		} catch (error) {
			if (isUniqueViolation(error)) {
				await client.query("ROLLBACK");
				return { ok: false, code: "USERNAME_TAKEN" };
			}
			throw error;
		}
		await client.query(
			`UPDATE identity_invitations
			 SET used_at = $2, used_by_account_id = $3
			 WHERE invitation_id = $1`,
			[invitationId, now, accountId],
		);
		const sessionToken = await insertLoginSession(client, accountId, now);
		await appendAudit(client, {
			action: "REGISTER_WITH_INVITATION",
			actorAccountId: accountId,
			correlationId: command.correlationId,
			objectId: accountId,
			objectType: "ACCOUNT",
			occurredAt: now,
			result: "ALLOWED",
		});
		await client.query("COMMIT");

		return {
			ok: true,
			access: "FULL",
			account: {
				accountId,
				role: "USER",
				status: "ACTIVE",
				username: command.username,
			},
			sessionToken,
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function setAccountRole(
	pool: Pool,
	command: SetAccountRoleCommand,
	now: Date,
): Promise<SetAccountRoleResult> {
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const actorResult = await client.query<{
			account_id: string;
			password_hash: string;
			role: AccountRole;
		}>(
			`SELECT account.account_id, account.password_hash, account.role
			 FROM identity_login_sessions AS session
			 JOIN identity_accounts AS account ON account.account_id = session.account_id
			 WHERE session.token_hash = $1
			   AND session.revoked_at IS NULL
			   AND session.expires_at > $2
			   AND account.status = 'ACTIVE'
			   AND account.password_kind = 'PERMANENT'
			 FOR UPDATE OF account`,
			[hashOpaqueSecret(command.sessionToken), now],
		);
		const actor = actorResult.rows[0];
		if (actor === undefined || actor.role !== "SUPERADMIN") {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		if (!(await verifyPassword(command.currentPassword, actor.password_hash))) {
			await client.query("ROLLBACK");
			return { ok: false, code: "REAUTHENTICATION_FAILED" };
		}
		const targetResult = await client.query<{ role: AccountRole }>(
			`SELECT role
			 FROM identity_accounts
			 WHERE account_id = $1 AND status <> 'DELETED'
			 FOR UPDATE`,
			[command.accountId],
		);
		const target = targetResult.rows[0];
		if (target === undefined) {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		if (target.role === "SUPERADMIN" && command.role !== "SUPERADMIN") {
			const otherSuperadmins = await client.query<{ account_count: string }>(
				`SELECT COUNT(*)::text AS account_count
				 FROM identity_accounts
				 WHERE role = 'SUPERADMIN'
				   AND status = 'ACTIVE'
				   AND account_id <> $1`,
				[command.accountId],
			);
			if (otherSuperadmins.rows[0]?.account_count === "0") {
				await client.query("ROLLBACK");
				return { ok: false, code: "LAST_SUPERADMIN" };
			}
		}
		await client.query(
			`UPDATE identity_accounts
			 SET role = $2, updated_at = $3
			 WHERE account_id = $1`,
			[command.accountId, command.role, now],
		);
		await client.query("COMMIT");
		return {
			ok: true,
			account: { accountId: command.accountId, role: command.role },
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function setAccountStatus(
	pool: Pool,
	command: SetAccountStatusCommand,
	now: Date,
): Promise<SetAccountStatusResult> {
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const actorResult = await client.query<{
			account_id: string;
			password_hash: string;
			role: AccountRole;
		}>(
			`SELECT account.account_id, account.password_hash, account.role
			 FROM identity_login_sessions AS session
			 JOIN identity_accounts AS account ON account.account_id = session.account_id
			 WHERE session.token_hash = $1
			   AND session.revoked_at IS NULL
			   AND session.expires_at > $2
			   AND account.status = 'ACTIVE'
			   AND account.password_kind = 'PERMANENT'
			 FOR UPDATE OF account`,
			[hashOpaqueSecret(command.sessionToken), now],
		);
		const actor = actorResult.rows[0];
		if (
			actor === undefined ||
			(actor.role !== "ADMIN" && actor.role !== "SUPERADMIN")
		) {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		const targetResult = await client.query<{
			role: AccountRole;
			status: AccountStatus;
		}>(
			`SELECT role, status
			 FROM identity_accounts
			 WHERE account_id = $1
			 FOR UPDATE`,
			[command.accountId],
		);
		const target = targetResult.rows[0];
		if (
			target === undefined ||
			target.status === "DELETED" ||
			target.status === "PENDING_DELETION" ||
			(actor.role === "ADMIN" && target.role !== "USER")
		) {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		if (target.role === "SUPERADMIN") {
			if (
				actor.role !== "SUPERADMIN" ||
				command.currentPassword === undefined ||
				!(await verifyPassword(command.currentPassword, actor.password_hash))
			) {
				await client.query("ROLLBACK");
				return { ok: false, code: "REAUTHENTICATION_FAILED" };
			}
			if (command.status === "DISABLED") {
				const otherSuperadmins = await client.query<{ account_count: string }>(
					`SELECT COUNT(*)::text AS account_count
					 FROM identity_accounts
					 WHERE role = 'SUPERADMIN'
					   AND status = 'ACTIVE'
					   AND password_kind = 'PERMANENT'
					   AND account_id <> $1`,
					[command.accountId],
				);
				if (otherSuperadmins.rows[0]?.account_count === "0") {
					await client.query("ROLLBACK");
					return { ok: false, code: "LAST_SUPERADMIN" };
				}
			}
		}
		await client.query(
			`UPDATE identity_accounts SET status = $2, updated_at = $3 WHERE account_id = $1`,
			[command.accountId, command.status, now],
		);
		if (command.status === "ACTIVE") {
			await client.query(
				`UPDATE identity_account_lifecycle_events
				 SET cancelled_at = $2
				 WHERE account_id = $1
				   AND event_type = 'RESTRICT_ACCOUNT'
				   AND processed_at IS NULL
				   AND cancelled_at IS NULL`,
				[command.accountId, now],
			);
		}
		if (command.status === "DISABLED") {
			await client.query(
				`UPDATE identity_login_sessions
				 SET revoked_at = $2
				 WHERE account_id = $1 AND revoked_at IS NULL`,
				[command.accountId, now],
			);
			if (target.status !== "DISABLED") {
				await enqueueAccountLifecycleEvent(client, {
					accountId: command.accountId,
					correlationId: command.correlationId,
					eventType: "RESTRICT_ACCOUNT",
					occurredAt: now,
					scheduledAt: now,
				});
			}
		}
		await client.query("COMMIT");
		return {
			ok: true,
			account: { accountId: command.accountId, status: command.status },
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function requestSelfDeletion(
	pool: Pool,
	command: RequestSelfDeletionCommand,
	now: Date,
): Promise<RequestSelfDeletionResult> {
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const accountResult = await client.query<{
			account_id: string;
			deletion_due_at: Date | null;
			password_hash: string;
			role: AccountRole;
		}>(
			`SELECT account.account_id, account.password_hash, account.role
			 FROM identity_login_sessions AS session
			 JOIN identity_accounts AS account ON account.account_id = session.account_id
			 WHERE session.token_hash = $1
			   AND session.revoked_at IS NULL
			   AND session.expires_at > $2
			   AND account.status = 'ACTIVE'
			   AND account.password_kind = 'PERMANENT'
			 FOR UPDATE OF account`,
			[hashOpaqueSecret(command.sessionToken), now],
		);
		const account = accountResult.rows[0];
		if (account === undefined || account.role !== "USER") {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		if (
			!(await verifyPassword(command.currentPassword, account.password_hash))
		) {
			await client.query("ROLLBACK");
			return { ok: false, code: "REAUTHENTICATION_FAILED" };
		}
		const deletionDueAt = new Date(now.getTime() + accountDeletionWaitMs);
		await client.query(
			`UPDATE identity_accounts
			 SET status = 'PENDING_DELETION',
			     deletion_requested_at = $2,
			     deletion_due_at = $3,
			     updated_at = $2
			 WHERE account_id = $1`,
			[account.account_id, now, deletionDueAt],
		);
		await client.query(
			`UPDATE identity_login_sessions
			 SET revoked_at = $2
			 WHERE account_id = $1 AND revoked_at IS NULL`,
			[account.account_id, now],
		);
		await enqueueAccountLifecycleEvent(client, {
			accountId: account.account_id,
			correlationId: command.correlationId,
			eventType: "RESTRICT_ACCOUNT",
			occurredAt: now,
			scheduledAt: now,
		});
		await enqueueAccountLifecycleEvent(client, {
			accountId: account.account_id,
			correlationId: command.correlationId,
			eventType: "DELETE_ACCOUNT",
			occurredAt: now,
			scheduledAt: deletionDueAt,
		});
		await client.query("COMMIT");
		return {
			ok: true,
			accountId: account.account_id,
			deletionDueAt: deletionDueAt.toISOString(),
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function requestAccountDeletion(
	pool: Pool,
	command: RequestAccountDeletionCommand,
	now: Date,
): Promise<RequestAccountDeletionResult> {
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const actorResult = await client.query<{
			account_id: string;
			password_hash: string;
			role: AccountRole;
		}>(
			`SELECT account.account_id, account.password_hash, account.role
			 FROM identity_login_sessions AS session
			 JOIN identity_accounts AS account ON account.account_id = session.account_id
			 WHERE session.token_hash = $1
			   AND session.revoked_at IS NULL
			   AND session.expires_at > $2
			   AND account.status = 'ACTIVE'
			   AND account.password_kind = 'PERMANENT'
			 FOR UPDATE OF account`,
			[hashOpaqueSecret(command.sessionToken), now],
		);
		const actor = actorResult.rows[0];
		if (actor === undefined || actor.role !== "SUPERADMIN") {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		if (!(await verifyPassword(command.currentPassword, actor.password_hash))) {
			await client.query("ROLLBACK");
			return { ok: false, code: "REAUTHENTICATION_FAILED" };
		}
		const targetResult = await client.query<{
			role: AccountRole;
			status: AccountStatus;
		}>(
			`SELECT role, status
			 FROM identity_accounts
			 WHERE account_id = $1
			 FOR UPDATE`,
			[command.accountId],
		);
		const target = targetResult.rows[0];
		if (
			target === undefined ||
			target.role !== "USER" ||
			target.status !== "ACTIVE"
		) {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		const deletionDueAt = new Date(now.getTime() + accountDeletionWaitMs);
		await client.query(
			`UPDATE identity_accounts
			 SET status = 'PENDING_DELETION',
			     deletion_requested_at = $2,
			     deletion_due_at = $3,
			     updated_at = $2
			 WHERE account_id = $1`,
			[command.accountId, now, deletionDueAt],
		);
		await client.query(
			`UPDATE identity_login_sessions
			 SET revoked_at = $2
			 WHERE account_id = $1 AND revoked_at IS NULL`,
			[command.accountId, now],
		);
		await enqueueAccountLifecycleEvent(client, {
			accountId: command.accountId,
			correlationId: command.correlationId,
			eventType: "RESTRICT_ACCOUNT",
			occurredAt: now,
			scheduledAt: now,
		});
		await enqueueAccountLifecycleEvent(client, {
			accountId: command.accountId,
			correlationId: command.correlationId,
			eventType: "DELETE_ACCOUNT",
			occurredAt: now,
			scheduledAt: deletionDueAt,
		});
		await client.query("COMMIT");
		return {
			ok: true,
			accountId: command.accountId,
			deletionDueAt: deletionDueAt.toISOString(),
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function cancelSelfDeletion(
	pool: Pool,
	command: CancelSelfDeletionCommand,
	now: Date,
): Promise<CancelSelfDeletionResult> {
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const accountResult = await client.query<{
			account_id: string;
			role: AccountRole;
			username: string;
		}>(
			`SELECT account.account_id, account.role, account.username
			 FROM identity_login_sessions AS session
			 JOIN identity_accounts AS account ON account.account_id = session.account_id
			 WHERE session.token_hash = $1
			   AND session.revoked_at IS NULL
			   AND session.expires_at > $2
			   AND account.status = 'PENDING_DELETION'
			 FOR UPDATE OF account`,
			[hashOpaqueSecret(command.sessionToken), now],
		);
		const account = accountResult.rows[0];
		if (account === undefined) {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		await client.query(
			`UPDATE identity_accounts
			 SET status = 'ACTIVE',
			     deletion_requested_at = NULL,
			     deletion_due_at = NULL,
			     updated_at = $2
			 WHERE account_id = $1`,
			[account.account_id, now],
		);
		await client.query(
			`UPDATE identity_login_sessions
			 SET revoked_at = $2
			 WHERE account_id = $1 AND revoked_at IS NULL`,
			[account.account_id, now],
		);
		await client.query(
			`UPDATE identity_account_lifecycle_events
			 SET cancelled_at = $2
			 WHERE account_id = $1
			   AND event_type IN ('DELETE_ACCOUNT', 'RESTRICT_ACCOUNT')
			   AND processed_at IS NULL
			   AND cancelled_at IS NULL`,
			[account.account_id, now],
		);
		const sessionToken = await insertLoginSession(
			client,
			account.account_id,
			now,
		);
		await client.query("COMMIT");
		return {
			ok: true,
			access: "FULL",
			account: {
				accountId: account.account_id,
				role: account.role,
				status: "ACTIVE",
				username: account.username,
			},
			sessionToken,
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function createAccount(
	pool: Pool,
	command: CreateAccountCommand,
	now: Date,
): Promise<CreateAccountResult> {
	if (!isValidUsername(command.username))
		return { ok: false, code: "INVALID_USERNAME" };
	const actor = await resolveFullAccessAccount(pool, command.sessionToken, now);
	if (
		actor === undefined ||
		(actor.role !== "ADMIN" && actor.role !== "SUPERADMIN") ||
		(command.role === "ADMIN" && actor.role !== "SUPERADMIN")
	) {
		return { ok: false, code: "UNAUTHORIZED" };
	}
	const accountId = randomUUID();
	const temporaryPassword = randomBytes(18).toString("base64url");
	try {
		await pool.query(
			`INSERT INTO identity_accounts (
			   account_id, username, username_key, role, status, password_hash,
			   password_kind, created_at, updated_at
			 ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, 'TEMPORARY', $6, $6)`,
			[
				accountId,
				command.username,
				normalizeUsername(command.username),
				command.role,
				await hashPassword(temporaryPassword),
				now,
			],
		);
	} catch (error) {
		if (isUniqueViolation(error)) return { ok: false, code: "USERNAME_TAKEN" };
		throw error;
	}
	return {
		ok: true,
		account: {
			accountId,
			role: command.role,
			status: "ACTIVE",
			username: command.username,
		},
		temporaryPassword,
	};
}

async function resetAccountPassword(
	pool: Pool,
	command: ResetAccountPasswordCommand,
	now: Date,
): Promise<ResetAccountPasswordResult> {
	const actor = await resolveFullAccessAccount(pool, command.sessionToken, now);
	if (
		actor === undefined ||
		(actor.role !== "ADMIN" && actor.role !== "SUPERADMIN")
	) {
		return { ok: false, code: "UNAUTHORIZED" };
	}
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const targetResult = await client.query<{
			role: AccountRole;
			status: AccountStatus;
		}>(
			`SELECT role, status
			 FROM identity_accounts
			 WHERE account_id = $1
			 FOR UPDATE`,
			[command.accountId],
		);
		const target = targetResult.rows[0];
		if (
			target === undefined ||
			target.status === "DELETED" ||
			target.role === "SUPERADMIN" ||
			(actor.role === "ADMIN" && target.role !== "USER")
		) {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		const temporaryPassword = randomBytes(18).toString("base64url");
		await client.query(
			`UPDATE identity_accounts
			 SET password_hash = $2, password_kind = 'TEMPORARY', updated_at = $3
			 WHERE account_id = $1`,
			[command.accountId, await hashPassword(temporaryPassword), now],
		);
		await client.query(
			`UPDATE identity_login_sessions
			 SET revoked_at = $2
			 WHERE account_id = $1 AND revoked_at IS NULL`,
			[command.accountId, now],
		);
		await client.query("COMMIT");
		return { ok: true, accountId: command.accountId, temporaryPassword };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function completeTemporaryPasswordChange(
	pool: Pool,
	command: CompleteTemporaryPasswordChangeCommand,
	now: Date,
): Promise<CompleteTemporaryPasswordChangeResult> {
	if (!isValidPassword(command.newPassword))
		return { ok: false, code: "INVALID_PASSWORD" };
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const accountResult = await client.query<{
			account_id: string;
			role: AccountRole;
			username: string;
		}>(
			`SELECT account.account_id, account.role, account.username
			 FROM identity_login_sessions AS session
			 JOIN identity_accounts AS account ON account.account_id = session.account_id
			 WHERE session.token_hash = $1
			   AND session.revoked_at IS NULL
			   AND session.expires_at > $2
			   AND account.status = 'ACTIVE'
			   AND account.password_kind = 'TEMPORARY'
			 FOR UPDATE OF account`,
			[hashOpaqueSecret(command.sessionToken), now],
		);
		const account = accountResult.rows[0];
		if (account === undefined) {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		await client.query(
			`UPDATE identity_accounts
			 SET password_hash = $2, password_kind = 'PERMANENT', updated_at = $3
			 WHERE account_id = $1`,
			[account.account_id, await hashPassword(command.newPassword), now],
		);
		await client.query(
			`UPDATE identity_login_sessions
			 SET revoked_at = $2
			 WHERE account_id = $1 AND revoked_at IS NULL`,
			[account.account_id, now],
		);
		const sessionToken = await insertLoginSession(
			client,
			account.account_id,
			now,
		);
		await client.query("COMMIT");
		return {
			ok: true,
			access: "FULL",
			account: {
				accountId: account.account_id,
				role: account.role,
				status: "ACTIVE",
				username: account.username,
			},
			sessionToken,
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function changePassword(
	pool: Pool,
	command: ChangePasswordCommand,
	now: Date,
): Promise<ChangePasswordResult> {
	if (!isValidPassword(command.newPassword))
		return { ok: false, code: "INVALID_PASSWORD" };
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		const accountResult = await client.query<{
			account_id: string;
			deletion_due_at: Date | null;
			password_hash: string;
		}>(
			`SELECT account.account_id, account.password_hash
			 FROM identity_login_sessions AS session
			 JOIN identity_accounts AS account ON account.account_id = session.account_id
			 WHERE session.token_hash = $1
			   AND session.revoked_at IS NULL
			   AND session.expires_at > $2
			   AND account.status = 'ACTIVE'
			 FOR UPDATE OF account`,
			[hashOpaqueSecret(command.sessionToken), now],
		);
		const account = accountResult.rows[0];
		if (account === undefined) {
			await client.query("ROLLBACK");
			return { ok: false, code: "UNAUTHORIZED" };
		}
		if (
			!(await verifyPassword(command.currentPassword, account.password_hash))
		) {
			await client.query("ROLLBACK");
			return { ok: false, code: "INVALID_CREDENTIALS" };
		}
		await client.query(
			`UPDATE identity_accounts
			 SET password_hash = $2, password_kind = 'PERMANENT', updated_at = $3
			 WHERE account_id = $1`,
			[account.account_id, await hashPassword(command.newPassword), now],
		);
		await client.query(
			`UPDATE identity_login_sessions
			 SET revoked_at = $2
			 WHERE account_id = $1 AND revoked_at IS NULL`,
			[account.account_id, now],
		);
		await client.query("COMMIT");
		return { ok: true };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function login(
	pool: Pool,
	command: LoginCommand,
	now: Date,
): Promise<LoginResult> {
	const usernameKey = normalizeUsername(command.username);
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			[`choicemind-login-${usernameKey}`],
		);
		const throttle = await client.query<{
			failed_count: number;
			locked_until: Date | null;
		}>(
			`SELECT failed_count, locked_until
			 FROM identity_login_throttles
			 WHERE username_key = $1`,
			[usernameKey],
		);
		const throttleState = throttle.rows[0];
		if (
			throttleState?.locked_until !== null &&
			throttleState?.locked_until !== undefined
		) {
			if (throttleState.locked_until.getTime() > now.getTime()) {
				await appendAudit(client, {
					action: "LOGIN",
					actorAccountId: null,
					correlationId: command.correlationId,
					objectId: usernameKey,
					objectType: "ACCOUNT",
					occurredAt: now,
					result: "DENIED",
				});
				await client.query("COMMIT");
				return {
					ok: false,
					code: "LOGIN_THROTTLED",
					retryAt: throttleState.locked_until.toISOString(),
				};
			}
		}

		const accountResult = await client.query<{
			account_id: string;
			deletion_due_at: Date | null;
			password_hash: string;
			password_kind: "PERMANENT" | "TEMPORARY";
			role: AccountRole;
			status: AccountStatus;
			username: string;
		}>(
			`SELECT account_id, deletion_due_at, password_hash, password_kind, role, status, username
			 FROM identity_accounts
			 WHERE username_key = $1`,
			[usernameKey],
		);
		const account = accountResult.rows[0];
		const passwordMatches =
			account === undefined
				? await consumePasswordVerificationCost(command.password)
				: await verifyPassword(command.password, account.password_hash);
		if (
			account === undefined ||
			account.status === "DISABLED" ||
			account.status === "DELETED" ||
			!passwordMatches ||
			(account.status === "PENDING_DELETION" &&
				account.deletion_due_at === null)
		) {
			const failedCount = (throttleState?.failed_count ?? 0) + 1;
			const lockedUntil =
				failedCount >= 5
					? new Date(now.getTime() + loginThrottleLifetimeMs)
					: null;
			await client.query(
				`INSERT INTO identity_login_throttles (
				   username_key, failed_count, locked_until, updated_at
				 ) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (username_key) DO UPDATE
				 SET failed_count = EXCLUDED.failed_count,
				     locked_until = EXCLUDED.locked_until,
				     updated_at = EXCLUDED.updated_at`,
				[usernameKey, failedCount, lockedUntil, now],
			);
			await appendAudit(client, {
				action: "LOGIN",
				actorAccountId: account?.account_id ?? null,
				correlationId: command.correlationId,
				objectId: account?.account_id ?? usernameKey,
				objectType: "ACCOUNT",
				occurredAt: now,
				result: "DENIED",
			});
			await client.query("COMMIT");
			return lockedUntil === null
				? { ok: false, code: "INVALID_CREDENTIALS" }
				: {
						ok: false,
						code: "LOGIN_THROTTLED",
						retryAt: lockedUntil.toISOString(),
					};
		}

		await client.query(
			"DELETE FROM identity_login_throttles WHERE username_key = $1",
			[usernameKey],
		);
		const sessionToken = await insertLoginSession(
			client,
			account.account_id,
			now,
		);
		await appendAudit(client, {
			action: "LOGIN",
			actorAccountId: account.account_id,
			correlationId: command.correlationId,
			objectId: account.account_id,
			objectType: "ACCOUNT",
			occurredAt: now,
			result: "ALLOWED",
		});
		await client.query("COMMIT");
		if (account.status === "PENDING_DELETION") {
			if (account.deletion_due_at === null) {
				throw new Error("待删除账号缺少到期时间");
			}
			return {
				ok: true,
				access: "DELETION_PENDING",
				account: {
					accountId: account.account_id,
					role: account.role,
					status: "PENDING_DELETION",
					username: account.username,
				},
				deletionDueAt: account.deletion_due_at.toISOString(),
				sessionToken,
			};
		}
		return {
			ok: true,
			access:
				account.password_kind === "TEMPORARY"
					? "PASSWORD_CHANGE_REQUIRED"
					: "FULL",
			account: {
				accountId: account.account_id,
				role: account.role,
				status: "ACTIVE",
				username: account.username,
			},
			sessionToken,
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function getCurrentSession(
	pool: Pool,
	sessionToken: string,
	now: Date,
): Promise<GetCurrentSessionResult> {
	const result = await pool.query<{
		account_id: string;
		deletion_due_at: Date | null;
		password_kind: "PERMANENT" | "TEMPORARY";
		role: AccountRole;
		status: "ACTIVE" | "PENDING_DELETION";
		username: string;
	}>(
		`SELECT account.account_id, account.deletion_due_at, account.password_kind,
		        account.role, account.status, account.username
		 FROM identity_login_sessions AS session
		 JOIN identity_accounts AS account ON account.account_id = session.account_id
		 WHERE session.token_hash = $1
		   AND session.revoked_at IS NULL
		   AND session.expires_at > $2
		   AND account.status IN ('ACTIVE', 'PENDING_DELETION')`,
		[hashOpaqueSecret(sessionToken), now],
	);
	const account = result.rows[0];
	if (account === undefined) return { authenticated: false };
	if (
		account.status === "PENDING_DELETION" &&
		account.deletion_due_at === null
	) {
		throw new Error("待删除账号缺少到期时间");
	}
	return {
		access:
			account.status === "PENDING_DELETION"
				? "DELETION_PENDING"
				: account.password_kind === "TEMPORARY"
					? "PASSWORD_CHANGE_REQUIRED"
					: "FULL",
		authenticated: true,
		account: {
			accountId: account.account_id,
			role: account.role,
			status: account.status,
			username: account.username,
		},
		...(account.deletion_due_at === null
			? {}
			: { deletionDueAt: account.deletion_due_at.toISOString() }),
		principal: {
			principalId: account.account_id,
			role: account.role,
			userId: account.account_id,
		},
	};
}

async function listAuditRecords(
	pool: Pool,
	sessionToken: string,
	now: Date,
): Promise<ListAuditRecordsResult> {
	const actor = await resolveFullAccessAccount(pool, sessionToken, now);
	if (actor?.role !== "SUPERADMIN") return { authorized: false };
	await pool.query(
		"DELETE FROM identity_audit_records WHERE occurred_at < $1",
		[new Date(now.getTime() - auditRetentionMs)],
	);
	const result = await pool.query<{
		action: string;
		actor_account_id: string | null;
		audit_id: string;
		correlation_id: string;
		object_id: string;
		object_type: string;
		occurred_at: Date;
		result: "ALLOWED" | "DENIED";
	}>(
		`SELECT audit_id, occurred_at, actor_account_id, action,
		        object_type, object_id, result, correlation_id
		 FROM identity_audit_records
		 ORDER BY occurred_at DESC, audit_id DESC`,
	);
	return {
		authorized: true,
		records: result.rows.map((record) => ({
			action: record.action,
			actorAccountId: record.actor_account_id,
			auditId: record.audit_id,
			correlationId: record.correlation_id,
			object: { id: record.object_id, type: record.object_type },
			occurredAt: record.occurred_at.toISOString(),
			result: record.result,
		})),
	};
}

async function listAccounts(
	pool: Pool,
	sessionToken: string,
	now: Date,
): Promise<ListAccountsResult> {
	const actor = await resolveFullAccessAccount(pool, sessionToken, now);
	if (
		actor === undefined ||
		(actor.role !== "ADMIN" && actor.role !== "SUPERADMIN")
	) {
		return { authorized: false };
	}
	const result = await pool.query<{
		account_id: string;
		created_at: Date;
		deletion_due_at: Date | null;
		role: AccountRole;
		status: AccountStatus;
		username: string;
	}>(
		`SELECT account_id, created_at, deletion_due_at, role, status, username
		 FROM identity_accounts
		 ORDER BY created_at,
		          CASE role WHEN 'SUPERADMIN' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END,
		          account_id`,
	);
	return {
		authorized: true,
		accounts: result.rows.map((account) => ({
			accountId: account.account_id,
			createdAt: account.created_at.toISOString(),
			deletionDueAt: account.deletion_due_at?.toISOString() ?? null,
			role: account.role,
			status: account.status,
			username: account.username,
		})),
	};
}

async function listInvitations(
	pool: Pool,
	sessionToken: string,
	now: Date,
): Promise<ListInvitationsResult> {
	const actor = await resolveFullAccessAccount(pool, sessionToken, now);
	if (
		actor === undefined ||
		(actor.role !== "ADMIN" && actor.role !== "SUPERADMIN")
	) {
		return { authorized: false };
	}
	const result = await pool.query<{
		created_at: Date;
		expires_at: Date;
		invitation_id: string;
		revoked_at: Date | null;
		used_at: Date | null;
	}>(
		`SELECT invitation_id, created_at, expires_at, revoked_at, used_at
		 FROM identity_invitations
		 ORDER BY created_at DESC, invitation_id DESC`,
	);
	return {
		authorized: true,
		invitations: result.rows.map((invitation) => ({
			createdAt: invitation.created_at.toISOString(),
			expiresAt: invitation.expires_at.toISOString(),
			invitationId: invitation.invitation_id,
			status:
				invitation.used_at !== null
					? "USED"
					: invitation.revoked_at !== null
						? "REVOKED"
						: invitation.expires_at.getTime() <= now.getTime()
							? "EXPIRED"
							: "ACTIVE",
		})),
	};
}

async function appendAudit(
	client: Pool | PoolClient,
	record: Readonly<{
		action: string;
		actorAccountId: string | null;
		correlationId: string;
		objectId: string;
		objectType: string;
		occurredAt: Date;
		result: "ALLOWED" | "DENIED";
	}>,
): Promise<void> {
	await client.query(
		`INSERT INTO identity_audit_records (
		   audit_id, occurred_at, actor_account_id, action,
		   object_type, object_id, result, correlation_id
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[
			randomUUID(),
			record.occurredAt,
			record.actorAccountId,
			record.action,
			record.objectType,
			record.objectId,
			record.result,
			record.correlationId,
		],
	);
}

async function resolveFullAccessAccount(
	pool: Pool,
	sessionToken: string,
	now: Date,
): Promise<Readonly<{ accountId: string; role: AccountRole }> | undefined> {
	const result = await pool.query<{ account_id: string; role: AccountRole }>(
		`SELECT account.account_id, account.role
		 FROM identity_login_sessions AS session
		 JOIN identity_accounts AS account ON account.account_id = session.account_id
		 WHERE session.token_hash = $1
		   AND session.revoked_at IS NULL
		   AND session.expires_at > $2
		   AND account.status = 'ACTIVE'
		   AND account.password_kind = 'PERMANENT'`,
		[hashOpaqueSecret(sessionToken), now],
	);
	return result.rows[0] === undefined
		? undefined
		: { accountId: result.rows[0].account_id, role: result.rows[0].role };
}

async function resolveAuditActorAccountId(
	pool: Pool,
	sessionToken: string,
	now: Date,
): Promise<string | null> {
	const result = await pool.query<{ account_id: string }>(
		`SELECT account_id
		 FROM identity_login_sessions
		 WHERE token_hash = $1
		   AND revoked_at IS NULL
		   AND expires_at > $2`,
		[hashOpaqueSecret(sessionToken), now],
	);
	return result.rows[0]?.account_id ?? null;
}

async function insertLoginSession(
	client: PoolClient,
	accountId: string,
	now: Date,
): Promise<string> {
	const sessionToken = randomBytes(32).toString("base64url");
	await client.query(
		`INSERT INTO identity_login_sessions (
		   session_id, account_id, token_hash, created_at, expires_at
		 ) VALUES ($1, $2, $3, $4, $5)`,
		[
			randomUUID(),
			accountId,
			hashOpaqueSecret(sessionToken),
			now,
			new Date(now.getTime() + loginSessionLifetimeMs),
		],
	);
	return sessionToken;
}

async function enqueueAccountLifecycleEvent(
	client: PoolClient,
	event: Readonly<{
		accountId: string;
		correlationId: string;
		eventType: "RESTRICT_ACCOUNT" | "DELETE_ACCOUNT";
		occurredAt: Date;
		scheduledAt: Date;
	}>,
): Promise<void> {
	await client.query(
		`INSERT INTO identity_account_lifecycle_events (
		   event_id, account_id, event_type, correlation_id, occurred_at, scheduled_at
		 ) VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			randomUUID(),
			event.accountId,
			event.eventType,
			event.correlationId,
			event.occurredAt,
			event.scheduledAt,
		],
	);
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "23505"
	);
}

async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const derived = (await scrypt(password, salt, 32)) as Buffer;
	return `scrypt-v1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(
	password: string,
	passwordHash: string,
): Promise<boolean> {
	const [version, saltText, expectedText] = passwordHash.split("$");
	if (
		version !== "scrypt-v1" ||
		saltText === undefined ||
		expectedText === undefined
	) {
		return false;
	}
	const expected = Buffer.from(expectedText, "base64url");
	const actual = (await scrypt(
		password,
		Buffer.from(saltText, "base64url"),
		expected.length,
	)) as Buffer;
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function consumePasswordVerificationCost(
	password: string,
): Promise<boolean> {
	const salt = Buffer.alloc(16, 0);
	await scrypt(password, salt, 32);
	return false;
}

function hashOpaqueSecret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

function normalizeUsername(username: string): string {
	return username.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function isValidUsername(username: string): boolean {
	const length = [...username].length;
	return (
		length >= 2 &&
		length <= 32 &&
		/^[\p{Script=Han}A-Za-z0-9_]+$/u.test(username)
	);
}

function isValidPassword(password: string): boolean {
	return password.length >= 6 && /^[\x21-\x7E]+$/.test(password);
}

function formatRecoveryCode(hex: string): string {
	return hex.match(/.{1,6}/g)?.join("-") ?? hex;
}
