import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseAdapterCandidateSource } from "@choicemind/source-research/adapter-candidate";
import { acquireCandidateArtifact } from "./candidate-acquisition.js";
import { executeCandidateSandbox } from "./candidate-sandbox.js";

// 只物化调用方给定的精确 wheel 集；依赖是否完整由后续同一离线安装器判定。
export async function acquireCandidateWheelBundle(
	input: readonly { source: unknown; filename: string }[],
	signal?: AbortSignal,
) {
	if (!Array.isArray(input) || input.length === 0 || input.length > 1000)
		throw new Error("CANDIDATE_WHEEL_SET_INVALID");
	const names = new Set<string>();
	const filenames = new Set<string>();
	const items = input
		.map((item) => {
			if (
				item === null ||
				typeof item !== "object" ||
				typeof item.filename !== "string" ||
				!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,239}\.whl$/.test(item.filename)
			)
				throw new Error("CANDIDATE_WHEEL_SET_INVALID");
			const source = parseAdapterCandidateSource(item.source);
			if (
				source.kind !== "PYPI" ||
				names.has(source.packageName) ||
				filenames.has(item.filename.toLowerCase())
			)
				throw new Error("CANDIDATE_WHEEL_SET_INVALID");
			names.add(source.packageName);
			filenames.add(item.filename.toLowerCase());
			return { source, filename: item.filename };
		})
		.sort((a, b) =>
			a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0,
		);
	const locked = items.map(({ source, filename }) => ({
		filename,
		name: source.packageName,
		version: source.version,
		sha256: source.artifactSha256,
	}));
	const lockBytes = Buffer.from(JSON.stringify(locked), "utf8");
	const limit = 64 * 1024 * 1024;
	if (lockBytes.length > 1024 * 1024)
		throw new Error("CANDIDATE_WHEEL_SET_INVALID");
	const deadline = AbortSignal.timeout(600_000);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const artifacts: Buffer[] = [];
	const acquisitions: Awaited<
		ReturnType<typeof acquireCandidateArtifact>
	>["receipt"][] = [];
	let bytes = 0;
	const zipOverhead = items.reduce(
		(sum, item) => sum + 76 + 2 * Buffer.byteLength(item.filename),
		22,
	);
	for (const { source, filename } of items) {
		combined.throwIfAborted();
		const result = await acquireCandidateArtifact(source, combined);
		if (result.receipt.filename !== filename)
			throw new Error("CANDIDATE_WHEEL_FILENAME_MISMATCH");
		bytes += result.artifact.length;
		if (bytes + lockBytes.length + zipOverhead + 8 > limit)
			throw new Error("CANDIDATE_WHEEL_SET_LIMIT");
		artifacts.push(result.artifact);
		acquisitions.push(result.receipt);
	}
	const header = Buffer.from(
		JSON.stringify(
			items.map((item, index) => ({
				filename: item.filename,
				size: artifacts[index]?.length,
				sha256: item.source.artifactSha256,
			})),
		),
		"utf8",
	);
	if (header.length > 1024 * 1024 || 4 + header.length + bytes > limit)
		throw new Error("CANDIDATE_WHEEL_SET_LIMIT");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(header.length);
	const code = await readFile(
		new URL(
			"../../../scripts/adapter-candidate/pack_wheels.py",
			import.meta.url,
		),
	);
	const result = await executeCandidateSandbox({
		artifact: code,
		artifactSha256: hash(code),
		runtime: "PYTHON_BUILD",
		stdin: Buffer.concat([length, header, ...artifacts]),
		signal: combined,
	});
	combined.throwIfAborted();
	if (
		result.report.outcome !== "EXITED" ||
		result.report.exitCode !== 0 ||
		result.untrustedStdout.length === 0 ||
		result.untrustedStdout.length + lockBytes.length + 8 > limit
	)
		throw new Error("CANDIDATE_WHEEL_PACK_FAILED");
	return {
		bundle: result.untrustedStdout,
		sha256: hash(result.untrustedStdout),
		locked,
		acquisitions,
		execution: result.report,
		reportSha256: result.reportSha256,
		reviewStatus: "NOT_RUN" as const,
	};
}

function hash(value: Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}
