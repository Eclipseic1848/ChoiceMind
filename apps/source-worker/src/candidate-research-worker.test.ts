import { afterEach, describe, expect, it, vi } from "vitest";
import { createCandidateResearchWorker } from "./candidate-research-worker.js";

type ExecutionInput = Parameters<
	Parameters<typeof createCandidateResearchWorker>[0]["execute"]
>[0];

const claim = {
	jobId: "job",
	ownerUserId: "owner",
	decisionTaskId: "task",
	agentRunId: "run",
	sourceId: "source",
	token: "private-lease-token",
};
function requests() {
	return {
		claimNext: vi
			.fn()
			.mockResolvedValueOnce(claim)
			.mockResolvedValue(undefined),
		check: vi.fn().mockResolvedValue(true),
		finish: vi.fn().mockResolvedValue(true),
	};
}
function aborted(signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
afterEach(() => {
	vi.useRealTimers();
});

describe("候选研究消费者", () => {
	it("执行器不响应取消仍有界退出，迟到完成不能覆盖UNKNOWN或启动第二次付费", async () => {
		vi.useFakeTimers();
		const store = requests();
		let release: (() => void) | undefined;
		const paid = vi.fn();
		const worker = createCandidateResearchWorker({
			requests: store,
			timeoutMs: 20,
			async execute({ assertActive }) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				await assertActive();
				paid();
			},
		});
		const running = worker.runOnce();
		await vi.advanceTimersByTimeAsync(21);
		expect(await running).toEqual({ claimed: 1, completed: 0 });
		expect(store.finish).toHaveBeenCalledWith(claim, "UNKNOWN");
		expect(vi.getTimerCount()).toBe(0);
		release?.();
		await vi.advanceTimersByTimeAsync(1);
		expect(paid).not.toHaveBeenCalled();
		expect(store.finish).toHaveBeenCalledTimes(1);
		expect(await worker.runOnce()).toEqual({ claimed: 0, completed: 0 });
	});
	it("成功仅交付费用归属白名单，重复轮询不重做，落库失败不重执行", async () => {
		const store = requests();
		const execute = vi.fn(async ({ scope, assertActive }: ExecutionInput) => {
			expect(scope).toEqual({
				jobId: "job",
				ownerUserId: "owner",
				decisionTaskId: "task",
				agentRunId: "run",
				sourceId: "source",
			});
			await assertActive();
		});
		const worker = createCandidateResearchWorker({ requests: store, execute });
		expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 1 });
		expect(store.finish).toHaveBeenCalledWith(claim, "COMPLETED");
		expect(await worker.runOnce()).toEqual({ claimed: 0, completed: 0 });
		expect(execute).toHaveBeenCalledTimes(1);
		store.claimNext.mockResolvedValueOnce(claim);
		store.finish.mockRejectedValueOnce(new Error("DB_UNAVAILABLE"));
		expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 0 });
		expect(await worker.runOnce()).toEqual({ claimed: 0, completed: 0 });
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("父信号提前取消不领取；入场失租约不执行", async () => {
		const store = requests();
		const execute = vi.fn();
		const worker = createCandidateResearchWorker({ requests: store, execute });
		expect(await worker.runOnce(AbortSignal.abort())).toEqual({
			claimed: 0,
			completed: 0,
		});
		expect(store.claimNext).not.toHaveBeenCalled();
		store.check.mockResolvedValue(false);
		expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 0 });
		expect(execute).not.toHaveBeenCalled();
		expect(store.finish).toHaveBeenCalledWith(claim, "CANCELLED");
	});

	it.each(["cancel", "database"])(
		"运行中%s阻止第二次付费，取消后不再查库",
		async (mode) => {
			vi.useFakeTimers();
			const store = requests();
			const paid = vi.fn();
			let activeCheck: (() => Promise<void>) | undefined;
			const worker = createCandidateResearchWorker({
				requests: store,
				heartbeatIntervalMs: 10,
				execute: async ({ signal, assertActive }) => {
					activeCheck = assertActive;
					await assertActive();
					paid();
					if (mode === "cancel") store.check.mockResolvedValue(false);
					else store.check.mockRejectedValue(new Error("DB_UNAVAILABLE"));
					await aborted(signal);
					await assertActive();
					paid();
				},
			});
			const running = worker.runOnce();
			await vi.advanceTimersByTimeAsync(11);
			expect(await running).toEqual({ claimed: 1, completed: 0 });
			expect(paid).toHaveBeenCalledTimes(1);
			expect(store.finish).toHaveBeenCalledWith(claim, "UNKNOWN");
			const calls = store.check.mock.calls.length;
			await expect(activeCheck?.()).rejects.toThrow(
				"CANDIDATE_RESEARCH_STOPPED",
			);
			expect(store.check).toHaveBeenCalledTimes(calls);
			expect(await worker.runOnce()).toEqual({ claimed: 0, completed: 0 });
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["timeout", "parent"])("%s中止执行并保留UNKNOWN", async (mode) => {
		vi.useFakeTimers();
		const store = requests();
		const parent = new AbortController();
		const worker = createCandidateResearchWorker({
			requests: store,
			timeoutMs: 20,
			execute: async ({ signal }) => {
				await aborted(signal);
			},
		});
		const running = worker.runOnce(parent.signal);
		await vi.advanceTimersByTimeAsync(1);
		if (mode === "parent") parent.abort();
		await vi.advanceTimersByTimeAsync(20);
		expect(await running).toEqual({ claimed: 1, completed: 0 });
		expect(store.finish).toHaveBeenCalledWith(claim, "UNKNOWN");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("执行失败不自动重试或宣称未收费", async () => {
		const store = requests();
		const execute = vi
			.fn()
			.mockRejectedValue(new Error("PROVIDER_RESULT_UNKNOWN"));
		const worker = createCandidateResearchWorker({ requests: store, execute });
		expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 0 });
		expect(store.finish).toHaveBeenCalledWith(claim, "UNKNOWN");
		await worker.runOnce();
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("慢心跳不重叠，退出等待已开始查询后才finish", async () => {
		vi.useFakeTimers();
		const store = requests();
		let releaseCheck: ((value: boolean) => void) | undefined;
		let returnExecution: (() => void) | undefined;
		const worker = createCandidateResearchWorker({
			requests: store,
			heartbeatIntervalMs: 10,
			execute: async () => {
				store.check.mockImplementation(
					() =>
						new Promise<boolean>((resolve) => {
							releaseCheck = resolve;
						}),
				);
				await new Promise<void>((resolve) => {
					returnExecution = resolve;
				});
			},
		});
		const running = worker.runOnce();
		await vi.advanceTimersByTimeAsync(35);
		expect(store.check).toHaveBeenCalledTimes(2);
		returnExecution?.();
		await vi.advanceTimersByTimeAsync(1);
		expect(store.finish).not.toHaveBeenCalled();
		releaseCheck?.(false);
		expect(await running).toEqual({ claimed: 1, completed: 0 });
		expect(store.finish).toHaveBeenCalledWith(claim, "UNKNOWN");
		expect(vi.getTimerCount()).toBe(0);
	});
});
