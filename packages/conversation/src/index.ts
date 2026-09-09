import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export type RequirementMissingKey =
	| "CONSUMPTION_GOAL"
	| "PRIMARY_SCENARIO"
	| "HARD_CONSTRAINTS";

export type RequirementRevision = Readonly<{
	revisionId: string;
	revisionNumber: number;
	consumptionGoal: string | null;
	primaryScenario: string | null;
	hardConstraints: readonly string[] | null;
	missingKeys: readonly RequirementMissingKey[];
	readiness: "NEEDS_CLARIFICATION" | "READY_FOR_RESEARCH";
	createdAt: string;
}>;

export type ConversationMessage = Readonly<{
	messageId: string;
	ordinal: number;
	role: "ASSISTANT" | "USER";
	text: string;
	createdAt: string;
}>;

export type ConversationDecisionTaskLink = Readonly<{
	decisionTaskId: string;
	requirementRevisionId?: string | undefined;
	linkedAt: string;
}>;

export type ConversationSession = Readonly<{
	sessionId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: readonly ConversationMessage[];
	currentRequirement: RequirementRevision | null;
	decisionTasks: readonly ConversationDecisionTaskLink[];
}>;

export type ConversationTurnResult = ConversationSession &
	Readonly<{
		turn: Readonly<{
			assistantMessageId: string;
			clientTurnId: string;
			userMessageId: string;
		}>;
	}>;

export type CreateSessionCommand = Readonly<{
	type: "CREATE_SESSION";
	clientRequestId: string;
	ownerUserId: string;
}>;

export type RequirementUpdate = Readonly<{
	consumptionGoal?: string;
	primaryScenario?: string;
	hardConstraints?: readonly string[];
}>;

export type InterpretRequirementInput = Readonly<{
	clientTurnId: string;
	currentRequirement: RequirementRevision | null;
	ownerUserId: string;
	sessionId: string;
	text: string;
}>;

export interface RequirementInterpreter {
	interpret(input: InterpretRequirementInput): Promise<RequirementUpdate>;
}

export type AppendUserTurnCommand = Readonly<{
	type: "APPEND_USER_TURN";
	clientTurnId: string;
	ownerUserId: string;
	sessionId: string;
	text: string;
	requirementUpdate?: RequirementUpdate;
}>;

export type LinkDecisionTaskCommand = Readonly<{
	type: "LINK_DECISION_TASK";
	decisionTaskId: string;
	requirementRevisionId: string;
	ownerUserId: string;
	sessionId: string;
}>;

export type GetSessionQuery = Readonly<{
	type: "GET_SESSION";
	ownerUserId: string;
	sessionId: string;
}>;

export type ConversationSessionSummary = Readonly<{
	sessionId: string;
	title: string;
	latestMessage: string;
	readiness: RequirementRevision["readiness"] | null;
	updatedAt: string;
}>;

export type ListSessionsQuery = Readonly<{
	type: "LIST_SESSIONS";
	ownerUserId: string;
}>;

export type ListRequirementRevisionsQuery = Readonly<{
	type: "LIST_REQUIREMENT_REVISIONS";
	ownerUserId: string;
	sessionId: string;
}>;

export type GetDecisionTaskContextQuery = Readonly<{
	type: "GET_DECISION_TASK_CONTEXT";
	ownerUserId: string;
	decisionTaskId: string;
	requirementRevisionId: string;
}>;

export type ConversationDecisionTaskContext = Readonly<{
	sessionId: string;
	triggerMessage: Readonly<{
		messageId: string;
		text: string;
		createdAt: string;
	}>;
}>;

export interface Conversation {
	execute(command: CreateSessionCommand): Promise<ConversationSession>;
	execute(command: AppendUserTurnCommand): Promise<ConversationTurnResult>;
	execute(command: LinkDecisionTaskCommand): Promise<ConversationSession>;
	read(query: GetSessionQuery): Promise<ConversationSession | undefined>;
	read(
		query: ListSessionsQuery,
	): Promise<readonly ConversationSessionSummary[]>;
	read(
		query: ListRequirementRevisionsQuery,
	): Promise<readonly RequirementRevision[]>;
	read(
		query: GetDecisionTaskContextQuery,
	): Promise<ConversationDecisionTaskContext | undefined>;
	beginPrivateDataDeletionForSession(
		ownerUserId: string,
		sessionId: string,
	): Promise<boolean>;
	completePrivateDataDeletionForSession(
		ownerUserId: string,
		sessionId: string,
	): Promise<boolean>;
	purgePrivateDataForOwner(
		ownerUserId: string,
	): Promise<Readonly<{ deletedSessions: number }>>;
	close(): Promise<void>;
}

type OpenPostgresConversationOptions = Readonly<{
	databaseUrl: string;
	now?: () => Date;
	requirementInterpreter?: RequirementInterpreter;
}>;

type SessionRow = Readonly<{
	session_id: string;
	title: string;
	created_at: Date;
	updated_at: Date;
}>;

type MessageRow = Readonly<{
	message_id: string;
	ordinal: string;
	role: "ASSISTANT" | "USER";
	text: string;
	created_at: Date;
}>;

type RequirementRow = Readonly<{
	revision_id: string;
	revision_number: number;
	consumption_goal: string | null;
	primary_scenario: string | null;
	hard_constraints: unknown;
	missing_keys: unknown;
	readiness: "NEEDS_CLARIFICATION" | "READY_FOR_RESEARCH";
	created_at: Date;
}>;

type SessionSummaryRow = Readonly<{
	session_id: string;
	title: string;
	latest_message: string;
	readiness: RequirementRevision["readiness"] | null;
	updated_at: Date;
}>;

type DecisionTaskLinkRow = Readonly<{
	decision_task_id: string;
	requirement_revision_id: string | null;
	linked_at: Date;
}>;

