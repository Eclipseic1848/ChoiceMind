import {
	decodeLocalServiceResultV1,
	type LocalServiceRequestV1,
	type LocalServiceResultV1,
} from "@choicemind/contracts/local-services/v1";

import type { LocalServiceTargetV1 } from "./index.js";

type Fetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export async function executeLocalServiceRequest(
	target: LocalServiceTargetV1,
	request: LocalServiceRequestV1,
	dependencies: Readonly<{ fetch?: Fetch }> = {},
): Promise<LocalServiceResultV1> {
	if (target.port !== request.port) {
		return failure(
			target,
			request.requestId,
			"INVALID_RESPONSE",
			"目标服务与请求端口不匹配",
		);
	}

	const inputBytes = Buffer.byteLength(JSON.stringify(request.input), "utf8");
	if (target.limits !== undefined && inputBytes > target.limits.maxInputBytes) {
		return failure(
			target,
			request.requestId,
			"CAPABILITY_LIMIT_EXCEEDED",
			`输入大小 ${inputBytes} 超过配置上限 ${target.limits.maxInputBytes}`,
		);
	}

	const fetcher = dependencies.fetch ?? fetch;
	let response: Response;
	try {
		response = await fetcher(...buildUpstreamRequest(target, request));
	} catch (error) {
		if (isTimeoutError(error)) {
			return failure(target, request.requestId, "TIMEOUT", "本地服务调用超时");
		}
		return failure(
			target,
			request.requestId,
			"CONNECTION_FAILED",
			"无法连接本地服务",
		);
	}
	if (!response.ok) {
		const code =
			response.status === 408 || response.status === 504
				? "TIMEOUT"
				: "INVALID_RESPONSE";
		return failure(
			target,
			request.requestId,
			code,
			`上游返回 HTTP ${response.status}`,
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return failure(
			target,
			request.requestId,
			"INVALID_RESPONSE",
			"上游返回的正文不是 JSON",
		);
	}
	const candidate = mapSuccessfulResponse(target, request, payload);
	const decoded = decodeLocalServiceResultV1(candidate);
	if (!decoded.ok) {
		return failure(
			target,
			request.requestId,
			"INVALID_RESPONSE",
			"上游返回结构不符合合同",
		);
	}
	return decoded.value;
}

function buildUpstreamRequest(
	target: LocalServiceTargetV1,
	request: LocalServiceRequestV1,
): [string, RequestInit] {
	const signal = AbortSignal.timeout(target.timeoutMs);
	switch (target.protocol) {
		case "OPENAI_CHAT_COMPLETIONS": {
			if (request.port !== "MODEL_PROVIDER") {
				throw new Error("模型协议只接受 ModelProvider 请求");
			}
			return [
				joinUrl(target.baseUrl, "chat/completions"),
				jsonPost(
					{
						model: target.model,
						messages: request.input.messages,
						max_tokens: request.input.maxOutputTokens,
						stream: false,
					},
					signal,
				),
			];
		}
		case "OPENAI_EMBEDDINGS": {
			if (request.port !== "EMBEDDING_PROVIDER") {
				throw new Error("嵌入协议只接受 EmbeddingProvider 请求");
			}
			return [
				joinUrl(target.baseUrl, "embeddings"),
				jsonPost(
					{
						model: target.model,
						input: request.input.texts,
					},
					signal,
				),
			];
		}
		case "RERANK": {
			if (request.port !== "RERANKER") {
				throw new Error("重排协议只接受 Reranker 请求");
			}
			return [
				joinUrl(target.baseUrl, "rerank"),
				jsonPost(
					{
						model: target.model,
						query: request.input.query,
						documents: request.input.documents.map((document) => document.text),
						top_n: request.input.topK,
					},
					signal,
				),
			];
		}
		case "PADDLEOCR_VL": {
			if (request.port !== "DOCUMENT_PARSER") {
				throw new Error("PaddleOCR 协议只接受 DocumentParser 请求");
			}
			return [
				joinUrl(target.baseUrl, "chat/completions"),
				jsonPost(
					{
						model: target.model,
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: "请识别图片中的全部文字。" },
									{
										type: "image_url",
										image_url: {
											url: `data:${request.input.document.mediaType};base64,${request.input.document.dataBase64}`,
										},
									},
								],
							},
						],
						max_tokens: 256,
						stream: false,
					},
					signal,
				),
			];
		}
		case "MINERU": {
			if (request.port !== "DOCUMENT_PARSER") {
				throw new Error("MinerU 协议只接受 DocumentParser 请求");
			}
			const bytes = Buffer.from(request.input.document.dataBase64, "base64");
			const form = new FormData();
			form.append(
				"files",
				new Blob([bytes], { type: request.input.document.mediaType }),
				request.input.document.mediaType === "application/pdf"
					? "sample.pdf"
					: "sample.png",
			);
			form.append("return_md", "true");
			form.append("response_format_zip", "false");
			form.append("backend", "pipeline");
			return [
				joinUrl(target.baseUrl, "file_parse"),
				{ method: "POST", body: form, signal },
			];
		}
		case "CHOICEMIND_DOCUMENT_PARSER": {
			if (request.port !== "DOCUMENT_PARSER") {
				throw new Error("ChoiceMind 解析协议只接受 DocumentParser 请求");
			}
			return [
				joinUrl(target.baseUrl, "document/parse"),
				jsonPost(request, signal),
			];
		}
	}
}

