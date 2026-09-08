import { createHash } from "node:crypto";
import type { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import type { SourceAdapter } from "./worker.js";

// 工厂由受信任注册器提供，必须只加载传入制品；这里不接受路径或任意模块名。
export async function loadApprovedCandidateAdapter(input: {
	candidateId: string;
	reviewBindingSha256: string;
	artifact: Uint8Array;
	approvals: Pick<
		Awaited<ReturnType<typeof openPostgresCandidateStore>>,
		"readApproved"
	>;
	load: (artifact: Uint8Array) => Promise<SourceAdapter>;
}): Promise<SourceAdapter> {
	if (
		!(input.artifact instanceof Uint8Array) ||
		input.artifact.byteLength === 0 ||
		input.artifact.byteLength > 64 * 1024 * 1024
	)
		throw new Error("ADAPTER_CANDIDATE_ARTIFACT_INVALID");
	const artifact = Buffer.from(input.artifact);
	const sha256 = createHash("sha256").update(artifact).digest("hex");
	const { candidateId, reviewBindingSha256, approvals, load } = input;
	async function check() {
		if (
			(await approvals.readApproved(
				candidateId,
				reviewBindingSha256,
				sha256,
			)) === undefined
		)
			throw new Error("ADAPTER_CANDIDATE_NOT_APPROVED");
	}
	await check();
	const adapter = await load(artifact);
	await check();
	if (
		adapter === null ||
		typeof adapter !== "object" ||
		typeof adapter.run !== "function" ||
		(adapter.accessMode !== "PUBLIC" && adapter.accessMode !== "CREDENTIAL") ||
		(adapter.accessMode === "CREDENTIAL" &&
			typeof adapter.officialLoginUrl !== "string")
	)
		throw new Error("ADAPTER_CANDIDATE_DRIVER_INVALID");
	if (adapter.accessMode === "PUBLIC")
		return {
			accessMode: "PUBLIC",
			async run(job) {
				await check();
				return adapter.run(job);
			},
		};
	return {
		accessMode: "CREDENTIAL",
		officialLoginUrl: adapter.officialLoginUrl,
		async run(job) {
			await check();
			return adapter.run(job);
		},
	};
}
