import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { executeCandidateSandbox } from "./candidate-sandbox.js";

// 归档只通过 stdin 进入受监督容器；宿主不打开 TAR/ZIP，不解压或导入归档。
export async function inspectCandidateArchive(input: {
	archive: Uint8Array;
	sha256: string;
	kind: "TAR" | "WHEEL";
	signal?: AbortSignal;
}) {
	if (
		!(input.archive instanceof Uint8Array) ||
		input.archive.byteLength === 0 ||
		input.archive.byteLength > 64 * 1024 * 1024 ||
		!/^[a-f0-9]{64}$/.test(input.sha256) ||
		(input.kind !== "TAR" && input.kind !== "WHEEL")
	)
		throw new Error("CANDIDATE_ARCHIVE_INVALID");
	const archive = Buffer.from(input.archive);
	if (hash(archive) !== input.sha256)
		throw new Error("CANDIDATE_ARCHIVE_HASH_MISMATCH");
	const inspector = await readFile(
		new URL(
			"../../../scripts/adapter-candidate/inspect_archive.py",
			import.meta.url,
		),
		"utf8",
	);
	const source = Buffer.from(
		`${inspector}\nimport json, sys\nsys.stdout.reconfigure(encoding='utf-8')\ntry:\n    result=inspect_archive(sys.stdin.buffer.read(MAX_ARCHIVE_BYTES+1), ${JSON.stringify(input.sha256)}, ${JSON.stringify(input.kind)})\n    print(json.dumps(result, ensure_ascii=False))\nexcept ValueError:\n    sys.exit(2)\n`,
		"utf8",
	);
	const execution = await executeCandidateSandbox({
		artifact: source,
		artifactSha256: hash(source),
		runtime: "PYTHON",
		stdin: archive,
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
	if (
		execution.report.outcome !== "EXITED" ||
		execution.report.exitCode !== 0
	) {
		throw new Error("CANDIDATE_ARCHIVE_REJECTED");
	}
	// 原始条目保持 unknown；归档摘要不是依赖、安全审查或正式启用批准。
	const manifest: unknown = JSON.parse(
		execution.untrustedStdout.toString("utf8"),
	);
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("archiveSha256" in manifest) ||
		manifest.archiveSha256 !== input.sha256
	)
		throw new Error("CANDIDATE_ARCHIVE_REPORT_INVALID");
	return {
		manifest,
		execution: execution.report,
		reportSha256: execution.reportSha256,
	};
}

function hash(value: Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}