function mapSuccessfulResponse(
	target: LocalServiceTargetV1,
	request: LocalServiceRequestV1,
	payload: unknown,
): unknown {
	const header = {
		contractType: "local-service-result",
		contractVersion: "1.0",
		requestId: request.requestId,
		port: request.port,
		ok: true,
	} as const;
	if (!isRecord(payload)) {
		return { ...header, output: undefined };
	}
	if (target.protocol === "CHOICEMIND_DOCUMENT_PARSER") {
		return payload.requestId === request.requestId && payload.port === request.port
			? payload
			: { ...header, output: undefined };
	}
	if (
		target.protocol === "MINERU"
			? payload.status !== "completed" ||
				payload.version !== target.model?.replace(/^MinerU-/, "")
			: payload.model !== target.model
	) {
		return { ...header, output: undefined };
	}

	switch (target.protocol) {
		case "OPENAI_CHAT_COMPLETIONS":
			return {
				...header,
				output: {
					model: payload.model,
					text: readChatText(payload),
				},
			};
		case "OPENAI_EMBEDDINGS": {
			const vectors = Array.isArray(payload.data)
				? payload.data.map((item) =>
						isRecord(item) ? item.embedding : undefined,
					)
				: undefined;
			const first = Array.isArray(vectors?.[0]) ? vectors[0] : undefined;
			return {
				...header,
				output: {
					model: payload.model,
					dimensions: first?.length,
					vectors,
				},
			};
		}
		case "RERANK": {
			const documents =
				request.port === "RERANKER" ? request.input.documents : [];
			const rankings = Array.isArray(payload.results)
				? payload.results.map((item) => {
						if (!isRecord(item) || typeof item.index !== "number") {
							return undefined;
						}
						return {
							documentId: documents[item.index]?.documentId,
							score: item.relevance_score,
						};
					})
				: undefined;
			return { ...header, output: { model: payload.model, rankings } };
		}
		case "PADDLEOCR_VL":
			return {
				...header,
				output: {
					parser: target.model,
					text: readChatText(payload),
					pageCount: 1,
				},
			};
		case "MINERU":
			return {
				...header,
				output: {
					parser: target.model,
					text: findMarkdown(payload.results),
					pageCount: 1,
				},
			};
	}
}

function failure(
	target: LocalServiceTargetV1,
	requestId: string,
	code:
		| "TIMEOUT"
		| "CONNECTION_FAILED"
		| "INVALID_RESPONSE"
		| "CAPABILITY_LIMIT_EXCEEDED",
	message: string,
): LocalServiceResultV1 {
	const transport = code === "TIMEOUT" || code === "CONNECTION_FAILED";
	return {
		contractType: "local-service-result",
		contractVersion: "1.0",
		requestId,
		port: target.port,
		ok: false,
		error: {
			code,
			category: transport
				? "TRANSPORT"
				: code === "INVALID_RESPONSE"
					? "PROTOCOL"
					: "CAPABILITY",
			message,
			retryable: transport,
		},
	};
}

function jsonPost(body: unknown, signal: AbortSignal): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	};
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/$/, "")}/${path}`;
}

function readChatText(payload: Record<string, unknown>): unknown {
	const choice = Array.isArray(payload.choices)
		? payload.choices[0]
		: undefined;
	return isRecord(choice) && isRecord(choice.message)
		? choice.message.content
		: undefined;
}

function findMarkdown(value: unknown): unknown {
	if (!isRecord(value)) {
		return undefined;
	}
	for (const result of Object.values(value)) {
		if (isRecord(result) && typeof result.md_content === "string") {
			return result.md_content;
		}
	}
	return undefined;
}

function isTimeoutError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
