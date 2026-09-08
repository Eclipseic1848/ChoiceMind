import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 只有受信任监督进程完成实际 Docker 检查，才允许执行者启动候选。
export function startCandidateSupervisor(
	containerId: string,
	deadline: number,
) {
	const signal = new AbortController();
	const sourceMode = import.meta.url.endsWith(".ts");
	const child = spawn(
		process.execPath,
		[
			...(sourceMode ? ["--import", "tsx"] : []),
			fileURLToPath(
				new URL(
					`./candidate-sandbox-supervisor.${sourceMode ? "ts" : "js"}`,
					import.meta.url,
				),
			),
			containerId,
		],
		{
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		},
	);
	return new Promise<{ signal: AbortSignal; stop: () => void }>(
		(resolve, reject) => {
			let ready = false;
			let stopped = false;
			const fail = () => {
				if (stopped) return;
				signal.abort();
				if (!ready) {
					stop();
					reject(new Error("CANDIDATE_SUPERVISION_UNAVAILABLE"));
				}
			};
			let timer = setTimeout(
				fail,
				Math.max(1, Math.min(30_000, deadline - Date.now())),
			);
			function stop() {
				stopped = true;
				clearTimeout(timer);
				child.kill("SIGKILL");
			}
			child.on("message", (message) => {
				if (
					stopped ||
					signal.signal.aborted ||
					typeof message !== "object" ||
					message === null ||
					!("containerId" in message) ||
					message.containerId !== containerId ||
					!("type" in message) ||
					message.type !== "HEALTHY"
				)
					return;
				clearTimeout(timer);
				timer = setTimeout(fail, 5000);
				if (!ready) {
					ready = true;
					// 控制器退出不带走监督者；监督者仅监控本容器，回收后自行退出。
					child.unref();
					child.channel?.unref();
					resolve({ signal: signal.signal, stop });
				}
			});
			child.once("error", fail);
			child.once("exit", fail);
		},
	);
}
