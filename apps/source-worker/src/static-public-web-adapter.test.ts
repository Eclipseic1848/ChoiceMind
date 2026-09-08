import { describe, expect, it, vi } from "vitest";

import { createStaticPublicWebSourceAdapter } from "./static-public-web-adapter.js";

const definition = {
	sourceId: "brand-web",
	title: "品牌官网",
	allowedOrigins: ["https://brand.example"],
	entryUrls: [
		"https://brand.example/product-a",
		"https://brand.example/product-b",
	],
	renderMode: "STATIC" as const,
	sourceRole: "OFFICIAL" as const,
};

const claim = {
	status: "CLAIMED" as const,
	jobId: "job-a",
	batchId: "batch-a",
	ownerUserId: "user-a",
	decisionTaskId: "task-a",
	query: "轻薄办公电脑",
	sourceId: "brand-web",
	sourceAccountId: "public",
	accessMode: "PUBLIC" as const,
	researchTarget: {
		subject: { kind: "CANDIDATE", value: "candidate-a" },
		claimTargets: [
			{ claimId: "claim-memory", statement: "该型号配备 32 GB 内存" },
		],
	},
	checkpoint: null,
	workerId: "worker-a",
	attemptCount: 1,
};

function material(url: string) {
	return {
		capturedAt: "2026-08-30T12:00:00.000Z",
		validUntil: "2026-09-06T12:00:00.000Z",
		excerpt: "该型号配备 32 GB 内存",
		locator: { section: "body", field: "text:0-18" },
		parserVersion: "choicemind-html-parser-1.0",
		rawArtifact: {
			algorithm: "sha256" as const,
			digest: "a".repeat(64),
			objectKey: `evidence-raw/sha256/${"a".repeat(64)}`,
			lifecycle: "TRANSIENT_PLATFORM" as const,
			expiresAt: "2026-09-06T12:00:00.000Z",
		},
		source: {
			sourceType: "LIVE_PLATFORM" as const,
			sourceId: "brand-web",
			platform: "PUBLIC_WEB",
			title: "品牌官网",
			url,
		},
		sourceRole: "OFFICIAL" as const,
		subject: { subjectType: "CANDIDATE" as const, candidateId: "candidate-a" },
		claimLinks: [{ claimId: "claim-memory", direction: "SUPPORTS" as const }],
	};
}

function runInput() {
	return {
		claim,
		idempotencyKey: "job-a",
		signal: new AbortController().signal,
		saveCheckpoint: vi.fn(async () => {}),
	};
}

