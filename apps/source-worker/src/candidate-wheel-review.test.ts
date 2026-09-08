import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { describe, expect, it, vi } from "vitest";
import { reviewCandidateWheelDependencies } from "./candidate-wheel-review.js";

describe.runIf(
	process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1" &&
		process.env.CHOICEMIND_TEST_DATABASE_URL !== undefined,
)("可信依赖安装回执", () => {
	it.each(["complete", "missing"])(
		"%s：报告来自实际执行，残缺检查不能启用",
		async (mode) => {
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
					mode === "complete" ? "PASSED" : "FAILED",
				);
				expect(report.execution.exitCode).toBe(mode === "complete" ? 0 : 2);
				expect(report.vulnerabilityScan).toBe("NOT_RUN");
				expect(stored.candidate.review.checks.dependencies.status).toBe(
					mode === "complete" ? "NOT_RUN" : "FAILED",
				);
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
