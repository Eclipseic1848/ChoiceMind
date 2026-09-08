import { createHash } from "node:crypto";
import {
	type AdapterCandidateSource,
	createAdapterCandidate,
	parseAdapterCandidateSource,
} from "@choicemind/source-research/adapter-candidate";
import type { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { acquireCandidateArtifact } from "./candidate-acquisition.js";
import { scanCandidateArchiveSecrets } from "./candidate-archive-secret-scan.js";
import { resolvePublicPypiClosure } from "./candidate-pypi-closure.js";
import { scanCandidateVulnerabilities } from "./candidate-vulnerability-scan.js";
import {
	parseWheelRequirement,
	type WheelRequirement,
} from "./candidate-wheel-dependencies.js";
import {
	CandidateWheelInstallFailure,
	installCandidateWheels,
} from "./candidate-wheel-install.js";
import {
	CandidatePythonCallFailure,
	createPythonCandidateInvoker,
} from "./python-candidate-adapter.js";

// 仅执行固定的可信 wheel 安装检查；不接受候选自报的检查状态或测试函数。
export async function reviewCandidateWheelDependencies(
	request:
		| {
				source: AdapterCandidateSource;
				artifact: Uint8Array;
				bundle: Uint8Array;
				locked: Parameters<typeof installCandidateWheels>[0]["locked"];
				signal?: AbortSignal;
		  }
		| {
				requirement: WheelRequirement;
				expectedSource?: AdapterCandidateSource;
				signal?: AbortSignal;
		  },
	store: Pick<
		Awaited<ReturnType<typeof openPostgresCandidateStore>>,
		"saveArtifact" | "record"
	>,
) {
	const prepared =
		"requirement" in request
			? await preparePypiReview(request)
			: { input: request, provenance: undefined };
	const { input, provenance } = prepared;
	const signal = input.signal;
	const notRun = { status: "NOT_RUN", checkCount: 0, findingCount: 0 } as const;
	const initial = createAdapterCandidate({
		schemaVersion: "adapter-candidate.v1",
		source: input.source,
		review: {
			reportSha256: "0".repeat(64),
			reviewedAt: new Date().toISOString(),
			checks: {
				dependencies: notRun,
				entrypoints: notRun,
				network: notRun,
				secrets: notRun,
				basicCollection: notRun,
				loginExpiry: notRun,
				rateLimit: notRun,
				emptyResult: notRun,
				failureHandling: notRun,
			},
		},
	});
	if (
		initial.source.kind !== "PYPI" ||
		!(input.artifact instanceof Uint8Array) ||
		input.artifact.byteLength === 0 ||
		input.artifact.byteLength > 64 * 1024 * 1024 ||
		!(input.bundle instanceof Uint8Array) ||
		input.bundle.byteLength === 0 ||
		input.bundle.byteLength > 64 * 1024 * 1024
	)
		throw new Error("CANDIDATE_WHEEL_REVIEW_INPUT_INVALID");
	const artifact = Buffer.from(input.artifact);
	const bundle = Buffer.from(input.bundle);
	if (
		hash(artifact) !== initial.source.artifactSha256 ||
		!Array.isArray(input.locked) ||
		input.locked.length === 0 ||
		input.locked.length > 1000
	)
		throw new Error("CANDIDATE_WHEEL_REVIEW_INPUT_INVALID");
	const lockManifest = Buffer.from(JSON.stringify(input.locked), "utf8");
	if (lockManifest.length > 1024 * 1024)
		throw new Error("CANDIDATE_WHEEL_REVIEW_INPUT_INVALID");
	const locked: typeof input.locked = JSON.parse(lockManifest.toString("utf8"));
	const source = initial.source;
	if (
		!locked.some(
			(item) =>
				item !== null &&
				typeof item.name === "string" &&
				item.name.toLowerCase().replace(/[-_.]+/g, "-") ===
					source.packageName &&
				item.version === source.version &&
				item.sha256 === source.artifactSha256,
		)
	)
		throw new Error("CANDIDATE_WHEEL_REVIEW_TARGET_NOT_LOCKED");
	let receipt: Pick<
		Awaited<ReturnType<typeof installCandidateWheels>>,
		"execution" | "reportSha256"
	>;
	let installed = true;
	try {
		receipt = await installCandidateWheels({
			bundle,
			sha256: hash(bundle),
			locked,
			...(signal === undefined ? {} : { signal }),
		});
	} catch (error) {
		if (
			!(error instanceof CandidateWheelInstallFailure) ||
			error.execution.outcome === "CANCELLED"
		)
			throw error;
		installed = false;
		receipt = error;
	}
	signal?.throwIfAborted();
	const secretScan = installed
		? await scanCandidateArchiveSecrets({
				archive: bundle,
				sha256: hash(bundle),
				kind: "WHEEL_BUNDLE",
				...(signal === undefined ? {} : { signal }),
			})
		: { status: "NOT_RUN" as const, checkCount: 0, findingCount: 0 };
	signal?.throwIfAborted();
	const vulnerabilityScan = installed
		? await scanCandidateVulnerabilities(locked, signal)
		: { status: "NOT_RUN" as const, findingCount: 0 };
	signal?.throwIfAborted();
	let entrypoint: {
		status: "PASSED" | "FAILED" | "NOT_RUN";
		execution?: CandidatePythonCallFailure["execution"];
		executionReportSha256?: string;
	} = { status: "NOT_RUN" };
	// 只有前置检查完整通过才执行候选；固定空请求只证明调用协议，不证明业务行为。
	if (
		installed &&
		secretScan.status === "NO_FINDINGS" &&
		vulnerabilityScan.status === "PASSED"
	) {
		try {
			const call = await createPythonCandidateInvoker({
				bundle,
				bundleSha256: hash(bundle),
				artifactSha256: source.artifactSha256,
				locked,
			})(
				{ query: "", researchTarget: null, checkpoint: null },
				signal ?? new AbortController().signal,
			);
			entrypoint = {
				status: "PASSED",
				execution: call.execution,
				executionReportSha256: call.reportSha256,
			};
		} catch (error) {
			if (!(error instanceof CandidatePythonCallFailure)) throw error;
			entrypoint = {
				status: "FAILED",
				execution: error.execution,
				executionReportSha256: error.reportSha256,
			};
		}
	}
	signal?.throwIfAborted();
	const report = {
		schemaVersion: provenance
			? "candidate-wheel-dependency-review.v5"
			: "candidate-wheel-dependency-review.v4",
		...(provenance ? { provenance } : {}),
		source,
		artifactSha256: hash(artifact),
		bundleSha256: hash(bundle),
		lockSha256: hash(lockManifest),
		reviewedAt: new Date().toISOString(),
		controller: "isolated-locked-wheel-install.v1",
		lockedWheelInstallation: installed ? "PASSED" : "FAILED",
		vulnerabilityScan,
		secretScan,
		entrypoint,
		execution: receipt.execution,
		executionReportSha256: receipt.reportSha256,
	};
	const reportBytes = Buffer.from(JSON.stringify(report), "utf8");
	// 这里只完成部分审查；原制品留存交给完整安全审查，不能凭无命中提前保存。
	await store.saveArtifact(reportBytes);
	signal?.throwIfAborted();
	// 发布请求开始后不承诺撤回数据库提交；发布前的取消不得生成新审查版本。
	const stored = await store.record({
		schemaVersion: "adapter-candidate.v1",
		source,
		review: {
			reportSha256: hash(reportBytes),
			reviewedAt: report.reviewedAt,
			checks: {
				...initial.review.checks,
				entrypoints:
					entrypoint.status === "NOT_RUN"
						? notRun
						: {
								status: entrypoint.status,
								checkCount: 1,
								findingCount: entrypoint.status === "FAILED" ? 1 : 0,
							},
				secrets:
					secretScan.status === "NOT_RUN"
						? notRun
						: {
								status:
									secretScan.status === "FINDINGS"
										? ("FAILED" as const)
										: ("PASSED" as const),
								checkCount: secretScan.checkCount,
								findingCount: secretScan.findingCount,
							},
				dependencies: installed
					? vulnerabilityScan.status === "NOT_RUN"
						? notRun
						: {
								status: vulnerabilityScan.status,
								checkCount: 2,
								findingCount: vulnerabilityScan.findingCount,
							}
					: { status: "FAILED", checkCount: 1, findingCount: 1 },
			},
		},
	});
	return { stored, report };
}

// 证据只来自本次实际解析；不接受调用者提交的来源回执或 PASSED 状态。
async function preparePypiReview(request: {
	requirement: WheelRequirement;
	expectedSource?: AdapterCandidateSource;
	signal?: AbortSignal;
}) {
	const requirement = parseWheelRequirement(request.requirement);
	const expected =
		request.expectedSource === undefined
			? undefined
			: parseAdapterCandidateSource(request.expectedSource);
	if (
		expected &&
		(expected.kind !== "PYPI" ||
			expected.packageName !== requirement.packageName)
	)
		throw new Error("CANDIDATE_PROPOSAL_SOURCE_MISMATCH");
	const timeout = AbortSignal.timeout(600_000);
	const signal = request.signal
		? AbortSignal.any([request.signal, timeout])
		: timeout;
	const resolution = await resolvePublicPypiClosure([requirement], signal);
	const target = resolution.locked.find(
		(item) => item.name === requirement.packageName,
	);
	if (!target) throw new Error("CANDIDATE_WHEEL_REVIEW_TARGET_NOT_LOCKED");
	if (
		expected &&
		(expected.kind !== "PYPI" ||
			expected.version !== target.version ||
			expected.artifactSha256 !== target.sha256)
	)
		throw new Error("CANDIDATE_PROPOSAL_SOURCE_MISMATCH");
	// 重新获取所选根制品并核验固定摘要，避免在宿主解包候选 catalogue。
	const acquired = await acquireCandidateArtifact(
		{
			kind: "PYPI",
			packageName: target.name,
			version: target.version,
			artifactSha256: target.sha256,
		},
		signal,
	);
	if (acquired.receipt.filename !== target.filename)
		throw new Error("CANDIDATE_WHEEL_FILENAME_MISMATCH");
	return {
		input: {
			source: acquired.receipt.source,
			artifact: acquired.artifact,
			bundle: resolution.bundle,
			locked: resolution.locked,
			signal,
		},
		provenance: {
			requirement,
			locked: resolution.locked,
			indexes: resolution.indexes,
			missingProjects: resolution.missingProjects,
			acquisitions: resolution.acquisitions,
			targetAcquisition: acquired.receipt,
			dependencyReports: resolution.dependencyReports,
			catalogueSha256: resolution.catalogueSha256,
			catalogueReportSha256: resolution.catalogueReportSha256,
			requirementsSha256: resolution.requirementsSha256,
			execution: resolution.execution,
			reportSha256: resolution.reportSha256,
		},
	};
}

function hash(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}
