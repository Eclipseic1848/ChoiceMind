import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

export type MemoryAuthorization = Readonly<{
	ownerUserId: string;
	memoryEnabled: boolean;
	toolAssistedEnabled: boolean;
	updatedAt: string | null;
}>;

export type MemoryValue =
	| Readonly<{ valueType: "TEXT"; value: string }>
	| Readonly<{ valueType: "NUMBER"; value: number }>
	| Readonly<{ valueType: "BOOLEAN"; value: boolean }>
	| Readonly<{ valueType: "TEXT_SET"; value: readonly string[] }>;

export type MemoryOperationConflictCode =
	| "MEMORY_IDEMPOTENCY_CONFLICT"
	| "MEMORY_PROPOSAL_ALREADY_REVIEWED"
	| "MEMORY_PROPOSAL_STALE"
	| "MEMORY_REQUEST_RETIRED"
	| "MEMORY_SOURCE_ORDER_AMBIGUOUS";

export class MemoryOperationConflictError extends Error {
	readonly name = "MemoryOperationConflictError";

	constructor(readonly code: MemoryOperationConflictCode) {
		super(code);
	}
}

export type MemorySourceInput = Readonly<{
	sourceType: "USER_MESSAGE" | "TOOL_ASSISTED_CHAT";
	sessionId: string;
	messageId: string;
	userExcerpt: string;
	occurredAt: string;
}>;

export type MemorySource = MemorySourceInput &
	Readonly<{ conversationState: "AVAILABLE" | "DELETED" }>;

export interface MemorySourceVerifier {
	verifyUserMessage(
		input: Readonly<{
			ownerUserId: string;
			source: MemorySourceInput;
		}>,
	): Promise<string | undefined>;
	conversationExists(
		input: Readonly<{
			ownerUserId: string;
			sessionId: string;
		}>,
	): Promise<boolean>;
}

export type MemoryItem = Readonly<{
	memoryId: string;
	ownerUserId: string;
	key: string;
	value: MemoryValue;
	statement: string;
	sensitivity: "ORDINARY" | "SENSITIVE";
	applicationMode: "SOFT_PREFERENCE" | "CURRENT_CONFIRMATION_REQUIRED";
	status: "ACTIVE" | "NEEDS_REVIEW" | "SUPERSEDED";
	source: MemorySource;
	lastConfirmedAt: string;
	reviewAt: string;
	supersedesMemoryId?: string;
	createdAt: string;
	updatedAt: string;
}>;

export type MemoryProposal = Readonly<{
	proposalId: string;
	ownerUserId: string;
	key: string;
	value: MemoryValue;
	statement: string;
	sensitivity: "ORDINARY" | "SENSITIVE";
	applicationMode: "SOFT_PREFERENCE" | "CURRENT_CONFIRMATION_REQUIRED";
	reason: "SENSITIVE" | "UNCERTAIN" | "BEHAVIOR_INFERRED" | "TOOL_INFERRED";
	status: "PENDING" | "ACCEPTED" | "REJECTED";
	source: MemorySource;
	requestedReviewAt?: string;
	resultingMemoryId?: string;
	createdAt: string;
	reviewedAt?: string;
}>;

export type SetAuthorizationCommand = Readonly<{
	type: "SET_AUTHORIZATION";
	ownerUserId: string;
	memoryEnabled: boolean;
	toolAssistedEnabled: boolean;
}>;

export type ProposeMemoryChangesCommand = Readonly<{
	type: "PROPOSE_CHANGES";
	requestId: string;
	ownerUserId: string;
	source: MemorySourceInput;
	changes: readonly Readonly<{
		key: string;
		value: MemoryValue;
		statement: string;
		sensitivity: "ORDINARY" | "SENSITIVE";
		applicationMode: "SOFT_PREFERENCE" | "CURRENT_CONFIRMATION_REQUIRED";
		inference: "EXPLICIT" | "UNCERTAIN" | "BEHAVIOR_INFERRED" | "TOOL_INFERRED";
		reviewAt?: string;
	}>[];
}>;

export type MemoryChangeResult = Readonly<{
	applied: readonly MemoryItem[];
	proposals: readonly MemoryProposal[];
	changes: readonly Readonly<{
		key: string;
		changeType: "CREATED" | "REPLACED";
		statement: string;
		previousStatement?: string;
	}>[];
}>;

export type ReviewMemoryProposalCommand = Readonly<{
	type: "REVIEW_PROPOSAL";
	requestId: string;
	ownerUserId: string;
	proposalId: string;
	decision: "ACCEPT" | "REJECT";
}>;

export type EditMemoryItemCommand = Readonly<{
	type: "EDIT_ITEM";
	requestId: string;
	ownerUserId: string;
	memoryId: string;
	restoreMemoryId?: string;
	value: MemoryValue;
	statement: string;
	applicationMode: "SOFT_PREFERENCE" | "CURRENT_CONFIRMATION_REQUIRED";
	reviewAt?: string;
}>;

export type DeleteMemoryItemCommand = Readonly<{
	type: "DELETE_ITEM";
	requestId: string;
	ownerUserId: string;
	memoryId: string;
}>;

export type DeleteAllMemoryCommand = Readonly<{
	type: "DELETE_ALL";
	requestId: string;
	ownerUserId: string;
}>;

export type MemoryEditResult = Readonly<{
	item: MemoryItem;
	changeType: "REPLACED";
}>;

export type MemoryDeletionResult = Readonly<{ deleted: true }>;

export type MemoryProposalReviewResult = Readonly<{
	proposal: MemoryProposal;
	item?: MemoryItem;
}>;

export type GetMemorySettingsQuery = Readonly<{
	type: "GET_SETTINGS";
	ownerUserId: string;
}>;

export type GetMemoryChangeResultQuery = Readonly<{
	type: "GET_CHANGE_RESULT";
	ownerUserId: string;
	requestId: string;
}>;

export type ListMemoryItemsQuery = Readonly<{
	type: "LIST_ITEMS";
	ownerUserId: string;
	cursor?: string;
	currentOnly?: boolean;
	keys?: readonly string[];
	limit?: number;
	search?: string;
}>;

export type ListMemoryProposalsQuery = Readonly<{
	type: "LIST_PROPOSALS";
	ownerUserId: string;
	cursor?: string;
	limit?: number;
	sessionId?: string;
	status?: MemoryProposal["status"];
}>;

export type MemoryItemPage = Readonly<{
	items: readonly MemoryItem[];
	nextCursor?: string;
}>;

export type MemoryProposalPage = Readonly<{
	proposals: readonly MemoryProposal[];
	nextCursor?: string;
}>;

export type ExportMemoryQuery = Readonly<{
	type: "EXPORT";
	ownerUserId: string;
}>;

export type MemoryExport = Readonly<{
	schemaVersion: 1;
	exportedAt: string;
	authorization: MemoryAuthorization;
	items: readonly MemoryItem[];
	proposals: readonly MemoryProposal[];
}>;

export type SelectRelevantMemoryQuery = Readonly<{
	type: "SELECT_RELEVANT";
	ownerUserId: string;
	query: string;
	limit: number;
}>;

export type MemoryProjectionItem = Readonly<{
	memoryId: string;
	key: string;
	value: MemoryValue;
	statement: string;
	applicationMode: "SOFT_PREFERENCE" | "CURRENT_CONFIRMATION_REQUIRED";
}>;

export type RelevantMemoryProjection = Readonly<{
	applied: readonly MemoryProjectionItem[];
	confirmationRequired: readonly MemoryProjectionItem[];
	reviewRequired: readonly MemoryProjectionItem[];
}>;

export interface Memory {
	execute(command: SetAuthorizationCommand): Promise<MemoryAuthorization>;
	execute(command: ProposeMemoryChangesCommand): Promise<MemoryChangeResult>;
	execute(
		command: ReviewMemoryProposalCommand,
	): Promise<MemoryProposalReviewResult>;
	execute(command: EditMemoryItemCommand): Promise<MemoryEditResult>;
	execute(command: DeleteMemoryItemCommand): Promise<MemoryDeletionResult>;
	execute(command: DeleteAllMemoryCommand): Promise<MemoryDeletionResult>;
	read(query: GetMemorySettingsQuery): Promise<MemoryAuthorization>;
	read(
		query: GetMemoryChangeResultQuery,
	): Promise<MemoryChangeResult | undefined>;
	read(query: ListMemoryItemsQuery): Promise<MemoryItemPage>;
	read(query: ListMemoryProposalsQuery): Promise<MemoryProposalPage>;
	read(query: SelectRelevantMemoryQuery): Promise<RelevantMemoryProjection>;
	read(query: ExportMemoryQuery): Promise<MemoryExport>;
	close(): Promise<void>;
}

type AuthorizationRow = Readonly<{
	owner_user_id: string;
	memory_enabled: boolean;
	tool_assisted_enabled: boolean;
	updated_at: Date;
}>;

type MemoryItemRow = Readonly<{
	owner_user_id: string;
	memory_id: string;
	memory_key: string;
	value: unknown;
	statement: string;
	sensitivity: "ORDINARY" | "SENSITIVE";
	application_mode: "SOFT_PREFERENCE" | "CURRENT_CONFIRMATION_REQUIRED";
	status: "ACTIVE" | "NEEDS_REVIEW" | "SUPERSEDED";
	source: unknown;
	last_confirmed_at: Date;
	review_at: Date;
	supersedes_memory_id: string | null;
	created_at: Date;
	updated_at: Date;
}>;

type MemoryProposalRow = Readonly<{
	owner_user_id: string;
	proposal_id: string;
	memory_key: string;
	value: unknown;
	statement: string;
	sensitivity: "ORDINARY" | "SENSITIVE";
	application_mode: "SOFT_PREFERENCE" | "CURRENT_CONFIRMATION_REQUIRED";
	reason: "SENSITIVE" | "UNCERTAIN" | "BEHAVIOR_INFERRED" | "TOOL_INFERRED";
	status: "PENDING" | "ACCEPTED" | "REJECTED";
	source: unknown;
	requested_review_at: Date | null;
	resulting_memory_id: string | null;
	created_at: Date;
	reviewed_at: Date | null;
}>;

