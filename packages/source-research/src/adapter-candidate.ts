import { createHash } from "node:crypto";

export type AdapterCandidateSource =
	| Readonly<{
			kind: "GITHUB";
			repository: string;
			commitSha: string;
			artifactSha256: string;
	  }>
	| Readonly<{
			kind: "NPM" | "PYPI";
			packageName: string;
			version: string;
			artifactSha256: string;
	  }>;

export type AdapterCandidateReviewCheck = Readonly<{
	status: "PASSED" | "FAILED" | "NOT_RUN";
	checkCount: number;
	findingCount: number;
}>;

export type AdapterCandidateReview = Readonly<{
	reportSha256: string;
	reviewedAt: string;
	checks: Readonly<{
		dependencies: AdapterCandidateReviewCheck;
		entrypoints: AdapterCandidateReviewCheck;
		network: AdapterCandidateReviewCheck;
		secrets: AdapterCandidateReviewCheck;
		basicCollection: AdapterCandidateReviewCheck;
		loginExpiry: AdapterCandidateReviewCheck;
		rateLimit: AdapterCandidateReviewCheck;
		emptyResult: AdapterCandidateReviewCheck;
		failureHandling: AdapterCandidateReviewCheck;
	}>;
}>;

export type AdapterCandidate = Readonly<{
	schemaVersion: "adapter-candidate.v1";
	candidateId: string;
	source: AdapterCandidateSource;
	review: AdapterCandidateReview;
}>;

export type AdapterCandidateLifecycleEvent =
	| Readonly<{
			sequence: number;
			type: "ENABLED";
			actorId: string;
			actorRole: "ADMIN" | "SUPERADMIN";
			occurredAt: string;
	  }>
	| Readonly<{
			sequence: number;
			type: "DISABLED";
			actorId: string;
			actorRole: "ADMIN" | "SUPERADMIN";
			occurredAt: string;
			reasonCode: "ADMIN_REQUEST" | "SECURITY_REVIEW" | "SOURCE_DEPRECATED";
	  }>
	| Readonly<{
			sequence: number;
			type: "FAILED_ROLLBACK";
			actorId: string;
			actorRole: "SYSTEM";
			occurredAt: string;
			failureCode:
				| "LOAD_FAILED"
				| "HEALTH_CHECK_FAILED"
				| "BEHAVIOR_BOUNDARY_VIOLATION";
	  }>;

export type AdapterCandidateLifecycle = Readonly<{
	schemaVersion: "adapter-candidate-lifecycle.v1";
	candidateId: string;
	reviewBindingSha256: string;
	state: "AWAITING_APPROVAL" | "REVIEW_FAILED" | "ENABLED" | "DISABLED";
	events: readonly AdapterCandidateLifecycleEvent[];
}>;

const REVIEW_KEYS = [
	"dependencies",
	"entrypoints",
	"network",
	"secrets",
	"basicCollection",
	"loginExpiry",
	"rateLimit",
	"emptyResult",
	"failureHandling",
] as const;

export function createAdapterCandidate(input: unknown): AdapterCandidate {
	if (
		!isExactObject(input, ["schemaVersion", "source", "review"]) ||
		input.schemaVersion !== "adapter-candidate.v1"
	) {
		invalidCandidate();
	}
	return buildCandidate(parseSource(input.source), parseReview(input.review));
}

export function createAdapterCandidateLifecycle(
	input: unknown,
): AdapterCandidateLifecycle {
	const candidate = parseCandidate(input);
	return freezeLifecycle({
		schemaVersion: "adapter-candidate-lifecycle.v1",
		candidateId: candidate.candidateId,
		reviewBindingSha256: reviewBinding(candidate),
		state: allChecksPassed(candidate.review)
			? "AWAITING_APPROVAL"
			: "REVIEW_FAILED",
		events: [],
	});
}

export function transitionAdapterCandidateLifecycle(
	candidateInput: unknown,
	lifecycleInput: unknown,
	actionInput: unknown,
): AdapterCandidateLifecycle {
	const candidate = parseCandidate(candidateInput);
	const lifecycle = parseLifecycle(candidate, lifecycleInput);
	const event = actionToEvent(actionInput, lifecycle.events.length + 1);
	return parseLifecycle(candidate, {
		...lifecycle,
		state: nextState(lifecycle.state, event),
		events: [...lifecycle.events, event],
	});
}

