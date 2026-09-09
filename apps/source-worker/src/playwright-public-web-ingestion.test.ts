import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlaywrightPublicWebIngestion } from "./playwright-public-web-ingestion.js";

type RouteHandler = (route: FakeRoute) => Promise<void>;

class FakeRoute {
	readonly abort = vi.fn(async () => {});
	readonly fulfill = vi.fn(async () => {});

	constructor(
		private readonly requestValue: Readonly<{
			method: string;
			resourceType: string;
			url: string;
		}>,
	) {}

	request() {
		return {
			isNavigationRequest: () => this.requestValue.resourceType === "document",
			method: () => this.requestValue.method,
			resourceType: () => this.requestValue.resourceType,
			url: () => this.requestValue.url,
		};
	}
}

function createFakeBrowser(
	requests: readonly Readonly<{
		method: string;
		resourceType: string;
		url: string;
	}>[] = [
		{
			method: "GET",
			resourceType: "document",
			url: "https://brand.example/product",
		},
		{
			method: "GET",
			resourceType: "script",
			url: "https://brand.example/app.js",
		},
	],
) {
	let routeHandler: RouteHandler | undefined;
	let webSocketHandler: ((socket: { close(): void }) => void) | undefined;
	let pageUrl = "https://brand.example/product";
	const routes: FakeRoute[] = [];
	const close = vi.fn(async () => {});
	const page = {
		content: vi.fn(
			async () =>
				"<!doctype html><html><head><title>产品页</title></head><body><main>渲染后的产品正文</main></body></html>",
		),
		goto: vi.fn(async () => {
			for (const request of requests) {
				const route = new FakeRoute(request);
				routes.push(route);
				await routeHandler?.(route);
				if (request.resourceType === "document") pageUrl = request.url;
			}
		}),
		on: vi.fn(),
		waitForTimeout: vi.fn(async () => {}),
		url: () => pageUrl,
	};
	const context = {
		addInitScript: vi.fn(async () => {}),
		close,
		newPage: vi.fn(async () => page),
		route: vi.fn(async (_pattern: string, handler: RouteHandler) => {
			routeHandler = handler;
		}),
		routeWebSocket: vi.fn(
			async (_pattern: string, handler: typeof webSocketHandler) => {
				webSocketHandler = handler;
			},
		),
	};
	const browser = {
		newContext: vi.fn(async () => context),
		version: () => "123.0.0.0",
	};
	return {
		browser,
		close,
		context,
		page,
		routes,
		triggerWebSocket: () => {
			const socket = { close: vi.fn() };
			webSocketHandler?.(socket);
			return socket;
		},
	};
}