type MemoryCommandResultRow = Readonly<{
	request_fingerprint: string;
	result: unknown;
}>;

type RetirableMemoryCommandResultRow = MemoryCommandResultRow &
	Readonly<{ request_id: string }>;

type MemoryCommandTombstoneRow = Readonly<{
	request_fingerprint: string;
}>;

export async function openPostgresMemory(
	options: Readonly<{
		databaseUrl: string;
		now?: () => Date;
		sourceVerifier: MemorySourceVerifier;
	}>,
): Promise<Memory> {
	const pool = new Pool({ connectionString: options.databaseUrl });
	try {
		await migrateMemory(pool);
	} catch (error) {
		await pool.end();
		throw error;
	}
	const now = options.now ?? (() => new Date());

	async function execute(
		command: SetAuthorizationCommand,
	): Promise<MemoryAuthorization>;
	async function execute(
		command: ProposeMemoryChangesCommand,
	): Promise<MemoryChangeResult>;
	async function execute(
		command: ReviewMemoryProposalCommand,
	): Promise<MemoryProposalReviewResult>;
	async function execute(
		command: EditMemoryItemCommand,
	): Promise<MemoryEditResult>;
	async function execute(
		command: DeleteMemoryItemCommand,
	): Promise<MemoryDeletionResult>;
	async function execute(
		command: DeleteAllMemoryCommand,
	): Promise<MemoryDeletionResult>;
	async function execute(
		command:
			| SetAuthorizationCommand
			| ProposeMemoryChangesCommand
			| ReviewMemoryProposalCommand
			| EditMemoryItemCommand
			| DeleteMemoryItemCommand
			| DeleteAllMemoryCommand,
	): Promise<
		| MemoryAuthorization
		| MemoryChangeResult
		| MemoryProposalReviewResult
		| MemoryEditResult
		| MemoryDeletionResult
	> {
		switch (command.type) {
			case "SET_AUTHORIZATION":
				return setAuthorization(pool, command, now());
			case "PROPOSE_CHANGES":
				return proposeChanges(pool, command, now(), options.sourceVerifier);
			case "REVIEW_PROPOSAL":
				return reviewProposal(pool, command, now());
			case "EDIT_ITEM":
				return editItem(pool, command, now());
			case "DELETE_ITEM":
				return deleteItem(pool, command, now());
			case "DELETE_ALL":
				return deleteAll(pool, command, now());
		}
	}

	async function read(
		query: GetMemorySettingsQuery,
	): Promise<MemoryAuthorization>;
	async function read(
		query: GetMemoryChangeResultQuery,
	): Promise<MemoryChangeResult | undefined>;
	async function read(query: ListMemoryItemsQuery): Promise<MemoryItemPage>;
	async function read(
		query: ListMemoryProposalsQuery,
	): Promise<MemoryProposalPage>;
	async function read(
		query: SelectRelevantMemoryQuery,
	): Promise<RelevantMemoryProjection>;
	async function read(query: ExportMemoryQuery): Promise<MemoryExport>;
	async function read(
		query:
			| GetMemorySettingsQuery
			| GetMemoryChangeResultQuery
			| ListMemoryItemsQuery
			| ListMemoryProposalsQuery
			| SelectRelevantMemoryQuery
			| ExportMemoryQuery,
	): Promise<
		| MemoryAuthorization
		| MemoryChangeResult
		| MemoryItemPage
		| MemoryProposalPage
		| RelevantMemoryProjection
		| MemoryExport
		| undefined
	> {
		switch (query.type) {
			case "GET_SETTINGS":
				return readAuthorization(pool, query.ownerUserId);
			case "GET_CHANGE_RESULT":
				return readChangeResult(pool, query);
			case "LIST_ITEMS":
				return listItems(pool, query, options.sourceVerifier);
			case "LIST_PROPOSALS":
				return listProposals(pool, query, options.sourceVerifier);
			case "SELECT_RELEVANT":
				return selectRelevant(pool, query, now());
			case "EXPORT":
				return exportMemory(
					pool,
					query.ownerUserId,
					now(),
					options.sourceVerifier,
				);
		}
	}

	return { execute, read, close: () => pool.end() };
}

async function readChangeResult(
	pool: Pool,
	query: GetMemoryChangeResultQuery,
): Promise<MemoryChangeResult | undefined> {
	assertOwnerUserId(query.ownerUserId);
	assertOpaqueId(query.requestId, "requestId");
	const client = await pool.connect();
	try {
		const replay = await readCommandReplay(
			client,
			query.ownerUserId,
			query.requestId,
		);
		if (replay === undefined) return undefined;
		const result = decodeMemoryChangeResult(replay.result);
		if (result === undefined) throw new Error("MEMORY_REPLAY_INVALID");
		return result;
	} finally {
		client.release();
	}
}