export function readApprovedAdapterCandidate(
	candidateInput: unknown,
	lifecycleInput: unknown,
	expectedReviewBinding: string,
	artifactSha256: string,
): AdapterCandidate | undefined {
	const candidate = parseCandidate(candidateInput);
	const lifecycle = parseLifecycle(candidate, lifecycleInput);
	return lifecycle.state === "ENABLED" &&
		lifecycle.reviewBindingSha256 === expectedReviewBinding &&
		candidate.source.artifactSha256 === artifactSha256
		? candidate
		: undefined;
}

function parseCandidate(input: unknown): AdapterCandidate {
	if (
		!isExactObject(input, [
			"schemaVersion",
			"candidateId",
			"source",
			"review",
		]) ||
		input.schemaVersion !== "adapter-candidate.v1"
	) {
		invalidCandidate();
	}
	const candidate = buildCandidate(
		parseSource(input.source),
		parseReview(input.review),
	);
	if (input.candidateId !== candidate.candidateId) invalidCandidate();
	return candidate;
}

function buildCandidate(
	source: AdapterCandidateSource,
	review: AdapterCandidateReview,
): AdapterCandidate {
	const candidateId = `adapter-candidate-${createHash("sha256")
		.update(JSON.stringify(source), "utf8")
		.digest("hex")}`;
	return Object.freeze({
		schemaVersion: "adapter-candidate.v1",
		candidateId,
		source,
		review,
	});
}

function parseSource(input: unknown): AdapterCandidateSource {
	if (!isPlainObject(input) || typeof input.kind !== "string") {
		invalidCandidate();
	}
	if (input.kind === "GITHUB") {
		if (
			!hasExactKeys(input, [
				"kind",
				"repository",
				"commitSha",
				"artifactSha256",
			]) ||
			typeof input.repository !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
				input.repository,
			) ||
			typeof input.commitSha !== "string" ||
			!/^[a-fA-F0-9]{40}$/.test(input.commitSha) ||
			typeof input.artifactSha256 !== "string" ||
			!/^[a-fA-F0-9]{64}$/.test(input.artifactSha256)
		) {
			invalidCandidate();
		}
		return Object.freeze({
			kind: "GITHUB",
			repository: input.repository.toLowerCase(),
			commitSha: input.commitSha.toLowerCase(),
			artifactSha256: input.artifactSha256.toLowerCase(),
		});
	}
	if (input.kind === "NPM" || input.kind === "PYPI") {
		if (
			!hasExactKeys(input, [
				"kind",
				"packageName",
				"version",
				"artifactSha256",
			]) ||
			typeof input.packageName !== "string" ||
			typeof input.version !== "string" ||
			typeof input.artifactSha256 !== "string" ||
			!/^[a-fA-F0-9]{64}$/.test(input.artifactSha256)
		) {
			invalidCandidate();
		}
		const packageName =
			input.kind === "NPM"
				? normalizeNpmPackage(input.packageName)
				: normalizePypiPackage(input.packageName);
		const version =
			input.kind === "NPM"
				? normalizeNpmVersion(input.version)
				: normalizePypiVersion(input.version);
		return Object.freeze({
			kind: input.kind,
			packageName,
			version,
			artifactSha256: input.artifactSha256.toLowerCase(),
		});
	}
	return invalidCandidate();
}

function normalizeNpmPackage(value: string): string {
	const normalized = value.toLowerCase();
	if (
		value !== normalized ||
		!/^(?:@[a-z0-9][a-z0-9._-]{0,213}\/[a-z0-9][a-z0-9._-]{0,213}|[a-z0-9][a-z0-9._-]{0,213})$/.test(
			normalized,
		)
	) {
		invalidCandidate();
	}
	return normalized;
}

function normalizePypiPackage(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
		invalidCandidate();
	}
	return value.toLowerCase().replace(/[._-]+/g, "-");
}

function normalizeNpmVersion(value: string): string {
	if (
		!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
			value,
		)
	) {
		invalidCandidate();
	}
	return value;
}

function normalizePypiVersion(value: string): string {
	const normalized = value.toLowerCase();
	if (
		value !== normalized ||
		!/^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(
			normalized,
		)
	) {
		invalidCandidate();
	}
	return normalized;
}

