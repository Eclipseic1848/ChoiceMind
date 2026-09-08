import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { recoverCandidateSandbox } from "./candidate-sandbox.js";

// 独立于候选执行控制器运行；复用身份、截止时间和精确 ID 回收边界。
export async function superviseCandidateSandbox(signal: AbortSignal) {
	while (!signal.aborted) {
		await recoverCandidateSandbox();
		try {
			await delay(1000, undefined, { signal });
		} catch (error) {
			if (!signal.aborted) throw error;
		}
	}
}

if (
	process.argv[1] !== undefined &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	const stop = new AbortController();
	process.once("SIGINT", () => stop.abort());
	process.once("SIGTERM", () => stop.abort());
	try {
		await superviseCandidateSandbox(stop.signal);
	} catch {
		// 不输出 Docker 原始错误、环境或候选内容；异常交给进程管理器处理。
		process.stderr.write("CANDIDATE_SUPERVISION_FAILED\n");
		process.exitCode = 1;
	}
}