async function setAuthorization(
	pool: Pool,
	command: SetAuthorizationCommand,
	timestamp: Date,
): Promise<MemoryAuthorization> {
	assertOwnerUserId(command.ownerUserId);
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await lockOwner(client, command.ownerUserId);
		const toolAssistedEnabled =
			command.memoryEnabled && command.toolAssistedEnabled;
		const result = await client.query<AuthorizationRow>(
			`INSERT INTO memory_authorizations (
         owner_user_id, memory_enabled, tool_assisted_enabled, updated_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_user_id) DO UPDATE SET
         memory_enabled = EXCLUDED.memory_enabled,
         tool_assisted_enabled = EXCLUDED.tool_assisted_enabled,
         updated_at = EXCLUDED.updated_at
       RETURNING owner_user_id, memory_enabled, tool_assisted_enabled, updated_at`,
			[
				command.ownerUserId,
				command.memoryEnabled,
				toolAssistedEnabled,
				timestamp,
			],
		);
		const row = result.rows[0];
		if (row === undefined) throw new Error("MEMORY_AUTHORIZATION_WRITE_FAILED");
		await client.query("COMMIT");
		return toAuthorization(row);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function proposeChanges(
	pool: Pool,
	command: ProposeMemoryChangesCommand,
	timestamp: Date,
	sourceVerifier: MemorySourceVerifier,
): Promise<MemoryChangeResult> {
	assertOwnerUserId(command.ownerUserId);
	assertOpaqueId(command.requestId, "requestId");
	assertMemorySource(command.source, timestamp);
	if (command.changes.length === 0) throw new Error("MEMORY_CHANGES_INVALID");
	for (const change of command.changes) {
		assertMemoryChange(change);
		assertReviewAt(change.reviewAt, new Date(command.source.occurredAt));
	}
	if (
		new Set(command.changes.map((change) => change.key)).size !==
		command.changes.length
	) {
		throw new Error("MEMORY_CHANGES_INVALID");
	}
	const authorizationBeforeVerification = await readAuthorization(
		pool,
		command.ownerUserId,
	);
	if (!authorizationBeforeVerification.memoryEnabled) {
		throw new Error("MEMORY_DISABLED");
	}
	if (
		command.source.sourceType === "TOOL_ASSISTED_CHAT" &&
		!authorizationBeforeVerification.toolAssistedEnabled
	) {
		throw new Error("TOOL_ASSISTED_MEMORY_DISABLED");
	}
	const verifiedUserText = await sourceVerifier.verifyUserMessage({
		ownerUserId: command.ownerUserId,
		source: command.source,
	});
	if (verifiedUserText === undefined) {
		throw new Error("MEMORY_SOURCE_NOT_USER_MESSAGE");
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await lockOwner(client, command.ownerUserId);
		const authorization = await readAuthorizationForUpdate(
			client,
			command.ownerUserId,
		);
		if (!authorization.memoryEnabled) throw new Error("MEMORY_DISABLED");
		if (
			command.source.sourceType === "TOOL_ASSISTED_CHAT" &&
			!authorization.toolAssistedEnabled
		) {
			throw new Error("TOOL_ASSISTED_MEMORY_DISABLED");
		}
		const requestFingerprint = fingerprintCommand(command);
		await lockCommand(client, command.ownerUserId, command.requestId);
		const previous = await readCommandReplay(
			client,
			command.ownerUserId,
			command.requestId,
		);
		if (previous !== undefined) {
			assertReplayFingerprint(previous, requestFingerprint);
			const result = decodeMemoryChangeResult(previous.result);
			if (result === undefined) throw new Error("MEMORY_STORED_DATA_INVALID");
			await client.query("COMMIT");
			return result;
		}
		const applied: MemoryItem[] = [];
		const proposals: MemoryProposal[] = [];
		const changes: Array<MemoryChangeResult["changes"][number]> = [];
		for (const untrustedChange of command.changes) {
			const change = normalizeMemoryChange(untrustedChange, verifiedUserText);
			if (
				(await compareSourceOrder(
					client,
					command.ownerUserId,
					change.key,
					command.source,
				)) === "STALE"
			) {
				continue;
			}
			const proposalReason = classifyProposalReason(change, verifiedUserText);
			if (proposalReason !== undefined) {
				const proposalId = randomUUID();
				const inserted = await client.query<MemoryProposalRow>(
					`INSERT INTO memory_proposals (
             owner_user_id, proposal_id, memory_key, value, statement,
             sensitivity, application_mode, reason, status, source,
             requested_review_at, resulting_memory_id, created_at, reviewed_at
           ) VALUES (
             $1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'PENDING', $9::jsonb,
             $10, NULL, $11, NULL
           ) RETURNING ${memoryProposalColumns()}`,
					[
						command.ownerUserId,
						proposalId,
						change.key,
						JSON.stringify(change.value),
						change.statement,
						proposalReason === "SENSITIVE" ? "SENSITIVE" : change.sensitivity,
						change.applicationMode,
						proposalReason,
						JSON.stringify(toStoredMemorySource(command.source)),
						change.reviewAt === undefined ? null : new Date(change.reviewAt),
						timestamp,
					],
				);
				const row = inserted.rows[0];
				if (row === undefined) throw new Error("MEMORY_PROPOSAL_WRITE_FAILED");
				proposals.push(toMemoryProposal(row));
				await client.query(
					`UPDATE memory_items SET status = 'NEEDS_REVIEW', updated_at = $1
           WHERE owner_user_id = $2 AND memory_key = $3 AND status = 'ACTIVE'`,
					[timestamp, command.ownerUserId, change.key],
				);
				continue;
			}
			if (
				change.inference !== "EXPLICIT" ||
				change.sensitivity !== "ORDINARY" ||
				containsSensitiveMarker(change, verifiedUserText)
			) {
				throw new Error("MEMORY_CLASSIFICATION_INVALID");
			}
			const item = await insertActiveItem(client, {
				ownerUserId: command.ownerUserId,
				change,
				source: command.source,
				timestamp,
			});
			if (item.stale) continue;
			applied.push(item.item);
			changes.push({
				key: change.key,
				changeType: item.replaced ? "REPLACED" : "CREATED",
				statement: item.item.statement,
				...(item.previousStatement === undefined
					? {}
					: { previousStatement: item.previousStatement }),
			});
		}
		const result = { applied, proposals, changes };
		await client.query(
			`INSERT INTO memory_command_results (
         owner_user_id, request_id, request_fingerprint, result, created_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
			[
				command.ownerUserId,
				command.requestId,
				requestFingerprint,
				JSON.stringify(result),
				timestamp,
			],
		);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function reviewProposal(
	pool: Pool,
	command: ReviewMemoryProposalCommand,
	timestamp: Date,
): Promise<MemoryProposalReviewResult> {
	assertOwnerUserId(command.ownerUserId);
	assertOpaqueId(command.requestId, "requestId");
	assertOpaqueId(command.proposalId, "proposalId");
	const client = await pool.connect();
	let transactionCommitted = false;
	try {
		await client.query("BEGIN");
		await lockOwner(client, command.ownerUserId);
		const requestFingerprint = fingerprintCommand(command);
		await lockCommand(client, command.ownerUserId, command.requestId);
		const replay = await readCommandReplay(
			client,
			command.ownerUserId,
			command.requestId,
		);
		if (replay !== undefined) {
			assertReplayFingerprint(replay, requestFingerprint);
			const result = decodeMemoryProposalReviewResult(replay.result);
			if (result === undefined) throw new Error("MEMORY_STORED_DATA_INVALID");
			await client.query("COMMIT");
			transactionCommitted = true;
			return result;
		}
		const found = await client.query<MemoryProposalRow>(
			`SELECT ${memoryProposalColumns()} FROM memory_proposals
       WHERE owner_user_id = $1 AND proposal_id = $2 FOR UPDATE`,
			[command.ownerUserId, command.proposalId],
		);
		const current = found.rows[0];
		if (current === undefined) throw new Error("MEMORY_PROPOSAL_NOT_FOUND");
		if (current.status !== "PENDING")
			throw new MemoryOperationConflictError(
				"MEMORY_PROPOSAL_ALREADY_REVIEWED",
			);

		let item: MemoryItem | undefined;
		let resultingMemoryId: string | null = null;
		if (command.decision === "ACCEPT") {
			const authorization = await readAuthorizationForUpdate(
				client,
				command.ownerUserId,
			);
			if (!authorization.memoryEnabled) throw new Error("MEMORY_DISABLED");
			const value = decodeMemoryValue(current.value);
			const source = decodeMemorySource(current.source);
			if (value === undefined || source === undefined) {
				throw new Error("MEMORY_STORED_DATA_INVALID");
			}
			assertReviewAt(current.requested_review_at?.toISOString(), timestamp);
			const sourceOrder = await compareSourceOrder(
				client,
				command.ownerUserId,
				current.memory_key,
				source,
				current.proposal_id,
			);
			if (sourceOrder === "STALE") {
				const rejected = await client.query(
					`UPDATE memory_proposals SET status = 'REJECTED', reviewed_at = $1
					 WHERE owner_user_id = $2 AND proposal_id = $3`,
					[timestamp, command.ownerUserId, command.proposalId],
				);
				if (rejected.rowCount !== 1)
					throw new Error("MEMORY_PROPOSAL_WRITE_FAILED");
				await client.query("COMMIT");
				transactionCommitted = true;
				throw new MemoryOperationConflictError("MEMORY_PROPOSAL_STALE");
			}
			const inserted = await insertActiveItem(client, {
				ownerUserId: command.ownerUserId,
				change: {
					key: current.memory_key,
					value,
					statement: current.statement,
					sensitivity: current.sensitivity,
					applicationMode: current.application_mode,
					inference: "EXPLICIT",
					...(current.requested_review_at === null
						? {}
						: { reviewAt: current.requested_review_at.toISOString() }),
				},
				source,
				timestamp,
				confirmedAt: timestamp,
			});
			if (inserted.stale) throw new Error("MEMORY_ITEM_WRITE_FAILED");
			item = inserted.item;
			resultingMemoryId = item.memoryId;
		}
		const updated = await client.query<MemoryProposalRow>(
			`UPDATE memory_proposals SET
         status = $1, resulting_memory_id = $2, reviewed_at = $3
       WHERE owner_user_id = $4 AND proposal_id = $5
       RETURNING ${memoryProposalColumns()}`,
			[
				command.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED",
				resultingMemoryId,
				timestamp,
				command.ownerUserId,
				command.proposalId,
			],
		);
		const proposal = updated.rows[0];
		if (proposal === undefined) throw new Error("MEMORY_PROPOSAL_WRITE_FAILED");
		const result: MemoryProposalReviewResult = {
			proposal: toMemoryProposal(proposal),
			...(item === undefined ? {} : { item }),
		};
		await writeCommandResult(
			client,
			command.ownerUserId,
			command.requestId,
			requestFingerprint,
			result,
			timestamp,
		);
		await client.query("COMMIT");
		transactionCommitted = true;
		return result;
	} catch (error) {
		if (!transactionCommitted) await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function editItem(
	pool: Pool,
	command: EditMemoryItemCommand,
	timestamp: Date,
): Promise<MemoryEditResult> {
	assertOwnerUserId(command.ownerUserId);
	assertOpaqueId(command.requestId, "requestId");
	assertOpaqueId(command.memoryId, "memoryId");
	if (command.restoreMemoryId !== undefined) {
		assertOpaqueId(command.restoreMemoryId, "restoreMemoryId");
	}
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await lockOwner(client, command.ownerUserId);
		const authorization = await readAuthorizationForUpdate(
			client,
			command.ownerUserId,
		);
		if (!authorization.memoryEnabled) throw new Error("MEMORY_DISABLED");
		const requestFingerprint = fingerprintCommand(command);
		await lockCommand(client, command.ownerUserId, command.requestId);
		const replay = await readCommandReplay(
			client,
			command.ownerUserId,
			command.requestId,
		);
		if (replay !== undefined) {
			assertReplayFingerprint(replay, requestFingerprint);
			const result = decodeMemoryEditResult(replay.result);
			if (result === undefined) throw new Error("MEMORY_STORED_DATA_INVALID");
			await client.query("COMMIT");
			return result;
		}
		const found = await client.query<MemoryItemRow>(
			`SELECT ${memoryItemColumns()} FROM memory_items
       WHERE owner_user_id = $1 AND memory_id = $2
         AND status IN ('ACTIVE', 'NEEDS_REVIEW') FOR UPDATE`,
			[command.ownerUserId, command.memoryId],
		);
		const current = found.rows[0];
		if (current === undefined) throw new Error("MEMORY_ITEM_NOT_FOUND");
		if (command.restoreMemoryId !== undefined) {
			if (current.supersedes_memory_id !== command.restoreMemoryId) {
				throw new Error("MEMORY_ITEM_NOT_FOUND");
			}
			const previous = await client.query<MemoryItemRow>(
				`SELECT ${memoryItemColumns()} FROM memory_items
         WHERE owner_user_id = $1 AND memory_id = $2
           AND memory_key = $3 AND status = 'SUPERSEDED' FOR UPDATE`,
				[command.ownerUserId, command.restoreMemoryId, current.memory_key],
			);
			const restoreTarget = previous.rows[0];
			if (restoreTarget === undefined) throw new Error("MEMORY_ITEM_NOT_FOUND");
			await client.query(
				`UPDATE memory_items SET status = 'SUPERSEDED', updated_at = $1
         WHERE owner_user_id = $2 AND memory_id = $3`,
				[timestamp, command.ownerUserId, current.memory_id],
			);
			const restored = await client.query<MemoryItemRow>(
				`UPDATE memory_items
         SET status = CASE WHEN review_at <= $1 THEN 'NEEDS_REVIEW' ELSE 'ACTIVE' END,
             updated_at = $1
         WHERE owner_user_id = $2 AND memory_id = $3
         RETURNING ${memoryItemColumns()}`,
				[timestamp, command.ownerUserId, restoreTarget.memory_id],
			);
			await client.query(
				"DELETE FROM memory_projection_cache WHERE owner_user_id = $1 AND memory_key = $2",
				[command.ownerUserId, current.memory_key],
			);
			const restoredRow = restored.rows[0];
			if (restoredRow === undefined)
				throw new Error("MEMORY_ITEM_WRITE_FAILED");
			const result: MemoryEditResult = {
				item: toMemoryItem(restoredRow),
				changeType: "REPLACED",
			};
			await writeCommandResult(
				client,
				command.ownerUserId,
				command.requestId,
				requestFingerprint,
				result,
				timestamp,
			);
			await client.query("COMMIT");
			return result;
		}
		const source = decodeMemorySource(current.source);
		if (source === undefined) throw new Error("MEMORY_STORED_DATA_INVALID");
		const untrustedChange: ProposeMemoryChangesCommand["changes"][number] = {
			key: current.memory_key,
			value: command.value,
			statement: command.statement,
			sensitivity: current.sensitivity,
			applicationMode: command.applicationMode,
			inference: "EXPLICIT",
			...(command.reviewAt === undefined ? {} : { reviewAt: command.reviewAt }),
		};
		const change = normalizeMemoryChange(untrustedChange);
		assertReviewAt(change.reviewAt, timestamp);
		if (
			current.sensitivity === "SENSITIVE" ||
			change.sensitivity === "SENSITIVE"
		) {
			throw new Error("MEMORY_EDIT_REQUIRES_PROPOSAL");
		}
		assertMemoryChange(change);
		const inserted = await insertActiveItem(client, {
			ownerUserId: command.ownerUserId,
			change,
			source,
			timestamp,
			confirmedAt: timestamp,
		});
		if (inserted.stale) throw new Error("MEMORY_ITEM_WRITE_FAILED");
		const result: MemoryEditResult = {
			item: inserted.item,
			changeType: "REPLACED",
		};
		await writeCommandResult(
			client,
			command.ownerUserId,
			command.requestId,
			requestFingerprint,
			result,
			timestamp,
		);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function deleteItem(
	pool: Pool,
	command: DeleteMemoryItemCommand,
	timestamp: Date,
): Promise<MemoryDeletionResult> {
	assertOwnerUserId(command.ownerUserId);
	assertOpaqueId(command.requestId, "requestId");
	assertOpaqueId(command.memoryId, "memoryId");
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const requestFingerprint = fingerprintCommand(command);
		await lockOwner(client, command.ownerUserId);
		await lockCommand(client, command.ownerUserId, command.requestId);
		const replay = await readCommandReplay(
			client,
			command.ownerUserId,
			command.requestId,
		);
		if (replay !== undefined) {
			assertReplayFingerprint(replay, requestFingerprint);
			const result = decodeMemoryDeletionResult(replay.result);
			if (result === undefined) throw new Error("MEMORY_STORED_DATA_INVALID");
			await client.query("COMMIT");
			return result;
		}
		const found = await client.query<
			Pick<MemoryItemRow, "memory_key"> & { memory_id: string }
		>(
			`SELECT memory_id, memory_key FROM memory_items
       WHERE owner_user_id = $1 AND memory_id = $2 FOR UPDATE`,
			[command.ownerUserId, command.memoryId],
		);
		const target = found.rows[0];
		if (target === undefined) throw new Error("MEMORY_ITEM_NOT_FOUND");
		await client.query(
			"DELETE FROM memory_proposals WHERE owner_user_id = $1 AND memory_key = $2",
			[command.ownerUserId, target.memory_key],
		);
		await client.query(
			"DELETE FROM memory_embeddings WHERE owner_user_id = $1 AND memory_key = $2",
			[command.ownerUserId, target.memory_key],
		);
		await client.query(
			"DELETE FROM memory_projection_cache WHERE owner_user_id = $1 AND memory_key = $2",
			[command.ownerUserId, target.memory_key],
		);
		await client.query(
			"DELETE FROM memory_items WHERE owner_user_id = $1 AND memory_key = $2",
			[command.ownerUserId, target.memory_key],
		);
		await retireCommandResults(
			client,
			command.ownerUserId,
			timestamp,
			target.memory_key,
		);
		await writeDeletionAudit(
			client,
			command.ownerUserId,
			"ITEM",
			command.memoryId,
			timestamp,
		);
		const result: MemoryDeletionResult = { deleted: true };
		await writeCommandResult(
			client,
			command.ownerUserId,
			command.requestId,
			requestFingerprint,
			result,
			timestamp,
		);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function deleteAll(
	pool: Pool,
	command: DeleteAllMemoryCommand,
	timestamp: Date,
): Promise<MemoryDeletionResult> {
	assertOwnerUserId(command.ownerUserId);
	assertOpaqueId(command.requestId, "requestId");
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const requestFingerprint = fingerprintCommand(command);
		await lockOwner(client, command.ownerUserId);
		await lockCommand(client, command.ownerUserId, command.requestId);
		const replay = await readCommandReplay(
			client,
			command.ownerUserId,
			command.requestId,
		);
		if (replay !== undefined) {
			assertReplayFingerprint(replay, requestFingerprint);
			const result = decodeMemoryDeletionResult(replay.result);
			if (result === undefined) throw new Error("MEMORY_STORED_DATA_INVALID");
			await client.query("COMMIT");
			return result;
		}
		await client.query(
			"DELETE FROM memory_proposals WHERE owner_user_id = $1",
			[command.ownerUserId],
		);
		await client.query(
			"DELETE FROM memory_embeddings WHERE owner_user_id = $1",
			[command.ownerUserId],
		);
		await client.query(
			"DELETE FROM memory_projection_cache WHERE owner_user_id = $1",
			[command.ownerUserId],
		);
		await client.query("DELETE FROM memory_items WHERE owner_user_id = $1", [
			command.ownerUserId,
		]);
		await retireCommandResults(client, command.ownerUserId, timestamp);
		await writeDeletionAudit(
			client,
			command.ownerUserId,
			"ALL",
			command.requestId,
			timestamp,
		);
		const result: MemoryDeletionResult = { deleted: true };
		await writeCommandResult(
			client,
			command.ownerUserId,
			command.requestId,
			requestFingerprint,
			result,
			timestamp,
		);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function compareSourceOrder(
	client: PoolClient,
	ownerUserId: string,
	key: string,
	source: MemorySourceInput,
	excludedProposalId?: string,
): Promise<"CURRENT" | "STALE"> {
	const history = await client.query<Readonly<{ source: unknown }>>(
		`SELECT source FROM memory_items
		 WHERE owner_user_id = $1 AND memory_key = $2
		 UNION ALL
		 SELECT source FROM memory_proposals
		 WHERE owner_user_id = $1 AND memory_key = $2
		   AND ($3::uuid IS NULL OR proposal_id <> $3::uuid)`,
		[ownerUserId, key, excludedProposalId ?? null],
	);
	if (history.rows.length === 0) return "CURRENT";
	const existingSources = history.rows.map((row) => {
		const existingSource = decodeMemorySource(row.source);
		if (existingSource === undefined)
			throw new Error("MEMORY_STORED_DATA_INVALID");
		return existingSource;
	});
	const existingTime = Math.max(
		...existingSources.map((existingSource) =>
			Date.parse(existingSource.occurredAt),
		),
	);
	const incomingTime = Date.parse(source.occurredAt);
	if (existingTime > incomingTime) return "STALE";
	if (existingTime < incomingTime) return "CURRENT";
	if (
		existingSources
			.filter(
				(existingSource) =>
					Date.parse(existingSource.occurredAt) === existingTime,
			)
			.every((existingSource) => existingSource.messageId === source.messageId)
	) {
		return "STALE";
	}
	throw new MemoryOperationConflictError("MEMORY_SOURCE_ORDER_AMBIGUOUS");
}

async function insertActiveItem(
	client: PoolClient,
	input: Readonly<{
		ownerUserId: string;
		change: ProposeMemoryChangesCommand["changes"][number];
		source: MemorySourceInput;
		timestamp: Date;
		confirmedAt?: Date;
	}>,
): Promise<
	| Readonly<{ stale: true }>
	| Readonly<{
			stale: false;
			item: MemoryItem;
			replaced: boolean;
			previousStatement?: string;
	  }>
> {
	const existing = await loadActiveItem(
		client,
		input.ownerUserId,
		input.change.key,
	);
	const memoryId = randomUUID();
	const confirmedAt = input.confirmedAt ?? new Date(input.source.occurredAt);
	if (existing !== undefined && input.confirmedAt === undefined) {
		const existingSource = decodeMemorySource(existing.source);
		if (existingSource === undefined)
			throw new Error("MEMORY_STORED_DATA_INVALID");
		if (Date.parse(existingSource.occurredAt) >= confirmedAt.getTime()) {
			return { stale: true };
		}
	}
	const reviewAt =
		input.change.reviewAt === undefined
			? new Date(confirmedAt.getTime() + 180 * 24 * 60 * 60 * 1_000)
			: new Date(input.change.reviewAt);
	if (existing !== undefined) {
		await client.query(
			`UPDATE memory_items SET status = 'SUPERSEDED', updated_at = $1
       WHERE owner_user_id = $2 AND memory_id = $3
         AND status IN ('ACTIVE', 'NEEDS_REVIEW')`,
			[input.timestamp, input.ownerUserId, existing.memory_id],
		);
	}
	const inserted = await client.query<MemoryItemRow>(
		`INSERT INTO memory_items (
       owner_user_id, memory_id, memory_key, value, statement,
       sensitivity, application_mode, status, source,
       last_confirmed_at, review_at, supersedes_memory_id,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4::jsonb, $5, $6, $7, 'ACTIVE', $8::jsonb,
       $9, $10, $11, $12, $12
     ) RETURNING ${memoryItemColumns()}`,
		[
			input.ownerUserId,
			memoryId,
			input.change.key,
			JSON.stringify(input.change.value),
			input.change.statement,
			input.change.sensitivity,
			input.change.applicationMode,
			JSON.stringify(toStoredMemorySource(input.source)),
			confirmedAt,
			reviewAt,
			existing?.memory_id ?? null,
			input.timestamp,
		],
	);
	const row = inserted.rows[0];
	if (row === undefined) throw new Error("MEMORY_ITEM_WRITE_FAILED");
	return {
		stale: false,
		item: toMemoryItem(row),
		replaced: existing !== undefined,
		...(existing === undefined
			? {}
			: { previousStatement: existing.statement }),
	};
}

async function readAuthorization(
	pool: Pool,
	ownerUserId: string,
): Promise<MemoryAuthorization> {
	assertOwnerUserId(ownerUserId);
	const result = await pool.query<AuthorizationRow>(
		`SELECT owner_user_id, memory_enabled, tool_assisted_enabled, updated_at
     FROM memory_authorizations WHERE owner_user_id = $1`,
		[ownerUserId],
	);
	const row = result.rows[0];
	return row === undefined
		? {
				ownerUserId,
				memoryEnabled: false,
				toolAssistedEnabled: false,
				updatedAt: null,
			}
		: toAuthorization(row);
}

async function readAuthorizationForUpdate(
	client: PoolClient,
	ownerUserId: string,
): Promise<MemoryAuthorization> {
	const result = await client.query<AuthorizationRow>(
		`SELECT owner_user_id, memory_enabled, tool_assisted_enabled, updated_at
     FROM memory_authorizations WHERE owner_user_id = $1 FOR UPDATE`,
		[ownerUserId],
	);
	const row = result.rows[0];
	return row === undefined
		? {
				ownerUserId,
				memoryEnabled: false,
				toolAssistedEnabled: false,
				updatedAt: null,
			}
		: toAuthorization(row);
}

function readListWindow(
	requestedLimit: number | undefined,
	cursor: string | undefined,
): Readonly<{ limit: number; offset: number }> {
	const limit = requestedLimit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("MEMORY_LIST_LIMIT_INVALID");
	}
	if (cursor === undefined) return { limit, offset: 0 };
	if (!/^(0|[1-9]\d*)$/.test(cursor)) {
		throw new Error("MEMORY_LIST_CURSOR_INVALID");
	}
	const offset = Number(cursor);
	if (!Number.isSafeInteger(offset) || offset > 100_000) {
		throw new Error("MEMORY_LIST_CURSOR_INVALID");
	}
	return { limit, offset };
}

async function listItems(
	pool: Pool,
	query: ListMemoryItemsQuery,
	sourceVerifier: MemorySourceVerifier,
	bounded = true,
): Promise<MemoryItemPage> {
	assertOwnerUserId(query.ownerUserId);
	const window = bounded
		? readListWindow(query.limit, query.cursor)
		: undefined;
	const keys = query.keys === undefined ? null : [...new Set(query.keys)];
	if (keys !== null) {
		if (keys.length === 0 || keys.length > 100) {
			throw new Error("MEMORY_LIST_KEYS_INVALID");
		}
		for (const key of keys) assertMemoryKey(key);
	}
	const search = query.search?.trim();
	if (
		query.search !== undefined &&
		(search === undefined || search === "" || search.length > 200)
	) {
		throw new Error("MEMORY_LIST_SEARCH_INVALID");
	}
	const result = await pool.query<MemoryItemRow>(
		`SELECT ${memoryItemColumns()} FROM memory_items
		 WHERE owner_user_id = $1
		   AND ($2::text[] IS NULL OR memory_key = ANY($2::text[]))
		   AND ($3::text IS NULL OR POSITION(LOWER($3) IN LOWER(
		     memory_key || ' ' || statement || ' ' || value::text
		   )) > 0)
		   AND ($4::boolean = FALSE OR status <> 'SUPERSEDED')
		 ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'NEEDS_REVIEW' THEN 1 ELSE 2 END,
		          created_at DESC, memory_id DESC
		 ${window === undefined ? "" : "LIMIT $5 OFFSET $6"}`,
		window === undefined
			? [query.ownerUserId, keys, search ?? null, query.currentOnly ?? false]
			: [
					query.ownerUserId,
					keys,
					search ?? null,
					query.currentOnly ?? false,
					window.limit + 1,
					window.offset,
				],
	);
	const rows =
		window === undefined ? result.rows : result.rows.slice(0, window.limit);
	return {
		items: await Promise.all(
			rows.map((row) => hydrateItemSource(toMemoryItem(row), sourceVerifier)),
		),
		...(window !== undefined && result.rows.length > window.limit
			? { nextCursor: String(window.offset + window.limit) }
			: {}),
	};
}

async function listProposals(
	pool: Pool,
	query: ListMemoryProposalsQuery,
	sourceVerifier: MemorySourceVerifier,
	bounded = true,
): Promise<MemoryProposalPage> {
	assertOwnerUserId(query.ownerUserId);
	if (query.sessionId !== undefined) {
		assertOpaqueId(query.sessionId, "sessionId");
	}
	if (
		query.status !== undefined &&
		!(["PENDING", "ACCEPTED", "REJECTED"] as const).includes(query.status)
	) {
		throw new Error("MEMORY_PROPOSAL_STATUS_INVALID");
	}
	const window = bounded
		? readListWindow(query.limit, query.cursor)
		: undefined;
	const result = await pool.query<MemoryProposalRow>(
		`SELECT ${memoryProposalColumns()} FROM memory_proposals
		 WHERE owner_user_id = $1
		   AND ($2::text IS NULL OR status = $2)
		   AND ($3::text IS NULL OR source ->> 'sessionId' = $3)
		 ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END,
		          created_at DESC, proposal_id DESC
		 ${window === undefined ? "" : "LIMIT $4 OFFSET $5"}`,
		window === undefined
			? [query.ownerUserId, query.status ?? null, query.sessionId ?? null]
			: [
					query.ownerUserId,
					query.status ?? null,
					query.sessionId ?? null,
					window.limit + 1,
					window.offset,
				],
	);
	const rows =
		window === undefined ? result.rows : result.rows.slice(0, window.limit);
	return {
		proposals: await Promise.all(
			rows.map((row) =>
				hydrateProposalSource(toMemoryProposal(row), sourceVerifier),
			),
		),
		...(window !== undefined && result.rows.length > window.limit
			? { nextCursor: String(window.offset + window.limit) }
			: {}),
	};
}

async function exportMemory(
	pool: Pool,
	ownerUserId: string,
	timestamp: Date,
	sourceVerifier: MemorySourceVerifier,
): Promise<MemoryExport> {
	const [authorization, items, proposals] = await Promise.all([
		readAuthorization(pool, ownerUserId),
		listItems(pool, { type: "LIST_ITEMS", ownerUserId }, sourceVerifier, false),
		listProposals(
			pool,
			{ type: "LIST_PROPOSALS", ownerUserId },
			sourceVerifier,
			false,
		),
	]);
	return {
		schemaVersion: 1,
		exportedAt: timestamp.toISOString(),
		authorization,
		items: items.items,
		proposals: proposals.proposals,
	};
}

async function hydrateItemSource(
	item: MemoryItem,
	sourceVerifier: MemorySourceVerifier,
): Promise<MemoryItem> {
	const source = await hydrateMemorySource(
		item.ownerUserId,
		item.source,
		sourceVerifier,
	);
	return { ...item, source };
}

async function hydrateProposalSource(
	proposal: MemoryProposal,
	sourceVerifier: MemorySourceVerifier,
): Promise<MemoryProposal> {
	const source = await hydrateMemorySource(
		proposal.ownerUserId,
		proposal.source,
		sourceVerifier,
	);
	return { ...proposal, source };
}

async function hydrateMemorySource(
	ownerUserId: string,
	source: MemorySource,
	sourceVerifier: MemorySourceVerifier,
): Promise<MemorySource> {
	const exists = await sourceVerifier.conversationExists({
		ownerUserId,
		sessionId: source.sessionId,
	});
	return { ...source, conversationState: exists ? "AVAILABLE" : "DELETED" };
}

async function selectRelevant(
	pool: Pool,
	query: SelectRelevantMemoryQuery,
	timestamp: Date,
): Promise<RelevantMemoryProjection> {
	assertOwnerUserId(query.ownerUserId);
	if (
		query.query.trim() === "" ||
		!Number.isSafeInteger(query.limit) ||
		query.limit <= 0
	) {
		throw new Error("MEMORY_SELECTION_INVALID");
	}
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await lockOwner(client, query.ownerUserId);
		const authorization = await readAuthorizationForUpdate(
			client,
			query.ownerUserId,
		);
		if (!authorization.memoryEnabled) {
			await client.query("COMMIT");
			return { applied: [], confirmationRequired: [], reviewRequired: [] };
		}
		const result = await client.query<MemoryItemRow>(
			`SELECT ${memoryItemColumns()} FROM memory_items
       WHERE owner_user_id = $1 AND status IN ('ACTIVE', 'NEEDS_REVIEW')
       ORDER BY memory_key, memory_id`,
			[query.ownerUserId],
		);
		const ranked = result.rows
			.map(toMemoryItem)
			.map((item) => ({ item, score: relevanceScore(query.query, item) }))
			.filter((entry) => entry.score > 0)
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.item.key.localeCompare(right.item.key),
			);
		const selected: MemoryProjectionItem[] = [];
		// 为三个投影分组的 JSON 包装和分隔符预留空间。
		let characters = 100;
		for (const entry of ranked) {
			if (selected.length >= Math.min(query.limit, 10)) break;
			const statement = entry.item.statement.slice(0, 500);
			const projectionItem: MemoryProjectionItem = {
				memoryId: entry.item.memoryId,
				key: entry.item.key,
				value: entry.item.value,
				statement,
				applicationMode: entry.item.applicationMode,
			};
			const itemCharacters = JSON.stringify(projectionItem).length;
			if (characters + itemCharacters > 4_000) continue;
			characters += itemCharacters;
			selected.push(projectionItem);
		}
		const selectedIds = new Set(selected.map((item) => item.memoryId));
		const newlyExpiredIds = new Set(
			ranked
				.filter(
					(entry) =>
						selectedIds.has(entry.item.memoryId) &&
						entry.item.status === "ACTIVE" &&
						Date.parse(entry.item.reviewAt) <= timestamp.getTime(),
				)
				.map((entry) => entry.item.memoryId),
		);
		if (newlyExpiredIds.size > 0) {
			await client.query(
				`UPDATE memory_items SET status = 'NEEDS_REVIEW', updated_at = $1
         WHERE owner_user_id = $2 AND memory_id = ANY($3::uuid[]) AND status = 'ACTIVE'`,
				[timestamp, query.ownerUserId, [...newlyExpiredIds]],
			);
		}
		const reviewRequiredIds = new Set([
			...newlyExpiredIds,
			...ranked
				.filter(
					(entry) =>
						selectedIds.has(entry.item.memoryId) &&
						entry.item.status === "NEEDS_REVIEW",
				)
				.map((entry) => entry.item.memoryId),
		]);
		const reviewRequired = selected.filter((item) =>
			reviewRequiredIds.has(item.memoryId),
		);
		const eligible = selected.filter(
			(item) => !reviewRequiredIds.has(item.memoryId),
		);
		const projection = {
			applied: eligible.filter(
				(item) => item.applicationMode === "SOFT_PREFERENCE",
			),
			confirmationRequired: eligible.filter(
				(item) => item.applicationMode === "CURRENT_CONFIRMATION_REQUIRED",
			),
			reviewRequired,
		};
		await client.query("COMMIT");
		return projection;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function loadActiveItem(
	client: PoolClient,
	ownerUserId: string,
	key: string,
): Promise<MemoryItemRow | undefined> {
	const result = await client.query<MemoryItemRow>(
		`SELECT ${memoryItemColumns()} FROM memory_items
     WHERE owner_user_id = $1 AND memory_key = $2
       AND status IN ('ACTIVE', 'NEEDS_REVIEW')
     ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1 FOR UPDATE`,
		[ownerUserId, key],
	);
	return result.rows[0];
}

async function migrateMemory(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('choicemind-memory-migration', 0))",
		);
		await client.query(`
      CREATE TABLE IF NOT EXISTS memory_authorizations (
        owner_user_id text PRIMARY KEY,
        memory_enabled boolean NOT NULL DEFAULT false,
        tool_assisted_enabled boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL,
        CHECK (memory_enabled OR NOT tool_assisted_enabled)
      )
    `);
		await client.query(`
      CREATE TABLE IF NOT EXISTS memory_items (
        owner_user_id text NOT NULL,
        memory_id uuid NOT NULL,
        memory_key text NOT NULL,
        value jsonb NOT NULL,
        statement text NOT NULL,
        sensitivity text NOT NULL CHECK (sensitivity IN ('ORDINARY', 'SENSITIVE')),
        application_mode text NOT NULL CHECK (
          application_mode IN ('SOFT_PREFERENCE', 'CURRENT_CONFIRMATION_REQUIRED')
        ),
        status text NOT NULL CHECK (status IN ('ACTIVE', 'NEEDS_REVIEW', 'SUPERSEDED')),
        source jsonb NOT NULL,
        last_confirmed_at timestamptz NOT NULL,
        review_at timestamptz NOT NULL,
        supersedes_memory_id uuid,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (owner_user_id, memory_id),
        FOREIGN KEY (owner_user_id, supersedes_memory_id)
          REFERENCES memory_items(owner_user_id, memory_id)
      )
    `);
		await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS memory_items_one_active_key
      ON memory_items (owner_user_id, memory_key) WHERE status = 'ACTIVE'
    `);
		await client.query(`
      CREATE TABLE IF NOT EXISTS memory_proposals (
        owner_user_id text NOT NULL,
        proposal_id uuid NOT NULL,
        memory_key text NOT NULL,
        value jsonb NOT NULL,
        statement text NOT NULL,
        sensitivity text NOT NULL CHECK (sensitivity IN ('ORDINARY', 'SENSITIVE')),
        application_mode text NOT NULL CHECK (
          application_mode IN ('SOFT_PREFERENCE', 'CURRENT_CONFIRMATION_REQUIRED')
        ),
        reason text NOT NULL CHECK (
          reason IN ('SENSITIVE', 'UNCERTAIN', 'BEHAVIOR_INFERRED', 'TOOL_INFERRED')
        ),
        status text NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
        source jsonb NOT NULL,
        requested_review_at timestamptz,
        resulting_memory_id uuid,
        created_at timestamptz NOT NULL,
        reviewed_at timestamptz,
        PRIMARY KEY (owner_user_id, proposal_id),
        FOREIGN KEY (owner_user_id, resulting_memory_id)
          REFERENCES memory_items(owner_user_id, memory_id)
      )
    `);
		await client.query(`
      ALTER TABLE memory_proposals
      ADD COLUMN IF NOT EXISTS requested_review_at timestamptz
    `);
		await client.query(`
      CREATE TABLE IF NOT EXISTS memory_command_results (
        owner_user_id text NOT NULL,
        request_id text NOT NULL,
        request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (owner_user_id, request_id)
      )
    `);
		await client.query(`
      CREATE TABLE IF NOT EXISTS memory_command_tombstones (
        owner_user_id text NOT NULL,
        request_id text NOT NULL,
        request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
        retired_at timestamptz NOT NULL,
        PRIMARY KEY (owner_user_id, request_id)
      )
    `);
		await client.query(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        owner_user_id text NOT NULL,
        memory_id uuid NOT NULL,
        memory_key text NOT NULL,
        embedding jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (owner_user_id, memory_id),
        FOREIGN KEY (owner_user_id, memory_id)
          REFERENCES memory_items(owner_user_id, memory_id) ON DELETE CASCADE
      )
    `);
		await client.query(`
      CREATE TABLE IF NOT EXISTS memory_projection_cache (
        owner_user_id text NOT NULL,
        memory_key text NOT NULL,
        cache_key text NOT NULL,
        projection jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (owner_user_id, cache_key)
      )
    `);
		await client.query(`
      CREATE TABLE IF NOT EXISTS memory_deletion_audit (
        audit_id uuid PRIMARY KEY,
        owner_user_id text NOT NULL,
        object_scope text NOT NULL CHECK (object_scope IN ('ITEM', 'ALL')),
        object_id_hash text NOT NULL CHECK (object_id_hash ~ '^[0-9a-f]{64}$'),
        deleted_at timestamptz NOT NULL
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

function memoryItemColumns(): string {
	return `owner_user_id, memory_id, memory_key, value, statement,
          sensitivity, application_mode, status, source,
          last_confirmed_at, review_at, supersedes_memory_id,
          created_at, updated_at`;
}

function memoryProposalColumns(): string {
	return `owner_user_id, proposal_id, memory_key, value, statement,
          sensitivity, application_mode, reason, status, source,
          requested_review_at, resulting_memory_id, created_at, reviewed_at`;
}

function toAuthorization(row: AuthorizationRow): MemoryAuthorization {
	return {
		ownerUserId: row.owner_user_id,
		memoryEnabled: row.memory_enabled,
		toolAssistedEnabled: row.tool_assisted_enabled,
		updatedAt: row.updated_at.toISOString(),
	};
}

function toMemoryItem(row: MemoryItemRow): MemoryItem {
	const value = decodeMemoryValue(row.value);
	const source = decodeMemorySource(row.source);
	if (value === undefined || source === undefined)
		throw new Error("MEMORY_STORED_DATA_INVALID");
	return {
		memoryId: row.memory_id,
		ownerUserId: row.owner_user_id,
		key: row.memory_key,
		value,
		statement: row.statement,
		sensitivity: row.sensitivity,
		applicationMode: row.application_mode,
		status: row.status,
		source,
		lastConfirmedAt: row.last_confirmed_at.toISOString(),
		reviewAt: row.review_at.toISOString(),
		...(row.supersedes_memory_id === null
			? {}
			: { supersedesMemoryId: row.supersedes_memory_id }),
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}

function toMemoryProposal(row: MemoryProposalRow): MemoryProposal {
	const value = decodeMemoryValue(row.value);
	const source = decodeMemorySource(row.source);
	if (value === undefined || source === undefined)
		throw new Error("MEMORY_STORED_DATA_INVALID");
	return {
		proposalId: row.proposal_id,
		ownerUserId: row.owner_user_id,
		key: row.memory_key,
		value,
		statement: row.statement,
		sensitivity: row.sensitivity,
		applicationMode: row.application_mode,
		reason: row.reason,
		status: row.status,
		source,
		...(row.requested_review_at === null
			? {}
			: { requestedReviewAt: row.requested_review_at.toISOString() }),
		...(row.resulting_memory_id === null
			? {}
			: { resultingMemoryId: row.resulting_memory_id }),
		createdAt: row.created_at.toISOString(),
		...(row.reviewed_at === null
			? {}
			: { reviewedAt: row.reviewed_at.toISOString() }),
	};
}

function assertMemoryChange(
	change: ProposeMemoryChangesCommand["changes"][number],
): void {
	if (
		!isMemoryKey(change.key) ||
		change.statement.trim() === "" ||
		change.statement.length > 500 ||
		decodeMemoryValue(change.value) === undefined ||
		(change.sensitivity !== "ORDINARY" && change.sensitivity !== "SENSITIVE") ||
		(change.applicationMode !== "SOFT_PREFERENCE" &&
			change.applicationMode !== "CURRENT_CONFIRMATION_REQUIRED") ||
		!["EXPLICIT", "UNCERTAIN", "BEHAVIOR_INFERRED", "TOOL_INFERRED"].includes(
			change.inference,
		)
	) {
		throw new Error("MEMORY_CHANGE_INVALID");
	}
}

function assertMemoryKey(key: string): void {
	if (!isMemoryKey(key)) throw new Error("MEMORY_KEY_INVALID");
}

function isMemoryKey(key: string): boolean {
	return /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(key) && key.length <= 120;
}

function assertReviewAt(reviewAt: string | undefined, confirmedAt: Date): void {
	if (
		reviewAt !== undefined &&
		(!Number.isFinite(Date.parse(reviewAt)) ||
			Date.parse(reviewAt) <= confirmedAt.getTime())
	) {
		throw new Error("MEMORY_REVIEW_AT_INVALID");
	}
}

function assertMemorySource(
	source: MemorySourceInput,
	latestOccurredAt?: Date,
): void {
	assertOpaqueId(source.sessionId, "sessionId");
	assertOpaqueId(source.messageId, "messageId");
	if (
		source.userExcerpt.trim() === "" ||
		Array.from(source.userExcerpt).length > 200 ||
		!Number.isFinite(Date.parse(source.occurredAt)) ||
		(latestOccurredAt !== undefined &&
			Date.parse(source.occurredAt) > latestOccurredAt.getTime())
	) {
		throw new Error("MEMORY_SOURCE_INVALID");
	}
}

function decodeMemoryValue(value: unknown): MemoryValue | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.valueType === "TEXT" && typeof candidate.value === "string") {
		return candidate.value.trim() === "" || candidate.value.length > 2_000
			? undefined
			: { valueType: "TEXT", value: candidate.value };
	}
	if (
		candidate.valueType === "NUMBER" &&
		typeof candidate.value === "number" &&
		Number.isFinite(candidate.value)
	) {
		return { valueType: "NUMBER", value: candidate.value };
	}
	if (
		candidate.valueType === "BOOLEAN" &&
		typeof candidate.value === "boolean"
	) {
		return { valueType: "BOOLEAN", value: candidate.value };
	}
	if (
		candidate.valueType === "TEXT_SET" &&
		Array.isArray(candidate.value) &&
		candidate.value.length > 0 &&
		candidate.value.length <= 20 &&
		candidate.value.every(
			(item) =>
				typeof item === "string" && item.trim() !== "" && item.length <= 500,
		)
	) {
		return { valueType: "TEXT_SET", value: [...new Set(candidate.value)] };
	}
	return undefined;
}

function decodeMemorySource(value: unknown): MemorySource | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		(candidate.sourceType !== "USER_MESSAGE" &&
			candidate.sourceType !== "TOOL_ASSISTED_CHAT") ||
		typeof candidate.sessionId !== "string" ||
		typeof candidate.messageId !== "string" ||
		typeof candidate.userExcerpt !== "string" ||
		typeof candidate.occurredAt !== "string"
	) {
		return undefined;
	}
	const source: MemorySource = {
		sourceType: candidate.sourceType,
		sessionId: candidate.sessionId,
		messageId: candidate.messageId,
		userExcerpt: candidate.userExcerpt,
		occurredAt: candidate.occurredAt,
		conversationState:
			candidate.conversationState === "DELETED" ? "DELETED" : "AVAILABLE",
	};
	try {
		assertMemorySource(source);
		return source;
	} catch {
		return undefined;
	}
}

function toStoredMemorySource(source: MemorySourceInput): MemorySource {
	return { ...source, conversationState: "AVAILABLE" };
}

function containsSensitiveMarker(
	change: ProposeMemoryChangesCommand["changes"][number],
	verifiedUserExcerpt?: string,
): boolean {
	const text =
		`${change.key} ${change.statement} ${JSON.stringify(change.value)} ${verifiedUserExcerpt ?? ""}`.toLowerCase();
	const markerMatched = [
		"health",
		"medical",
		"diagnosis",
		"hiv",
		"aids",
		"cancer",
		"diabetes",
		"tumor",
		"asthma",
		"hypertension",
		"blood pressure",
		"allergy",
		"myopia",
		"vision",
		"hearing",
		"anxiety",
		"medication",
		"pain",
		"address",
		"child",
		"daughter",
		"son",
		"baby",
		"infant",
		"minor",
		"pregnan",
		"breastfeed",
		"postpartum",
		"income",
		"salary",
		"debt",
		"loan",
		"mortgage",
		"bankruptcy",
		"bank account",
		"credit score",
		"net worth",
		"identity",
		"contact",
		"email",
		"phone number",
		"telephone number",
		"religion",
		"faith",
		"believe in",
		"sikh",
		"hindu",
		"jewish",
		"halal",
		"politic",
		"communist",
		"republican",
		"democrat",
		"sexual orientation",
		"biometric",
		"fingerprint",
		"face recognition",
		"iris",
		"voiceprint",
		"dna",
		"健康",
		"疾病",
		"艾滋",
		"人类免疫缺陷",
		"诊断",
		"病史",
		"患有",
		"得了",
		"确诊",
		"癌",
		"肿瘤",
		"糖尿病",
		"哮喘",
		"血压",
		"高血脂",
		"胆固醇",
		"心脏病",
		"冠心病",
		"肾病",
		"肝病",
		"用药",
		"治疗",
		"手术",
		"过敏",
		"抑郁",
		"近视",
		"远视",
		"散光",
		"视力",
		"听力",
		"失眠",
		"焦虑",
		"药物",
		"疼痛",
		"住址",
		"详细地址",
		"怀孕",
		"孕产",
		"孕妇",
		"备孕",
		"哺乳",
		"产后",
		"儿童",
		"孩子",
		"未成年",
		"未成年人",
		"女儿",
		"儿子",
		"宝宝",
		"婴儿",
		"幼儿",
		"小孩",
		"财务状况",
		"收入",
		"工资",
		"债务",
		"负债",
		"资产",
		"破产",
		"贷款",
		"房贷",
		"车贷",
		"月收入",
		"年收入",
		"存款",
		"银行卡",
		"征信",
		"身份证",
		"联系方式",
		"手机号",
		"电话号码",
		"邮箱",
		"宗教",
		"佛教",
		"道教",
		"基督教",
		"天主教",
		"伊斯兰教",
		"宗教信仰",
		"信奉",
		"信仰",
		"教徒",
		"锡克",
		"印度教",
		"犹太",
		"清真",
		"政治",
		"政治立场",
		"党员",
		"团员",
		"党派",
		"政党",
		"选民",
		"投票",
		"左派",
		"右派",
		"保守派",
		"自由派",
		"性取向",
		"同性恋",
		"异性恋",
		"双性恋",
		"残疾",
		"轮椅",
		"无障碍",
		"生物特征",
		"指纹",
		"人脸识别",
		"虹膜",
		"声纹",
		"dna",
	].some((marker) => text.includes(marker));
	if (markerMatched) return true;
	return (
		/\b(home_location|residential_address|street_address|national_id)\b/u.test(
			text,
		) ||
		/(我|本人).{0,8}(有|患|得|确诊|被诊断为|感染).{0,20}(病|症|炎|癌|瘤|压|糖尿|哮喘|过敏|抑郁|焦虑|病毒)/u.test(
			text,
		) ||
		/(我|本人).{0,4}(住在|居住在)/u.test(text) ||
		/[省市区县].{0,30}(街道|路|巷|号|小区|楼|栋|单元|室)/u.test(text) ||
		/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu.test(text) ||
		/\b1[3-9]\d{9}\b/u.test(text) ||
		/\b\d{17}[\dXx]\b/u.test(text) ||
		/(微信号|微信账号|qq号|qq账号|wechat\s*id|telegram\s*(id|账号)|whatsapp\s*(number|账号)|line\s*id)/iu.test(
			text,
		) ||
		/\b\d{1,6}\s+[\p{L}\d.'-]+(?:\s+[\p{L}\d.'-]+){0,5}\s+(street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|way|court|ct)\b/iu.test(
			text,
		)
	);
}

