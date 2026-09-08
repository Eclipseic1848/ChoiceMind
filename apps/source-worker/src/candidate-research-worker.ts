import type { openPostgresCandidateResearchRequests } from "@choicemind/source-research/candidate-store";

type CandidateRequests = Awaited<
	ReturnType<typeof openPostgresCandidateResearchRequests>
>;
export type CandidateResearchScope = Readonly<{
	jobId: string;
	ownerUserId: string;
	decisionTaskId: string;
	agentRunId: string;
	sourceId: string;
}>;

export function createCandidateResearchWorker(
	options: Readonly<{
		requests: Pick<CandidateRequests, "claimNext" | "check" | "finish">;
		execute(
			input: Readonly<{
				scope: CandidateResearchScope;
				signal: AbortSignal;
				assertActive(): Promise<void>;
			}>,
		): Promise<void>;
		heartbeatIntervalMs?: number;
		timeoutMs?: number;
	}>,
) {
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000;
	const timeoutMs = options.timeoutMs ?? 600_000;
	if (
		!Number.isSafeInteger(heartbeatIntervalMs) ||
		heartbeatIntervalMs < 1 ||
		heartbeatIntervalMs >= 30_000 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 600_000
	)
		throw new Error("CANDIDATE_WORKER_TIMING_INVALID");
	return {
		async runOnce(
			parentSignal?: AbortSignal,
		): Promise<{ claimed: number; completed: number }> {
			if (parentSignal?.aborted) return { claimed: 0, completed: 0 };
			const claim = await options.requests.claimNext();
			if (!claim) return { claimed: 0, completed: 0 };
			const controller = new AbortController();
			const abort = () =>
				controller.abort(new Error("CANDIDATE_RESEARCH_STOPPED"));
			parentSignal?.addEventListener("abort", abort, { once: true });
			if (parentSignal?.aborted) abort();
			const timeout = setTimeout(abort, timeoutMs);
			let checking: Promise<void> | undefined;
			const assertActive = async () => {
				controller.signal.throwIfAborted();
				// 心跳与付费前检查共用在途查询，不叠加续租请求。
				checking ??= options.requests
					.check(claim)
					.then((active) => {
						if (!active) abort();
					})
					.catch(() => {
						abort();
					})
					.finally(() => {
						checking = undefined;
					});
				await checking;
				controller.signal.throwIfAborted();
			};
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let rejectExecution: (() => void) | undefined;
			let started = false;
			let outcome: "COMPLETED" | "CANCELLED" | "UNKNOWN" = "CANCELLED";
			try {
				await assertActive();
				heartbeat = setInterval(() => {
					void assertActive().catch(() => {});
				}, heartbeatIntervalMs);
				started = true;
				const interrupted = new Promise<never>((_, reject) => {
					rejectExecution = () => reject(controller.signal.reason);
					controller.signal.addEventListener("abort", rejectExecution, {
						once: true,
					});
				});
				// 仅保证调度有界退出；外部执行是否停止仍需执行器证明，结果不明不得重领。
				await Promise.race([
					interrupted,
					Promise.resolve().then(() => {
						controller.signal.throwIfAborted();
						return options.execute({
							scope: {
								jobId: claim.jobId,
								ownerUserId: claim.ownerUserId,
								decisionTaskId: claim.decisionTaskId,
								agentRunId: claim.agentRunId,
								sourceId: claim.sourceId,
							},
							signal: controller.signal,
							assertActive,
						});
					}),
				]);
				await assertActive();
				outcome = "COMPLETED";
			} catch {
				// 一旦交给执行器，无法在这里证明未外发；费用结算仍由 ProviderRouting 负责。
				outcome = started ? "UNKNOWN" : "CANCELLED";
				abort();
			} finally {
				clearTimeout(timeout);
				clearInterval(heartbeat);
				if (rejectExecution)
					controller.signal.removeEventListener("abort", rejectExecution);
				await checking;
				if (controller.signal.aborted && started) outcome = "UNKNOWN";
				abort();
				parentSignal?.removeEventListener("abort", abort);
			}
			try {
				const recorded = await options.requests.finish(claim, outcome);
				return {
					claimed: 1,
					completed: recorded && outcome === "COMPLETED" ? 1 : 0,
				};
			} catch {
				// 落库结果不明不得重新执行；持久领取会在租约过期后保留 UNKNOWN。
				return { claimed: 1, completed: 0 };
			}
		},
	};
}
