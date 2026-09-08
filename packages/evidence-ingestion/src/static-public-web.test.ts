import { createHash } from "node:crypto";

import { createEgressGuard } from "@choicemind/security";
import { describe, expect, it, vi } from "vitest";

import {
	createEvidenceIngestionService,
	createHttpDataSourceConnector,
	createPublicWebEvidenceGenerator,
	createStaticPublicWebPageCollector,
} from "./index.js";

const collection = {
	ok: true,
	sourceFacts: {
		capturedAt: "2026-08-30T12:00:00.000Z",
		mediaType: "text/html",
		sourceId: "brand-official",
		title: "品牌官网",
		url: "https://brand.example/product",
	},
	rawArtifact: {
		algorithm: "sha256",
		digest: "a".repeat(64),
		objectKey: `evidence-raw/sha256/${"a".repeat(64)}`,
	},
	metrics: { bytesFetched: 512, durationMs: 20 },
} as const;

function evidenceWithText(text: string) {
	return {
		contractType: "evidence" as const,
		contractVersion: "1.0" as const,
		evidenceId: "temporary-evidence-id",
		decisionTaskId: "task-a",
		capturedAt: collection.sourceFacts.capturedAt,
		locator: { section: "body", field: "text" },
		excerpt: text,
		validUntil: "2026-09-06T12:00:00.000Z",
		synthetic: false as const,
		source: {
			sourceKind: "PUBLIC_WEB" as const,
			sourceId: collection.sourceFacts.sourceId,
			title: collection.sourceFacts.title,
			url: collection.sourceFacts.url,
		},
		excerptHash: { algorithm: "sha256" as const, digest: "b".repeat(64) },
		parserVersion: "choicemind-html-parser-1.0",
		rawArtifact: collection.rawArtifact,
	};
}

function input() {
	return {
		correlationId: "correlation-a",
		decisionTaskId: "task-a",
		operationId: "collect-brand-a",
		ownerUserId: "user-a",
		signal: new AbortController().signal,
		source: {
			sourceId: "brand-official",
			sourceRole: "OFFICIAL" as const,
			title: "品牌官网",
			url: "https://brand.example/product",
		},
		subject: { subjectType: "CANDIDATE" as const, candidateId: "candidate-a" },
		claimTargets: [
			{ claimId: "claim-memory", statement: "该型号配备 32 GB 内存" },
			{ claimId: "claim-weight", statement: "整机重量为 1.2 千克" },
		],
	};
}