function isClearlyOrdinaryConsumerMemory(
	change: ProposeMemoryChangesCommand["changes"][number],
	verifiedUserExcerpt: string,
): boolean {
	const text =
		`${change.statement} ${JSON.stringify(change.value)}`.toLowerCase();
	const hasConsumerMarker = [
		"budget",
		"price",
		"cost",
		"size",
		"weight",
		"color",
		"brand",
		"material",
		"feature",
		"battery",
		"screen",
		"product",
		"预算",
		"价格",
		"价位",
		"尺寸",
		"重量",
		"颜色",
		"品牌",
		"材质",
		"功能",
		"续航",
		"屏幕",
		"哑光屏",
		"显示器",
		"键盘",
		"鼠标",
		"耳机",
		"手机",
		"电脑",
		"家电",
		"服装",
		"鞋",
		"食品",
		"商品",
		"产品",
	].some((marker) => text.includes(marker));
	const sourceLooksLikeIdentityDisclosure =
		/(作为|身为|我是|本人是|我属于|我的身份是|我支持|我反对|我信|信奉|信仰|加入|成员|教徒)/u.test(
			verifiedUserExcerpt,
		);
	return (
		hasConsumerMarker &&
		!sourceLooksLikeIdentityDisclosure &&
		hasConsistentExplicitMeaning(change, verifiedUserExcerpt) &&
		hasVerifiedExplicitSupport(change, verifiedUserExcerpt)
	);
}

