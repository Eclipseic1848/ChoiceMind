import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { startCandidateSupervisor } from "./candidate-sandbox-guard.js";

const RUNTIMES = {
	NODE: {
		image:
			"node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d",
		policy: "local-node-sandbox.v1",
		outputLimit: 65_536,
		command: ["node", "--input-type=module"],
	},
	PYTHON: {
		image:
			"python@sha256:9d7f287598e1a5a978c015ee176d8216435aaf335ed69ac3c38dd1bbb10e8d64",
		policy: "local-python-sandbox.v1",
		// 10000 个最长路径条目及 JSON 转义仍有界；普通 Node 日志额度不变。
		outputLimit: 32 * 1024 * 1024,
		command: [
			"python",
			"-I",
			"-c",
			"import sys; n=int.from_bytes(sys.stdin.buffer.read(4),'big'); code=sys.stdin.buffer.read(n); exec(compile(code,'<candidate>','exec'))",
		],
	},
} as const;
const SLOT = "choicemind-adapter-candidate-slot";
const LIMIT = 65_536;
const OWNER_LABEL = "choicemind.candidate.owner";
const DEADLINE_LABEL = "choicemind.candidate.deadline";
const POLICY_LABEL = "choicemind.candidate.policy";

type Outcome = "EXITED" | "TIMED_OUT" | "CANCELLED" | "OUTPUT_LIMIT";

