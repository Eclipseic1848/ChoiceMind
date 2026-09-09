import type {
	DataSourceArtifactRef,
	DataSourceCollectionResult,
	RawEvidenceObjectStore,
} from "@choicemind/evidence-ingestion";
import type { Browser, Route } from "playwright";

const PLAYWRIGHT_VERSION = "1.62.1";

type CollectedSource = Extract<
	DataSourceCollectionResult,
	Readonly<{ ok: true }>
>;

type ResourceLoadResult =
	| Readonly<{
			status: "LOADED";
			response: Readonly<{
				body: Uint8Array;
				headers: Readonly<Record<string, string>>;
				status: number;
			}>;
	  }>
	| Readonly<{
			status: "EVIDENCE_GAP";
			gap: Readonly<{ code: string; retryable: boolean }>;
	  }>;

export function createPlaywrightPublicWebIngestion(
	options: Readonly<{
		approvedSourceOrigins: ReadonlySet<string>;
		approvedSourceUrls: ReadonlySet<string>;
		browser: Browser;
		maxRequests?: number;
		maxTotalBytes?: number;
		nextGapId: () => string;
		now: () => Date;
		objectStore: Pick<RawEvidenceObjectStore, "put">;
		readDurationMs?: () => number;
		safeResourceLoader: Readonly<{
			load(
				input: Readonly<{
					correlationId: string;
					decisionTaskId: string;
					maxBytes: number;
					operationId: string;
					signal: AbortSignal;
					sourceId: string;
					url: string;
					userId: string;
				}>,
			): Promise<ResourceLoadResult>;
		}>;
		settleTimeMs?: number;
		timeoutMs?: number;
	}>,
) {
	const maxRequests = positiveInteger(options.maxRequests ?? 50, "请求数");
	const maxTotalBytes = positiveInteger(
		options.maxTotalBytes ?? 5_000_000,
		"响应大小",
	);
	const settleTimeMs = nonNegativeInteger(
		options.settleTimeMs ?? 250,
		"页面稳定时间",
	);
	const timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "页面超时");

	return {
		async ingest(
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
					gap: Readonly<{
						code: string;
						decisionTaskId: string;
						gapId: string;
						retryable: boolean;
						sourceId: string;
					}>;
			  }>
		> {
			const initialUrl = validateInitialUrl(
				input.source.url,
				options.approvedSourceUrls,
			);
			if (typeof initialUrl === "string") {
				return evidenceGap(options, input, initialUrl, false);
			}

			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const signal =
				input.signal === undefined
					? timeoutSignal
					: AbortSignal.any([input.signal, timeoutSignal]);
			let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
			let fatalGap: Readonly<{ code: string; retryable: boolean }> | undefined;
			let requestCount = 0;
			let redirectCount = 0;
			let totalBytes = 0;
			let loadQueue = Promise.resolve();
			const startedAt = performance.now();

			try {
				signal.throwIfAborted();
				const createdContext = await abortable(
					options.browser.newContext({ serviceWorkers: "block" }).then(async (created) => {
						if (signal.aborted) {
							await created.close();
							signal.throwIfAborted();
						}
						return created;
					}),
					signal,
				);
				context = createdContext;
				signal.throwIfAborted();
				const closeOnAbort = () => {
					void context?.close().catch(() => undefined);
				};
				signal.addEventListener("abort", closeOnAbort, { once: true });
				try {
					await context.addInitScript({ content: BLOCKED_BROWSER_APIS_SCRIPT });
					await context.route("**/*", async (route) => {
						requestCount += 1;
						const requestNumber = requestCount;
						if (fatalGap !== undefined || requestNumber > maxRequests) {
							fatalGap ??= {
								code: "SOURCE_REQUEST_LIMIT_EXCEEDED",
								retryable: false,
							};
							await route.abort("blockedbyclient");
							return;
						}
						const request = route.request();
						const rejection = validateBrowserRequest(
							request.method(),
							request.resourceType(),
							request.url(),
							options.approvedSourceOrigins,
						);
						if (rejection !== undefined) {
							if (request.isNavigationRequest()) fatalGap ??= rejection;
							await route.abort("blockedbyclient");
							return;
						}

						let loaded: ResourceLoadResult;
						try {
							const scheduledLoad = loadQueue.then(async () => {
								signal.throwIfAborted();
								const maxBytes = maxTotalBytes - totalBytes;
								if (maxBytes <= 0) {
									return {
										status: "EVIDENCE_GAP" as const,
										gap: {
											code: "SOURCE_SIZE_EXCEEDED",
											retryable: false,
										},
									};
								}
								const result = await options.safeResourceLoader.load({
									correlationId: input.correlationId,
									decisionTaskId: input.decisionTaskId,
									maxBytes,
									operationId: `${input.operationId}:request-${requestNumber}`,
									signal,
									sourceId: input.source.sourceId,
									url: request.url(),
									userId: input.userId,
								});
								if (result.status === "LOADED") {
									if (result.response.body.byteLength > maxBytes) {
										return {
											status: "EVIDENCE_GAP" as const,
											gap: {
												code: "SOURCE_SIZE_EXCEEDED",
												retryable: false,
											},
										};
									}
									totalBytes += result.response.body.byteLength;
								}
								return result;
							});
							loadQueue = scheduledLoad.then(
								() => undefined,
								() => undefined,
							);
							loaded = await abortable(scheduledLoad, signal);
						} catch {
							fatalGap ??= { code: "SOURCE_FETCH_FAILED", retryable: true };
							await route.abort("failed");
							return;
						}
						if (loaded.status === "EVIDENCE_GAP") {
							fatalGap ??= loaded.gap;
							await route.abort("failed");
							return;
						}
						if (
							loaded.response.status >= 300 &&
							loaded.response.status < 400
						) {
							const redirectRejection = validateRedirectResponse(
								request.url(),
								loaded.response.headers,
								options.approvedSourceOrigins,
							);
							if (redirectRejection !== undefined) {
								fatalGap ??= redirectRejection;
								await route.abort("blockedbyclient");
								return;
							}
							redirectCount += 1;
							if (redirectCount > 3) {
								fatalGap ??= {
									code: "SOURCE_REDIRECT_REJECTED",
									retryable: false,
								};
								await route.abort("blockedbyclient");
								return;
							}
						}
						if (fatalGap !== undefined) {
							await route.abort("blockedbyclient");
							return;
						}
						if (
							request.isNavigationRequest() &&
							loaded.response.status >= 400
						) {
							fatalGap = httpGap(loaded.response.status);
							await route.abort("failed");
							return;
						}
						await fulfill(route, loaded.response);
					});
					await context.routeWebSocket("**/*", (socket) => socket.close());
					const page = await context.newPage();
					page.on("popup", (popup) => {
						void popup.close().catch(() => undefined);
					});
					try {
						await page.goto(initialUrl.href, {
							timeout: timeoutMs,
							waitUntil: "networkidle",
						});
						if (settleTimeMs > 0) await page.waitForTimeout(settleTimeMs);
					} catch {
						fatalGap ??= { code: "SOURCE_FETCH_FAILED", retryable: true };
					}
					signal.throwIfAborted();
					if (fatalGap !== undefined) {
						return evidenceGap(
							options,
							input,
							fatalGap.code,
							fatalGap.retryable,
						);
					}

					const finalUrl = validateRoutedUrl(
						page.url(),
						options.approvedSourceOrigins,
					);
					if (typeof finalUrl === "string") {
						return evidenceGap(options, input, finalUrl, false);
					}
					const html = new TextEncoder().encode(await page.content());
					if (totalBytes + html.byteLength > maxTotalBytes) {
						return evidenceGap(options, input, "SOURCE_SIZE_EXCEEDED", false);
					}
					signal.throwIfAborted();
					const capturedAt = options.now();
					const expiresAt = new Date(
						capturedAt.getTime() + 7 * 24 * 60 * 60 * 1_000,
					).toISOString();
					let rawArtifact: DataSourceArtifactRef;
					try {
						rawArtifact = await options.objectStore.put(html, { expiresAt });
					} catch {
						return evidenceGap(
							options,
							input,
							"SOURCE_ARTIFACT_WRITE_FAILED",
							true,
						);
					}
					signal.throwIfAborted();
					return {
						status: "COLLECTED",
						collection: {
							ok: true,
							sourceFacts: {
								capturedAt: capturedAt.toISOString(),
								collectorVersion: `playwright@${PLAYWRIGHT_VERSION}/chromium-${options.browser.version()} + http-connector@1`,
								mediaType: "text/html",
								sourceId: input.source.sourceId,
								title: input.source.title,
								url: finalUrl.href,
							},
							rawArtifact,
							metrics: {
								bytesFetched: totalBytes,
								durationMs:
									options.readDurationMs?.() ??
									Math.max(0, Math.round(performance.now() - startedAt)),
							},
						},
					};
				} finally {
					signal.removeEventListener("abort", closeOnAbort);
				}
			} catch {
				if (input.signal?.aborted === true) throw input.signal.reason;
				return evidenceGap(options, input, "SOURCE_FETCH_FAILED", true);
			} finally {
				await context?.close().catch(() => undefined);
			}
		},
	};
}

