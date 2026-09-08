import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseAdapterCandidateSource } from "@choicemind/source-research/adapter-candidate";
import { readPypiProjectMetadata } from "./candidate-acquisition.js";
import { executeCandidateSandbox } from "./candidate-sandbox.js";

export async function discoverPypiWheelCandidates(input: {
	packageName: string;
	specifier: string;
	signal?: AbortSignal;
}) {
	if (typeof input.specifier !== "string" || input.specifier.length > 1000)
		throw new Error("CANDIDATE_INDEX_INPUT_INVALID");
	const { signal, specifier } = input;
	const metadata = await readPypiProjectMetadata(input.packageName, signal);
	const header = Buffer.from(
		JSON.stringify({
			name: metadata.packageName,
			specifier,
			sha256: metadata.sha256,
		}),
		"utf8",
	);
	if (header.length > 4096) throw new Error("CANDIDATE_INDEX_INPUT_INVALID");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(header.length);
	const code = await readFile(
		new URL(
			"../../../scripts/adapter-candidate/select_pypi_wheels.py",
			import.meta.url,
		),
	);
	const result = await executeCandidateSandbox({
		artifact: code,
		artifactSha256: createHash("sha256").update(code).digest("hex"),
		runtime: "PYTHON",
		stdin: Buffer.concat([length, header, metadata.bytes]),
		...(signal ? { signal } : {}),
	});
	signal?.throwIfAborted();
	if (result.report.outcome !== "EXITED" || result.report.exitCode !== 0)
		throw new Error("CANDIDATE_INDEX_SELECTION_FAILED");
	try {
		const output = JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(result.untrustedStdout),
		);
		if (
			!output ||
			!Array.isArray(output.candidates) ||
			output.candidates.length > 1000 ||
			output.reviewStatus !== "NOT_RUN" ||
			typeof output.pythonVersion !== "string" ||
			typeof output.platform !== "string"
		)
			throw new Error("INVALID");
		const candidates = output.candidates.map(
			(item: {
				filename: string;
				name: string;
				version: string;
				sha256: string;
			}) => {
				if (
					!item ||
					item.name !== metadata.packageName ||
					typeof item.filename !== "string" ||
					!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,239}\.whl$/.test(item.filename)
				)
					throw new Error("INVALID");
				return {
					filename: item.filename,
					source: parseAdapterCandidateSource({
						kind: "PYPI",
						packageName: item.name,
						version: item.version,
						artifactSha256: item.sha256,
					}),
				};
			},
		);
		return {
			candidates,
			metadataSha256: metadata.sha256,
			specifier,
			pythonVersion: output.pythonVersion as string,
			platform: output.platform as string,
			execution: result.report,
			reportSha256: result.reportSha256,
			reviewStatus: "NOT_RUN" as const,
		};
	} catch {
		throw new Error("CANDIDATE_INDEX_RESPONSE_INVALID");
	}
}
