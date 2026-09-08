import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { reviewCandidateWheelDependencies } from "./candidate-wheel-review.js";

vi.mock("./candidate-wheel-install.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./candidate-wheel-install.js")>()),
	installCandidateWheels: vi.fn(async () => ({
		execution: { outcome: "EXITED", exitCode: 0 },
		reportSha256: "0".repeat(64),
	})),
}));

it.each([1, 2, 3, 4])(
	"第 %i 次归档等待中取消，不发布审查版本",
	async (cancelAt) => {
		const controller = new AbortController();
		const artifact = Buffer.from("synthetic");
		const sha256 = createHash("sha256").update(artifact).digest("hex");
		let calls = 0;
		const saveArtifact = vi.fn(async () => {
			if (++calls === cancelAt) controller.abort();
			return sha256;
		});
		const record = vi.fn();
		await expect(
			reviewCandidateWheelDependencies(
				{
					source: {
						kind: "PYPI",
						packageName: "candidate",
						version: "1.0",
						artifactSha256: sha256,
					},
					artifact,
					bundle: artifact,
					locked: [
						{
							name: "candidate",
							version: "1.0",
							filename: "candidate-1.0-py3-none-any.whl",
							sha256,
						},
					],
					signal: controller.signal,
				},
				{ saveArtifact, record },
			),
		).rejects.toThrow();
		expect(saveArtifact).toHaveBeenCalledTimes(cancelAt);
		expect(record).not.toHaveBeenCalled();
	},
);