export async function openPostgresConversation(
	options: OpenPostgresConversationOptions,
): Promise<Conversation> {
	const pool = new Pool({ connectionString: options.databaseUrl });
	try {
		await migrateConversation(pool);
	} catch (error) {
		await pool.end();
		throw error;
	}
	const now = options.now ?? (() => new Date());

	async function execute(
		command: CreateSessionCommand,
	): Promise<ConversationSession>;
	async function execute(
		command: AppendUserTurnCommand,
	): Promise<ConversationTurnResult>;
	async function execute(
		command: LinkDecisionTaskCommand,
	): Promise<ConversationSession>;
	async function execute(
		command:
			| CreateSessionCommand
			| AppendUserTurnCommand
			| LinkDecisionTaskCommand,
	): Promise<ConversationSession> {
		switch (command.type) {
			case "CREATE_SESSION":
				return createSession(pool, command, now());
			case "APPEND_USER_TURN":
				return command.requirementUpdate === undefined
					? appendInterpretedUserTurn(
							pool,
							command,
							options.requirementInterpreter,
							now(),
						)
					: appendUserTurn(pool, command, now());
			case "LINK_DECISION_TASK":
				return linkDecisionTask(pool, command, now());
		}
	}
	async function read(
		query: GetSessionQuery,
	): Promise<ConversationSession | undefined>;
	async function read(
		query: ListSessionsQuery,
	): Promise<readonly ConversationSessionSummary[]>;
	async function read(
		query: ListRequirementRevisionsQuery,
	): Promise<readonly RequirementRevision[]>;
	async function read(
		query: GetDecisionTaskContextQuery,
	): Promise<ConversationDecisionTaskContext | undefined>;
	async function read(
		query:
			| GetSessionQuery
			| ListSessionsQuery
			| ListRequirementRevisionsQuery
			| GetDecisionTaskContextQuery,
	): Promise<
		| ConversationSession
		| ConversationDecisionTaskContext
		| undefined
		| readonly ConversationSessionSummary[]
		| readonly RequirementRevision[]
	> {
		switch (query.type) {
			case "GET_SESSION":
				return loadSession(pool, query.ownerUserId, query.sessionId);
			case "LIST_SESSIONS":
				return listSessions(pool, query.ownerUserId);
			case "LIST_REQUIREMENT_REVISIONS":
				return listRequirementRevisions(
					pool,
					query.ownerUserId,
					query.sessionId,
				);
			case "GET_DECISION_TASK_CONTEXT":
				return loadDecisionTaskContext(pool, query);
		}
	}

	return {
		execute,
		read,
		async beginPrivateDataDeletionForSession(ownerUserId, sessionId) {
			assertOpaqueId(ownerUserId, "ownerUserId");
			assertOpaqueId(sessionId, "sessionId");
			const result = await pool.query(
				`UPDATE conversation_sessions
				 SET private_data_deletion_status = 'DELETING_PRIVATE_DATA'
				 WHERE session_id = $1 AND owner_user_id = $2`,
				[sessionId, ownerUserId],
			);
			return result.rowCount === 1;
		},
		async completePrivateDataDeletionForSession(ownerUserId, sessionId) {
			assertOpaqueId(ownerUserId, "ownerUserId");
			assertOpaqueId(sessionId, "sessionId");
			const result = await pool.query(
				`DELETE FROM conversation_sessions
				 WHERE session_id = $1 AND owner_user_id = $2
				   AND private_data_deletion_status = 'DELETING_PRIVATE_DATA'`,
				[sessionId, ownerUserId],
			);
			return result.rowCount === 1;
		},
		async purgePrivateDataForOwner(ownerUserId) {
			assertOpaqueId(ownerUserId, "ownerUserId");
			const result = await pool.query(
				"DELETE FROM conversation_sessions WHERE owner_user_id = $1",
				[ownerUserId],
			);
			return { deletedSessions: result.rowCount ?? 0 };
		},
		async close() {
			await pool.end();
		},
	};
}