describe("Static public web page collector", () => {
	it("composes safe HTTP collection, parsing, and material creation without real network", async () => {
		const rawBytes = new TextEncoder().encode("<main>品牌官网产品参数</main>");
		let storedBytes: Uint8Array | undefined;
		const objectStore = {
			async put(bytes: Uint8Array) {
				storedBytes = bytes;
				const digest = createHash("sha256").update(bytes).digest("hex");
				return {
					algorithm: "sha256" as const,
					digest,
					objectKey: `evidence-raw/sha256/${digest}`,
				};
			},
			async read() {
				if (storedBytes === undefined) throw new Error("原始正文尚未保存");
				return storedBytes;
			},
		};
		const connector = createHttpDataSourceConnector({
			fetch: async (request) => {
				expect(request.signal).toBeInstanceOf(AbortSignal);
				return {
					arrayBuffer: async () => rawBytes.buffer,
					headers: new Headers({ "content-type": "text/html" }),
					ok: true,
					status: 200,
					url: "https://brand.example/product",
				};
			},
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			objectStore,
			readDurationMs: () => 18,
		});
		const egressOperations: string[] = [];
		const ingestion = createEvidenceIngestionService({
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			approvedSourceOrigins: new Set(["https://brand.example"]),
			collectionPolicy: {
				allowedMediaTypes: ["text/html"],
				maxBytes: 1_000_000,
			},
			connector,
			egressGuard: createEgressGuard({
				appendRecord: async (record) => {
					egressOperations.push(record.operationId);
				},
				nextId: () => "egress-static-composition",
				now: () => new Date("2026-08-30T11:59:59.000Z"),
			}),
			nextGapId: () => "gap-unused",
			resolveHost: async () => ["93.184.216.34"],
		});
		const text = `${"品牌产品参数与使用说明。".repeat(12)}该型号配备 32 GB 内存。`;
		const evidenceGenerator = createPublicWebEvidenceGenerator({
			nextEvidenceId: () => "temporary-evidence-id",
			nextGapId: () => "gap-parser",
			nextParserRequestId: () => "parse-static-composition",
			objectStore,
			parse: async (request) => ({
				contractType: "local-service-result",
				contractVersion: "1.0",
				requestId: request.requestId,
				port: "DOCUMENT_PARSER",
				ok: true,
				output: {
					parser: "choicemind-html-parser-1.0",
					text,
					pageCount: 1,
				},
			}),
		});
		const collector = createStaticPublicWebPageCollector({
			ingestion,
			evidenceGenerator,
			minimumTextCharacters: 100,
		});

		await expect(collector.collect(input())).resolves.toMatchObject({
			status: "EVIDENCE_MATERIAL",
			material: {
				validUntil: "2026-09-06T12:00:00.000Z",
				rawArtifact: {
					lifecycle: "TRANSIENT_PLATFORM",
					expiresAt: "2026-09-06T12:00:00.000Z",
				},
				claimLinks: [{ claimId: "claim-memory", direction: "SUPPORTS" }],
			},
		});
		expect(egressOperations).toEqual(["collect-brand-a:hop-0"]);
	});

	it("creates seven-day traceable material only for claims present in the excerpt", async () => {
		const text = `${"品牌产品参数与使用说明。".repeat(12)}该型号配备 32 GB 内存。`;
		const collector = createStaticPublicWebPageCollector({
			ingestion: {
				ingest: vi.fn(async () => ({
					status: "COLLECTED" as const,
					collection,
				})),
			},
			evidenceGenerator: {
				generate: vi.fn(async () => ({
					status: "EVIDENCE_CREATED" as const,
					documentSignals: { hasMainContent: true, hasTitle: true },
					evidence: evidenceWithText(text),
				})),
			},
			minimumTextCharacters: 100,
		});

		await expect(collector.collect(input())).resolves.toEqual({
			status: "EVIDENCE_MATERIAL",
			summary: "品牌官网：该型号配备 32 GB 内存",
			material: {
				capturedAt: "2026-08-30T12:00:00.000Z",
				validUntil: "2026-09-06T12:00:00.000Z",
				excerpt: text,
				locator: { section: "body", field: `text:0-${text.length}` },
				parserVersion: "choicemind-html-parser-1.0",
				rawArtifact: {
					...collection.rawArtifact,
					lifecycle: "TRANSIENT_PLATFORM",
					expiresAt: "2026-09-06T12:00:00.000Z",
				},
				source: {
					sourceType: "LIVE_PLATFORM",
					sourceId: "brand-official",
					platform: "PUBLIC_WEB",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				sourceRole: "OFFICIAL",
				subject: { subjectType: "CANDIDATE", candidateId: "candidate-a" },
				claimLinks: [{ claimId: "claim-memory", direction: "SUPPORTS" }],
			},
		});
	});

	it("requires the dynamic path when visible text is an insufficient shell", async () => {
		const collector = createStaticPublicWebPageCollector({
			ingestion: {
				ingest: async () => ({ status: "COLLECTED" as const, collection }),
			},
			evidenceGenerator: {
				generate: async () => ({
					status: "EVIDENCE_CREATED" as const,
					documentSignals: { hasMainContent: true, hasTitle: true },
					evidence: evidenceWithText("正在加载，请启用 JavaScript"),
				}),
			},
			minimumTextCharacters: 100,
		});

		await expect(collector.collect(input())).resolves.toEqual({
			status: "DYNAMIC_REQUIRED",
			summary: "品牌官网的静态正文不足，不能形成证据",
		});
	});

	it("returns no match after a sufficient page contains none of the target claims", async () => {
		const text = "品牌官网提供了完整的产品介绍、服务政策和常见问题。".repeat(
			10,
		);
		const collector = createStaticPublicWebPageCollector({
			ingestion: {
				ingest: async () => ({ status: "COLLECTED" as const, collection }),
			},
			evidenceGenerator: {
				generate: async () => ({
					status: "EVIDENCE_CREATED" as const,
					documentSignals: { hasMainContent: true, hasTitle: true },
					evidence: evidenceWithText(text),
				}),
			},
			minimumTextCharacters: 100,
		});

		await expect(collector.collect(input())).resolves.toEqual({
			status: "NO_MATCH",
			summary: "品牌官网未找到可逐字核对的目标信息",
		});
	});

	it("preserves retryability when safe collection fails", async () => {
		const generate = vi.fn();
		const collector = createStaticPublicWebPageCollector({
			ingestion: {
				ingest: async () => ({
					status: "EVIDENCE_GAP" as const,
					gap: { code: "SOURCE_DNS_FAILED", retryable: true },
				}),
			},
			evidenceGenerator: { generate },
		});

		await expect(collector.collect(input())).resolves.toEqual({
			status: "FAILED",
			code: "SOURCE_DNS_FAILED",
			retryable: true,
			summary: "品牌官网采集失败：SOURCE_DNS_FAILED",
		});
		expect(generate).not.toHaveBeenCalled();
	});

	it("does not accept a long loading shell even when it repeats the claim text", async () => {
		const text = `${"正在加载产品参数，请稍候。".repeat(60)}该型号配备 32 GB 内存`;
		const collector = createStaticPublicWebPageCollector({
			ingestion: {
				ingest: async () => ({ status: "COLLECTED" as const, collection }),
			},
			evidenceGenerator: {
				generate: async () => ({
					status: "EVIDENCE_CREATED" as const,
					documentSignals: { hasMainContent: true, hasTitle: true },
					evidence: evidenceWithText(text),
				}),
			},
			minimumTextCharacters: 100,
		});

		await expect(collector.collect(input())).resolves.toEqual({
			status: "DYNAMIC_REQUIRED",
			summary: "品牌官网的静态正文不足，不能形成证据",
		});
	});

	it("requires a title or main content container before accepting static Evidence", async () => {
		const text = `${"品牌产品参数与使用说明。".repeat(12)}该型号配备 32 GB 内存。`;
		const collector = createStaticPublicWebPageCollector({
			ingestion: {
				ingest: async () => ({ status: "COLLECTED" as const, collection }),
			},
			evidenceGenerator: {
				generate: async () => ({
					status: "EVIDENCE_CREATED" as const,
					documentSignals: { hasMainContent: false, hasTitle: false },
					evidence: evidenceWithText(text),
				}),
			},
			minimumTextCharacters: 100,
		});

		await expect(collector.collect(input())).resolves.toEqual({
			status: "DYNAMIC_REQUIRED",
			summary: "品牌官网的静态正文不足，不能形成证据",
		});
	});

	it("stops on a password form without fabricating a login session", async () => {
		const text = `${"品牌产品参数与使用说明。".repeat(12)}该型号配备 32 GB 内存。`;
		const collector = createStaticPublicWebPageCollector({
			ingestion: {
				ingest: async () => ({ status: "COLLECTED" as const, collection }),
			},
			evidenceGenerator: {
				generate: async () => ({
					status: "EVIDENCE_CREATED" as const,
					documentSignals: {
						hasAccessForm: true,
						hasMainContent: true,
						hasTitle: true,
					},
					evidence: evidenceWithText(text),
				}),
			},
			minimumTextCharacters: 100,
		});

		await expect(collector.collect(input())).resolves.toEqual({
			status: "FAILED",
			code: "SOURCE_ACCESS_CHALLENGE",
			retryable: false,
			summary: "品牌官网采集失败：SOURCE_ACCESS_CHALLENGE",
		});
	});

	it("stops on a short Sign in page before claim matching", async () => {
		const collector = createStaticPublicWebPageCollector({
			ingestion: {
				ingest: async () => ({ status: "COLLECTED" as const, collection }),
			},
			evidenceGenerator: {
				generate: async () => ({
					status: "EVIDENCE_CREATED" as const,
					documentSignals: { hasMainContent: true, hasTitle: true },
					evidence: evidenceWithText("Sign in"),
				}),
			},
		});

		await expect(collector.collect(input())).resolves.toMatchObject({
			status: "FAILED",
			code: "SOURCE_ACCESS_CHALLENGE",
			retryable: false,
		});
	});
});