function parseReview(input: unknown): AdapterCandidateReview {
	const checksInput = isPlainObject(input) ? input.checks : undefined;
	if (
		!isExactObject(input, ["reportSha256", "reviewedAt", "checks"]) ||
		typeof input.reportSha256 !== "string" ||
		!/^[a-fA-F0-9]{64}$/.test(input.reportSha256) ||
		typeof input.reviewedAt !== "string" ||
		!isCanonicalTimestamp(input.reviewedAt) ||
		!isExactObject(checksInput, REVIEW_KEYS)
	) {
		invalidCandidate();
	}
	const checks = Object.fromEntries(
		REVIEW_KEYS.map((key) => [key, parseReviewCheck(checksInput[key])]),
	) as AdapterCandidateReview["checks"];
	return Object.freeze({
		reportSha256: input.reportSha256.toLowerCase(),
		reviewedAt: input.reviewedAt,
		checks: Object.freeze(checks),
	});
}

function parseReviewCheck(input: unknown): AdapterCandidateReviewCheck {
	if (
		!isExactObject(input, ["status", "checkCount", "findingCount"]) ||
		!(["PASSED", "FAILED", "NOT_RUN"] as const).includes(
			input.status as never,
		) ||
		!boundedCount(input.checkCount) ||
		!boundedCount(input.findingCount) ||
		!validCheckCounts(
			input.status as AdapterCandidateReviewCheck["status"],
			input.checkCount,
			input.findingCount,
		)
	) {
		invalidCandidate();
	}
	return Object.freeze({
		status: input.status as AdapterCandidateReviewCheck["status"],
		checkCount: input.checkCount,
		findingCount: input.findingCount,
	});
}

function validCheckCounts(
	status: AdapterCandidateReviewCheck["status"],
	checkCount: number,
	findingCount: number,
): boolean {
	if (status === "PASSED") return checkCount > 0 && findingCount === 0;
	if (status === "FAILED") return checkCount > 0 && findingCount > 0;
	return checkCount === 0 && findingCount === 0;
}

function allChecksPassed(review: AdapterCandidateReview): boolean {
	return REVIEW_KEYS.every((key) => review.checks[key].status === "PASSED");
}

function parseLifecycle(
	candidate: AdapterCandidate,
	input: unknown,
): AdapterCandidateLifecycle {
	if (
		!isExactObject(input, [
			"schemaVersion",
			"candidateId",
			"reviewBindingSha256",
			"state",
			"events",
		]) ||
		input.schemaVersion !== "adapter-candidate-lifecycle.v1" ||
		input.candidateId !== candidate.candidateId ||
		input.reviewBindingSha256 !== reviewBinding(candidate) ||
		!(
			["AWAITING_APPROVAL", "REVIEW_FAILED", "ENABLED", "DISABLED"] as const
		).includes(input.state as never) ||
		!Array.isArray(input.events) ||
		input.events.length > 10_000
	) {
		invalidLifecycle();
	}
	const events = input.events.map((event, index) =>
		parseEvent(event, index + 1),
	);
	let state: AdapterCandidateLifecycle["state"] = allChecksPassed(
		candidate.review,
	)
		? "AWAITING_APPROVAL"
		: "REVIEW_FAILED";
	let previousTime = -Infinity;
	for (const event of events) {
		const eventTime = Date.parse(event.occurredAt);
		if (eventTime < previousTime) invalidLifecycle();
		state = nextState(state, event);
		previousTime = eventTime;
	}
	if (input.state !== state) invalidLifecycle();
	return freezeLifecycle({
		schemaVersion: "adapter-candidate-lifecycle.v1",
		candidateId: candidate.candidateId,
		reviewBindingSha256: reviewBinding(candidate),
		state,
		events,
	});
}

function actionToEvent(
	input: unknown,
	sequence: number,
): AdapterCandidateLifecycleEvent {
	if (!isPlainObject(input) || typeof input.type !== "string") {
		invalidLifecycle();
	}
	if (input.type === "ENABLE") {
		if (!hasExactKeys(input, ["type", "actorId", "actorRole", "occurredAt"])) {
			invalidLifecycle();
		}
		return parseEvent({ ...input, sequence, type: "ENABLED" }, sequence);
	}
	if (input.type === "DISABLE") {
		if (
			!hasExactKeys(input, [
				"type",
				"actorId",
				"actorRole",
				"occurredAt",
				"reasonCode",
			])
		) {
			invalidLifecycle();
		}
		return parseEvent({ ...input, sequence, type: "DISABLED" }, sequence);
	}
	if (input.type === "ROLLBACK_FAILURE") {
		if (
			!hasExactKeys(input, [
				"type",
				"actorId",
				"actorRole",
				"occurredAt",
				"failureCode",
			])
		) {
			invalidLifecycle();
		}
		return parseEvent(
			{ ...input, sequence, type: "FAILED_ROLLBACK" },
			sequence,
		);
	}
	return invalidLifecycle();
}