function hasConsistentExplicitMeaning(
	change: ProposeMemoryChangesCommand["changes"][number],
	verifiedUserText: string,
): boolean {
	const source = verifiedUserText.toLocaleLowerCase();
	if (
		/(不喜欢|不偏好|不想|不要|不选|不会|不再|没有|无需|避免|排除|拒绝|讨厌)|\b(?:not|never|avoid|without|dislike|hate|do not|don't)\b/iu.test(
			source,
		)
	) {
		return false;
	}
	const hasPastMeaning =
		/(以前|之前|曾经|原来|过去)|\b(?:used to|previously|before)\b/iu.test(
			source,
		);
	const hasCurrentMeaning =
		/(现在|如今|后来|改成|改为|换成|不再)|\b(?:now|currently|changed to|switched to|no longer)\b/iu.test(
			source,
		);
	if (hasPastMeaning && hasCurrentMeaning) return false;
	const meaningTokens = explicitHanMeaningTokens(change.statement);
	if (meaningTokens.some((token) => !source.includes(token))) return false;

	const candidateNumbers = extractNumbers(
		`${change.statement} ${JSON.stringify(change.value)}`,
	);
	if (candidateNumbers.length === 0) return true;
	const sourceNumbers = extractNumbers(source);
	return candidateNumbers.every((candidate) =>
		sourceNumbers.includes(candidate),
	);
}

