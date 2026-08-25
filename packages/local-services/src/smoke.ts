import { createHash } from "node:crypto";

import type {
	LocalServiceRequestV1,
	LocalServiceResultV1,
} from "@choicemind/contracts/local-services/v1";

import { executeLocalServiceRequest } from "./client.js";
import type {
	LocalServiceConfigurationV1,
	LocalServiceTargetV1,
} from "./index.js";
import {
	MINERU_SMOKE_PDF_BASE64,
	PADDLE_SMOKE_JPEG_BASE64,
} from "./smoke-fixtures.js";

export type LocalServiceSmokeServiceReportV1 = Readonly<{
	serviceId: LocalServiceTargetV1["serviceId"];
	port: LocalServiceTargetV1["port"];
	endpoint: string;
	model?: string | undefined;
	status: "SMOKE_PASSED" | "SMOKE_FAILED";
	inputSha256: string;
	latencyMs: number;
	capabilities: readonly string[];
	limitations: readonly string[];
	errorCode?: string | undefined;
}>;

export type LocalServiceSmokeReportV1 = Readonly<{
	contractType: "local-service-smoke-report";
	contractVersion: "1.0";
	status: "SMOKE_PASSED" | "SMOKE_FAILED";
	executedAt: string;
	services: readonly LocalServiceSmokeServiceReportV1[];
}>;

type Execute = (
	target: LocalServiceTargetV1,
	request: LocalServiceRequestV1,
) => Promise<LocalServiceResultV1>;

export async function runLocalServiceSmoke(
	configuration: LocalServiceConfigurationV1,
	dependencies: Readonly<{
		execute?: Execute;
		now?: () => Date;
		monotonicNow?: () => number;
	}> = {},
): Promise<LocalServiceSmokeReportV1> {
	const execute = dependencies.execute ?? executeLocalServiceRequest;
	const now = dependencies.now ?? (() => new Date());
	const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
	const requests = buildFixedLocalServiceSmokeRequests(configuration);
	const services: LocalServiceSmokeServiceReportV1[] = [];

	for (const target of configuration.targets) {
		const request = requests.get(target.serviceId);
		if (request === undefined) {
			throw new Error(`缺少本地服务固定样本：${target.serviceId}`);
		}
		const startedAt = monotonicNow();
		const result = await execute(target, request);
		const latencyMs = Math.max(0, Math.round(monotonicNow() - startedAt));
		services.push({
			serviceId: target.serviceId,
			port: target.port,
			endpoint: target.baseUrl,
			...(target.model === undefined ? {} : { model: target.model }),
			status: result.ok ? "SMOKE_PASSED" : "SMOKE_FAILED",
			inputSha256: sha256(request.input),
			latencyMs,
			capabilities: target.capabilities,
			limitations: target.limitations,
			...(result.ok ? {} : { errorCode: result.error.code }),
		});
	}

	return {
		contractType: "local-service-smoke-report",
		contractVersion: "1.0",
		status: services.every((service) => service.status === "SMOKE_PASSED")
			? "SMOKE_PASSED"
			: "SMOKE_FAILED",
		executedAt: now().toISOString(),
		services,
	};
}

export function buildFixedLocalServiceSmokeRequests(
	configuration: LocalServiceConfigurationV1,
): ReadonlyMap<LocalServiceTargetV1["serviceId"], LocalServiceRequestV1> {
	return new Map(
		configuration.targets.map(
			(target) => [target.serviceId, fixedRequest(target)] as const,
		),
	);
}

function fixedRequest(target: LocalServiceTargetV1): LocalServiceRequestV1 {
	const header = {
		contractType: "local-service-request",
		contractVersion: "1.0",
		requestId: `smoke-${target.serviceId}`,
	} as const;
	if (target.serviceId === "qwen-model") {
		return {
			...header,
			port: "MODEL_PROVIDER",
			input: {
				messages: [{ role: "user", content: "只回答：CHOICEMIND_OK" }],
				maxOutputTokens: 128,
			},
		};
	}
	if (target.serviceId === "qwen-embedding") {
		return {
			...header,
			port: "EMBEDDING_PROVIDER",
			input: { texts: ["ChoiceMind 固定嵌入样本"] },
		};
	}
	if (target.serviceId === "qwen-reranker") {
		return {
			...header,
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
	if (target.serviceId === "paddleocr-vl") {
		return {
			...header,
			port: "DOCUMENT_PARSER",
			input: {
				document: {
					mediaType: "image/jpeg",
					dataBase64: PADDLE_SMOKE_JPEG_BASE64,
				},
			},
		};
	}
	return {
		...header,
		port: "DOCUMENT_PARSER",
		input: {
			document: {
				mediaType: "application/pdf",
				dataBase64: MINERU_SMOKE_PDF_BASE64,
			},
		},
	};
}

function sha256(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value), "utf8")
		.digest("hex");
}
