import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { executeCandidateSandbox } from "./candidate-sandbox.js";

export async function installCandidateWheels(input: {
	bundle: Uint8Array;
	sha256: string;
	locked: Array<{
		filename: string;
		name: string;
		version: string;
		sha256: string;
	}>;
	signal?: AbortSignal;
	source?: { archive: Uint8Array; sha256: string };
}) {
	if (
		!(input.bundle instanceof Uint8Array) ||
		input.bundle.byteLength === 0 ||
		input.bundle.byteLength > 64 * 1024 * 1024 ||
		!/^[a-f0-9]{64}$/.test(input.sha256) ||
		!Array.isArray(input.locked) ||
		input.locked.length === 0 ||
		input.locked.length > 1000
	)
		throw new Error("CANDIDATE_WHEEL_INPUT_INVALID");
	const bundle = Buffer.from(input.bundle);
	if (hash(bundle) !== input.sha256) throw new Error("CANDIDATE_HASH_MISMATCH");
	if (
		input.source !== undefined &&
		(!(input.source.archive instanceof Uint8Array) ||
			input.source.archive.byteLength === 0 ||
			!/^[a-f0-9]{64}$/.test(input.source.sha256))
	)
		throw new Error("CANDIDATE_SOURCE_INVALID");
	const sourceArchive =
		input.source === undefined
			? Buffer.alloc(0)
			: Buffer.from(input.source.archive);
	const sourceSha256 = hash(sourceArchive);
	if (input.source !== undefined && sourceSha256 !== input.source.sha256)
		throw new Error("CANDIDATE_HASH_MISMATCH");
	// 锁文件是数据，不拼成 Python 表达式或 shell；字段由容器再次严格校验。
	const locked = JSON.stringify(input.locked);
	if (
		Buffer.byteLength(locked, "utf8") > 1024 * 1024 ||
		8 +
			Buffer.byteLength(locked, "utf8") +
			bundle.byteLength +
			sourceArchive.byteLength >
			64 * 1024 * 1024
	)
		throw new Error("CANDIDATE_WHEEL_INPUT_INVALID");
	const scripts = await Promise.all(
		[
			"inspect_archive.py",
			"install_wheels.py",
			...(input.source === undefined ? [] : ["build_python_source.py"]),
		].map((name) =>
			readFile(
				new URL(`../../../scripts/adapter-candidate/${name}`, import.meta.url),
				"utf8",
			),
		),
	);
	const lockBytes = Buffer.from(locked, "utf8");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(lockBytes.byteLength);
	const bundleLength = Buffer.alloc(4);
	bundleLength.writeUInt32BE(bundle.byteLength);
	const source = Buffer.from(
		`${scripts.join("\n")}\nimport json\ntry:\n    length=int.from_bytes(sys.stdin.buffer.read(4),'big')\n    locked=json.loads(sys.stdin.buffer.read(length))\n    length=int.from_bytes(sys.stdin.buffer.read(4),'big')\n    result=install_wheels(sys.stdin.buffer.read(length), ${JSON.stringify(input.sha256)}, locked, inspect_archive, MAX_EXPANDED_BYTES)\n${input.source === undefined ? "" : `    result['build']=build_python_source(sys.stdin.buffer.read(MAX_ARCHIVE_BYTES+1), ${JSON.stringify(sourceSha256)}, inspect_archive, MAX_ARCHIVE_BYTES, locked)\n`}    print(json.dumps(result))\nexcept ValueError:\n    sys.exit(2)\n`,
		"utf8",
	);
	const execution = await executeCandidateSandbox({
		artifact: source,
		artifactSha256: hash(source),
		runtime: "PYTHON",
		stdin: Buffer.concat([
			length,
			lockBytes,
			bundleLength,
			bundle,
			sourceArchive,
		]),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
	if (execution.report.outcome !== "EXITED" || execution.report.exitCode !== 0)
		throw new Error("CANDIDATE_WHEEL_INSTALL_REJECTED");
	const summary: unknown = JSON.parse(
		execution.untrustedStdout.toString("utf8"),
	);
	return {
		summary,
		execution: execution.report,
		reportSha256: execution.reportSha256,
	};
}

function hash(value: Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}