const ALLOWED_RESOURCE_TYPES = new Set([
	"document",
	"fetch",
	"script",
	"stylesheet",
	"xhr",
]);

const BLOCKED_BROWSER_APIS_SCRIPT = `
for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebSocket", "WebTransport", "Worker", "SharedWorker"]) {
  try {
    Object.defineProperty(globalThis, name, { configurable: false, value: undefined, writable: false });
  } catch {}
}
`;

function validateInitialUrl(
	value: string,
	approvedSourceUrls: ReadonlySet<string>,
): URL | string {
	const url = parseUrl(value);
	if (typeof url === "string") return url;
	return approvedSourceUrls.has(url.href) ? url : "SOURCE_NOT_APPROVED";
}

function validateBrowserRequest(
	method: string,
	resourceType: string,
	value: string,
	approvedSourceOrigins: ReadonlySet<string>,
): Readonly<{ code: string; retryable: boolean }> | undefined {
	if (method !== "GET")
		return { code: "SOURCE_METHOD_REJECTED", retryable: false };
	if (!ALLOWED_RESOURCE_TYPES.has(resourceType)) {
		return { code: "SOURCE_RESOURCE_TYPE_REJECTED", retryable: false };
	}
	const url = validateRoutedUrl(value, approvedSourceOrigins);
	return typeof url === "string" ? { code: url, retryable: false } : undefined;
}

