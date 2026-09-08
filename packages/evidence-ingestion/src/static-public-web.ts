import type { PublicWebEvidenceV1 } from "@choicemind/contracts/decision/v1";

import type {
	DataSourceCollectionResult,
	EvidenceSourceRole,
	EvidenceSubject,
	ResearchEvidenceMaterial,
} from "./index.js";

type CollectedSource = Extract<
	DataSourceCollectionResult,
	Readonly<{ ok: true }>
>;

type StaticPageInput = Readonly<{
	correlationId: string;
	decisionTaskId: string;
	operationId: string;
	ownerUserId: string;
	signal: AbortSignal;
	source: Readonly<{
		sourceId: string;
		sourceRole: EvidenceSourceRole;
		title: string;
		url: string;
	}>;
	subject: EvidenceSubject;
	claimTargets: readonly Readonly<{ claimId: string; statement: string }>[];
}>;

export function createStaticPublicWebPageCollector(
	options: Readonly<{
		ingestion: Readonly<{
			ingest(
				input: Readonly<{
					correlationId: string;
					decisionTaskId: string;
					operationId: string;
					signal?: AbortSignal;
					source: Readonly<{ sourceId: string; title: string; url: string }>;
					userId: string;
				}>,
			): Promise<
				| Readonly<{ status: "COLLECTED"; collection: CollectedSource }>
				| Readonly<{
						status: "EVIDENCE_GAP";
						gap: Readonly<{ code: string; retryable: boolean }>;
				  }>
			>;
		}>;
		evidenceGenerator: Readonly<{
			generate(
				input: Readonly<{
					collection: CollectedSource;
					decisionTaskId: string;
					signal?: AbortSignal;
					validUntil: string;
				}>,
			): Promise<
				| Readonly<{
						status: "EVIDENCE_CREATED";
						documentSignals: Readonly<{
							hasAccessForm?: boolean;
							hasMainContent: boolean;
							hasTitle: boolean;
						}>;
						evidence: PublicWebEvidenceV1;
				  }>
				| Readonly<{
						status: "EVIDENCE_GAP";
						gap: Readonly<{ code: string; retryable: boolean }>;
				  }>
			>;
		}>;
		minimumTextCharacters?: number;
	}>,
) {
	const minimumTextCharacters = options.minimumTextCharacters ?? 200;
	if (
		!Number.isSafeInteger(minimumTextCharacters) ||
		minimumTextCharacters <= 0
	) {
		throw new Error("STATIC_PUBLIC_WEB_MINIMUM_TEXT_INVALID");
	}

	return {
		async collect(input: StaticPageInput) {
			const collected = await options.ingestion.ingest({
				correlationId: input.correlationId,
				decisionTaskId: input.decisionTaskId,
				operationId: input.operationId,
				signal: input.signal,
				source: {
					sourceId: input.source.sourceId,
					title: input.source.title,
					url: input.source.url,
				},
				userId: input.ownerUserId,
			});
			if (collected.status === "EVIDENCE_GAP") {
				return failed(
					input.source.title,
					collected.gap.code,
					collected.gap.retryable,
				);
			}

			const capturedAt = Date.parse(
				collected.collection.sourceFacts.capturedAt,
			);
			if (!Number.isFinite(capturedAt)) {
				return failed(input.source.title, "SOURCE_CAPTURE_TIME_INVALID", false);
			}
			const expiresAt = new Date(
				capturedAt + 7 * 24 * 60 * 60 * 1_000,
			).toISOString();
			const generated = await options.evidenceGenerator.generate({
				collection: collected.collection,
				decisionTaskId: input.decisionTaskId,
				signal: input.signal,
				validUntil: expiresAt,
			});
			if (generated.status === "EVIDENCE_GAP") {
				return failed(
					input.source.title,
					generated.gap.code,
					generated.gap.retryable,
				);
			}

			const text = normalizeVisibleText(generated.evidence.excerpt);
			if (
				generated.documentSignals.hasAccessForm === true ||
				isAccessChallenge(text)
			) {
				return failed(input.source.title, "SOURCE_ACCESS_CHALLENGE", false);
			}
			if (
				text.length < minimumTextCharacters ||
				isLoadingShell(text) ||
				(!generated.documentSignals.hasMainContent &&
					!generated.documentSignals.hasTitle)
			) {
				return {
					status: "DYNAMIC_REQUIRED" as const,
					summary: `${input.source.title}的静态正文不足，不能形成证据`,
				};
			}

			const matches = input.claimTargets
				.map((claim) => ({
					claim,
					position: text
						.toLocaleLowerCase()
						.indexOf(normalizeVisibleText(claim.statement).toLocaleLowerCase()),
				}))
				.filter((match) => match.position >= 0)
				.sort((left, right) => left.position - right.position);
			const first = matches[0];
			if (first === undefined) {
				return {
					status: "NO_MATCH" as const,
					summary: `${input.source.title}未找到可逐字核对的目标信息`,
				};
			}

			const excerptStart =
				text.length <= 8_000 ? 0 : Math.max(0, first.position - 1_000);
			const excerptEnd = Math.min(text.length, excerptStart + 8_000);
			const claimLinks = matches
				.filter((match) => {
					const statementLength = normalizeVisibleText(
						match.claim.statement,
					).length;
					return (
						match.position >= excerptStart &&
						match.position + statementLength <= excerptEnd
					);
				})
				.map((match) => ({
					claimId: match.claim.claimId,
					direction: "SUPPORTS" as const,
				}));
			const material: ResearchEvidenceMaterial = {
				capturedAt: collected.collection.sourceFacts.capturedAt,
				validUntil: expiresAt,
				excerpt: text.slice(excerptStart, excerptEnd),
				locator: {
					section: "body",
					field: `text:${excerptStart}-${excerptEnd}`,
				},
				parserVersion: generated.evidence.parserVersion,
				rawArtifact: {
					...collected.collection.rawArtifact,
					lifecycle: "TRANSIENT_PLATFORM",
					expiresAt,
				},
				source: {
					sourceType: "LIVE_PLATFORM",
					sourceId: collected.collection.sourceFacts.sourceId,
					platform: "PUBLIC_WEB",
					title: collected.collection.sourceFacts.title,
					url: collected.collection.sourceFacts.url,
				},
				sourceRole: input.source.sourceRole,
				subject: input.subject,
				claimLinks,
			};
			return {
				status: "EVIDENCE_MATERIAL" as const,
				summary: `${input.source.title}：${first.claim.statement}`,
				material,
			};
		},
	};
}

function normalizeVisibleText(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function isLoadingShell(text: string): boolean {
	const normalized = text.toLocaleLowerCase();
	return ["请启用 javascript", "enable javascript", "正在加载", "loading"].some(
		(marker) => normalized.includes(marker),
	);
}

function isAccessChallenge(text: string): boolean {
	const normalized = text.toLocaleLowerCase();
	if (
		[
		"请先登录",
		"登录后查看",
		"验证码",
		"captcha",
		"sign in to continue",
		"log in to continue",
		].some((marker) => normalized.includes(marker))
	) {
		return true;
	}
	return (
		normalized.length <= 1_000 &&
		(normalized.includes("登录") || /\b(?:sign|log)\s+in\b/u.test(normalized))
	);
}

function failed(title: string, code: string, retryable: boolean) {
	return {
		status: "FAILED" as const,
		code,
		retryable,
		summary: `${title}采集失败：${code}`,
	};
}
