import type { LocalServiceRequestV1 } from "@choicemind/contracts/local-services/v1";
import { describe, expect, it, vi } from "vitest";

import {
	executeLocalServiceRequest,
	type LocalServiceTargetV1,
	loadLocalServiceConfiguration,
} from "./index.js";

const configuration = loadLocalServiceConfiguration({});

describe("executeLocalServiceRequest", () => {
	it.each([
		{
			serviceId: "qwen-model",
			request: modelRequest(),
			response: {
				model: "Qwen3.8-27B",
				choices: [{ message: { content: "CHOICEMIND_OK" } }],
			},
			expectedPath: "/v1/chat/completions",
			expectedOutput: { model: "Qwen3.8-27B", text: "CHOICEMIND_OK" },
		},
		{
			serviceId: "qwen-embedding",
			request: embeddingRequest(),
			response: {
				model: "Qwen3-Embedding-4B",
				data: [{ embedding: [0.1, 0.2] }],
			},
			expectedPath: "/v1/embeddings",
			expectedOutput: {
				model: "Qwen3-Embedding-4B",
				dimensions: 2,
				vectors: [[0.1, 0.2]],
			},
		},
		{
			serviceId: "qwen-reranker",
			request: rerankerRequest(),
			response: {
				model: "Qwen3-Reranker-8B",
				results: [
					{ index: 0, relevance_score: 0.9 },
					{ index: 1, relevance_score: 0.1 },
				],
			},
			expectedPath: "/v1/rerank",
			expectedOutput: {
				model: "Qwen3-Reranker-8B",
				rankings: [
					{ documentId: "candidate-a", score: 0.9 },
					{ documentId: "candidate-b", score: 0.1 },
				],
			},
		},
		{
			serviceId: "paddleocr-vl",
			request: documentRequest("image/png", "iVBORw0KGgo="),
			response: {
				model: "PaddleOCR-VL-1.6-0.9B",
				choices: [{ message: { content: "ChoiceMind" } }],
			},
			expectedPath: "/v1/chat/completions",
			expectedOutput: {
				parser: "PaddleOCR-VL-1.6-0.9B",
				text: "ChoiceMind",
				pageCount: 1,
			},
		},
		{
			serviceId: "mineru",
			request: documentRequest("application/pdf", "JVBERi0xLjQ="),
			response: {
				status: "completed",
				version: "3.4.4",
				results: { sample: { md_content: "ChoiceMind" } },
			},
			expectedPath: "/file_parse",
			expectedOutput: {
				parser: "MinerU-3.4.4",
				text: "ChoiceMind",
				pageCount: 1,
			},
		},
		{
			serviceId: "choicemind-html-parser",
			request: documentRequest("text/html", "PG1haW4+Q2hvaWNlTWluZDwvbWFpbj4="),
			response: {
				contractType: "local-service-result",
				contractVersion: "1.0",
				requestId: "request-document-text/html",
				port: "DOCUMENT_PARSER",
				ok: true,
				output: {
					parser: "choicemind-html-parser-1.0",
					text: "ChoiceMind",
					pageCount: 1,
				},
			},
			expectedPath: "/v1/document/parse",
			expectedOutput: {
				parser: "choicemind-html-parser-1.0",
				text: "ChoiceMind",
				pageCount: 1,
			},
		},
	])(
		"把 $serviceId 的固定成功响应映射为公共合同",
		async ({ serviceId, request, response, expectedPath, expectedOutput }) => {
			const fetcher = vi.fn(async (input: string | URL | Request) => {
				expect(new URL(input.toString()).pathname).toBe(expectedPath);
				return Response.json(response);
			});

			const result = await executeLocalServiceRequest(
				target(serviceId),
				request as LocalServiceRequestV1,
				{ fetch: fetcher },
			);

			expect(result).toMatchObject({ ok: true, output: expectedOutput });
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);

	it.each([
		["TIMEOUT", () => Promise.reject(new DOMException("超时", "TimeoutError"))],
		["CONNECTION_FAILED", () => Promise.reject(new TypeError("fetch failed"))],
	] as const)("准确映射 %s", async (code, fetcher) => {
		const result = await executeLocalServiceRequest(
			target("qwen-model"),
			modelRequest(),
			{
				fetch: fetcher,
			},
		);

		expect(result).toMatchObject({ ok: false, error: { code } });
	});

	it("调用方取消会中止在途请求并保持超时映射", async () => {
		const controller = new AbortController();
		let upstreamSignal: AbortSignal | undefined;
		const fetcher = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((resolve, reject) => {
					const signal = init?.signal;
					if (signal === null || signal === undefined) {
						throw new Error("测试请求缺少取消信号");
					}
					upstreamSignal = signal;
					const timer = setTimeout(
						() =>
							resolve(
								Response.json({
									model: "Qwen3.8-27B",
									choices: [{ message: { content: "CHOICEMIND_OK" } }],
								}),
							),
						50,
					);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
		);

		const resultPromise = executeLocalServiceRequest(
			{ ...target("qwen-model"), timeoutMs: 1_000 },
			modelRequest(),
			{ fetch: fetcher, signal: controller.signal },
		);
		controller.abort();
		const result = await resultPromise;

		expect(upstreamSignal?.aborted).toBe(true);
		expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
	});

	it.each(["AbortError", "TimeoutError"])("正文读取期间的 %s 保持超时映射", async (name) => {
		const response = Response.json({});
		vi.spyOn(response, "json").mockRejectedValue(new DOMException("请求已中止", name));
		const result = await executeLocalServiceRequest(
			target("choicemind-html-parser"),
			documentRequest("text/html", "PG1haW4+Q2hvaWNlTWluZDwvbWFpbj4="),
			{ fetch: async () => response },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
	});

	it("把不符合协议的响应映射为 INVALID_RESPONSE", async () => {
		const result = await executeLocalServiceRequest(
			target("qwen-model"),
			modelRequest(),
			{
				fetch: async () => Response.json({ choices: [] }),
			},
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "INVALID_RESPONSE" },
		});
	});

	it("把非 JSON 响应映射为 INVALID_RESPONSE", async () => {
		const result = await executeLocalServiceRequest(
			target("qwen-model"),
			modelRequest(),
			{ fetch: async () => new Response("not-json") },
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "INVALID_RESPONSE" },
		});
	});

	it("拒绝响应中的模型身份与统一配置不一致", async () => {
		const result = await executeLocalServiceRequest(
			target("qwen-model"),
			modelRequest(),
			{
				fetch: async () =>
					Response.json({
						model: "unexpected-model",
						choices: [{ message: { content: "CHOICEMIND_OK" } }],
					}),
			},
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "INVALID_RESPONSE" },
		});
	});

	it("拒绝 MinerU 返回非 3.4.4 或非 completed 结果", async () => {
		const result = await executeLocalServiceRequest(
			target("mineru"),
			documentRequest("application/pdf", "JVBERi0xLjQ="),
			{
				fetch: async () =>
					Response.json({
						status: "processing",
						version: "3.4.3",
						results: { sample: { md_content: "ChoiceMind" } },
					}),
			},
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "INVALID_RESPONSE" },
		});
	});

	it("MinerU 固定选择已实测可用的 pipeline 后端", async () => {
		const fetcher = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const body = init?.body;
				expect(body).toBeInstanceOf(FormData);
				if (!(body instanceof FormData)) {
					throw new Error("测试请求缺少 multipart 表单");
				}
				expect(body.get("backend")).toBe("pipeline");
				return Response.json({
					status: "completed",
					version: "3.4.4",
					results: { sample: { md_content: "ChoiceMind" } },
				});
			},
		);

		const result = await executeLocalServiceRequest(
			target("mineru"),
			documentRequest("application/pdf", "JVBERi0xLjQ="),
			{ fetch: fetcher },
		);

		expect(result).toMatchObject({ ok: true });
	});

	it("在发出请求前拒绝超过配置能力限制的输入", async () => {
		const fetcher = vi.fn();
		const limitedTarget: LocalServiceTargetV1 = {
			...target("qwen-model"),
			limits: { maxInputBytes: 1 },
		};

		const result = await executeLocalServiceRequest(
			limitedTarget,
			modelRequest(),
			{
				fetch: fetcher,
			},
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "CAPABILITY_LIMIT_EXCEEDED" },
		});
		expect(fetcher).not.toHaveBeenCalled();
	});
});

