import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseAdapterCandidateSource } from "@choicemind/source-research/adapter-candidate";
import { executeCandidateSandbox } from "./candidate-sandbox.js";

export type WheelRequirement = {
	packageName: string;
	specifier: string;
	extras: string[];
};

export function parseWheelRequirement(input: unknown): WheelRequirement {
	if (
		typeof input !== "object" ||
		input === null ||
		!("packageName" in input) ||
		!("specifier" in input) ||
		!("extras" in input) ||
		typeof input.specifier !== "string" ||
		input.specifier.length > 1000 ||
		!Array.isArray(input.extras) ||
		input.extras.length > 100 ||
		input.extras.some(
			(value) =>
				typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value),
		)
	)
		throw new Error("CANDIDATE_REQUIREMENT_INVALID");
	const source = parseAdapterCandidateSource({
		kind: "PYPI",
		packageName: input.packageName,
		version: "0",
		artifactSha256: "0".repeat(64),
	});
	if (source.kind !== "PYPI") throw new Error("CANDIDATE_REQUIREMENT_INVALID");
	return {
		packageName: source.packageName,
		specifier: input.specifier,
		extras: [...new Set(input.extras as string[])].sort(),
	};
}

export async function readCandidateWheelDependencies(input: {
	source: unknown;
	artifact: Uint8Array;
	extras: string[];
	signal?: AbortSignal;
}) {
	const source = parseAdapterCandidateSource(input.source);
	if (
		source.kind !== "PYPI" ||
		!(input.artifact instanceof Uint8Array) ||
		input.artifact.length === 0 ||
		input.artifact.length > 64 * 1024 * 1024
	)
		throw new Error("CANDIDATE_METADATA_INPUT_INVALID");
	const extras = parseWheelRequirement({
		packageName: source.packageName,
		specifier: "",
		extras: input.extras,
	}).extras;
	const artifact = Buffer.from(input.artifact);
	if (
		createHash("sha256").update(artifact).digest("hex") !==
		source.artifactSha256
	)
		throw new Error("CANDIDATE_HASH_MISMATCH");
	const header = Buffer.from(
		JSON.stringify({
			name: source.packageName,
			version: source.version,
			sha256: source.artifactSha256,
			extras,
		}),
		"utf8",
	);
	if (4 + header.length + artifact.length > 64 * 1024 * 1024)
		throw new Error("CANDIDATE_METADATA_INPUT_INVALID");
	const scripts = await Promise.all(
		["inspect_archive.py", "read_wheel_dependencies.py"].map((name) =>
			readFile(
				new URL(`../../../scripts/adapter-candidate/${name}`, import.meta.url),
				"utf8",
			),
		),
	);
	const code = Buffer.from(
		`${scripts.join("\n")}\nimport json,sys\ntry:\n n=int.from_bytes(sys.stdin.buffer.read(4),'big')\n header=json.loads(sys.stdin.buffer.read(n))\n print(json.dumps(read_dependencies(sys.stdin.buffer.read(MAX_ARCHIVE_BYTES+1),header,inspect_archive)))\nexcept Exception:\n sys.exit(2)\n`,
		"utf8",
	);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(header.length);
	const result = await executeCandidateSandbox({
		artifact: code,
		artifactSha256: createHash("sha256").update(code).digest("hex"),
		runtime: "PYTHON",
		stdin: Buffer.concat([length, header, artifact]),
		...(input.signal ? { signal: input.signal } : {}),
	});
	input.signal?.throwIfAborted();
	if (result.report.outcome !== "EXITED" || result.report.exitCode !== 0)
		throw new Error("CANDIDATE_METADATA_REJECTED");
	try {
		const output = JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(result.untrustedStdout),
		);
		if (!Array.isArray(output) || output.length > 1000)
			throw new Error("INVALID");
		return {
			dependencies: output.map(parseWheelRequirement),
			execution: result.report,
			reportSha256: result.reportSha256,
		};
	} catch {
		throw new Error("CANDIDATE_METADATA_RESPONSE_INVALID");
	}
}
