import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { reviewCandidateWheelDependencies } from "./candidate-wheel-review.js";

const secretScan = vi.hoisted(() =>
	vi.fn(async () => ({
		status: "NO_FINDINGS",
		checkCount: 1,
		findingCount: 0,
	})),
);
vi.mock("./candidate-archive-secret-scan.js", () => ({
	scanCandidateArchiveSecrets: secretScan,
}));

vi.mock("./candidate-vulnerability-scan.js", () => ({
	scanCandidateVulnerabilities: vi.fn(async () => ({
		status: "PASSED",
		findingCount: 0,
	})),
}));

vi.mock("./candidate-wheel-install.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./candidate-wheel-install.js")>()),
	installCandidateWheels: vi.fn(async () => ({
		execution: { outcome: "EXITED", exitCode: 0 },
		reportSha256: "0".repeat(64),
	})),
}));

it.each(["scan-cancel", "scan-failure", "save-cancel"])(
	"%s：中止或失败不发布审查版本",
	async (stage) => {
		const controller = new AbortController();
		secretScan.mockImplementationOnce(async () => {
			if (stage === "scan-cancel") controller.abort();
			if (stage === "scan-failure")
				throw new Error("SYNTHETIC_SCANNER_UNAVAILABLE");
			return { status: "NO_FINDINGS", checkCount: 1, findingCount: 0 };
		});
		const artifact = Buffer.from("synthetic");
		const sha256 = createHash("sha256").update(artifact).digest("hex");
		const saveArtifact = vi.fn(async () => {
			if (stage === "save-cancel") controller.abort();
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
		expect(saveArtifact).toHaveBeenCalledTimes(stage === "save-cancel" ? 1 : 0);
		expect(record).not.toHaveBeenCalled();
	},
);