function explicitHanMeaningTokens(statement: string): string[] {
	const segments = statement
		.toLocaleLowerCase()
		.replace(
			/(?:偏好|喜欢|通常|常规|选择|购买|以后|今后|商品|产品|预算|价格|价位|尺寸|重量|颜色|品牌|材质|功能|续航|屏幕|哑光屏|显示器|键盘|鼠标|耳机|手机|电脑|家电|服装|食品|本人|我|更|选|买|时|的)/gu,
			" ",
		)
		.match(/\p{Script=Han}+/gu);
	return (segments ?? []).flatMap((segment) =>
		segment.length <= 2 ? [segment] : hanBigrams(segment),
	);
}

function extractNumbers(value: string): number[] {
	return (value.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/gu) ?? []).map((token) =>
		Number(token.replaceAll(",", "")),
	);
}

function hasVerifiedExplicitSupport(
	change: ProposeMemoryChangesCommand["changes"][number],
	verifiedUserText: string,
): boolean {
	const source = verifiedUserText.toLocaleLowerCase();
	const statement = change.statement.toLocaleLowerCase();
	const sourceHanBigrams = new Set(hanBigrams(source));
	const matchedHanBigrams = new Set(
		hanBigrams(statement).filter((token) => sourceHanBigrams.has(token)),
	);
	const domainBigrams = new Set([
		"预算",
		"价格",
		"显示",
		"示器",
		"键盘",
		"鼠标",
		"耳机",
		"手机",
		"电脑",
		"家电",
		"服装",
		"食品",
		"商品",
		"产品",
	]);
	const domainSupported = [...matchedHanBigrams].some((token) =>
		domainBigrams.has(token),
	);
	const attributeMatches = [...matchedHanBigrams].filter(
		(token) =>
			!domainBigrams.has(token) &&
			token !== "偏好" &&
			token !== "喜欢" &&
			token !== "通常" &&
			token !== "常规" &&
			token !== "选择" &&
			token !== "购买",
	);
	const candidateWords = statement
		.split(/[^\p{L}\p{N}]+/u)
		.filter(
			(token) =>
				token.length >= 2 &&
				!/^(prefer|preference|usually|product|keyboard|mouse|display)$/u.test(
					token,
				),
		);
	const wordSupported = candidateWords.some((token) => source.includes(token));

	if (change.value.valueType === "NUMBER") {
		return source.includes(String(change.value.value)) && domainSupported;
	}
	return (
		attributeMatches.length >= 2 ||
		(attributeMatches.length >= 1 && domainSupported) ||
		wordSupported
	);
}

