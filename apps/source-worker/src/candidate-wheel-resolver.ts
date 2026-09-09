import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseAdapterCandidateSource } from "@choicemind/source-research/adapter-candidate";
import { executeCandidateSandbox } from "./candidate-sandbox.js";
import {
	decodeCandidateWheelOutput,
	type installCandidateWheels,
} from "./candidate-wheel-install.js";

export async function resolveCandidateWheelSet(input: {
	bundle: Uint8Array;
	sha256: string;
	requirements: readonly string[];
	signal?: AbortSignal;
}) {
	if (
		!(input.bundle instanceof Uint8Array) ||
		input.bundle.length === 0 ||
		input.bundle.length > 64 * 1024 * 1024 ||
		!Array.isArray(input.requirements) ||
		input.requirements.length === 0 ||
		input.requirements.length > 1000 ||
		input.requirements.some(
			(value) => typeof value !== "string" || value.length > 1000,
		)
	)
		throw new Error("CANDIDATE_RESOLUTION_INPUT_INVALID");
	const bundle = Buffer.from(input.bundle);
	if (hash(bundle) !== input.sha256) throw new Error("CANDIDATE_HASH_MISMATCH");
	const roots = Buffer.from(JSON.stringify(input.requirements), "utf8");
	if (
		roots.length > 1024 * 1024 ||
		4 + roots.length + bundle.length > 64 * 1024 * 1024
	)
		throw new Error("CANDIDATE_RESOLUTION_INPUT_INVALID");
	const scripts = await Promise.all(
		["inspect_archive.py", "resolve_wheels.py"].map((name) =>
			readFile(
				new URL(`../../../scripts/adapter-candidate/${name}`, import.meta.url),
				"utf8",
			),
		),
	);
	const code = Buffer.from(
		`${scripts.join("\n")}\ntry:\n n=int.from_bytes(sys.stdin.buffer.read(4),'big')\n roots=json.loads(sys.stdin.buffer.read(n))\n summary,selected=resolve_wheels(sys.stdin.buffer.read(MAX_ARCHIVE_BYTES+1),${JSON.stringify(hash(bundle))},roots,inspect_archive,MAX_EXPANDED_BYTES)\n summary=json.dumps(summary).encode('utf-8')\n sys.stdout.buffer.write(len(summary).to_bytes(4,'big')+summary+selected)\nexcept Exception:\n sys.exit(2)\n`,
		"utf8",
	);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(roots.length);
	const result = await executeCandidateSandbox({
		artifact: code,
		artifactSha256: hash(code),
		runtime: "PYTHON_BUILD",
		stdin: Buffer.concat([length, roots, bundle]),
		...(input.signal ? { signal: input.signal } : {}),
	});
	input.signal?.throwIfAborted();
	if (result.report.outcome !== "EXITED" || result.report.exitCode !== 0)
		throw new Error("CANDIDATE_RESOLUTION_FAILED");
	let output: {
		locked: Parameters<typeof installCandidateWheels>[0]["locked"];
		pipVersion: string;
		reviewStatus: "NOT_RUN";
	};
	let selected: Uint8Array;
	try {
		const decoded = decodeCandidateWheelOutput(result.untrustedStdout, true);
		output = decoded.summary as typeof output;
		if (!decoded.builtArtifact) throw new Error("INVALID");
		selected = decoded.builtArtifact.bytes;
		if (
			!output ||
			!Array.isArray(output.locked) ||
			output.locked.length === 0 ||
			output.locked.length > 1000 ||
			output.reviewStatus !== "NOT_RUN" ||
			typeof output.pipVersion !== "string"
		)
			throw new Error("INVALID");
		const names = new Set<string>();
		for (const item of output.locked) {
			if (
				!item ||
				typeof item.filename !== "string" ||
				!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,239}\.whl$/.test(item.filename)
			)
				throw new Error("INVALID");
			const source = parseAdapterCandidateSource({
				kind: "PYPI",
				packageName: item.name,
				version: item.version,
				artifactSha256: item.sha256,
			});
			if (source.kind !== "PYPI" || names.has(source.packageName))
				throw new Error("INVALID");
			names.add(source.packageName);
		}
		if (
			8 +
				Buffer.byteLength(JSON.stringify(output.locked), "utf8") +
				selected.length >
			64 * 1024 * 1024
		)
			throw new Error("INVALID");
	} catch {
		throw new Error("CANDIDATE_RESOLUTION_RESPONSE_INVALID");
	}
	return {
		...output,
		bundle: selected,
		sha256: hash(selected),
		catalogueSha256: hash(bundle),
		requirementsSha256: hash(roots),
		execution: result.report,
		reportSha256: result.reportSha256,
	};
}

function hash(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}
