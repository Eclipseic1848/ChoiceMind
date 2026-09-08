import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { executeCandidateSandbox } from "./candidate-sandbox.js";
import type { installCandidateWheels } from "./candidate-wheel-install.js";
import type { PublicSourceAdapter } from "./worker.js";

// 工厂供受信任注册器及同一套验收调用；正式使用还必须经过批准加载器。
export function createPythonCandidateSourceAdapter(input: {
	bundle: Uint8Array;
	bundleSha256: string;
	artifactSha256: string;
	locked: Parameters<typeof installCandidateWheels>[0]["locked"];
	sourceId: string;
	// 复用具体来源的可信映射层；候选不能自行声明 Evidence ID、权限或费用。
	mapResult(
		result: unknown,
		context: Parameters<PublicSourceAdapter["run"]>[0],
	): ReturnType<PublicSourceAdapter["run"]>;
}): PublicSourceAdapter {
	if (
		!(input.bundle instanceof Uint8Array) ||
		input.bundle.length === 0 ||
		input.bundle.length > 64 * 1024 * 1024 ||
		!Array.isArray(input.locked) ||
		input.locked.length === 0 ||
		input.locked.length > 1000 ||
		!/^[a-f0-9]{64}$/.test(input.artifactSha256) ||
		typeof input.sourceId !== "string" ||
		input.sourceId.length === 0 ||
		typeof input.mapResult !== "function"
	)
		throw new Error("CANDIDATE_PYTHON_ADAPTER_INVALID");
	const bundle = Buffer.from(input.bundle);
	const { bundleSha256, artifactSha256, sourceId, mapResult } = input;
	if (hash(bundle) !== bundleSha256) throw new Error("CANDIDATE_HASH_MISMATCH");
	const locked = JSON.stringify(input.locked);
	if (Buffer.byteLength(locked, "utf8") > 1024 * 1024)
		throw new Error("CANDIDATE_PYTHON_ADAPTER_INVALID");
	return {
		accessMode: "PUBLIC",
		async run(context) {
			const { signal, claim } = context;
			signal.throwIfAborted();
			if (claim.accessMode !== "PUBLIC" || claim.sourceId !== sourceId)
				throw new Error("CANDIDATE_PYTHON_SOURCE_MISMATCH");
			// 只传研究内容，不传用户/会话/任务身份、回调、凭据或宿主环境。
			const request = JSON.stringify({
				query: claim.query,
				researchTarget: claim.researchTarget,
				checkpoint: claim.checkpoint,
			});
			if (Buffer.byteLength(request, "utf8") > 65_536)
				throw new Error("CANDIDATE_PYTHON_REQUEST_INVALID");
			const header = Buffer.from(
				`{"locked":${locked},"request":${request}}`,
				"utf8",
			);
			if (4 + header.length + bundle.length > 64 * 1024 * 1024)
				throw new Error("CANDIDATE_PYTHON_REQUEST_INVALID");
			const length = Buffer.alloc(4);
			length.writeUInt32BE(header.length);
			const scripts = await Promise.all(
				[
					"inspect_archive.py",
					"install_wheels.py",
					"invoke_python_candidate.py",
				].map((name) =>
					readFile(
						new URL(
							`../../../scripts/adapter-candidate/${name}`,
							import.meta.url,
						),
						"utf8",
					),
				),
			);
			const code = Buffer.from(
				`${scripts.join("\n")}\ntry:\n    n=int.from_bytes(sys.stdin.buffer.read(4),'big')\n    header=json.loads(sys.stdin.buffer.read(n))\n    bundle=sys.stdin.buffer.read(MAX_ARCHIVE_BYTES+1)\n    install_wheels(bundle,${JSON.stringify(bundleSha256)},header['locked'],inspect_archive,MAX_EXPANDED_BYTES)\n    invoke_python_candidate(bundle,header['locked'],${JSON.stringify(artifactSha256)},header['request'])\nexcept Exception:\n    sys.exit(2)\n`,
				"utf8",
			);
			const execution = await executeCandidateSandbox({
				artifact: code,
				artifactSha256: hash(code),
				runtime: "PYTHON_INVOKE",
				stdin: Buffer.concat([length, header, bundle]),
				signal,
			});
			signal.throwIfAborted();
			if (
				execution.report.outcome !== "EXITED" ||
				execution.report.exitCode !== 0
			)
				throw new Error("CANDIDATE_PYTHON_CALL_FAILED");
			let output: unknown;
			try {
				output = JSON.parse(
					new TextDecoder("utf8", { fatal: true }).decode(
						execution.untrustedStdout,
					),
				);
			} catch {
				// 解析异常可能含候选原文，不能进入业务错误或日志。
				throw new Error("CANDIDATE_PYTHON_RESPONSE_INVALID");
			}
			if (
				typeof output !== "object" ||
				output === null ||
				Object.keys(output).sort().join(",") !== "result,schemaVersion" ||
				!("schemaVersion" in output) ||
				output.schemaVersion !== "choicemind-python-source.v1" ||
				!("result" in output)
			)
				throw new Error("CANDIDATE_PYTHON_RESPONSE_INVALID");
			return mapResult(output.result, context);
		},
	};
}

function hash(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}