function hanBigrams(value: string): string[] {
	return (value.match(/\p{Script=Han}+/gu) ?? []).flatMap((segment) => {
		const characters = Array.from(segment);
		return characters.slice(0, -1).map((character, index) => {
			return `${character}${characters[index + 1]}`;
		});
	});
}

function containsDecisionMarker(
	change: ProposeMemoryChangesCommand["changes"][number],
): boolean {
	const text = `${change.key} ${change.statement}`.toLowerCase();
	const hardMarker = [
		".max",
		".min",
		"hard_constraint",
		"required",
		"must",
		"never",
		"cannot",
		"at most",
		"no more than",
		"maximum",
		"minimum",
		"必须",
		"绝不能",
		"不能超过",
		"不得",
		"至少",
		"至多",
		"上限",
		"下限",
		"仅限",
		"预算只有",
		"只能花",
	].some((marker) => text.includes(marker));
	if (hardMarker) return true;
	const explicitSoftPreference = [
		"prefer",
		"preference",
		"usually",
		"tend to",
		"like",
		"偏好",
		"喜欢",
		"倾向",
		"通常",
		"更想",
		"更爱",
	].some((marker) => text.includes(marker));
	return !explicitSoftPreference;
}

function normalizeMemoryChange(
	change: ProposeMemoryChangesCommand["changes"][number],
	verifiedUserExcerpt?: string,
): ProposeMemoryChangesCommand["changes"][number] {
	const sensitivity =
		change.sensitivity === "SENSITIVE" ||
		containsSensitiveMarker(change, verifiedUserExcerpt)
			? "SENSITIVE"
			: "ORDINARY";
	const applicationMode =
		sensitivity === "SENSITIVE" ||
		change.applicationMode === "CURRENT_CONFIRMATION_REQUIRED" ||
		containsDecisionMarker(change)
			? "CURRENT_CONFIRMATION_REQUIRED"
			: "SOFT_PREFERENCE";
	return { ...change, sensitivity, applicationMode };
}

