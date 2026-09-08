import { createHash } from "node:crypto";
import {
	type AdapterCandidateSource,
	createAdapterCandidate,
} from "@choicemind/source-research/adapter-candidate";
import type { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { scanCandidateArchiveSecrets } from "./candidate-archive-secret-scan.js";
import { scanCandidateVulnerabilities } from "./candidate-vulnerability-scan.js";
import {
	CandidateWheelInstallFailure,
	installCandidateWheels,
} from "./candidate-wheel-install.js";

// 仅执行固定的可信 wheel 安装检查；不接受候选自报的检查状态或测试函数。
export async function reviewCandidateWheelDependencies(
	input: {
		source: AdapterCandidateSource;
		artifact: Uint8Array;
		bundle: Uint8Array;
		locked: Parameters<typeof installCandidateWheels>[0]["locked"];
		signal?: AbortSignal;
	},
	store: Pick<
		Awaited<ReturnType<typeof openPostgresCandidateStore>>,
		"saveArtifact" | "record"
	>,
) {
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
	const report = {
		schemaVersion: "candidate-wheel-dependency-review.v3",
		source,
		artifactSha256: hash(artifact),
		bundleSha256: hash(bundle),
		lockSha256: hash(lockManifest),
		reviewedAt: new Date().toISOString(),
		controller: "isolated-locked-wheel-install.v1",
		lockedWheelInstallation: installed ? "PASSED" : "FAILED",
		vulnerabilityScan,
		secretScan,
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

function hash(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}
