import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { executeCandidateSandbox } from "./candidate-sandbox.js";

export async function scanCandidateArchiveSecrets(input: {
	archive: Uint8Array;
	sha256: string;
	kind: "TAR" | "WHEEL" | "WHEEL_BUNDLE";
	signal?: AbortSignal;
}) {
	const { sha256, kind, signal } = input;
	if (
		!(input.archive instanceof Uint8Array) ||
		input.archive.length === 0 ||
		input.archive.length > 64 * 1024 * 1024 ||
		!["TAR", "WHEEL", "WHEEL_BUNDLE"].includes(kind)
	)
		throw new Error("CANDIDATE_ARCHIVE_INVALID");
	const archive = Buffer.from(input.archive);
	if (hash(archive) !== sha256)
		throw new Error("CANDIDATE_ARCHIVE_HASH_MISMATCH");
	signal?.throwIfAborted();
	const scripts = await Promise.all(
		["inspect_archive.py", "scan_archive_secrets.py"].map((name) =>
			readFile(
				new URL(`../../../scripts/adapter-candidate/${name}`, import.meta.url),
				"utf8",
			),
		),
	);
	const code = Buffer.from(
		`${scripts.join("\n")}\nimport json,sys\ntry:\n    archive=sys.stdin.buffer.read(MAX_ARCHIVE_BYTES+1)\n    print(json.dumps(scan_archive_secrets(archive, ${JSON.stringify(sha256)}, ${JSON.stringify(kind)}, inspect_archive)))\nexcept Exception:\n    sys.exit(2)\n`,
		"utf8",
	);
	const execution = await executeCandidateSandbox({
		artifact: code,
		artifactSha256: hash(code),
		runtime: "PYTHON_SECRETS",
		stdin: archive,
		...(signal === undefined ? {} : { signal }),
	});
	signal?.throwIfAborted();
	if (execution.report.outcome !== "EXITED" || execution.report.exitCode !== 0)
		throw new Error("CANDIDATE_ARCHIVE_SECRET_SCAN_INCOMPLETE");
	const summary: unknown = JSON.parse(
		execution.untrustedStdout.toString("utf8"),
	);
	if (
		typeof summary !== "object" ||
		summary === null ||
		!("archiveSha256" in summary) ||
		summary.archiveSha256 !== sha256
	)
		throw new Error("CANDIDATE_ARCHIVE_SECRET_REPORT_INVALID");
	const reports =
		kind === "WHEEL_BUNDLE" && "archives" in summary
			? summary.archives
			: [summary];
	if (!Array.isArray(reports) || reports.length === 0 || reports.length > 1001)
		throw new Error("CANDIDATE_ARCHIVE_SECRET_REPORT_INVALID");
	let checkCount = 0;
	let findingCount = 0;
	let incomplete = false;
	for (const report of reports) {
		if (
			typeof report !== "object" ||
			report === null ||
			!Array.isArray(report.files)
		)
			throw new Error("CANDIDATE_ARCHIVE_SECRET_REPORT_INVALID");
		if (report.files.length === 0) incomplete = true;
		for (const file of report.files) {
			if (
				typeof file !== "object" ||
				file === null ||
				!["EMPTY", "NO_FINDINGS", "FINDINGS", "NOT_RUN"].includes(file.status)
			)
				throw new Error("CANDIDATE_ARCHIVE_SECRET_REPORT_INVALID");
			checkCount++;
			if (checkCount > 11_001)
				throw new Error("CANDIDATE_ARCHIVE_SECRET_REPORT_INVALID");
			if (file.status === "FINDINGS") findingCount++;
			if (file.status === "NOT_RUN") incomplete = true;
		}
	}
	const status =
		findingCount > 0 ? "FINDINGS" : incomplete ? "NOT_RUN" : "NO_FINDINGS";
	if (!("status" in summary) || summary.status !== status)
		throw new Error("CANDIDATE_ARCHIVE_SECRET_REPORT_INVALID");
	return {
		status,
		checkCount,
		findingCount,
		summary,
		execution: execution.report,
		executionReportSha256: execution.reportSha256,
	};
}

function hash(value: Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}