describe("createPlaywrightPublicWebIngestion", () => {
	it("取消后才创建成功的上下文仍会关闭", async () => {
		const fake = createFakeBrowser();
		let finish!: (context: typeof fake.context) => void;
		fake.browser.newContext.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		const controller = new AbortController();
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: { load: vi.fn() }, objectStore: { put: vi.fn() },
			nextGapId: () => "gap-cancel", now: () => new Date(),
		});
		const pending = ingestion.ingest({
			correlationId: "cancel", decisionTaskId: "task", operationId: "cancel",
			signal: controller.signal, userId: "user",
			source: { sourceId: "brand", title: "品牌", url: "https://brand.example/product" },
		});
		controller.abort();
		await expect(pending).rejects.toBe(controller.signal.reason);
		finish(fake.context);
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.close).toHaveBeenCalledOnce();
		expect(fake.context.newPage).not.toHaveBeenCalled();
	});

	it("通过安全加载器执行动态页面，并保存七天原始 HTML", async () => {
		const fake = createFakeBrowser();
		const load = vi.fn(async (input: Readonly<{ url: string }>) => ({
			status: "LOADED" as const,
			response: {
				status: 200,
				headers: {
					"content-type": input.url.endsWith(".js")
						? "text/javascript"
						: "text/html",
				},
				body: new TextEncoder().encode(
					input.url.endsWith(".js")
						? "document.body.dataset.ready='1'"
						: "<html></html>",
				),
			},
		}));
		const put = vi.fn(
			async (
				_bytes: Uint8Array,
				_retention?: Readonly<{ expiresAt: string }>,
			) => ({
				algorithm: "sha256" as const,
				digest: "a".repeat(64),
				objectKey: `evidence-raw/sha256/${"a".repeat(64)}`,
			}),
		);
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: { load },
			objectStore: { put },
			nextGapId: () => "gap-1",
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			readDurationMs: () => 25,
		});

		await expect(
			ingestion.ingest({
				correlationId: "job-1",
				decisionTaskId: "task-1",
				operationId: "job-1:dynamic",
				signal: new AbortController().signal,
				source: {
					sourceId: "brand-web",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				userId: "user-1",
			}),
		).resolves.toEqual({
			status: "COLLECTED",
			collection: {
				ok: true,
				sourceFacts: {
					capturedAt: "2026-08-30T12:00:00.000Z",
					collectorVersion:
						"playwright@1.62.1/chromium-123.0.0.0 + http-connector@1",
					mediaType: "text/html",
					sourceId: "brand-web",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				rawArtifact: {
					algorithm: "sha256",
					digest: "a".repeat(64),
					objectKey: `evidence-raw/sha256/${"a".repeat(64)}`,
				},
				metrics: { bytesFetched: 44, durationMs: 25 },
			},
		});
		expect(fake.browser.newContext).toHaveBeenCalledWith({
			serviceWorkers: "block",
		});
		expect(fake.context.addInitScript).toHaveBeenCalledOnce();
		expect(fake.page.goto).toHaveBeenCalledWith(
			"https://brand.example/product",
			expect.objectContaining({ waitUntil: "networkidle" }),
		);
		expect(load.mock.calls.map(([input]) => input.url)).toEqual([
			"https://brand.example/product",
			"https://brand.example/app.js",
		]);
		expect(
			fake.routes.every((route) => route.fulfill.mock.calls.length === 1),
		).toBe(true);
		expect(put).toHaveBeenCalledWith(expect.any(Uint8Array), {
			expiresAt: "2026-09-06T12:00:00.000Z",
		});
		expect(new TextDecoder().decode(put.mock.calls[0]?.[0])).toContain(
			"渲染后的产品正文",
		);
		expect(fake.triggerWebSocket().close).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
	});

	it("让浏览器处理安全加载器返回的重定向与响应安全头", async () => {
		const fake = createFakeBrowser([
			{
				method: "GET",
				resourceType: "document",
				url: "https://brand.example/product",
			},
			{
				method: "GET",
				resourceType: "document",
				url: "https://brand.example/products/final",
			},
		]);
		const load = vi.fn(async (input: Readonly<{ url: string }>) =>
			input.url.endsWith("/product")
				? {
						status: "LOADED" as const,
						response: {
							status: 302,
							headers: {
								location: "https://brand.example/products/final",
							},
							body: new Uint8Array(),
						},
					}
				: {
						status: "LOADED" as const,
						response: {
							status: 200,
							headers: {
								"content-security-policy": "default-src 'self'",
								"content-type": "text/html",
							},
							body: new TextEncoder().encode("<html></html>"),
						},
					},
		);
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: { load },
			objectStore: {
				put: async () => ({
					algorithm: "sha256",
					digest: "d".repeat(64),
					objectKey: `evidence-raw/sha256/${"d".repeat(64)}`,
				}),
			},
			nextGapId: () => "gap-unused",
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			settleTimeMs: 0,
		});

		await expect(
			ingestion.ingest({
				correlationId: "job-redirect",
				decisionTaskId: "task-redirect",
				operationId: "job-redirect:dynamic",
				source: {
					sourceId: "brand-web",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				userId: "user-redirect",
			}),
		).resolves.toMatchObject({
			status: "COLLECTED",
			collection: {
				sourceFacts: { url: "https://brand.example/products/final" },
			},
		});
		expect(fake.routes[0]?.fulfill).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 302,
				headers: expect.objectContaining({
					location: "https://brand.example/products/final",
				}),
			}),
		);
		expect(fake.routes[1]?.fulfill).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({
					"content-security-policy": "default-src 'self'",
				}),
			}),
		);
	});

	it("拒绝安全加载器返回的跨来源重定向", async () => {
		const fake = createFakeBrowser([
			{
				method: "GET",
				resourceType: "document",
				url: "https://brand.example/product",
			},
		]);
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: {
				load: async () => ({
					status: "LOADED" as const,
					response: {
						status: 302,
						headers: { location: "https://tracker.example/steal" },
						body: new Uint8Array(),
					},
				}),
			},
			objectStore: { put: vi.fn() },
			nextGapId: () => "gap-redirect",
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			settleTimeMs: 0,
		});

		await expect(
			ingestion.ingest({
				correlationId: "job-cross-origin",
				decisionTaskId: "task-cross-origin",
				operationId: "job-cross-origin:dynamic",
				source: {
					sourceId: "brand-web",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				userId: "user-cross-origin",
			}),
		).resolves.toMatchObject({
			status: "EVIDENCE_GAP",
			gap: { code: "SOURCE_REDIRECT_REJECTED", retryable: false },
		});
		expect(fake.routes[0]?.fulfill).not.toHaveBeenCalled();
	});

	it("把剩余总预算传给安全加载器，避免先下载后发现超限", async () => {
		const fake = createFakeBrowser();
		const remainingBudgets: number[] = [];
		const put = vi.fn();
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: {
				async load(input) {
					remainingBudgets.push(input.maxBytes);
					const body = new Uint8Array(input.url.endsWith(".js") ? 4 : 7);
					return body.byteLength > input.maxBytes
						? {
								status: "EVIDENCE_GAP" as const,
								gap: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
							}
						: {
								status: "LOADED" as const,
								response: {
									body,
									headers: { "content-type": "text/html" },
									status: 200,
								},
							};
				},
			},
			objectStore: { put },
			nextGapId: () => "gap-size",
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			maxTotalBytes: 10,
			settleTimeMs: 0,
		});

		await expect(
			ingestion.ingest({
				correlationId: "job-size",
				decisionTaskId: "task-size",
				operationId: "job-size:dynamic",
				source: {
					sourceId: "brand-web",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				userId: "user-size",
			}),
		).resolves.toMatchObject({
			status: "EVIDENCE_GAP",
			gap: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
		});
		expect(remainingBudgets).toEqual([10, 3]);
		expect(put).not.toHaveBeenCalled();
	});

	it("拒绝 POST、跨来源和非必要资源，且不把它们交给加载器", async () => {
		const fake = createFakeBrowser([
			{
				method: "GET",
				resourceType: "document",
				url: "https://brand.example/product",
			},
			{
				method: "POST",
				resourceType: "fetch",
				url: "https://brand.example/track",
			},
			{
				method: "GET",
				resourceType: "script",
				url: "https://tracker.example/track.js",
			},
			{
				method: "GET",
				resourceType: "image",
				url: "https://brand.example/hero.jpg",
			},
		]);
		const load = vi.fn(async () => ({
			status: "LOADED" as const,
			response: {
				status: 200,
				headers: { "content-type": "text/html" },
				body: new TextEncoder().encode("<html></html>"),
			},
		}));
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: { load },
			objectStore: {
				put: async () => ({
					algorithm: "sha256",
					digest: "b".repeat(64),
					objectKey: `evidence-raw/sha256/${"b".repeat(64)}`,
				}),
			},
			nextGapId: () => "gap-1",
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			settleTimeMs: 0,
		});

		await expect(
			ingestion.ingest({
				correlationId: "job-1",
				decisionTaskId: "task-1",
				operationId: "job-1:dynamic",
				source: {
					sourceId: "brand-web",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				userId: "user-1",
			}),
		).resolves.toMatchObject({ status: "COLLECTED" });
		expect(load).toHaveBeenCalledOnce();
		expect(fake.routes[0]?.fulfill).toHaveBeenCalledOnce();
		for (const route of fake.routes.slice(1)) {
			expect(route.abort).toHaveBeenCalledOnce();
			expect(route.fulfill).not.toHaveBeenCalled();
		}
	});

	it.each([
		{
			name: "请求数",
			limits: { maxRequests: 1, maxTotalBytes: 1_000 },
			expectedCode: "SOURCE_REQUEST_LIMIT_EXCEEDED",
		},
		{
			name: "响应总字节",
			limits: { maxRequests: 10, maxTotalBytes: 10 },
			expectedCode: "SOURCE_SIZE_EXCEEDED",
		},
	])(
		"超过$name上限时返回结构化缺口且不保存原始材料",
		async ({ limits, expectedCode }) => {
			const fake = createFakeBrowser();
			const put = vi.fn();
			const ingestion = createPlaywrightPublicWebIngestion({
				browser: fake.browser as never,
				approvedSourceOrigins: new Set(["https://brand.example"]),
				approvedSourceUrls: new Set(["https://brand.example/product"]),
				safeResourceLoader: {
					load: async () => ({
						status: "LOADED" as const,
						response: {
							status: 200,
							headers: { "content-type": "text/html" },
							body: new TextEncoder().encode("<html></html>"),
						},
					}),
				},
				objectStore: { put },
				nextGapId: () => "gap-limit",
				now: () => new Date("2026-08-30T12:00:00.000Z"),
				settleTimeMs: 0,
				...limits,
			});

			await expect(
				ingestion.ingest({
					correlationId: "job-limit",
					decisionTaskId: "task-limit",
					operationId: "job-limit:dynamic",
					source: {
						sourceId: "brand-web",
						title: "品牌官网",
						url: "https://brand.example/product",
					},
					userId: "user-1",
				}),
			).resolves.toEqual({
				status: "EVIDENCE_GAP",
				gap: {
					code: expectedCode,
					decisionTaskId: "task-limit",
					gapId: "gap-limit",
					retryable: false,
					sourceId: "brand-web",
				},
			});
			expect(put).not.toHaveBeenCalled();
		},
	);

	it("保留安全加载器的失败语义，且不伪造动态采集成功", async () => {
		const fake = createFakeBrowser([
			{
				method: "GET",
				resourceType: "document",
				url: "https://brand.example/product",
			},
		]);
		const put = vi.fn();
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: {
				load: async () => ({
					status: "EVIDENCE_GAP" as const,
					gap: { code: "SOURCE_SSRF_BLOCKED", retryable: false },
				}),
			},
			objectStore: { put },
			nextGapId: () => "gap-ssrf",
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			settleTimeMs: 0,
		});

		await expect(
			ingestion.ingest({
				correlationId: "job-ssrf",
				decisionTaskId: "task-ssrf",
				operationId: "job-ssrf:dynamic",
				source: {
					sourceId: "brand-web",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				userId: "user-1",
			}),
		).resolves.toMatchObject({
			status: "EVIDENCE_GAP",
			gap: { code: "SOURCE_SSRF_BLOCKED", retryable: false },
		});
		expect(put).not.toHaveBeenCalled();
	});

	it("租约取消会关闭 BrowserContext 并向上抛出取消原因", async () => {
		const fake = createFakeBrowser([
			{
				method: "GET",
				resourceType: "document",
				url: "https://brand.example/product",
			},
		]);
		let started: (() => void) | undefined;
		const loaderStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const controller = new AbortController();
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: {
				load: async () => {
					started?.();
					return new Promise<never>(() => {});
				},
			},
			objectStore: { put: vi.fn() },
			nextGapId: () => "gap-abort",
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			settleTimeMs: 0,
		});
		const cancelled = new Error("租约已取消");
		const pending = ingestion.ingest({
			correlationId: "job-abort",
			decisionTaskId: "task-abort",
			operationId: "job-abort:dynamic",
			signal: controller.signal,
			source: {
				sourceId: "brand-web",
				title: "品牌官网",
				url: "https://brand.example/product",
			},
			userId: "user-1",
		});
		await loaderStarted;
		controller.abort(cancelled);

		await expect(pending).rejects.toBe(cancelled);
		expect(fake.close).toHaveBeenCalled();
	});

	it("浏览器工作超过时限时返回可重试缺口并关闭上下文", async () => {
		const fake = createFakeBrowser([
			{
				method: "GET",
				resourceType: "document",
				url: "https://brand.example/product",
			},
		]);
		const ingestion = createPlaywrightPublicWebIngestion({
			browser: fake.browser as never,
			approvedSourceOrigins: new Set(["https://brand.example"]),
			approvedSourceUrls: new Set(["https://brand.example/product"]),
			safeResourceLoader: { load: async () => new Promise<never>(() => {}) },
			objectStore: { put: vi.fn() },
			nextGapId: () => "gap-timeout",
			now: () => new Date("2026-08-30T12:00:00.000Z"),
			settleTimeMs: 0,
			timeoutMs: 5,
		});

		await expect(
			ingestion.ingest({
				correlationId: "job-timeout",
				decisionTaskId: "task-timeout",
				operationId: "job-timeout:dynamic",
				source: {
					sourceId: "brand-web",
					title: "品牌官网",
					url: "https://brand.example/product",
				},
				userId: "user-1",
			}),
		).resolves.toMatchObject({
			status: "EVIDENCE_GAP",
			gap: { code: "SOURCE_FETCH_FAILED", retryable: true },
		});
		expect(fake.close).toHaveBeenCalled();
	});
});

