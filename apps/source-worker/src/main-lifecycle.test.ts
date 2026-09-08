import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	closed: [] as string[],
	failOpen: false,
	failDrain: false,
	stopNormally: false,
	failClose: false,
	publicSources: false,
	key: undefined as Buffer | undefined,
	signals: [] as AbortSignal[],
}));
const resource = (name: string) => ({
	close: async () => {
		state.closed.push(name);
		if (state.failClose && name === "store")
			throw new Error("TEST_CLOSE_FAILED");
	},
});

vi.mock("@choicemind/task-persistence", () => ({
	openPersistentDecisionTaskModule: async () => resource("persistence"),
}));
vi.mock("@choicemind/security", () => ({
	createCredentialVault: ({ masterKey }: { masterKey: Buffer }) => {
		state.key = masterKey;
		return {};
	},
}));
vi.mock("@choicemind/source-access", () => ({
	openPostgresSourceAccess: async () => resource("access"),
}));
vi.mock("@choicemind/source-research", () => ({
	openPostgresSourceResearch: async () => resource("research"),
	createPublicWebSourceCatalog: () => new Map(state.publicSources ? [["brand", {}]] : []),
}));
vi.mock("@choicemind/source-research/candidate-store", () => ({
	openPostgresCandidateResearchRequests: async () => ({
		...resource("requests"),
		review: {},
	}),
	openPostgresCandidateStore: async () => {
		if (state.failOpen) throw new Error("TEST_STORE_OPEN_FAILED");
		return resource("store");
	},
}));
vi.mock("./candidate-wheel-review.js", () => ({
	createCandidateReviewWorker: () => ({
		runOnce: async (signal: AbortSignal) => {
			state.signals.push(signal);
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			state.closed.push("poll-stopped");
		},
		drain: async () => {
			state.closed.push("drain");
			if (state.failDrain) throw new Error("TEST_DRAIN_FAILED");
		},
	}),
}));
vi.mock("./worker.js", () => ({
	createSourceWorker: () => ({
		runOnce: async () => {
			if (!state.stopNormally) throw new Error("TEST_WORKER_FAILED");
			// 只调用本次入口安装的处理器，不能给测试宿主或其他服务发送信号。
			const handler = process.listeners("SIGTERM").at(-1);
			if (!handler) throw new Error("TEST_STOP_HANDLER_MISSING");
			handler("SIGTERM");
			return { claimed: 0 };
		},
	}),
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	state.closed = [];
	state.signals = [];
	state.failOpen = false;
	state.failDrain = false;
	state.stopNormally = false;
	state.failClose = false;
	state.publicSources = false;
	state.key = undefined;
});

it.each(["startup", "configuration", "running", "drain", "close", "signal"])(
	"%s 退出仍回收已取得资源并擦除密钥",
	async (phase) => {
		vi.stubEnv("CHOICEMIND_DATABASE_URL", "postgres://synthetic-unused");
		vi.stubEnv(
			"CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64",
			Buffer.alloc(32, 7).toString("base64"),
		);
		vi.stubEnv("CHOICEMIND_REDIS_URL", "");
		vi.stubEnv("CHOICEMIND_EVIDENCE_OBJECT_ROOT", "");
		vi.stubEnv("CHOICEMIND_PUBLIC_WEB_SOURCES_JSON", "[]");
		state.failOpen = phase === "startup";
		state.publicSources = phase === "configuration";
		state.failDrain = phase === "drain";
		state.failClose = phase === "close";
		state.stopNormally = phase === "signal";
		const listeners = [
			process.listenerCount("SIGINT"),
			process.listenerCount("SIGTERM"),
		];
		const error = await import("./main.js").then(
			() => undefined,
			(error) => error,
		);
		if (phase === "signal") expect(error).toBeUndefined();
		else if (phase === "drain" || phase === "close") {
			expect(error).toBeInstanceOf(AggregateError);
			expect(error.errors.map((entry: Error) => entry.message)).toEqual([
				"TEST_WORKER_FAILED",
				phase === "drain" ? "TEST_DRAIN_FAILED" : "TEST_CLOSE_FAILED",
			]);
		} else
			expect(error.message).toBe(
				phase === "startup" ? "TEST_STORE_OPEN_FAILED" : phase === "configuration" ? "CHOICEMIND_EVIDENCE_OBJECT_ROOT 未配置" : "TEST_WORKER_FAILED",
			);
		expect(state.closed).toEqual(
			phase === "startup"
				? ["requests", "research", "access", "persistence"]
				: [
						...(phase === "configuration" ? [] : ["poll-stopped"]),
						"drain",
						"store",
						"requests",
						"research",
						"access",
						"persistence",
					],
		);
		expect(state.key?.every((byte) => byte === 0)).toBe(true);
		expect(state.signals.every((signal) => signal.aborted)).toBe(true);
		expect([
			process.listenerCount("SIGINT"),
			process.listenerCount("SIGTERM"),
		]).toEqual(listeners);
	},
);