function validateRoutedUrl(
	value: string,
	approvedSourceOrigins: ReadonlySet<string>,
): URL | string {
	const url = parseUrl(value);
	if (typeof url === "string") return url;
	return approvedSourceOrigins.has(url.origin) ? url : "SOURCE_NOT_APPROVED";
}

function validateRedirectResponse(
	requestUrl: string,
	headers: Readonly<Record<string, string>>,
	approvedSourceOrigins: ReadonlySet<string>,
): Readonly<{ code: string; retryable: boolean }> | undefined {
	const location = Object.entries(headers).find(
		([name]) => name.toLocaleLowerCase() === "location",
	)?.[1];
	if (location === undefined || location.trim() === "") {
		return { code: "SOURCE_REDIRECT_REJECTED", retryable: false };
	}
	let target: URL;
	try {
		target = new URL(location, requestUrl);
	} catch {
		return { code: "SOURCE_REDIRECT_REJECTED", retryable: false };
	}
	const rejection = validateRoutedUrl(target.href, approvedSourceOrigins);
	return typeof rejection === "string"
		? { code: "SOURCE_REDIRECT_REJECTED", retryable: false }
		: undefined;
}

function parseUrl(value: string): URL | string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "SOURCE_NOT_APPROVED";
	}
	if (url.protocol !== "https:") return "SOURCE_SCHEME_REJECTED";
	if (url.username !== "" || url.password !== "" || url.hash !== "") {
		return "SOURCE_NOT_APPROVED";
	}
	return url;
}

async function fulfill(
	route: Route,
	response: Readonly<{
		body: Uint8Array;
		headers: Readonly<Record<string, string>>;
		status: number;
	}>,
): Promise<void> {
	const headers = Object.fromEntries(
		Object.entries(response.headers).filter(
			([name]) =>
				![
					"connection",
					"content-encoding",
					"content-length",
					"set-cookie",
					"transfer-encoding",
				].includes(name.toLocaleLowerCase()),
		),
	);
	await route.fulfill({
		body: Buffer.from(response.body),
		headers,
		status: response.status,
	});
}

function httpGap(
	status: number,
): Readonly<{ code: string; retryable: boolean }> {
	if (status === 401 || status === 403) {
		return { code: "SOURCE_ACCESS_CHALLENGE", retryable: false };
	}
	return {
		code: "SOURCE_FETCH_FAILED",
		retryable: status === 408 || status === 429 || status >= 500,
	};
}

function evidenceGap(
	options: Readonly<{ nextGapId: () => string }>,
	input: Readonly<{
		decisionTaskId: string;
		source: Readonly<{ sourceId: string }>;
	}>,
	code: string,
	retryable: boolean,
) {
	return {
		status: "EVIDENCE_GAP" as const,
		gap: {
			code,
			decisionTaskId: input.decisionTaskId,
			gapId: options.nextGapId(),
			retryable,
			sourceId: input.source.sourceId,
		},
	};
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`动态网页${name}上限无效`);
	}
	return value;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`动态网页${name}无效`);
	}
	return value;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
}
