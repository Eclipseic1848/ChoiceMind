import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { expect, it, vi } from "vitest";
import { buildAndStoreCandidateWheels } from "./candidate-wheel-install.js";

it.runIf(
	process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1" &&
		process.env.CHOICEMIND_TEST_DATABASE_URL !== undefined,
)(
	"真实隔离构建的字节与输入入库，不产生批准",
	async () => {
		const store = await openPostgresCandidateStore(
			process.env.CHOICEMIND_TEST_DATABASE_URL ?? "",
		);
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
					"source-success",
				],
				{ encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
			);
			const fixture = JSON.parse(stdout);
			const bundle = Buffer.from(fixture.bundle, "base64");
			const archive = Buffer.from(fixture.source, "base64");
			const hash = (bytes: Uint8Array) =>
				createHash("sha256").update(bytes).digest("hex");
			const saveArtifact = vi.fn((bytes: Uint8Array) =>
				store.saveArtifact(bytes),
			);
			const result = await buildAndStoreCandidateWheels(
				{
					bundle,
					sha256: hash(bundle),
					locked: fixture.locked,
					source: { archive, sha256: hash(archive) },
				},
				{ saveArtifact },
			);
			expect(result.stored.sourceSha256).toBe(hash(archive));
			expect(result.stored.bundleSha256).toBe(hash(bundle));
			expect(result.builtArtifact?.bytes.length).toBeGreaterThan(0);
			expect(result.stored.artifactSha256).toBe(result.builtArtifact?.sha256);
			expect(result.stored.lockSha256).toBe(hash(result.lockManifest));
			expect(saveArtifact).toHaveBeenCalledTimes(4);
			expect(result.reviewStatus).toBe("NOT_RUN");
			expect(result.summary).toMatchObject({
				build: {
					wheelSha256: result.stored.artifactSha256,
					reviewStatus: "NOT_RUN",
				},
			});
		} finally {
			await store.close();
		}
	},
	40_000,
);