describe.runIf(process.env.CHOICEMIND_RUN_CHROMIUM_ACCEPTANCE === "1")(
	"Playwright dynamic ingestion with isolated Chromium",
	() => {
		let browser: Browser;

		beforeAll(async () => {
			browser = await chromium.launch({
				headless: true,
				args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
			});
		});

		afterAll(async () => {
			await browser.close();
		});

		it("executes routed JavaScript and stores the rendered DOM without external network", async () => {
			let storedHtml = "";
			const ingestion = createPlaywrightPublicWebIngestion({
				approvedSourceOrigins: new Set(["https://brand.example"]),
				approvedSourceUrls: new Set(["https://brand.example/product"]),
				browser,
				nextGapId: () => "gap-unused",
				now: () => new Date("2026-08-30T12:00:00.000Z"),
				objectStore: {
					async put(bytes) {
						storedHtml = new TextDecoder().decode(bytes);
						return {
							algorithm: "sha256",
							digest: "c".repeat(64),
							objectKey: `evidence-raw/sha256/${"c".repeat(64)}`,
						};
					},
				},
				safeResourceLoader: {
					async load(input) {
						const script = input.url.endsWith("/app.js");
						return {
							status: "LOADED" as const,
							response: {
								body: new TextEncoder().encode(
									script
										? 'document.querySelector("#root").innerHTML="<main>该型号配备 32 GB 内存</main>";document.title="产品页";document.documentElement.dataset.networkApis=["RTCPeerConnection","WebSocket","WebTransport","Worker"].every((name)=>globalThis[name]===undefined)?"blocked":"open";'
										: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root">正在加载</div><script src="/app.js"></script></body></html>',
								),
								headers: {
									"content-type": script
										? "text/javascript"
										: "text/html",
								},
								status: 200,
							},
						};
					},
				},
				settleTimeMs: 0,
			});

			await expect(
				ingestion.ingest({
					correlationId: "job-chromium",
					decisionTaskId: "task-chromium",
					operationId: "job-chromium:dynamic",
					source: {
						sourceId: "brand-web",
						title: "品牌官网",
						url: "https://brand.example/product",
					},
					userId: "user-chromium",
				}),
			).resolves.toMatchObject({ status: "COLLECTED" });
			expect(storedHtml).toContain("<main>该型号配备 32 GB 内存</main>");
			expect(storedHtml).toContain("<title>产品页</title>");
			expect(storedHtml).toContain('data-network-apis="blocked"');
		});
	},
);