function relevanceScore(query: string, item: MemoryItem): number {
	const normalizedQuery = query.toLocaleLowerCase();
	const searchableText =
		`${item.key.replace(/[._]/g, " ")} ${item.statement}`.toLocaleLowerCase();
	const tokens = new Set([
		...normalizedQuery
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length >= 2),
		...Array.from(normalizedQuery).filter((character) =>
			/\p{Script=Han}/u.test(character),
		),
	]);
	return [...tokens].reduce(
		(score, token) => score + (searchableText.includes(token) ? 1 : 0),
		0,
	);
}

function classifyProposalReason(
	change: ProposeMemoryChangesCommand["changes"][number],
	verifiedUserExcerpt: string,
): MemoryProposal["reason"] | undefined {
	if (
		change.sensitivity === "SENSITIVE" ||
		containsSensitiveMarker(change, verifiedUserExcerpt)
	) {
		return "SENSITIVE";
	}
	switch (change.inference) {
		case "EXPLICIT":
			return isClearlyOrdinaryConsumerMemory(change, verifiedUserExcerpt)
				? undefined
				: "UNCERTAIN";
		case "UNCERTAIN":
			return "UNCERTAIN";
		case "BEHAVIOR_INFERRED":
			return "BEHAVIOR_INFERRED";
		case "TOOL_INFERRED":
			return "TOOL_INFERRED";
	}
}

function decodeMemoryChangeResult(
	value: unknown,
): MemoryChangeResult | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("applied" in value) ||
		!("proposals" in value) ||
		!("changes" in value) ||
		!Array.isArray(value.applied) ||
		!Array.isArray(value.proposals) ||
		!Array.isArray(value.changes)
	) {
		return undefined;
	}
	return value as MemoryChangeResult;
}

function decodeMemoryProposalReviewResult(
	value: unknown,
): MemoryProposalReviewResult | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("proposal" in value) ||
		typeof value.proposal !== "object" ||
		value.proposal === null ||
		Array.isArray(value.proposal) ||
		!("proposalId" in value.proposal) ||
		typeof value.proposal.proposalId !== "string"
	) {
		return undefined;
	}
	return value as MemoryProposalReviewResult;
}

function decodeMemoryEditResult(value: unknown): MemoryEditResult | undefined {
	const record = value as Record<string, unknown> | null;
	const item = record?.item;
	if (
		record === null ||
		typeof record !== "object" ||
		Array.isArray(value) ||
		record.changeType !== "REPLACED" ||
		typeof item !== "object" ||
		item === null ||
		Array.isArray(item) ||
		!("memoryId" in item) ||
		typeof item.memoryId !== "string"
	) {
		return undefined;
	}
	return value as MemoryEditResult;
}

function decodeMemoryDeletionResult(
	value: unknown,
): MemoryDeletionResult | undefined {
	return typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"deleted" in value &&
		value.deleted === true
		? { deleted: true }
		: undefined;
}

function fingerprintCommand(command: unknown): string {
	return createHash("sha256").update(stableJson(command), "utf8").digest("hex");
}

async function lockCommand(
	client: PoolClient,
	ownerUserId: string,
	requestId: string,
): Promise<void> {
	await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
		`${ownerUserId}:${requestId}`,
	]);
}

async function lockOwner(
	client: PoolClient,
	ownerUserId: string,
): Promise<void> {
	await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
		`memory-owner:${ownerUserId}`,
	]);
}

async function readCommandReplay(
	client: PoolClient,
	ownerUserId: string,
	requestId: string,
): Promise<MemoryCommandResultRow | undefined> {
	const result = await client.query<MemoryCommandResultRow>(
		`SELECT request_fingerprint, result FROM memory_command_results
     WHERE owner_user_id = $1 AND request_id = $2`,
		[ownerUserId, requestId],
	);
	const replay = result.rows[0];
	if (replay !== undefined) return replay;
	const retired = await client.query<MemoryCommandTombstoneRow>(
		`SELECT request_fingerprint FROM memory_command_tombstones
     WHERE owner_user_id = $1 AND request_id = $2`,
		[ownerUserId, requestId],
	);
	const tombstone = retired.rows[0];
	if (tombstone !== undefined) {
		throw new MemoryOperationConflictError("MEMORY_REQUEST_RETIRED");
	}
	return undefined;
}

function assertReplayFingerprint(
	replay: MemoryCommandResultRow,
	requestFingerprint: string,
): void {
	if (replay.request_fingerprint !== requestFingerprint) {
		throw new MemoryOperationConflictError("MEMORY_IDEMPOTENCY_CONFLICT");
	}
}

async function writeCommandResult(
	client: PoolClient,
	ownerUserId: string,
	requestId: string,
	requestFingerprint: string,
	result: unknown,
	timestamp: Date,
): Promise<void> {
	await client.query(
		`INSERT INTO memory_command_results (
       owner_user_id, request_id, request_fingerprint, result, created_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
		[
			ownerUserId,
			requestId,
			requestFingerprint,
			JSON.stringify(result),
			timestamp,
		],
	);
}

async function retireCommandResults(
	client: PoolClient,
	ownerUserId: string,
	timestamp: Date,
	memoryKey?: string,
): Promise<void> {
	const candidates = await client.query<RetirableMemoryCommandResultRow>(
		`SELECT request_id, request_fingerprint, result
		 FROM memory_command_results WHERE owner_user_id = $1`,
		[ownerUserId],
	);
	const requestIds = candidates.rows
		.filter((row) => commandResultContainsMemoryKey(row.result, memoryKey))
		.map((row) => row.request_id);
	if (requestIds.length === 0) return;
	await client.query(
		`INSERT INTO memory_command_tombstones (
       owner_user_id, request_id, request_fingerprint, retired_at
     )
     SELECT owner_user_id, request_id, request_fingerprint, $2
	     FROM memory_command_results
	     WHERE owner_user_id = $1 AND request_id = ANY($3::text[])
	     ON CONFLICT (owner_user_id, request_id) DO NOTHING`,
		[ownerUserId, timestamp, requestIds],
	);
	await client.query(
		`DELETE FROM memory_command_results
		 WHERE owner_user_id = $1 AND request_id = ANY($2::text[])`,
		[ownerUserId, requestIds],
	);
}

function commandResultContainsMemoryKey(
	value: unknown,
	memoryKey?: string,
): boolean {
	if (Array.isArray(value)) {
		return value.some((item) =>
			commandResultContainsMemoryKey(item, memoryKey),
		);
	}
	if (typeof value !== "object" || value === null) return false;
	if (
		"key" in value &&
		typeof value.key === "string" &&
		isMemoryKey(value.key) &&
		(memoryKey === undefined || value.key === memoryKey)
	) {
		return true;
	}
	return Object.values(value).some((item) =>
		commandResultContainsMemoryKey(item, memoryKey),
	);
}

async function writeDeletionAudit(
	client: PoolClient,
	ownerUserId: string,
	scope: "ITEM" | "ALL",
	objectId: string,
	timestamp: Date,
): Promise<void> {
	const objectIdHash = createHash("sha256")
		.update(objectId, "utf8")
		.digest("hex");
	await client.query(
		`INSERT INTO memory_deletion_audit (
       audit_id, owner_user_id, object_scope, object_id_hash, deleted_at
     ) VALUES ($1, $2, $3, $4, $5)`,
		[randomUUID(), ownerUserId, scope, objectIdHash, timestamp],
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function assertOwnerUserId(ownerUserId: string): void {
	if (ownerUserId.trim() === "") throw new Error("MEMORY_OWNER_INVALID");
}

function assertOpaqueId(value: string, name: string): void {
	if (value.trim() === "")
		throw new Error(`MEMORY_${name.toUpperCase()}_INVALID`);
}