// 仅执行已物化的有界制品；不是下载器、审查器或正式 Adapter 加载器。
export async function executeCandidateSandbox(input: {
	artifact: Uint8Array;
	artifactSha256: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	runtime?: keyof typeof RUNTIMES;
	stdin?: Uint8Array;
}) {
	const timeoutMs = input.timeoutMs ?? 600_000;
	const runtimeName = input.runtime ?? "NODE";
	if (
		!(input.artifact instanceof Uint8Array) ||
		input.artifact.byteLength === 0 ||
		input.artifact.byteLength > LIMIT ||
		!/^[a-f0-9]{64}$/.test(input.artifactSha256) ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 100 ||
		timeoutMs > 600_000 ||
		!Object.hasOwn(RUNTIMES, runtimeName) ||
		(input.stdin !== undefined &&
			(runtimeName !== "PYTHON" ||
				!(input.stdin instanceof Uint8Array) ||
				input.stdin.byteLength > 64 * 1024 * 1024))
	) {
		throw new Error("CANDIDATE_INPUT_INVALID");
	}
	// 先复制再校验，调用方修改原缓冲区不能改变实际执行内容。
	const artifact = Buffer.from(input.artifact);
	const data =
		input.stdin === undefined ? Buffer.alloc(0) : Buffer.from(input.stdin);
	const runtime = RUNTIMES[runtimeName];
	let stdin = artifact;
	if (runtimeName === "PYTHON") {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(artifact.byteLength);
		stdin = Buffer.concat([length, artifact, data]);
	}
	if (digest(artifact) !== input.artifactSha256)
		throw new Error("CANDIDATE_HASH_MISMATCH");
	if (input.signal?.aborted) throw new Error("CANDIDATE_CANCELLED");
	if ((await recoverCandidateSandbox()) === "ACTIVE")
		throw new Error("CANDIDATE_SLOT_BUSY");
	await docker(["image", "inspect", runtime.image, "--format", "{{.Id}}"]);
	const owner = randomUUID();
	const deadline = Date.now() + timeoutMs;
	let containerId: string | undefined;
	let supervisor:
		| Awaited<ReturnType<typeof startCandidateSupervisor>>
		| undefined;
	try {
		// 固定槽位让 Docker 原子拒绝跨进程并发；已有槽位绝不抢占或删除。
		const created = await docker([
			"create",
			"--name",
			SLOT,
			"--label",
			`${OWNER_LABEL}=${owner}`,
			"--label",
			`${DEADLINE_LABEL}=${deadline}`,
			"--label",
			`${POLICY_LABEL}=${runtime.policy}`,
			"--label",
			`choicemind.candidate.artifact=${input.artifactSha256}`,
			"--pull",
			"never",
			"--interactive",
			"--network",
			"none",
			"--read-only",
			"--user",
			"65534:65534",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges=true",
			"--cpus",
			"2",
			"--memory",
			"2g",
			"--memory-swap",
			"2g",
			"--pids-limit",
			"64",
			"--tmpfs",
			"/work:rw,nosuid,nodev,size=536870912,mode=1777",
			"--workdir",
			"/work",
			"--log-driver",
			"none",
			runtime.image,
			...runtime.command,
		]);
		const id = created.stdout.toString("utf8").trim();
		if (!/^[a-f0-9]{64}$/.test(id))
			throw new Error("CANDIDATE_CREATE_UNCONFIRMED");
		containerId = id;
		const inspection = JSON.parse(
			(await docker(["inspect", id])).stdout.toString("utf8"),
		)[0];
		const host = inspection.HostConfig;
		if (
			inspection.Config.Image !== runtime.image ||
			inspection.Config.User !== "65534:65534" ||
			!inspection.Config.OpenStdin ||
			host.NetworkMode !== "none" ||
			!host.ReadonlyRootfs ||
			host.Privileged ||
			inspection.Mounts.length !== 0 ||
			host.Memory !== 2147483648 ||
			host.MemorySwap !== 2147483648 ||
			host.NanoCpus !== 2000000000 ||
			host.PidsLimit !== 64 ||
			!host.CapDrop.includes("ALL") ||
			!host.SecurityOpt.includes("no-new-privileges=true") ||
			host.Tmpfs["/work"] !== "rw,nosuid,nodev,size=536870912,mode=1777" ||
			host.LogConfig.Type !== "none"
		)
			throw new Error("CANDIDATE_POLICY_MISMATCH");
		if (input.signal?.aborted) throw new Error("CANDIDATE_CANCELLED");
		supervisor = await startCandidateSupervisor(id, deadline);
		if (supervisor.signal.aborted)
			throw new Error("CANDIDATE_SUPERVISION_LOST");
		if (input.signal?.aborted) throw new Error("CANDIDATE_CANCELLED");
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw new Error("CANDIDATE_DEADLINE_EXPIRED");
		const execution = await command(
			["start", "--attach", "--interactive", id],
			{
				stdin,
				timeoutMs: remainingMs,
				maxOutputBytes: runtime.outputLimit,
				signal: AbortSignal.any([
					supervisor.signal,
					...(input.signal === undefined ? [] : [input.signal]),
				]),
			},
		);
		if (supervisor.signal.aborted && Date.now() < deadline)
			throw new Error("CANDIDATE_SUPERVISION_LOST");
		let exitCode: number | null = null;
		if (execution.outcome === "EXITED") {
			const state = JSON.parse(
				(
					await docker(["inspect", id, "--format", "{{json .State}}"])
				).stdout.toString("utf8"),
			);
			if (
				state.Running ||
				!Number.isInteger(state.ExitCode) ||
				execution.code !== state.ExitCode
			) {
				throw new Error("CANDIDATE_EXIT_UNCONFIRMED");
			}
			exitCode = state.ExitCode;
		}
		const report = {
			schemaVersion: "candidate-execution.v1",
			policyVersion: runtime.policy,
			artifactSha256: digest(artifact),
			image: runtime.image,
			...(runtimeName === "PYTHON" ? { inputSha256: digest(data) } : {}),
			outcome: execution.outcome,
			exitCode,
			stdoutSha256: digest(execution.stdout),
			stderrSha256: digest(execution.stderr),
			outputBytes: execution.bytes,
			outputLimitBytes: runtime.outputLimit,
			timeoutMs,
			// 正常退出只说明进程执行完毕，绝不根据候选输出晋升。
			reviewStatus: "NOT_RUN" as const,
		};
		return {
			report,
			reportSha256: digest(Buffer.from(JSON.stringify(report), "utf8")),
			untrustedStdout: execution.stdout,
		};
	} finally {
		try {
			// create 的应答丢失也按本次 owner 查回，绝不按名称删除竞争者。
			if (containerId === undefined) {
				const slot = await inspectSlot();
				if (slot?.Config.Labels?.[OWNER_LABEL] === owner) containerId = slot.Id;
			}
			if (containerId !== undefined) {
				await removeContainer(containerId);
			}
			supervisor?.stop();
		} catch {
			// biome-ignore lint/correctness/noUnsafeFinally: 回收未确认必须覆盖成功结果，不能把残留容器报告为成功。
			throw new Error("CANDIDATE_CLEANUP_UNCONFIRMED");
		}
	}
}

