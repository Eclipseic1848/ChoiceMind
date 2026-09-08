import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { describe, expect, it, vi } from "vitest";
import { reviewCandidateWheelDependencies } from "./candidate-wheel-review.js";

// 容器/数据库使用真实实现，OSV 用固定响应；真实外部查询另设显式门禁。
const scan = vi.hoisted(() => vi.fn());
vi.mock("./candidate-vulnerability-scan.js", () => ({
	scanCandidateVulnerabilities: scan,
}));

describe.runIf(
	process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1" &&
		process.env.CHOICEMIND_TEST_DATABASE_URL !== undefined,
)("可信依赖安装回执", () => {
	it.each([
		["complete", "PASSED"],
		["complete", "FAILED"],
		["complete", "NOT_RUN"],
		["missing", "NOT_RUN"],
		["secret", "PASSED"],
		["binary", "PASSED"],
		["comment", "PASSED"],
	])(
		"%s / %s：报告来自实际执行，残缺检查不能启用",
		async (mode, status) => {
			scan.mockResolvedValue({
				status,
				findingCount: status === "FAILED" ? 1 : 0,
			});
			const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL ?? "";
			let store = await openPostgresCandidateStore(databaseUrl);
			try {
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
				const hash = (bytes: Uint8Array) =>
					createHash("sha256").update(bytes).digest("hex");
				const saveArtifact = vi.fn((bytes: Uint8Array) =>
					store.saveArtifact(bytes),
				);
				const { stored, report } = await reviewCandidateWheelDependencies(
					{
						source: {
							kind: "PYPI",
							packageName: "candidate",
							version: "1.0",
							artifactSha256: hash(artifact),
						},
						artifact,
						bundle: Buffer.from(fixture.bundle, "base64"),
						locked: fixture.locked,
					},
					{ saveArtifact, record: (input) => store.record(input) },
				);
				expect(report.lockedWheelInstallation).toBe(
					mode !== "missing" ? "PASSED" : "FAILED",
				);
				expect(report.execution.exitCode).toBe(mode !== "missing" ? 0 : 2);
				expect(report.vulnerabilityScan.status).toBe(
					mode !== "missing" ? status : "NOT_RUN",
				);
				expect(stored.candidate.review.checks.dependencies.status).toBe(
					mode !== "missing" ? status : "FAILED",
				);
				expect(stored.candidate.review.checks.secrets.status).toBe(
					mode === "secret" || mode === "comment"
						? "FAILED"
						: mode === "binary" || mode === "missing"
							? "NOT_RUN"
							: "PASSED",
				);
				expect(saveArtifact).toHaveBeenCalledTimes(1);
				for (const [bytes] of saveArtifact.mock.calls) {
					expect(Buffer.from(bytes).toString("utf8")).not.toContain(
						"Ab3dE5gH7jK9mN2pQ4sT6vW8xY0zB1cD3fG5",
					);
				}
				expect(stored.candidate.review.checks.basicCollection.status).toBe(
					"NOT_RUN",
				);
				expect(stored.lifecycle.state).toBe("REVIEW_FAILED");
				expect(saveArtifact).toHaveBeenCalledWith(
					Buffer.from(JSON.stringify(report), "utf8"),
				);
				expect(stored.candidate.review.reportSha256).toBe(
					hash(Buffer.from(JSON.stringify(report), "utf8")),
				);
				await store.close();
				store = await openPostgresCandidateStore(databaseUrl);
				expect(
					(await store.read(stored.candidate.candidateId))?.candidate.review,
				).toEqual(stored.candidate.review);
				await expect(
					store.transition(
						stored.candidate.candidateId,
						stored.lifecycle.reviewBindingSha256,
						randomUUID(),
						{
							type: "ENABLE",
							actorId: "synthetic-admin",
							actorRole: "ADMIN",
							occurredAt: new Date().toISOString(),
						},
					),
				).rejects.toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
			} finally {
				await store.close();
			}
		},
		40_000,
	);
});