async function migrateConversation(pool: Pool): Promise<void> {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS conversation_sessions (
			session_id uuid PRIMARY KEY,
			owner_user_id text NOT NULL,
			client_request_id text NOT NULL,
			title text NOT NULL,
			created_at timestamptz NOT NULL,
			updated_at timestamptz NOT NULL,
			private_data_deletion_status text NOT NULL DEFAULT 'ACTIVE'
				CHECK (private_data_deletion_status IN ('ACTIVE', 'DELETING_PRIVATE_DATA')),
			UNIQUE (owner_user_id, client_request_id)
		);
		ALTER TABLE conversation_sessions
			ADD COLUMN IF NOT EXISTS private_data_deletion_status text NOT NULL DEFAULT 'ACTIVE'
				CHECK (private_data_deletion_status IN ('ACTIVE', 'DELETING_PRIVATE_DATA'));
		CREATE INDEX IF NOT EXISTS conversation_sessions_owner_updated_idx
			ON conversation_sessions (owner_user_id, updated_at DESC, session_id);

		CREATE TABLE IF NOT EXISTS conversation_messages (
			message_id uuid PRIMARY KEY,
			session_id uuid NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
			owner_user_id text NOT NULL,
			client_turn_id text,
			command_fingerprint text,
			ordinal bigint NOT NULL CHECK (ordinal > 0),
			role text NOT NULL CHECK (role IN ('ASSISTANT', 'USER')),
			text text NOT NULL CHECK (char_length(text) > 0),
			interpretation_status text CHECK (
				interpretation_status IN ('PROCESSING', 'FAILED', 'SUCCEEDED')
			),
			interpretation_attempt_id uuid,
			interpretation_started_at timestamptz,
			interpretation_update jsonb,
			created_at timestamptz NOT NULL,
			UNIQUE (session_id, ordinal),
			UNIQUE (session_id, client_turn_id)
		);
		ALTER TABLE conversation_messages
			ADD COLUMN IF NOT EXISTS command_fingerprint text;
		ALTER TABLE conversation_messages
			ADD COLUMN IF NOT EXISTS interpretation_status text;
		ALTER TABLE conversation_messages
			ADD COLUMN IF NOT EXISTS interpretation_attempt_id uuid;
		ALTER TABLE conversation_messages
			ADD COLUMN IF NOT EXISTS interpretation_started_at timestamptz;
		ALTER TABLE conversation_messages
			ADD COLUMN IF NOT EXISTS interpretation_update jsonb;
		ALTER TABLE conversation_messages
			ADD COLUMN IF NOT EXISTS reply_to_message_id uuid;
		UPDATE conversation_messages
		SET interpretation_status = 'SUCCEEDED'
		WHERE role = 'USER' AND interpretation_status IS NULL;
		CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_reply_idx
			ON conversation_messages (session_id, reply_to_message_id)
			WHERE reply_to_message_id IS NOT NULL;

		CREATE TABLE IF NOT EXISTS conversation_requirement_revisions (
			revision_id uuid PRIMARY KEY,
			session_id uuid NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
			owner_user_id text NOT NULL,
			source_message_id uuid NOT NULL REFERENCES conversation_messages(message_id),
			previous_revision_id uuid REFERENCES conversation_requirement_revisions(revision_id),
			revision_number integer NOT NULL CHECK (revision_number > 0),
			consumption_goal text,
			primary_scenario text,
			hard_constraints jsonb,
			missing_keys jsonb NOT NULL,
			readiness text NOT NULL CHECK (readiness IN ('NEEDS_CLARIFICATION', 'READY_FOR_RESEARCH')),
			created_at timestamptz NOT NULL,
			UNIQUE (session_id, revision_number)
		);
		CREATE INDEX IF NOT EXISTS conversation_requirement_latest_idx
			ON conversation_requirement_revisions (session_id, revision_number DESC);

		CREATE TABLE IF NOT EXISTS conversation_decision_task_links (
			session_id uuid NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
			owner_user_id text NOT NULL,
			decision_task_id text NOT NULL UNIQUE,
			requirement_revision_id text,
			linked_at timestamptz NOT NULL,
			PRIMARY KEY (session_id, decision_task_id)
		);
	`);
	await pool.query(`
		ALTER TABLE conversation_decision_task_links
		ADD COLUMN IF NOT EXISTS requirement_revision_id text
	`);
}

async function createSession(
	pool: Pool,
	command: CreateSessionCommand,
	createdAt: Date,
): Promise<ConversationSession> {
	assertOpaqueId(command.ownerUserId, "ownerUserId");
	assertOpaqueId(command.clientRequestId, "clientRequestId");
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const existing = await client.query<{ session_id: string }>(
			`SELECT session_id
			 FROM conversation_sessions
			 WHERE owner_user_id = $1 AND client_request_id = $2`,
			[command.ownerUserId, command.clientRequestId],
		);
		if (existing.rows[0] !== undefined) {
			await client.query("COMMIT");
			const session = await loadSession(
				pool,
				command.ownerUserId,
				existing.rows[0].session_id,
			);
			if (session === undefined) throw new Error("幂等 Session 无法读取");
			return session;
		}

		const sessionId = randomUUID();
		const inserted = await client.query<{ session_id: string }>(
			`INSERT INTO conversation_sessions (
				session_id, owner_user_id, client_request_id, title, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $5)
			ON CONFLICT (owner_user_id, client_request_id) DO NOTHING
			RETURNING session_id`,
			[
				sessionId,
				command.ownerUserId,
				command.clientRequestId,
				"新的消费决策",
				createdAt,
			],
		);
		if (inserted.rowCount === 0) {
			const concurrent = await client.query<{ session_id: string }>(
				`SELECT session_id
				 FROM conversation_sessions
				 WHERE owner_user_id = $1 AND client_request_id = $2`,
				[command.ownerUserId, command.clientRequestId],
			);
			await client.query("COMMIT");
			const concurrentSessionId = concurrent.rows[0]?.session_id;
			if (concurrentSessionId === undefined) {
				throw new Error("并发幂等 Session 无法读取");
			}
			const concurrentSession = await loadSession(
				pool,
				command.ownerUserId,
				concurrentSessionId,
			);
			if (concurrentSession === undefined) {
				throw new Error("并发幂等 Session 无法读取");
			}
			return concurrentSession;
		}
		await insertMessage(client, {
			createdAt,
			messageId: randomUUID(),
			ordinal: 1,
			ownerUserId: command.ownerUserId,
			role: "ASSISTANT",
			sessionId,
			text: "先告诉我，你这次想解决什么消费问题？",
		});
		await client.query("COMMIT");
		const session = await loadSession(pool, command.ownerUserId, sessionId);
		if (session === undefined) throw new Error("新建 Session 无法读取");
		return session;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

type PreparedInterpretedTurn =
	| Readonly<{ completed: true; messageId: string }>
	| Readonly<{
			attemptId: string;
			completed: false;
			currentRequirement: RequirementRevision | null;
			messageId: string;
			text: string;
	  }>;

async function appendInterpretedUserTurn(
	pool: Pool,
	command: AppendUserTurnCommand,
	requirementInterpreter: RequirementInterpreter | undefined,
	createdAt: Date,
): Promise<ConversationTurnResult> {
	assertOpaqueId(command.ownerUserId, "ownerUserId");
	assertOpaqueId(command.clientTurnId, "clientTurnId");
	assertOpaqueId(command.sessionId, "sessionId");
	const text = normalizeText(command.text, "text");
	const prepared = await prepareInterpretedUserTurn(
		pool,
		command,
		text,
		createdAt,
	);
	if (prepared.completed) {
		const current = await loadSession(
			pool,
			command.ownerUserId,
			command.sessionId,
		);
		if (current === undefined) throw new Error("幂等消息无法读取");
		return toConversationTurnResult(
			pool,
			current,
			command.ownerUserId,
			command.clientTurnId,
			prepared.messageId,
		);
	}

	try {
		if (requirementInterpreter === undefined) {
			throw new ConversationRequirementInterpreterUnavailableError();
		}
		const requirementUpdate = await requirementInterpreter.interpret({
			clientTurnId: command.clientTurnId,
			currentRequirement: prepared.currentRequirement,
			ownerUserId: command.ownerUserId,
			sessionId: command.sessionId,
			text: prepared.text,
		});
		return await completeInterpretedUserTurn(
			pool,
			command,
			prepared.attemptId,
			prepared.messageId,
			requirementUpdate,
			createdAt,
		);
	} catch (error) {
		await markInterpretedUserTurnFailed(
			pool,
			command.ownerUserId,
			command.sessionId,
			command.clientTurnId,
			prepared.attemptId,
		);
		throw error;
	}
}

async function prepareInterpretedUserTurn(
	pool: Pool,
	command: AppendUserTurnCommand,
	text: string,
	createdAt: Date,
): Promise<PreparedInterpretedTurn> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const session = await client.query<SessionRow>(
			`SELECT session_id, title, created_at, updated_at
			 FROM conversation_sessions
			 WHERE session_id = $1 AND owner_user_id = $2
			   AND private_data_deletion_status = 'ACTIVE'
			 FOR UPDATE`,
			[command.sessionId, command.ownerUserId],
		);
		if (session.rows[0] === undefined) throw new ConversationNotFoundError();

		const existing = await client.query<{
			interpretation_attempt_id: string | null;
			interpretation_started_at: Date | null;
			interpretation_status: string | null;
			message_id: string;
			text: string;
		}>(
			`SELECT message_id, text, interpretation_status,
			        interpretation_attempt_id, interpretation_started_at
			 FROM conversation_messages
			 WHERE session_id = $1 AND client_turn_id = $2
			 FOR UPDATE`,
			[command.sessionId, command.clientTurnId],
		);
		const existingTurn = existing.rows[0];
		if (existingTurn !== undefined) {
			if (existingTurn.text !== text) {
				throw new ConversationIdempotencyConflictError(command.clientTurnId);
			}
			if (
				existingTurn.interpretation_status === null ||
				existingTurn.interpretation_status === "SUCCEEDED"
			) {
				await client.query("COMMIT");
				return { completed: true, messageId: existingTurn.message_id };
			}
			if (
				existingTurn.interpretation_status === "PROCESSING" &&
				!interpretationLeaseExpired(
					existingTurn.interpretation_started_at,
					createdAt,
				)
			) {
				throw new ConversationTurnInProgressError(command.clientTurnId);
			}
			const attemptId = randomUUID();
			await client.query(
				`UPDATE conversation_messages
				 SET interpretation_status = 'PROCESSING',
				     interpretation_attempt_id = $2,
				     interpretation_started_at = $3,
				     interpretation_update = NULL
				 WHERE message_id = $1`,
				[existingTurn.message_id, attemptId, createdAt],
			);
			const currentRequirement = await loadLatestRequirement(
				client,
				command.sessionId,
			);
			await client.query("COMMIT");
			return {
				attemptId,
				completed: false,
				currentRequirement,
				messageId: existingTurn.message_id,
				text,
			};
		}

		const latestMessage = await client.query<{ ordinal: string }>(
			`SELECT ordinal
			 FROM conversation_messages
			 WHERE session_id = $1
			 ORDER BY ordinal DESC
			 LIMIT 1`,
			[command.sessionId],
		);
		const userMessageId = randomUUID();
		const attemptId = randomUUID();
		await insertMessage(client, {
			interpretationAttemptId: attemptId,
			interpretationStartedAt: createdAt,
			clientTurnId: command.clientTurnId,
			commandFingerprint: fingerprintUserText(text),
			createdAt,
			interpretationStatus: "PROCESSING",
			messageId: userMessageId,
			ordinal: Number(latestMessage.rows[0]?.ordinal ?? "0") + 1,
			ownerUserId: command.ownerUserId,
			role: "USER",
			sessionId: command.sessionId,
			text,
		});
		await client.query(
			`UPDATE conversation_sessions
			 SET updated_at = $3
			 WHERE session_id = $1 AND owner_user_id = $2`,
			[command.sessionId, command.ownerUserId, createdAt],
		);
		const currentRequirement = await loadLatestRequirement(
			client,
			command.sessionId,
		);
		await client.query("COMMIT");
		return {
			attemptId,
			completed: false,
			currentRequirement,
			messageId: userMessageId,
			text,
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function completeInterpretedUserTurn(
	pool: Pool,
	command: AppendUserTurnCommand,
	attemptId: string,
	messageId: string,
	requirementUpdate: RequirementUpdate,
	createdAt: Date,
): Promise<ConversationTurnResult> {
	const normalizedUpdate = normalizeRequirementUpdate(requirementUpdate);
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const session = await client.query<SessionRow>(
			`SELECT session_id, title, created_at, updated_at
			 FROM conversation_sessions
			 WHERE session_id = $1 AND owner_user_id = $2
			   AND private_data_deletion_status = 'ACTIVE'
			 FOR UPDATE`,
			[command.sessionId, command.ownerUserId],
		);
		if (session.rows[0] === undefined) throw new ConversationNotFoundError();
		const turn = await client.query<{
			interpretation_attempt_id: string | null;
			interpretation_status: string | null;
		}>(
			`SELECT interpretation_status, interpretation_attempt_id
			 FROM conversation_messages
			 WHERE message_id = $1 AND session_id = $2 AND owner_user_id = $3
			 FOR UPDATE`,
			[messageId, command.sessionId, command.ownerUserId],
		);
		const status = turn.rows[0]?.interpretation_status;
		if (status === undefined) throw new ConversationNotFoundError();
		if (
			status !== "PROCESSING" ||
			turn.rows[0]?.interpretation_attempt_id !== attemptId
		) {
			throw new ConversationTurnInProgressError(command.clientTurnId);
		}
		await applyRequirementUpdateForUserMessage(client, {
			createdAt,
			ownerUserId: command.ownerUserId,
			requirementUpdate: normalizedUpdate,
			sessionId: command.sessionId,
			userMessageId: messageId,
		});
		await client.query(
			`UPDATE conversation_messages
			 SET interpretation_status = 'SUCCEEDED', interpretation_update = $2::jsonb
			 WHERE message_id = $1 AND interpretation_attempt_id = $3`,
			[messageId, JSON.stringify(normalizedUpdate), attemptId],
		);
		await client.query("COMMIT");
		const current = await loadSession(
			pool,
			command.ownerUserId,
			command.sessionId,
		);
		if (current === undefined) throw new Error("更新后的 Session 无法读取");
		return toConversationTurnResult(
			pool,
			current,
			command.ownerUserId,
			command.clientTurnId,
			messageId,
		);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function markInterpretedUserTurnFailed(
	pool: Pool,
	ownerUserId: string,
	sessionId: string,
	clientTurnId: string,
	attemptId: string,
): Promise<void> {
	await pool.query(
		`UPDATE conversation_messages
		 SET interpretation_status = 'FAILED'
		 WHERE owner_user_id = $1 AND session_id = $2 AND client_turn_id = $3
		   AND interpretation_status = 'PROCESSING'
		   AND interpretation_attempt_id = $4`,
		[ownerUserId, sessionId, clientTurnId, attemptId],
	);
}

async function appendUserTurn(
	pool: Pool,
	command: AppendUserTurnCommand,
	createdAt: Date,
): Promise<ConversationTurnResult> {
	assertOpaqueId(command.ownerUserId, "ownerUserId");
	assertOpaqueId(command.clientTurnId, "clientTurnId");
	assertOpaqueId(command.sessionId, "sessionId");
	const text = normalizeText(command.text, "text");
	if (command.requirementUpdate === undefined) {
		throw new ConversationValidationError("requirementUpdate 无效");
	}
	const normalizedUpdate = normalizeRequirementUpdate(
		command.requirementUpdate,
	);
	const commandFingerprint = fingerprintUserTurn(text, normalizedUpdate);
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const session = await client.query<SessionRow>(
			`SELECT session_id, title, created_at, updated_at
			 FROM conversation_sessions
			 WHERE session_id = $1 AND owner_user_id = $2
			   AND private_data_deletion_status = 'ACTIVE'
			 FOR UPDATE`,
			[command.sessionId, command.ownerUserId],
		);
		if (session.rows[0] === undefined) {
			throw new ConversationNotFoundError();
		}

		const existingTurn = await client.query<{
			command_fingerprint: string | null;
			message_id: string;
		}>(
			`SELECT message_id, command_fingerprint
			 FROM conversation_messages
			 WHERE session_id = $1 AND client_turn_id = $2`,
			[command.sessionId, command.clientTurnId],
		);
		if (existingTurn.rows[0] !== undefined) {
			if (existingTurn.rows[0].command_fingerprint !== commandFingerprint) {
				throw new ConversationIdempotencyConflictError(command.clientTurnId);
			}
			await client.query("COMMIT");
			const current = await loadSession(
				pool,
				command.ownerUserId,
				command.sessionId,
			);
			if (current === undefined) throw new Error("幂等消息无法读取");
			return toConversationTurnResult(
				pool,
				current,
				command.ownerUserId,
				command.clientTurnId,
				existingTurn.rows[0].message_id,
			);
		}

		const latestMessage = await client.query<{ ordinal: string }>(
			`SELECT ordinal
			 FROM conversation_messages
			 WHERE session_id = $1
			 ORDER BY ordinal DESC
			 LIMIT 1`,
			[command.sessionId],
		);
		const userOrdinal = Number(latestMessage.rows[0]?.ordinal ?? "0") + 1;
		const userMessageId = randomUUID();
		await insertMessage(client, {
			clientTurnId: command.clientTurnId,
			commandFingerprint,
			createdAt,
			messageId: userMessageId,
			ordinal: userOrdinal,
			ownerUserId: command.ownerUserId,
			role: "USER",
			sessionId: command.sessionId,
			text,
		});

		await applyRequirementUpdateForUserMessage(client, {
			createdAt,
			ownerUserId: command.ownerUserId,
			requirementUpdate: normalizedUpdate,
			sessionId: command.sessionId,
			userMessageId,
		});
		await client.query("COMMIT");
		const current = await loadSession(
			pool,
			command.ownerUserId,
			command.sessionId,
		);
		if (current === undefined) throw new Error("更新后的 Session 无法读取");
		return toConversationTurnResult(
			pool,
			current,
			command.ownerUserId,
			command.clientTurnId,
			userMessageId,
		);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function toConversationTurnResult(
	pool: Pool,
	session: ConversationSession,
	ownerUserId: string,
	clientTurnId: string,
	userMessageId: string,
): Promise<ConversationTurnResult> {
	const userMessage = session.messages.find(
		(message) => message.messageId === userMessageId && message.role === "USER",
	);
	const reply = await pool.query<{ message_id: string }>(
		`SELECT message_id
		 FROM conversation_messages
		 WHERE session_id = $1 AND owner_user_id = $2
		   AND role = 'ASSISTANT' AND reply_to_message_id = $3
		 LIMIT 1`,
		[session.sessionId, ownerUserId, userMessageId],
	);
	const replyMessageId = reply.rows[0]?.message_id;
	const assistantMessage =
		replyMessageId === undefined
			? session.messages.find(
					(message) =>
						message.role === "ASSISTANT" &&
						message.ordinal === (userMessage?.ordinal ?? -1) + 1,
				)
			: session.messages.find(
					(message) => message.messageId === replyMessageId,
				);
	if (userMessage === undefined || assistantMessage === undefined) {
		throw new Error("本轮消息身份无法读取");
	}
	return {
		...session,
		turn: {
			assistantMessageId: assistantMessage.messageId,
			clientTurnId,
			userMessageId,
		},
	};
}

async function applyRequirementUpdateForUserMessage(
	client: PoolClient,
	input: Readonly<{
		createdAt: Date;
		ownerUserId: string;
		requirementUpdate: RequirementUpdate;
		sessionId: string;
		userMessageId: string;
	}>,
): Promise<void> {
	const previous = await loadLatestRequirement(client, input.sessionId);
	const nextRequirement = mergeRequirement(previous, input.requirementUpdate);
	if (
		Object.keys(input.requirementUpdate).length > 0 &&
		requirementChanged(previous, nextRequirement)
	) {
		await client.query(
			`INSERT INTO conversation_requirement_revisions (
				revision_id, session_id, owner_user_id, source_message_id,
				previous_revision_id, revision_number, consumption_goal,
				primary_scenario, hard_constraints, missing_keys, readiness, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)`,
			[
				randomUUID(),
				input.sessionId,
				input.ownerUserId,
				input.userMessageId,
				previous?.revisionId ?? null,
				(previous?.revisionNumber ?? 0) + 1,
				nextRequirement.consumptionGoal,
				nextRequirement.primaryScenario,
				nextRequirement.hardConstraints === null
					? null
					: JSON.stringify(nextRequirement.hardConstraints),
				JSON.stringify(nextRequirement.missingKeys),
				nextRequirement.readiness,
				input.createdAt,
			],
		);
	}

	const latestMessage = await client.query<{ ordinal: string }>(
		`SELECT ordinal
		 FROM conversation_messages
		 WHERE session_id = $1
		 ORDER BY ordinal DESC
		 LIMIT 1`,
		[input.sessionId],
	);
	await insertMessage(client, {
		createdAt: input.createdAt,
		messageId: randomUUID(),
		ordinal: Number(latestMessage.rows[0]?.ordinal ?? "0") + 1,
		ownerUserId: input.ownerUserId,
		replyToMessageId: input.userMessageId,
		role: "ASSISTANT",
		sessionId: input.sessionId,
		text: clarificationMessage(nextRequirement.missingKeys),
	});
	await client.query(
		`UPDATE conversation_sessions
		 SET title = CASE WHEN $3::text IS NOT NULL THEN $3::text ELSE title END,
		     updated_at = $4
		 WHERE session_id = $1 AND owner_user_id = $2`,
		[
			input.sessionId,
			input.ownerUserId,
			input.requirementUpdate.consumptionGoal ?? null,
			input.createdAt,
		],
	);
}

async function linkDecisionTask(
	pool: Pool,
	command: LinkDecisionTaskCommand,
	linkedAt: Date,
): Promise<ConversationSession> {
	assertOpaqueId(command.ownerUserId, "ownerUserId");
	assertOpaqueId(command.sessionId, "sessionId");
	assertOpaqueId(command.decisionTaskId, "decisionTaskId");
	assertOpaqueId(command.requirementRevisionId, "requirementRevisionId");
	const result = await pool.query(
		`INSERT INTO conversation_decision_task_links (
			session_id, owner_user_id, decision_task_id, requirement_revision_id, linked_at
		)
		SELECT session.session_id, session.owner_user_id, $3, revision.revision_id::text, $5
		FROM conversation_sessions session
		JOIN conversation_requirement_revisions revision
		  ON revision.session_id = session.session_id
		 AND revision.owner_user_id = session.owner_user_id
		 AND revision.revision_id::text = $4
		WHERE session.session_id = $1 AND session.owner_user_id = $2
		  AND session.private_data_deletion_status = 'ACTIVE'
		ON CONFLICT DO NOTHING`,
		[
			command.sessionId,
			command.ownerUserId,
			command.decisionTaskId,
			command.requirementRevisionId,
			linkedAt,
		],
	);
	if (result.rowCount === 0) {
		const existing = await pool.query<{ requirement_revision_id: string }>(
			`SELECT requirement_revision_id
			 FROM conversation_decision_task_links
			 WHERE session_id = $1 AND owner_user_id = $2 AND decision_task_id = $3`,
			[command.sessionId, command.ownerUserId, command.decisionTaskId],
		);
		if (existing.rowCount !== 1) throw new ConversationNotFoundError();
		if (
			existing.rows[0]?.requirement_revision_id !==
			command.requirementRevisionId
		) {
			throw new ConversationIdempotencyConflictError(command.decisionTaskId);
		}
	}
	const session = await loadSession(
		pool,
		command.ownerUserId,
		command.sessionId,
	);
	if (session === undefined) throw new ConversationNotFoundError();
	return session;
}

async function loadSession(
	queryable: Pool | PoolClient,
	ownerUserId: string,
	sessionId: string,
): Promise<ConversationSession | undefined> {
	const sessionResult = await queryable.query<SessionRow>(
		`SELECT session_id, title, created_at, updated_at
		 FROM conversation_sessions
		 WHERE session_id = $1 AND owner_user_id = $2
		   AND private_data_deletion_status = 'ACTIVE'`,
		[sessionId, ownerUserId],
	);
	const session = sessionResult.rows[0];
	if (session === undefined) return undefined;

	const [messageResult, requirement, taskLinks] = await Promise.all([
		queryable.query<MessageRow>(
			`SELECT message_id, ordinal, role, text, created_at
			 FROM conversation_messages
			 WHERE session_id = $1 AND owner_user_id = $2
			 ORDER BY ordinal`,
			[sessionId, ownerUserId],
		),
		loadLatestRequirement(queryable, sessionId),
		queryable.query<DecisionTaskLinkRow>(
			`SELECT decision_task_id, requirement_revision_id, linked_at
			 FROM conversation_decision_task_links
			 WHERE session_id = $1 AND owner_user_id = $2
			 ORDER BY linked_at, decision_task_id`,
			[sessionId, ownerUserId],
		),
	]);
	return {
		createdAt: session.created_at.toISOString(),
		currentRequirement: requirement,
		decisionTasks: taskLinks.rows.map((link) => ({
			decisionTaskId: link.decision_task_id,
			...(link.requirement_revision_id === null
				? {}
				: { requirementRevisionId: link.requirement_revision_id }),
			linkedAt: link.linked_at.toISOString(),
		})),
		messages: messageResult.rows.map((message) => ({
			createdAt: message.created_at.toISOString(),
			messageId: message.message_id,
			ordinal: Number(message.ordinal),
			role: message.role,
			text: message.text,
		})),
		sessionId: session.session_id,
		title: session.title,
		updatedAt: session.updated_at.toISOString(),
	};
}

async function loadLatestRequirement(
	queryable: Pool | PoolClient,
	sessionId: string,
): Promise<RequirementRevision | null> {
	const result = await queryable.query<RequirementRow>(
		`SELECT revision_id, revision_number, consumption_goal, primary_scenario,
		        hard_constraints, missing_keys, readiness, created_at
		 FROM conversation_requirement_revisions
		 WHERE session_id = $1
		 ORDER BY revision_number DESC
		 LIMIT 1`,
		[sessionId],
	);
	const row = result.rows[0];
	if (row === undefined) return null;
	return decodeRequirementRow(row);
}

async function listSessions(
	pool: Pool,
	ownerUserId: string,
): Promise<readonly ConversationSessionSummary[]> {
	assertOpaqueId(ownerUserId, "ownerUserId");
	const result = await pool.query<SessionSummaryRow>(
		`SELECT session.session_id,
		        session.title,
		        session.updated_at,
		        latest_message.text AS latest_message,
		        latest_requirement.readiness
		 FROM conversation_sessions session
		 JOIN LATERAL (
			 SELECT text
			 FROM conversation_messages
			 WHERE session_id = session.session_id
			 ORDER BY ordinal DESC
			 LIMIT 1
		 ) latest_message ON true
		 LEFT JOIN LATERAL (
			 SELECT readiness
			 FROM conversation_requirement_revisions
			 WHERE session_id = session.session_id
			 ORDER BY revision_number DESC
			 LIMIT 1
		 ) latest_requirement ON true
		 WHERE session.owner_user_id = $1
		   AND session.private_data_deletion_status = 'ACTIVE'
		 ORDER BY session.updated_at DESC, session.session_id
		 LIMIT 50`,
		[ownerUserId],
	);
	return result.rows.map((row) => ({
		latestMessage: row.latest_message,
		readiness: row.readiness,
		sessionId: row.session_id,
		title: row.title,
		updatedAt: row.updated_at.toISOString(),
	}));
}

async function listRequirementRevisions(
	pool: Pool,
	ownerUserId: string,
	sessionId: string,
): Promise<readonly RequirementRevision[]> {
	assertOpaqueId(ownerUserId, "ownerUserId");
	assertOpaqueId(sessionId, "sessionId");
	const result = await pool.query<RequirementRow>(
		`SELECT revision.revision_id,
		        revision.revision_number,
		        revision.consumption_goal,
		        revision.primary_scenario,
		        revision.hard_constraints,
		        revision.missing_keys,
		        revision.readiness,
		        revision.created_at
		 FROM conversation_requirement_revisions revision
		 JOIN conversation_sessions session ON session.session_id = revision.session_id
		 WHERE revision.session_id = $1 AND session.owner_user_id = $2
		   AND session.private_data_deletion_status = 'ACTIVE'
		 ORDER BY revision.revision_number`,
		[sessionId, ownerUserId],
	);
	return result.rows.map(decodeRequirementRow);
}

async function loadDecisionTaskContext(
	pool: Pool,
	query: GetDecisionTaskContextQuery,
): Promise<ConversationDecisionTaskContext | undefined> {
	assertOpaqueId(query.ownerUserId, "ownerUserId");
	assertOpaqueId(query.decisionTaskId, "decisionTaskId");
	assertOpaqueId(query.requirementRevisionId, "requirementRevisionId");
	const result = await pool.query<{
		created_at: Date;
		message_id: string;
		session_id: string;
		text: string;
	}>(
		`SELECT session.session_id, message.message_id, message.text, message.created_at
		 FROM conversation_decision_task_links task_link
		 JOIN conversation_sessions session
		   ON session.session_id = task_link.session_id
		  AND session.owner_user_id = task_link.owner_user_id
		 JOIN conversation_requirement_revisions revision
		   ON revision.session_id = task_link.session_id
		  AND revision.owner_user_id = task_link.owner_user_id
		  AND revision.revision_id::text = task_link.requirement_revision_id
		 JOIN conversation_messages message
		   ON message.message_id = revision.source_message_id
		  AND message.owner_user_id = task_link.owner_user_id
		 WHERE task_link.owner_user_id = $1
		   AND task_link.decision_task_id = $2
		   AND revision.revision_id = $3
		   AND session.private_data_deletion_status = 'ACTIVE'
		 LIMIT 1`,
		[query.ownerUserId, query.decisionTaskId, query.requirementRevisionId],
	);
	const row = result.rows[0];
	return row === undefined
		? undefined
		: {
				sessionId: row.session_id,
				triggerMessage: {
					createdAt: row.created_at.toISOString(),
					messageId: row.message_id,
					text: row.text,
				},
			};
}

function decodeRequirementRow(row: RequirementRow): RequirementRevision {
	return {
		consumptionGoal: row.consumption_goal,
		createdAt: row.created_at.toISOString(),
		hardConstraints: decodeStringArray(row.hard_constraints, true),
		missingKeys: decodeMissingKeys(row.missing_keys),
		primaryScenario: row.primary_scenario,
		readiness: row.readiness,
		revisionId: row.revision_id,
		revisionNumber: row.revision_number,
	};
}

function normalizeRequirementUpdate(
	update: RequirementUpdate,
): RequirementUpdate {
	return {
		...(update.consumptionGoal === undefined
			? {}
			: {
					consumptionGoal: normalizeText(
						update.consumptionGoal,
						"consumptionGoal",
					),
				}),
		...(update.primaryScenario === undefined
			? {}
			: {
					primaryScenario: normalizeText(
						update.primaryScenario,
						"primaryScenario",
					),
				}),
		...(update.hardConstraints === undefined
			? {}
			: {
					hardConstraints: update.hardConstraints.map((constraint) =>
						normalizeText(constraint, "hardConstraints"),
					),
				}),
	};
}

function fingerprintUserTurn(text: string, update: RequirementUpdate): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				requirementUpdate: {
					consumptionGoal: update.consumptionGoal ?? null,
					hardConstraints: update.hardConstraints ?? null,
					primaryScenario: update.primaryScenario ?? null,
				},
				text,
			}),
		)
		.digest("hex");
}

function fingerprintUserText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function interpretationLeaseExpired(
	startedAt: Date | null,
	now: Date,
): boolean {
	return startedAt === null || now.getTime() - startedAt.getTime() >= 120_000;
}

function mergeRequirement(
	previous: RequirementRevision | null,
	update: RequirementUpdate,
): Readonly<{
	consumptionGoal: string | null;
	primaryScenario: string | null;
	hardConstraints: readonly string[] | null;
	missingKeys: readonly RequirementMissingKey[];
	readiness: RequirementRevision["readiness"];
}> {
	const consumptionGoal =
		update.consumptionGoal === undefined
			? (previous?.consumptionGoal ?? null)
			: normalizeText(update.consumptionGoal, "consumptionGoal");
	const primaryScenario =
		update.primaryScenario === undefined
			? (previous?.primaryScenario ?? null)
			: normalizeText(update.primaryScenario, "primaryScenario");
	const hardConstraints =
		update.hardConstraints === undefined
			? (previous?.hardConstraints ?? null)
			: update.hardConstraints.map((constraint) =>
					normalizeText(constraint, "hardConstraints"),
				);
	const missingKeys: RequirementMissingKey[] = [];
	if (consumptionGoal === null) missingKeys.push("CONSUMPTION_GOAL");
	if (primaryScenario === null) missingKeys.push("PRIMARY_SCENARIO");
	if (hardConstraints === null) missingKeys.push("HARD_CONSTRAINTS");
	return {
		consumptionGoal,
		hardConstraints,
		missingKeys,
		primaryScenario,
		readiness:
			missingKeys.length === 0 ? "READY_FOR_RESEARCH" : "NEEDS_CLARIFICATION",
	};
}

function requirementChanged(
	previous: RequirementRevision | null,
	next: ReturnType<typeof mergeRequirement>,
): boolean {
	return (
		previous === null ||
		previous.consumptionGoal !== next.consumptionGoal ||
		previous.primaryScenario !== next.primaryScenario ||
		!sameStrings(previous.hardConstraints, next.hardConstraints)
	);
}

function sameStrings(
	left: readonly string[] | null,
	right: readonly string[] | null,
): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.length === right.length &&
			left.every((value, index) => value === right[index]))
	);
}

function clarificationMessage(
	missingKeys: readonly RequirementMissingKey[],
): string {
	if (missingKeys.includes("CONSUMPTION_GOAL")) {
		return "先告诉我，你这次想解决什么消费问题？";
	}
	if (missingKeys.includes("PRIMARY_SCENARIO")) {
		return "它主要会用在什么场景？请说最常见、最重要的使用方式。";
	}
	if (missingKeys.includes("HARD_CONSTRAINTS")) {
		return "哪些条件一旦不满足，你就不会考虑？如果没有，也可以明确告诉我没有硬性条件。";
	}
	return "关键信息已经足够，可以开始有界研究。你仍可继续补充偏好或预算。";
}

async function insertMessage(
	client: PoolClient,
	input: Readonly<{
		clientTurnId?: string;
		commandFingerprint?: string;
		createdAt: Date;
		interpretationAttemptId?: string;
		interpretationStartedAt?: Date;
		interpretationStatus?: "PROCESSING" | "FAILED" | "SUCCEEDED";
		messageId: string;
		ordinal: number;
		ownerUserId: string;
		replyToMessageId?: string;
		role: "ASSISTANT" | "USER";
		sessionId: string;
		text: string;
	}>,
): Promise<void> {
	await client.query(
		`INSERT INTO conversation_messages (
			message_id, session_id, owner_user_id, client_turn_id, command_fingerprint,
			ordinal, role, text, interpretation_status, interpretation_attempt_id,
			interpretation_started_at, reply_to_message_id, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		[
			input.messageId,
			input.sessionId,
			input.ownerUserId,
			input.clientTurnId ?? null,
			input.commandFingerprint ?? null,
			input.ordinal,
			input.role,
			input.text,
			input.interpretationStatus ?? null,
			input.interpretationAttemptId ?? null,
			input.interpretationStartedAt ?? null,
			input.replyToMessageId ?? null,
			input.createdAt,
		],
	);
}