// 启动/恢复入口可重复调用；超时回收不等于候选成功，也不续用遗留输出。
export async function recoverCandidateSandbox(
	expectedContainerId?: string,
): Promise<"EMPTY" | "ACTIVE" | "RECOVERED"> {
	if (
		expectedContainerId !== undefined &&
		!/^[a-f0-9]{64}$/.test(expectedContainerId)
	)
		throw new Error("CANDIDATE_INPUT_INVALID");
	const endpoint = await docker([
		"context",
		"inspect",
		"desktop-linux",
		"--format",
		"{{.Endpoints.docker.Host}}",
	]);
	if (
		endpoint.stdout.toString("utf8").trim() !==
		"npipe:////./pipe/dockerDesktopLinuxEngine"
	) {
		throw new Error("CANDIDATE_LOCAL_DOCKER_REQUIRED");
	}
	const slot = await inspectSlot();
	if (slot === undefined) return "EMPTY";
	if (expectedContainerId !== undefined && slot.Id !== expectedContainerId)
		return "EMPTY";
	const labels = slot.Config.Labels;
	const deadline = Number(labels?.[DEADLINE_LABEL]);
	const createdAt = Date.parse(slot.Created);
	if (
		slot.Name !== `/${SLOT}` ||
		!Object.values(RUNTIMES).some(
			(runtime) =>
				slot.Config.Image === runtime.image &&
				labels?.[POLICY_LABEL] === runtime.policy,
		) ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
			labels?.[OWNER_LABEL] ?? "",
		) ||
		!/^[a-f0-9]{64}$/.test(labels?.["choicemind.candidate.artifact"] ?? "") ||
		!Number.isSafeInteger(deadline) ||
		!Number.isFinite(createdAt) ||
		// 创建可能排队到预算耗尽；截止时间早于 Created 的自有槽位仍须回收。
		deadline <= 0 ||
		deadline - createdAt > 600_000 ||
		slot.Mounts.length !== 0
	)
		throw new Error("CANDIDATE_SLOT_OWNERSHIP_UNCONFIRMED");
	if (Date.now() < deadline) return "ACTIVE";
	await removeContainer(slot.Id);
	return "RECOVERED";
}

async function inspectSlot() {
	const list = await docker([
		"ps",
		"--all",
		"--no-trunc",
		"--filter",
		`name=^/${SLOT}$`,
		"--format",
		"{{.ID}}",
	]);
	const id = list.stdout.toString("utf8").trim();
	if (id === "") return undefined;
	if (!/^[a-f0-9]{64}$/.test(id))
		throw new Error("CANDIDATE_SLOT_OWNERSHIP_UNCONFIRMED");
	let inspection: Awaited<ReturnType<typeof docker>>;
	try {
		inspection = await docker(["inspect", id]);
	} catch (error) {
		if (await containerExists(id)) throw error;
		return undefined;
	}
	const slot = JSON.parse(inspection.stdout.toString("utf8"))[0];
	if (slot?.Id !== id) throw new Error("CANDIDATE_SLOT_OWNERSHIP_UNCONFIRMED");
	return slot;
}

async function containerExists(id: string) {
	const result = await docker([
		"ps",
		"--all",
		"--no-trunc",
		"--filter",
		`id=${id}`,
		"--format",
		"{{.ID}}",
	]);
	const found = result.stdout.toString("utf8").trim();
	if (found !== "" && found !== id)
		throw new Error("CANDIDATE_SLOT_OWNERSHIP_UNCONFIRMED");
	return found === id;
}

async function removeContainer(id: string) {
	try {
		await docker(["rm", "--force", id]);
	} catch (error) {
		// 监督者与执行者可并发回收；只认原 ID 已消失，不按槽位名称重删。
		if (await containerExists(id)) throw error;
	}
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function docker(args: string[]) {
	const result = await command(args, { timeoutMs: 30_000 });
	if (result.outcome !== "EXITED" || result.code !== 0)
		throw new Error("CANDIDATE_DOCKER_FAILED");
	return result;
}

function command(
	args: string[],
	options: {
		stdin?: Buffer;
		timeoutMs: number;
		signal?: AbortSignal;
		maxOutputBytes?: number;
	},
) {
	return new Promise<{
		outcome: Outcome;
		code: number | null;
		stdout: Buffer;
		stderr: Buffer;
		bytes: number;
	}>((resolve, reject) => {
		const child = spawn("docker", ["--context", "desktop-linux", ...args], {
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let outcome: Outcome = "EXITED";
		let bytes = 0;
		const stdout: Buffer[] = [];
		const outputLimit = options.maxOutputBytes ?? LIMIT;
		const stderr: Buffer[] = [];
		const stop = (reason: Outcome) => {
			if (outcome !== "EXITED") return;
			outcome = reason;
			child.kill("SIGKILL");
		};
		const cancel = () => stop("CANCELLED");
		const timer = setTimeout(() => stop("TIMED_OUT"), options.timeoutMs);
		options.signal?.addEventListener("abort", cancel, { once: true });
		const collect = (target: Buffer[], chunk: Buffer) => {
			const remaining = Math.max(0, outputLimit - bytes);
			bytes += chunk.length;
			if (remaining > 0) target.push(chunk.subarray(0, remaining));
			if (bytes > outputLimit) stop("OUTPUT_LIMIT");
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.stdin.on("error", () => {
			/* 提前退出时 EPIPE 由容器退出状态判定。 */
		});
		child.once("error", () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			reject(new Error("CANDIDATE_DOCKER_LAUNCH_FAILED"));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			resolve({
				outcome,
				code,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				bytes,
			});
		});
		child.stdin.end(options.stdin);
		if (options.signal?.aborted) cancel();
	});
}
