import { describe, expect, it } from "vitest";

import { loadLocalServiceConfiguration } from "./index.js";

describe("loadLocalServiceConfiguration", () => {
	it("从一个入口提供五个本地服务目标，并默认使用已冻结的 Qwen3.8", () => {
		const configuration = loadLocalServiceConfiguration({});

		expect(configuration.targets).toEqual([
			expect.objectContaining({
				serviceId: "qwen-model",
				port: "MODEL_PROVIDER",
				baseUrl: "http://192.168.121.32:6013/v1",
				model: "Qwen3.8-27B",
				timeoutMs: 120_000,
			}),
			expect.objectContaining({
				serviceId: "qwen-embedding",
				port: "EMBEDDING_PROVIDER",
				baseUrl: "http://192.168.121.33:8008/v1",
			}),
			expect.objectContaining({
				serviceId: "qwen-reranker",
				port: "RERANKER",
				baseUrl: "http://192.168.121.33:8012/v1",
				model: "Qwen3-Reranker-8B",
			}),
			expect.objectContaining({
				serviceId: "paddleocr-vl",
				port: "DOCUMENT_PARSER",
				baseUrl: "http://192.168.121.33:18080/v1",
			}),
			expect.objectContaining({
				serviceId: "mineru",
				port: "DOCUMENT_PARSER",
				baseUrl: "http://192.168.121.33:8000",
			}),
		]);
	});

	it("允许在统一配置边界显式切回 Qwen3.6", () => {
		const configuration = loadLocalServiceConfiguration({
			CHOICEMIND_LOCAL_MODEL_BASE_URL: "http://192.168.121.32:6012/v1",
			CHOICEMIND_LOCAL_MODEL_NAME: "Qwen3.6-35B-A3B",
			CHOICEMIND_LOCAL_MODEL_TIMEOUT_MS: "90000",
		});

		expect(configuration.targets[0]).toMatchObject({
			baseUrl: "http://192.168.121.32:6012/v1",
			model: "Qwen3.6-35B-A3B",
			timeoutMs: 90_000,
		});
	});

	it.each([
		["无效 URL", { CHOICEMIND_LOCAL_MODEL_BASE_URL: "not-a-url" }],
		["非正超时", { CHOICEMIND_LOCAL_MODEL_TIMEOUT_MS: "0" }],
	])("拒绝%s", (_label, environment) => {
		expect(() => loadLocalServiceConfiguration(environment)).toThrow();
	});
});
