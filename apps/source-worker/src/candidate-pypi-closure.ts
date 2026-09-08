import {
	acquireCandidateArtifact,
	PypiProjectNotFound,
} from "./candidate-acquisition.js";
import { discoverPypiWheelCandidates } from "./candidate-pypi-index.js";
import { packCandidateWheels } from "./candidate-wheel-acquisition.js";
import {
	parseWheelRequirement,
	readCandidateWheelDependencies,
	type WheelRequirement,
} from "./candidate-wheel-dependencies.js";
import { resolveCandidateWheelSet } from "./candidate-wheel-resolver.js";

// 收集可行版本分支的并集，由固定 pip 求解最终交集；不以“只选最新版”替代回溯。
export async function resolvePublicPypiClosure(
	input: readonly WheelRequirement[],
	signal?: AbortSignal,
) {
	if (!Array.isArray(input) || input.length === 0 || input.length > 1000)
		throw new Error("CANDIDATE_ROOTS_INVALID");
	const roots = input.map(parseWheelRequirement);
	const queue = [...roots];
	const visited = new Set<string>();
	const inspected = new Set<string>();
	const files = new Map<
		string,
		Awaited<ReturnType<typeof acquireCandidateArtifact>> & { filename: string }
	>();
	const indexes: {
		packageName: string;
		specifier: string;
		metadataSha256: string;
		reportSha256: string;
	}[] = [];
	const dependencyReports: string[] = [];
	const missingProjects = new Set<string>();
	const timeout = AbortSignal.timeout(600_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let totalBytes = 0;
	while (queue.length > 0) {
		combined.throwIfAborted();
		const requirement = queue.shift();
		if (!requirement) break;
		const key = JSON.stringify(requirement);
		if (visited.has(key)) continue;
		if (visited.size >= 1000)
			throw new Error("CANDIDATE_DEPENDENCY_GRAPH_LIMIT");
		visited.add(key);
		let index: Awaited<ReturnType<typeof discoverPypiWheelCandidates>>;
		try {
			index = await discoverPypiWheelCandidates({
				packageName: requirement.packageName,
				specifier: requirement.specifier,
				signal: combined,
			});
		} catch (error) {
			combined.throwIfAborted();
			if (!(error instanceof PypiProjectNotFound)) throw error;
			missingProjects.add(requirement.packageName);
			continue;
		}
		indexes.push({
			packageName: requirement.packageName,
			specifier: requirement.specifier,
			metadataSha256: index.metadataSha256,
			reportSha256: index.reportSha256,
		});
		for (const candidate of index.candidates) {
			let file = files.get(candidate.filename);
			if (
				file &&
				file.receipt.artifactSha256 !== candidate.source.artifactSha256
			)
				throw new Error("CANDIDATE_INDEX_DRIFT");
			if (!file) {
				if (files.size >= 1000)
					throw new Error("CANDIDATE_DEPENDENCY_GRAPH_LIMIT");
				const acquired = await acquireCandidateArtifact(
					candidate.source,
					combined,
				);
				if (acquired.receipt.filename !== candidate.filename)
					throw new Error("CANDIDATE_WHEEL_FILENAME_MISMATCH");
				totalBytes += acquired.artifact.length;
				if (totalBytes > 64 * 1024 * 1024)
					throw new Error("CANDIDATE_DEPENDENCY_GRAPH_LIMIT");
				file = { ...acquired, filename: candidate.filename };
				files.set(candidate.filename, file);
			}
			const inspectionKey = `${file.receipt.artifactSha256}:${JSON.stringify(requirement.extras)}`;
			if (inspected.has(inspectionKey)) continue;
			inspected.add(inspectionKey);
			const metadata = await readCandidateWheelDependencies({
				source: file.receipt.source,
				artifact: file.artifact,
				extras: requirement.extras,
				signal: combined,
			});
			dependencyReports.push(metadata.reportSha256);
			for (const dependency of metadata.dependencies) {
				if (!visited.has(JSON.stringify(dependency))) queue.push(dependency);
			}
			if (queue.length > 10000)
				throw new Error("CANDIDATE_DEPENDENCY_GRAPH_LIMIT");
		}
	}
	const catalogue = await packCandidateWheels(
		[...files.values()].map((file) => ({
			filename: file.filename,
			bytes: file.artifact,
			sha256: file.receipt.artifactSha256,
		})),
		combined,
	);
	const resolution = await resolveCandidateWheelSet({
		bundle: catalogue.bundle,
		sha256: catalogue.sha256,
		requirements: roots.map(
			(root) =>
				`${root.packageName}${root.extras.length ? `[${root.extras.join(",")}]` : ""}${root.specifier}`,
		),
		signal: combined,
	});
	return {
		...resolution,
		indexes,
		missingProjects: [...missingProjects].sort(),
		dependencyReports,
		catalogueReportSha256: catalogue.reportSha256,
		acquisitions: [...files.values()].map((file) => file.receipt),
	};
}
