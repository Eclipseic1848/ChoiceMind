import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { reviewCandidateWheelDependencies } from "./candidate-wheel-review.js";

const invoke = vi.hoisted(() => vi.fn());
const closure = vi.hoisted(() => vi.fn());
vi.mock("./candidate-pypi-closure.js", () => ({
	resolvePublicPypiClosure: closure,
}));
vi.mock("./python-candidate-adapter.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./python-candidate-adapter.js")>()),
	createPythonCandidateInvoker: () => invoke,
}));

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

it.each(["package", "version", "sha256"])(
	"拒绝审查与提案不一致的%s，不执行候选或落库",
	async (mismatch) => {
		closure.mockReset();
		closure.mockResolvedValue({
			locked: [
				{
					name: "candidate",
					version: "1.0",
					sha256: "a".repeat(64),
					filename: "candidate.whl",
				},
			],
		});
		invoke.mockClear();
		const store = { saveArtifact: vi.fn(), record: vi.fn() };
		await expect(
			reviewCandidateWheelDependencies(
				{
					requirement: {
						packageName: "candidate",
						specifier: "==1.0",
						extras: [],
					},
					expectedSource: {
						kind: "PYPI",
						packageName: mismatch === "package" ? "other" : "candidate",
						version: mismatch === "version" ? "2.0" : "1.0",
						artifactSha256: (mismatch === "sha256" ? "b" : "a").repeat(64),
					},
				},
				store,
			),
		).rejects.toThrow("CANDIDATE_PROPOSAL_SOURCE_MISMATCH");
		expect(closure).toHaveBeenCalledTimes(mismatch === "package" ? 0 : 1);
		expect(invoke).not.toHaveBeenCalled();
		expect(store.saveArtifact).not.toHaveBeenCalled();
		expect(store.record).not.toHaveBeenCalled();
	},
);

it.each([
	"scan-cancel",
	"scan-failure",
	"invoke-cancel",
	"invoke-failure",
	"save-cancel",
])("%s：中止或失败不发布审查版本", async (stage) => {
	const controller = new AbortController();
	invoke.mockReset();
	invoke.mockImplementation(async () => {
		if (stage === "invoke-cancel") controller.abort();
		if (stage === "invoke-failure")
			throw new Error("SYNTHETIC_SANDBOX_UNAVAILABLE");
		return {
			output: {},
			execution: { outcome: "EXITED", exitCode: 0 },
			reportSha256: "0".repeat(64),
		};
	});
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
	expect(invoke).toHaveBeenCalledTimes(stage.startsWith("scan-") ? 0 : 1);
});
