import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { loadApprovedCandidateAdapter } from "./approved-candidate-adapter.js";
import { recoverCandidateSandbox } from "./candidate-sandbox.js";
import { createPythonCandidateSourceAdapter } from "./python-candidate-adapter.js";
import type { PublicSourceAdapter } from "./worker.js";

const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
function context(): Parameters<PublicSourceAdapter["run"]>[0] {
	return {
		claim: {
			status: "CLAIMED",
			jobId: "job-synthetic",
			batchId: "batch-synthetic",
			ownerUserId: "owner-must-not-leak",
			decisionTaskId: "task-synthetic",
			query: "显示器",
			sourceId: "candidate-public",
			sourceAccountId: "public",
			accessMode: "PUBLIC",
			researchTarget: null,
			checkpoint: { cursor: 1 },
			workerId: "worker-synthetic",
			attemptCount: 1,
		},
		idempotencyKey: "private-key-must-not-leak",
		signal: new AbortController().signal,
		saveCheckpoint: vi.fn(),
	};
}

it("创建前拒绝包摘要变化", () => {
	expect(() =>
		createPythonCandidateSourceAdapter({
			bundle: Buffer.from("x"),
			bundleSha256: "0".repeat(64),
			artifactSha256: "0".repeat(64),
			locked: [
				{ filename: "a.whl", name: "a", version: "1", sha256: "0".repeat(64) },
			],
			sourceId: "candidate-public",
			mapResult: vi.fn(),
		}),
	).toThrow("CANDIDATE_HASH_MISMATCH");
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"同一工厂的真实 Python 调用",
	() => {
		it.each([
			"invoke-success",
			"invoke-shadow",
			"invoke-no-entry",
			"invoke-signature",
			"invoke-noise",
			"invoke-output",
			"invoke-fake",
			"invoke-network",
		])(
			"%s",
			async (mode) => {
				const { stdout } = await promisify(execFile)(
					fileURLToPath(
						new URL(
							"../../../services/data-worker/.venv/Scripts/python.exe",
							import.meta.url,
						),
					),
					[
						"-I",
						fileURLToPath(
							new URL(
								"../../../scripts/adapter-candidate/wheel_fixture.py",
								import.meta.url,
							),
						),
						mode,
					],
					{ encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
				);
				const fixture = JSON.parse(stdout);
				const artifact = Buffer.from(fixture.artifact, "base64");
				const bundle = Buffer.from(fixture.bundle, "base64");
				const mapResult = vi.fn(
					async (
						result: unknown,
						input: Parameters<PublicSourceAdapter["run"]>[0],
					) => {
						if (mode === "invoke-fake")
							throw new Error("UNTRUSTED_RESULT_REJECTED");
						if (mode === "invoke-network")
							expect(result).toEqual({ networkBlocked: true });
						else
							expect(result).toEqual({
								query: "显示器",
								keys: ["checkpoint", "query", "researchTarget"],
								checkpoint: { cursor: 1 },
							});
						await input.saveCheckpoint({ cursor: 2 });
						return {
							type: "NO_RESULT" as const,
							summary: "合成来源未找到结果",
							costUnits: 0,
						};
					},
				);
				const approvals = {
					readApproved: vi
						.fn()
						.mockResolvedValue({ candidateId: "synthetic-approved" }),
				};
				const adapter = await loadApprovedCandidateAdapter({
					candidateId: "candidate-synthetic",
					reviewBindingSha256: "0".repeat(64),
					artifact,
					approvals,
					load: async (bytes) =>
						createPythonCandidateSourceAdapter({
							bundle,
							bundleSha256: hash(bundle),
							artifactSha256: hash(bytes),
							locked: fixture.locked,
							sourceId: "candidate-public",
							mapResult,
						}),
				});
				if (adapter.accessMode !== "PUBLIC")
					throw new Error("UNEXPECTED_CREDENTIAL_ADAPTER");
				const input = context();
				if (
					["invoke-success", "invoke-shadow", "invoke-network"].includes(mode)
				) {
					expect(await adapter.run(input)).toEqual({
						type: "NO_RESULT",
						summary: "合成来源未找到结果",
						costUnits: 0,
					});
					expect(input.saveCheckpoint).toHaveBeenCalledWith({ cursor: 2 });
				} else {
					await expect(adapter.run(input)).rejects.toThrow(
						mode === "invoke-noise"
							? "CANDIDATE_PYTHON_RESPONSE_INVALID"
							: mode === "invoke-fake"
								? "UNTRUSTED_RESULT_REJECTED"
								: "CANDIDATE_PYTHON_CALL_FAILED",
					);
					if (mode !== "invoke-fake") expect(mapResult).not.toHaveBeenCalled();
				}
				approvals.readApproved.mockResolvedValue(undefined);
				await expect(adapter.run(input)).rejects.toThrow(
					"ADAPTER_CANDIDATE_NOT_APPROVED",
				);
				expect(await recoverCandidateSandbox()).toBe("EMPTY");
			},
			40000,
		);
	},
);
