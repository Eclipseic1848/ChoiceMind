import type { LocalServicePortV1 } from "@choicemind/contracts/local-services/v1";

export { executeLocalServiceRequest } from "./client.js";
export { saveLocalServiceSmokeReport } from "./report-store.js";
export {
	buildFixedLocalServiceSmokeRequests,
	type LocalServiceSmokeReportV1,
	type LocalServiceSmokeServiceReportV1,
	runLocalServiceSmoke,
} from "./smoke.js";

export type LocalServiceProtocolV1 =
	| "OPENAI_CHAT_COMPLETIONS"
	| "OPENAI_EMBEDDINGS"
	| "RERANK"
	| "PADDLEOCR_VL"
	| "MINERU"
	| "CHOICEMIND_DOCUMENT_PARSER";

export type LocalServiceTargetV1 = Readonly<{
	serviceId:
		| "qwen-model"
		| "qwen-embedding"
		| "qwen-reranker"
		| "paddleocr-vl"
		| "mineru"
		| "choicemind-html-parser";
	port: LocalServicePortV1;
	baseUrl: string;
	model?: string | undefined;
	protocol: LocalServiceProtocolV1;
	timeoutMs: number;
	limits?: Readonly<{ maxInputBytes: number }> | undefined;
	capabilities: readonly string[];
	limitations: readonly string[];
}>;

export type LocalServiceConfigurationV1 = Readonly<{
	targets: readonly LocalServiceTargetV1[];
}>;

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_TIMEOUT_MS = 30_000;

export function loadLocalServiceConfiguration(
	environment: Environment,
): LocalServiceConfigurationV1 {
	const modelTimeoutMs = readPositiveInteger(
		environment.CHOICEMIND_LOCAL_MODEL_TIMEOUT_MS,
		120_000,
		"CHOICEMIND_LOCAL_MODEL_TIMEOUT_MS",
	);
	const sharedTimeoutMs = readPositiveInteger(
		environment.CHOICEMIND_LOCAL_SERVICE_TIMEOUT_MS,
		DEFAULT_TIMEOUT_MS,
		"CHOICEMIND_LOCAL_SERVICE_TIMEOUT_MS",
	);

	return {
		targets: [
			{
				serviceId: "qwen-model",
				port: "MODEL_PROVIDER",
				baseUrl: readBaseUrl(
					environment.CHOICEMIND_LOCAL_MODEL_BASE_URL,
					"http://192.168.121.32:6013/v1",
					"CHOICEMIND_LOCAL_MODEL_BASE_URL",
				),
				model: readMeaningfulText(
					environment.CHOICEMIND_LOCAL_MODEL_NAME,
					"Qwen3.8-27B",
					"CHOICEMIND_LOCAL_MODEL_NAME",
				),
				protocol: "OPENAI_CHAT_COMPLETIONS",
				timeoutMs: modelTimeoutMs,
				capabilities: ["文本生成", "OpenAI Chat Completions"],
				limitations: ["固定合成样本冒烟不代表模型能力认证"],
			},
			{
				serviceId: "qwen-embedding",
				port: "EMBEDDING_PROVIDER",
				baseUrl: readBaseUrl(
					environment.CHOICEMIND_LOCAL_EMBEDDING_BASE_URL,
					"http://192.168.121.33:8008/v1",
					"CHOICEMIND_LOCAL_EMBEDDING_BASE_URL",
				),
				model: readMeaningfulText(
					environment.CHOICEMIND_LOCAL_EMBEDDING_MODEL,
					"Qwen3-Embedding-4B",
					"CHOICEMIND_LOCAL_EMBEDDING_MODEL",
				),
				protocol: "OPENAI_EMBEDDINGS",
				timeoutMs: sharedTimeoutMs,
				capabilities: ["文本向量化"],
				limitations: ["仅验证固定单条文本输入"],
			},
			{
				serviceId: "qwen-reranker",
				port: "RERANKER",
				baseUrl: readBaseUrl(
					environment.CHOICEMIND_LOCAL_RERANKER_BASE_URL,
					"http://192.168.121.33:8012/v1",
					"CHOICEMIND_LOCAL_RERANKER_BASE_URL",
				),
				model: readMeaningfulText(
					environment.CHOICEMIND_LOCAL_RERANKER_MODEL,
					"Qwen3-Reranker-8B",
					"CHOICEMIND_LOCAL_RERANKER_MODEL",
				),
				protocol: "RERANK",
				timeoutMs: sharedTimeoutMs,
				capabilities: ["查询与候选文档重排"],
				limitations: ["仅验证两个固定候选文档"],
			},
			{
				serviceId: "paddleocr-vl",
				port: "DOCUMENT_PARSER",
				baseUrl: readBaseUrl(
					environment.CHOICEMIND_LOCAL_PADDLEOCR_BASE_URL,
					"http://192.168.121.33:18080/v1",
					"CHOICEMIND_LOCAL_PADDLEOCR_BASE_URL",
				),
				model: readMeaningfulText(
					environment.CHOICEMIND_LOCAL_PADDLEOCR_MODEL,
					"PaddleOCR-VL-1.6-0.9B",
					"CHOICEMIND_LOCAL_PADDLEOCR_MODEL",
				),
				protocol: "PADDLEOCR_VL",
				timeoutMs: sharedTimeoutMs,
				capabilities: ["图片文字识别"],
				limitations: ["仅验证固定合成图片"],
			},
			{
				serviceId: "mineru",
				port: "DOCUMENT_PARSER",
				baseUrl: readBaseUrl(
					environment.CHOICEMIND_LOCAL_MINERU_BASE_URL,
					"http://192.168.121.33:8000",
					"CHOICEMIND_LOCAL_MINERU_BASE_URL",
				),
				model: "MinerU-3.4.4",
				protocol: "MINERU",
				timeoutMs: sharedTimeoutMs,
				capabilities: ["PDF 文档解析"],
				limitations: ["仅验证固定单页合成 PDF"],
			},
			{
				serviceId: "choicemind-html-parser",
				port: "DOCUMENT_PARSER",
				baseUrl: readBaseUrl(
					environment.CHOICEMIND_DATA_WORKER_BASE_URL,
					"http://127.0.0.1:3300/v1",
					"CHOICEMIND_DATA_WORKER_BASE_URL",
				),
				protocol: "CHOICEMIND_DOCUMENT_PARSER",
				timeoutMs: sharedTimeoutMs,
				limits: { maxInputBytes: 1_500_000 },
				capabilities: ["HTML 文本解析"],
				limitations: ["P0 仅接受 UTF-8 HTML"],
			},
		],
	};
}

function readBaseUrl(
	value: string | undefined,
	fallback: string,
	name: string,
): string {
	const candidate = readMeaningfulText(value, fallback, name);
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error(`${name} 必须是有效 URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${name} 只允许 http 或 https`);
	}
	return url.toString().replace(/\/$/, "");
}

function readMeaningfulText(
	value: string | undefined,
	fallback: string,
	name: string,
): string {
	const candidate = value ?? fallback;
	if (candidate.trim() === "") {
		throw new Error(`${name} 不能为空`);
	}
	return candidate;
}

function readPositiveInteger(
	value: string | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} 必须是正整数毫秒数`);
	}
	return parsed;
}
