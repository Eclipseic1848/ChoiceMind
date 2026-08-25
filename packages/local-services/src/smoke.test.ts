import type {
	LocalServiceRequestV1,
	LocalServiceResultV1,
} from "@choicemind/contracts/local-services/v1";
import { describe, expect, it } from "vitest";

import {
	buildFixedLocalServiceSmokeRequests,
	type LocalServiceTargetV1,
	loadLocalServiceConfiguration,
	runLocalServiceSmoke,
} from "./index.js";

describe("runLocalServiceSmoke", () => {
	it("固定样本反映真实服务协议边界", () => {
		const requests = buildFixedLocalServiceSmokeRequests(
			loadLocalServiceConfiguration({}),
		);
		const model = requests.get("qwen-model");
		const paddle = requests.get("paddleocr-vl");

		expect(model).toMatchObject({
			port: "MODEL_PROVIDER",
			input: { maxOutputTokens: 128 },
		});
		expect(paddle).toMatchObject({
			port: "DOCUMENT_PARSER",
			input: { document: { mediaType: "image/jpeg" } },
		});
	});

	it("五个固定样本成功时只生成 SMOKE_PASSED 证据", async () => {
		let tick = 0;
		const report = await runLocalServiceSmoke(
			loadLocalServiceConfiguration({}),
			{
				execute: async (target, request) => success(target, request),
				now: () => new Date("2026-08-24T08:00:00.000Z"),
				monotonicNow: () => tick++ * 10,
			},
		);

		expect(report).toMatchObject({
			contractType: "local-service-smoke-report",
			contractVersion: "1.0",
			status: "SMOKE_PASSED",
			executedAt: "2026-08-24T08:00:00.000Z",
		});
		expect(report.services).toHaveLength(5);
		expect(report.services.map((service) => service.status)).toEqual([
			"SMOKE_PASSED",
			"SMOKE_PASSED",
			"SMOKE_PASSED",
			"SMOKE_PASSED",
			"SMOKE_PASSED",
		]);
		expect(report.services[0]).toMatchObject({
			serviceId: "qwen-model",
			model: "Qwen3.8-27B",
			latencyMs: 10,
			capabilities: expect.any(Array),
			limitations: expect.any(Array),
		});
		expect(
			report.services.every((service) =>
				/^[0-9a-f]{64}$/.test(service.inputSha256),
			),
		).toBe(true);
		expect(JSON.stringify(report)).not.toContain("CERTIFIED");
	});

	it("任一服务失败时使整个 P0 smoke 门禁失败", async () => {
		const report = await runLocalServiceSmoke(
			loadLocalServiceConfiguration({}),
			{
				execute: async (target, request) =>
					target.serviceId === "qwen-reranker"
						? {
								contractType: "local-service-result",
								contractVersion: "1.0",
								requestId: request.requestId,
								port: target.port,
								ok: false,
								error: {
									code: "CONNECTION_FAILED",
									category: "TRANSPORT",
									message: "无法连接本地服务",
									retryable: true,
								},
							}
						: success(target, request),
				now: () => new Date("2026-08-24T08:00:00.000Z"),
				monotonicNow: () => 0,
			},
		);

		expect(report.status).toBe("SMOKE_FAILED");
		expect(
			report.services.find((service) => service.serviceId === "qwen-reranker"),
		).toMatchObject({
			status: "SMOKE_FAILED",
			errorCode: "CONNECTION_FAILED",
		});
	});
});

function success(
	target: LocalServiceTargetV1,
	request: LocalServiceRequestV1,
): LocalServiceResultV1 {
	const header = {
		contractType: "local-service-result",
		contractVersion: "1.0",
		requestId: request.requestId,
		ok: true,
	} as const;
	switch (target.serviceId) {
		case "qwen-model":
			return {
				...header,
				port: "MODEL_PROVIDER",
				output: { model: requiredModel(target), text: "OK" },
			};
		case "qwen-embedding":
			return {
				...header,
				port: "EMBEDDING_PROVIDER",
				output: {
					model: requiredModel(target),
					dimensions: 2,
					vectors: [[0.1, 0.2]],
				},
			};
		case "qwen-reranker":
			return {
				...header,
				port: "RERANKER",
				output: {
					model: requiredModel(target),
					rankings: [{ documentId: "candidate-a", score: 0.9 }],
				},
			};
		case "paddleocr-vl":
		case "mineru":
			return {
				...header,
				port: "DOCUMENT_PARSER",
				output: {
					parser: requiredModel(target),
					text: "ChoiceMind",
					pageCount: 1,
				},
			};
	}
}

function requiredModel(target: LocalServiceTargetV1): string {
	if (target.model === undefined) {
		throw new Error(`测试目标缺少模型标识：${target.serviceId}`);
	}
	return target.model;
}