function decodeStringArray(
	value: unknown,
	nullable: true,
): readonly string[] | null;
function decodeStringArray(value: unknown, nullable?: false): readonly string[];
function decodeStringArray(
	value: unknown,
	nullable = false,
): readonly string[] | null {
	if (value === null && nullable) return null;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error("Conversation 字符串数组损坏");
	}
	return value;
}

function decodeMissingKeys(value: unknown): readonly RequirementMissingKey[] {
	const values = decodeStringArray(value);
	if (
		values.some(
			(value) =>
				value !== "CONSUMPTION_GOAL" &&
				value !== "PRIMARY_SCENARIO" &&
				value !== "HARD_CONSTRAINTS",
		)
	) {
		throw new Error("Conversation Requirement 缺失项损坏");
	}
	return values as readonly RequirementMissingKey[];
}

function normalizeText(value: string, field: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > 2_000) {
		throw new ConversationValidationError(`${field} 必须为 1–2000 个字符`);
	}
	return normalized;
}

function assertOpaqueId(value: string, field: string): void {
	if (value.length === 0 || value.trim() !== value || value.length > 200) {
		throw new ConversationValidationError(`${field} 无效`);
	}
}

export class ConversationNotFoundError extends Error {
	readonly code = "CONVERSATION_NOT_FOUND";

	constructor() {
		super("Session 不存在");
		this.name = "ConversationNotFoundError";
	}
}

export class ConversationValidationError extends Error {
	readonly code = "CONVERSATION_INVALID";

	constructor(message: string) {
		super(message);
		this.name = "ConversationValidationError";
	}
}

export class ConversationIdempotencyConflictError extends Error {
	readonly code = "CONVERSATION_IDEMPOTENCY_CONFLICT";

	constructor(readonly clientTurnId: string) {
		super("同一 clientTurnId 不能提交不同内容");
		this.name = "ConversationIdempotencyConflictError";
	}
}

export class ConversationTurnInProgressError extends Error {
	readonly code = "CONVERSATION_TURN_IN_PROGRESS";

	constructor(readonly clientTurnId: string) {
		super("该轮消息正在处理中");
		this.name = "ConversationTurnInProgressError";
	}
}

export class ConversationRequirementInterpreterUnavailableError extends Error {
	readonly code = "CONVERSATION_INTERPRETER_UNAVAILABLE";

	constructor() {
		super("需求理解模型暂时不可用");
		this.name = "ConversationRequirementInterpreterUnavailableError";
	}
}
