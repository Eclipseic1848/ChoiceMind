import { expect, it, vi } from "vitest";
import { loadApprovedCandidateAdapter } from "./approved-candidate-adapter.js";
import { createSourceWorker } from "./worker.js";

it.each(["before-status", "after-status"])(
	"撤销批准 %s 后不申请凭据租约",
	async (phase) => {
		const readApproved = vi.fn().mockResolvedValue({ candidateId: "approved" });
		const run = vi.fn();
		const adapter = await loadApprovedCandidateAdapter({
			candidateId: "candidate",
			reviewBindingSha256: "binding",
			artifact: Buffer.from("synthetic"),
			approvals: { readApproved },
			load: async () => ({
				accessMode: "CREDENTIAL",
				officialLoginUrl: "https://example.com/login",
				run,
			}),
		});
		if (phase === "before-status") readApproved.mockResolvedValue(undefined);
		const withCredential = vi.fn();
		const read = vi.fn(async () => {
			if (phase === "after-status") readApproved.mockResolvedValue(undefined);
			return { status: "ACTIVE" } as never;
		});
		const complete = vi.fn(async () => ({ status: "COMMITTED" as const }));
		const claim = {
			status: "CLAIMED" as const,
			jobId: "job",
			batchId: "batch",
			ownerUserId: "user",
			decisionTaskId: "task",
			query: "synthetic",
			sourceId: "candidate",
			sourceAccountId: "account",
			accessMode: "CREDENTIAL" as const,
			researchTarget: null,
			checkpoint: null,
			workerId: "worker",
			attemptCount: 1,
		};
		const worker = createSourceWorker({
			workerId: "worker",
			systemActor: { userId: "worker", role: "SYSTEM" },
			sourceAccess: { read, execute: vi.fn(), withCredential },
			sourceResearch: {
				claimNext: async () => claim,
				saveCheckpoint: vi.fn(),
				renewLease: vi.fn(),
				complete,
			},
			adapters: new Map([["candidate", adapter]]),
		});
		await expect(worker.runOnce()).resolves.toEqual({
			claimed: 1,
			completed: 1,
		});
		expect(withCredential).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		if (phase === "before-status") expect(read).not.toHaveBeenCalled();
		expect(complete).toHaveBeenCalledWith(
			claim,
			expect.objectContaining({ type: "FAILED_RETRYABLE" }),
		);
	},
);
