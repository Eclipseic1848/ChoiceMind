import { createHash } from "node:crypto";
import { executeCandidateSandbox } from "./candidate-sandbox.js";

// 只覆盖明确的 UTF-8 文本，不把单文件结果提升为完整制品或依赖审查。
export async function scanCandidateTextSecrets(input: {
	text: Uint8Array;
	sha256: string;
	signal?: AbortSignal;
}) {
	const signal = input.signal;
	const sha256 = input.sha256;
	if (
		!(input.text instanceof Uint8Array) ||
		input.text.length === 0 ||
		input.text.length > 64 * 1024 * 1024
	)
		throw new Error("CANDIDATE_SECRET_TEXT_INVALID");
	const text = Buffer.from(input.text);
	if (createHash("sha256").update(text).digest("hex") !== sha256)
		throw new Error("CANDIDATE_SECRET_TEXT_HASH_MISMATCH");
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(text);
		if (text.includes(0)) throw new Error();
	} catch {
		throw new Error("CANDIDATE_SECRET_TEXT_INVALID");
	}
	const execution = await executeCandidateSandbox({
		artifact: text,
		artifactSha256: sha256,
		runtime: "GITLEAKS",
		...(signal === undefined ? {} : { signal }),
	});
	signal?.throwIfAborted();
	const coverage = execution.untrustedStdout.toString("utf8");
	const complete =
		/^[0-9]+\n$/.test(coverage) && Number(coverage.trim()) === text.length;
	const status =
		execution.report.outcome !== "EXITED" || !complete
			? "NOT_RUN"
			: execution.report.exitCode === 0
				? "NO_FINDINGS"
				: execution.report.exitCode === 42
					? "FINDINGS"
					: "NOT_RUN";
	return {
		schemaVersion: "candidate-text-secrets.v1" as const,
		status,
		textSha256: sha256,
		scanner: "gitleaks-8.30.1",
		execution: execution.report,
		executionReportSha256: execution.reportSha256,
	};
}