describe("Static public web source adapter", () => {
	it("returns a stable bounded Evidence batch from matching static pages", async () => {
		const collect = vi.fn(
			async (input: { signal?: AbortSignal; source: { url: string } }) =>
				input.source.url.endsWith("product-a")
					? {
							status: "EVIDENCE_MATERIAL" as const,
							summary: "品牌官网：该型号配备 32 GB 内存",
							material: material(input.source.url),
						}
					: {
							status: "NO_MATCH" as const,
							summary: "品牌官网未找到可逐字核对的目标信息",
						},
		);
		const adapter = createStaticPublicWebSourceAdapter({
			definition,
			pageCollector: { collect },
		});

		const firstInput = runInput();
		const first = await adapter.run(firstInput);
		const second = await adapter.run(runInput());

		expect(second).toEqual(first);
		expect(first).toMatchObject({
			type: "EVIDENCE_BATCH",
			items: [
				{
					resultKey: expect.stringMatching(/^brand-web:[0-9a-f]{32}$/),
					evidenceId: expect.stringMatching(
						/^evidence-public-web-[0-9a-f]{32}$/,
					),
					summary: "品牌官网：该型号配备 32 GB 内存",
					material: { source: { url: "https://brand.example/product-a" } },
				},
			],
			costUnits: 0,
			checkpoint: { searched: 2, deepRead: 2, hasMore: false },
		});
		expect(collect).toHaveBeenCalledTimes(4);
		expect(collect.mock.calls[0]?.[0].signal).toBe(firstInput.signal);
	});

	it("does not create Evidence when all sufficient pages have no exact claim match", async () => {
		const adapter = createStaticPublicWebSourceAdapter({
			definition,
			pageCollector: {
				collect: async () => ({
					status: "NO_MATCH" as const,
					summary: "品牌官网未找到可逐字核对的目标信息",
				}),
			},
		});

		await expect(adapter.run(runInput())).resolves.toEqual({
			type: "NO_RESULT",
			summary: "品牌官网完成 2 个页面的静态核验，没有匹配结果",
			costUnits: 0,
		});
	});

	it("reports an insufficient static shell as a final failure until S63-3", async () => {
		const adapter = createStaticPublicWebSourceAdapter({
			definition,
			pageCollector: {
				collect: async () => ({
					status: "DYNAMIC_REQUIRED" as const,
					summary: "品牌官网的静态正文不足，不能形成证据",
				}),
			},
		});

		await expect(adapter.run(runInput())).resolves.toEqual({
			type: "FAILED_FINAL",
			summary: "品牌官网需要动态浏览器采集；S63-2 不会把静态空壳报成成功",
		});
	});

	it("falls back from an insufficient AUTO static page to dynamic Evidence", async () => {
		const staticCollect = vi.fn(async () => ({
			status: "DYNAMIC_REQUIRED" as const,
			summary: "静态正文不足",
		}));
		const dynamicCollect = vi.fn(
			async (input: { source: { url: string } }) => ({
				status: "EVIDENCE_MATERIAL" as const,
				summary: "品牌官网：该型号配备 32 GB 内存",
				material: material(input.source.url),
			}),
		);
		const adapter = createStaticPublicWebSourceAdapter({
			definition: {
				...definition,
				entryUrls: ["https://brand.example/product-a"],
				renderMode: "AUTO",
			},
			pageCollector: { collect: staticCollect },
			dynamicPageCollector: { collect: dynamicCollect },
		});

		await expect(adapter.run(runInput())).resolves.toMatchObject({
			type: "EVIDENCE_BATCH",
			items: [
				{ material: { source: { url: "https://brand.example/product-a" } } },
			],
			checkpoint: { searched: 1, deepRead: 1, hasMore: false },
		});
		expect(staticCollect).toHaveBeenCalledOnce();
		expect(dynamicCollect).toHaveBeenCalledOnce();
	});

	it("uses the dynamic collector directly for a DYNAMIC source", async () => {
		const staticCollect = vi.fn(async () => {
			throw new Error("DYNAMIC 来源不得先走静态采集");
		});
		const dynamicCollect = vi.fn(async () => ({
			status: "NO_MATCH" as const,
			summary: "动态正文没有匹配内容",
		}));
		const adapter = createStaticPublicWebSourceAdapter({
			definition: {
				...definition,
				entryUrls: ["https://brand.example/product-a"],
				renderMode: "DYNAMIC",
			},
			pageCollector: { collect: staticCollect },
			dynamicPageCollector: { collect: dynamicCollect },
		});

		await expect(adapter.run(runInput())).resolves.toEqual({
			type: "NO_RESULT",
			summary: "品牌官网完成 1 个页面的动态核验，没有匹配结果",
			costUnits: 0,
		});
		expect(staticCollect).not.toHaveBeenCalled();
		expect(dynamicCollect).toHaveBeenCalledOnce();
	});

	it("does not use the dynamic collector after a static security failure", async () => {
		const dynamicCollect = vi.fn();
		const adapter = createStaticPublicWebSourceAdapter({
			definition: { ...definition, renderMode: "AUTO" },
			pageCollector: {
				collect: async () => ({
					status: "FAILED" as const,
					code: "SOURCE_SSRF_BLOCKED",
					retryable: false,
					summary: "品牌官网采集失败：SOURCE_SSRF_BLOCKED",
				}),
			},
			dynamicPageCollector: { collect: dynamicCollect },
		});

		await expect(adapter.run(runInput())).resolves.toEqual({
			type: "FAILED_FINAL",
			summary: "品牌官网采集失败：SOURCE_SSRF_BLOCKED",
		});
		expect(dynamicCollect).not.toHaveBeenCalled();
	});

	it("preserves retryable collection failures without zero-value Evidence", async () => {
		const adapter = createStaticPublicWebSourceAdapter({
			definition,
			pageCollector: {
				collect: async () => ({
					status: "FAILED" as const,
					code: "SOURCE_DNS_FAILED",
					retryable: true,
					summary: "品牌官网采集失败：SOURCE_DNS_FAILED",
				}),
			},
		});

		await expect(adapter.run(runInput())).resolves.toEqual({
			type: "FAILED_RETRYABLE",
			summary: "品牌官网采集失败：SOURCE_DNS_FAILED",
		});
	});

	it("deep reads at most five server-approved entry pages", async () => {
		const collect = vi.fn(async () => ({
			status: "NO_MATCH" as const,
			summary: "未匹配",
		}));
		const adapter = createStaticPublicWebSourceAdapter({
			definition: {
				...definition,
				entryUrls: Array.from(
					{ length: 6 },
					(_, index) => `https://brand.example/product-${index + 1}`,
				),
			},
			pageCollector: { collect },
		});
		const input = runInput();

		await expect(adapter.run(input)).resolves.toEqual({
			type: "NO_RESULT",
			summary: "品牌官网完成 5 个页面的静态核验，没有匹配结果",
			costUnits: 0,
		});
		expect(collect).toHaveBeenCalledTimes(5);
		expect(input.saveCheckpoint).toHaveBeenCalledWith({
			searched: 6,
			deepRead: 5,
			hasMore: true,
		});
	});

	it("deduplicates entry URLs that resolve to the same canonical Evidence", async () => {
		const adapter = createStaticPublicWebSourceAdapter({
			definition,
			pageCollector: {
				collect: async () => ({
					status: "EVIDENCE_MATERIAL" as const,
					summary: "品牌官网：该型号配备 32 GB 内存",
					material: material("https://brand.example/canonical-product"),
				}),
			},
		});

		await expect(adapter.run(runInput())).resolves.toMatchObject({
			type: "EVIDENCE_BATCH",
			items: [
				{
					material: {
						source: { url: "https://brand.example/canonical-product" },
					},
				},
			],
			checkpoint: { searched: 2, deepRead: 2, hasMore: false },
		});
		const outcome = await adapter.run(runInput());
		expect(outcome.type === "EVIDENCE_BATCH" ? outcome.items : []).toHaveLength(
			1,
		);
	});
});