function parseEvent(
	input: unknown,
	expectedSequence: number,
): AdapterCandidateLifecycleEvent {
	if (
		!isPlainObject(input) ||
		input.sequence !== expectedSequence ||
		!safeActorId(input.actorId) ||
		typeof input.occurredAt !== "string" ||
		!isCanonicalTimestamp(input.occurredAt)
	) {
		invalidLifecycle();
	}
	if (input.type === "ENABLED") {
		if (
			!hasExactKeys(input, [
				"sequence",
				"type",
				"actorId",
				"actorRole",
				"occurredAt",
			]) ||
			!adminRole(input.actorRole)
		) {
			invalidLifecycle();
		}
		return Object.freeze({
			sequence: input.sequence,
			type: "ENABLED",
			actorId: input.actorId,
			actorRole: input.actorRole,
			occurredAt: input.occurredAt,
		});
	}
	if (input.type === "DISABLED") {
		if (
			!hasExactKeys(input, [
				"sequence",
				"type",
				"actorId",
				"actorRole",
				"occurredAt",
				"reasonCode",
			]) ||
			!adminRole(input.actorRole) ||
			!(
				["ADMIN_REQUEST", "SECURITY_REVIEW", "SOURCE_DEPRECATED"] as const
			).includes(input.reasonCode as never)
		) {
			invalidLifecycle();
		}
		return Object.freeze({
			sequence: input.sequence,
			type: "DISABLED",
			actorId: input.actorId,
			actorRole: input.actorRole,
			occurredAt: input.occurredAt,
			reasonCode: input.reasonCode as
				| "ADMIN_REQUEST"
				| "SECURITY_REVIEW"
				| "SOURCE_DEPRECATED",
		});
	}
	if (input.type === "FAILED_ROLLBACK") {
		if (
			!hasExactKeys(input, [
				"sequence",
				"type",
				"actorId",
				"actorRole",
				"occurredAt",
				"failureCode",
			]) ||
			input.actorRole !== "SYSTEM" ||
			!(
				[
					"LOAD_FAILED",
					"HEALTH_CHECK_FAILED",
					"BEHAVIOR_BOUNDARY_VIOLATION",
				] as const
			).includes(input.failureCode as never)
		) {
			invalidLifecycle();
		}
		return Object.freeze({
			sequence: input.sequence,
			type: "FAILED_ROLLBACK",
			actorId: input.actorId,
			actorRole: "SYSTEM",
			occurredAt: input.occurredAt,
			failureCode: input.failureCode as
				| "LOAD_FAILED"
				| "HEALTH_CHECK_FAILED"
				| "BEHAVIOR_BOUNDARY_VIOLATION",
		});
	}
	return invalidLifecycle();
}

function nextState(
	state: AdapterCandidateLifecycle["state"],
	event: AdapterCandidateLifecycleEvent,
): AdapterCandidateLifecycle["state"] {
	if (
		event.type === "ENABLED" &&
		(state === "AWAITING_APPROVAL" || state === "DISABLED")
	) {
		return "ENABLED";
	}
	if (
		(event.type === "DISABLED" || event.type === "FAILED_ROLLBACK") &&
		state === "ENABLED"
	) {
		return "DISABLED";
	}
	return invalidLifecycle();
}

function freezeLifecycle(
	input: AdapterCandidateLifecycle,
): AdapterCandidateLifecycle {
	return Object.freeze({ ...input, events: Object.freeze([...input.events]) });
}

function reviewBinding(candidate: AdapterCandidate): string {
	// 绑定规范化报告及其摘要；同一制品的新审查不得复用旧审批。
	return createHash("sha256")
		.update(JSON.stringify(candidate.review), "utf8")
		.digest("hex");
}

function adminRole(value: unknown): value is "ADMIN" | "SUPERADMIN" {
	return value === "ADMIN" || value === "SUPERADMIN";
}

function safeActorId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)
	);
}

function boundedCount(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= 0 &&
		(value as number) <= 1_000_000
	);
}

function isCanonicalTimestamp(value: string): boolean {
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isExactObject<K extends string>(
	value: unknown,
	keys: readonly K[],
): value is Record<K, unknown> {
	return isPlainObject(value) && hasExactKeys(value, keys);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return (
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function invalidCandidate(): never {
	throw new Error("ADAPTER_CANDIDATE_INVALID");
}

function invalidLifecycle(): never {
	throw new Error("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
}
