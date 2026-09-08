import { describe, expect, it } from "vitest";

import {
	decodeLocalServiceRequestV1,
	decodeLocalServiceResultV1,
} from "./index.js";

describe("本地服务 v1 合同", () => {
	it("链接发现为可选扩展，限制链接数量和字段大小", () => {
		const request = { contractType: "local-service-request", contractVersion: "1.0",
			requestId: "links", port: "DOCUMENT_PARSER",
			input: { extractLinks: true, document: { mediaType: "text/html", dataBase64: "YQ==" } } };
		expect(decodeLocalServiceRequestV1(request).ok).toBe(true);
		const result = { contractType: "local-service-result", contractVersion: "1.0",
			requestId: "links", port: "DOCUMENT_PARSER", ok: true,
			output: { parser: "html", text: "产品", pageCount: 1,
				links: [{ href: "/product", text: "产品", next: false }] } };
		expect(decodeLocalServiceResultV1(result).ok).toBe(true);
		for (const links of [
			Array.from({ length: 201 }, () => result.output.links[0]),
			[{ href: "x".repeat(2049), text: "产品", next: false }],
			[{ href: "/product", text: "中".repeat(201), next: false }],
		]) {
			expect(decodeLocalServiceResultV1({ ...result, output: { ...result.output, links } }).ok).toBe(false);
		}
	});
	it.each([
		{
			port: "MODEL_PROVIDER",
			input: {
				messages: [{ role: "user", content: "只回答：CHOICEMIND_OK" }],
				maxOutputTokens: 32,
			},
		},
		{
			port: "EMBEDDING_PROVIDER",
			input: { texts: ["ChoiceMind 固定嵌入样本"] },
		},
		{
			port: "RERANKER",
			input: {
				query: "哪个候选满足条件？",
				documents: [
					{ documentId: "candidate-a", text: "候选 A 满足条件" },
					{ documentId: "candidate-b", text: "候选 B 不满足条件" },
				],
				topK: 2,
			},
		},
		{
			port: "DOCUMENT_PARSER",
			input: {
				document: {
					mediaType: "application/pdf",
					dataBase64: "JVBERi0xLjQ=",
				},
			},
		},
		{
			port: "ASR",
			input: {
				audio: { mediaType: "audio/wav", dataBase64: "UklGRg==" },
				language: "zh-CN",
			},
		},
	])("接受 $port 的版本化请求", ({ port, input }) => {
		expect(
			decodeLocalServiceRequestV1({
				contractType: "local-service-request",
				contractVersion: "1.0",
				requestId: `request-${port.toLowerCase()}`,
				port,
				input,
			}),
		).toMatchObject({ ok: true, value: { port } });
	});

	it.each([
		{
			port: "MODEL_PROVIDER",
			output: { model: "Qwen3.8-27B", text: "CHOICEMIND_OK" },
		},
		{
			port: "EMBEDDING_PROVIDER",
			output: {
				model: "Qwen3-Embedding-4B",
				dimensions: 3,
				vectors: [[0.1, 0.2, 0.3]],
			},
		},
		{
			port: "RERANKER",
			output: {
				model: "Qwen3-Reranker-4B",
				rankings: [
					{ documentId: "candidate-a", score: 0.9 },
					{ documentId: "candidate-b", score: 0.1 },
				],
			},
		},
		{
			port: "DOCUMENT_PARSER",
			output: { parser: "MinerU-3.4.4", text: "ChoiceMind", pageCount: 1 },
		},
		{
			port: "ASR",
			output: { model: "local-asr", text: "ChoiceMind", language: "zh-CN" },
		},
	])("接受 $port 的版本化成功结果", ({ port, output }) => {
		expect(
			decodeLocalServiceResultV1({
				contractType: "local-service-result",
				contractVersion: "1.0",
				requestId: `request-${port.toLowerCase()}`,
				port,
				ok: true,
				output,
			}),
		).toMatchObject({ ok: true, value: { port, ok: true } });
	});

	it.each([
		["TIMEOUT", "TRANSPORT", true],
		["CONNECTION_FAILED", "TRANSPORT", true],
		["INVALID_RESPONSE", "PROTOCOL", false],
		["CAPABILITY_LIMIT_EXCEEDED", "CAPABILITY", false],
	] as const)("接受稳定错误码 %s", (code, category, retryable) => {
		expect(
			decodeLocalServiceResultV1({
				contractType: "local-service-result",
				contractVersion: "1.0",
				requestId: "request-error",
				port: "MODEL_PROVIDER",
				ok: false,
				error: {
					code,
					category,
					message: "固定错误信息",
					retryable,
				},
			}),
		).toMatchObject({ ok: true, value: { ok: false, error: { code } } });
	});

	it("显式拒绝不支持的合同版本", () => {
		expect(
			decodeLocalServiceRequestV1({
				contractType: "local-service-request",
				contractVersion: "2.0",
				requestId: "request-version",
				port: "MODEL_PROVIDER",
				input: {},
			}),
		).toEqual({
			ok: false,
			code: "CONTRACT_VERSION_UNSUPPORTED",
			issues: [{ path: "contractVersion", message: "合同版本不受支持" }],
		});
	});

	it("以稳定字段路径拒绝嵌入向量维度不一致", () => {
		expect(
			decodeLocalServiceResultV1({
				contractType: "local-service-result",
				contractVersion: "1.0",
				requestId: "request-invalid-vector",
				port: "EMBEDDING_PROVIDER",
				ok: true,
				output: {
					model: "Qwen3-Embedding-4B",
					dimensions: 3,
					vectors: [[0.1, 0.2]],
				},
			}),
		).toMatchObject({
			ok: false,
			code: "CONTRACT_INVALID",
			issues: [
				{ path: "output.vectors.0", message: "向量维度必须与 dimensions 一致" },
			],
		});
	});

	it("接受受控网页快照的 HTML 文档解析请求", () => {
		expect(
			decodeLocalServiceRequestV1({
				contractType: "local-service-request",
				contractVersion: "1.0",
				requestId: "request-html-parser",
				port: "DOCUMENT_PARSER",
				input: {
					document: {
						mediaType: "text/html",
						dataBase64: "PG1haW4+Q2hvaWNlTWluZDwvbWFpbj4=",
					},
				},
			}),
		).toMatchObject({
			ok: true,
			value: {
				port: "DOCUMENT_PARSER",
				input: { document: { mediaType: "text/html" } },
			},
		});
	});
});
