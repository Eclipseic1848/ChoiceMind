import { expect, it, vi } from "vitest";
import {
	loadApprovedCandidateAdapter,
	loadPersistedCandidateAdapter,
} from "./approved-candidate-adapter.js";

it("持久制品缺失时不能调用工厂", async () => {
	const load = vi.fn();
	await expect(
		loadPersistedCandidateAdapter({
			candidateId: "candidate",
			reviewBindingSha256: "binding",
			approvals: {
				readApproved: vi.fn(),
				readApprovedArtifact: vi.fn(async () => undefined),
			},
			load,
		}),
	).rejects.toThrow("ADAPTER_CANDIDATE_NOT_APPROVED");
	expect(load).not.toHaveBeenCalled();
});

it("工厂等待期间被撤销不能返回可用 Driver", async () => {
	const readApproved = vi
		.fn()
		.mockResolvedValueOnce({ candidateId: "approved" })
		.mockResolvedValue(undefined);
	await expect(
		loadApprovedCandidateAdapter({
			candidateId: "candidate",
			reviewBindingSha256: "binding",
			artifact: Buffer.from("synthetic"),
			approvals: { readApproved },
			load: async () => ({ accessMode: "PUBLIC", run: vi.fn() }),
		}),
	).rejects.toThrow("ADAPTER_CANDIDATE_NOT_APPROVED");
});

it("批准前不调用工厂，审批读取失败也不能加载", async () => {
	const load = vi.fn();
	const readApproved = vi.fn(async () => undefined);
	const input = {
		candidateId: "candidate",
		reviewBindingSha256: "binding",
		artifact: Buffer.from("synthetic"),
		approvals: { readApproved },
		load,
	};
	await expect(loadApprovedCandidateAdapter(input)).rejects.toThrow(
		"ADAPTER_CANDIDATE_NOT_APPROVED",
	);
	expect(load).not.toHaveBeenCalled();
	readApproved.mockRejectedValueOnce(new Error("database unavailable"));
	await expect(loadApprovedCandidateAdapter(input)).rejects.toThrow();
	expect(load).not.toHaveBeenCalled();
});

it("制品副本绑定实际哈希，撤销后不运行已加载适配器", async () => {
	const run = vi.fn();
	const artifact = Buffer.from("synthetic");
	const readApproved = vi.fn().mockResolvedValue({ candidateId: "approved" });
	const load = vi.fn(async (bytes: Uint8Array) => {
		expect(Buffer.from(bytes).toString()).toBe("synthetic");
		return { accessMode: "PUBLIC" as const, run };
	});
	const pending = loadApprovedCandidateAdapter({
		candidateId: "candidate",
		reviewBindingSha256: "binding",
		artifact,
		approvals: { readApproved },
		load,
	});
	artifact.fill(0);
	const adapter = await pending;
	expect(readApproved).toHaveBeenCalledWith(
		"candidate",
		"binding",
		expect.stringMatching(/^[a-f0-9]{64}$/),
	);
	readApproved.mockResolvedValue(undefined);
	await expect(adapter.run({} as never)).rejects.toThrow(
		"ADAPTER_CANDIDATE_NOT_APPROVED",
	);
	expect(run).not.toHaveBeenCalled();
});