function target(serviceId: string): LocalServiceTargetV1 {
	const found = configuration.targets.find(
		(candidate) => candidate.serviceId === serviceId,
	);
	if (found === undefined) {
		throw new Error(`测试目标不存在：${serviceId}`);
	}
	return found;
}

function modelRequest(): LocalServiceRequestV1 {
	return {
		contractType: "local-service-request",
		contractVersion: "1.0",
		requestId: "request-model",
		port: "MODEL_PROVIDER",
		input: {
			messages: [{ role: "user", content: "只回答：CHOICEMIND_OK" }],
			maxOutputTokens: 32,
		},
	};
}

function embeddingRequest(): LocalServiceRequestV1 {
	return {
		contractType: "local-service-request",
		contractVersion: "1.0",
		requestId: "request-embedding",
		port: "EMBEDDING_PROVIDER",
		input: { texts: ["ChoiceMind 固定嵌入样本"] },
	};
}

function rerankerRequest(): LocalServiceRequestV1 {
	return {
		contractType: "local-service-request",
		contractVersion: "1.0",
		requestId: "request-reranker",
		port: "RERANKER",
		input: {
			query: "哪个候选满足条件？",
			documents: [
				{ documentId: "candidate-a", text: "候选 A 满足条件" },
				{ documentId: "candidate-b", text: "候选 B 不满足条件" },
			],
			topK: 2,
		},
	};
}

function documentRequest(
	mediaType: "application/pdf" | "image/png" | "text/html",
	dataBase64: string,
): LocalServiceRequestV1 {
	return {
		contractType: "local-service-request",
		contractVersion: "1.0",
		requestId: `request-document-${mediaType}`,
		port: "DOCUMENT_PARSER",
		input: { document: { mediaType, dataBase64 } },
	};
}
