import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
	executeCandidateSandbox,
	recoverCandidateSandbox,
} from "./candidate-sandbox.js";

function input(source: string) {
	const artifact = Buffer.from(source, "utf8");
	return {
		artifact,
		artifactSha256: createHash("sha256").update(artifact).digest("hex"),
	};
}

it("启动任何进程前拒绝制品变化、越界预算与已取消作业", async () => {
	await expect(
		executeCandidateSandbox({ ...input("1"), artifactSha256: "0".repeat(64) }),
	).rejects.toThrow("CANDIDATE_HASH_MISMATCH");
	await expect(
		executeCandidateSandbox({ ...input("1"), timeoutMs: 600_001 }),
	).rejects.toThrow("CANDIDATE_INPUT_INVALID");
	await expect(
		executeCandidateSandbox(input("x".repeat(65_537))),
	).rejects.toThrow("CANDIDATE_INPUT_INVALID");
	await expect(
		executeCandidateSandbox({ ...input("1"), signal: AbortSignal.abort() }),
	).rejects.toThrow("CANDIDATE_CANCELLED");
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"本机 Docker 合成候选",
	() => {
		it("控制器被强制终止后不抢占有效租约，过期回收再运行", async () => {
			expect(await recoverCandidateSandbox()).toBe("EMPTY");
			const source = `// ${randomUUID()}\nsetInterval(()=>{},1000)`;
			const candidate = input(source);
			const entry = new URL("./candidate-sandbox.ts", import.meta.url).href;
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					`import {executeCandidateSandbox} from ${JSON.stringify(entry)}; await executeCandidateSandbox({artifact:Buffer.from(${JSON.stringify(source)},'utf8'),artifactSha256:${JSON.stringify(candidate.artifactSha256)},timeoutMs:7000});`,
				],
				{ windowsHide: true, stdio: "ignore" },
			);
			const exited = once(child, "exit");
			const runDocker = (args: string[]) =>
				promisify(execFile)("docker", ["--context", "desktop-linux", ...args], {
					windowsHide: true,
					timeout: 30_000,
					encoding: "utf8",
				});
			let ownedId: string | undefined;
			try {
				const waitUntil = Date.now() + 15_000;
				let running = false;
				while (Date.now() < waitUntil && !running) {
					const listed = await runDocker([
						"ps",
						"-a",
						"--no-trunc",
						"--filter",
						`label=choicemind.candidate.artifact=${candidate.artifactSha256}`,
						"--format",
						"{{.ID}}",
					]);
					const id = listed.stdout.trim();
					if (/^[a-f0-9]{64}$/.test(id)) {
						ownedId = id;
						running =
							(
								await runDocker([
									"inspect",
									id,
									"--format",
									"{{.State.Running}}",
								])
							).stdout.trim() === "true";
					}
					if (!running) await delay(100);
				}
				expect(running).toBe(true);
				child.kill("SIGKILL");
				await exited;
				expect(await recoverCandidateSandbox()).toBe("ACTIVE");
				await expect(executeCandidateSandbox(input("1"))).rejects.toThrow(
					"CANDIDATE_SLOT_BUSY",
				);
				let recovered = false;
				while (Date.now() < waitUntil && !recovered) {
					recovered = (await recoverCandidateSandbox()) === "RECOVERED";
					if (!recovered) await delay(200);
				}
				expect(recovered).toBe(true);
				ownedId = undefined;
				expect(await recoverCandidateSandbox()).toBe("EMPTY");
				expect(
					(await executeCandidateSandbox(input("1"))).report.exitCode,
				).toBe(0);
			} finally {
				if (child.exitCode === null && child.signalCode === null)
					child.kill("SIGKILL");
				// 仅清理带本次随机合成制品摘要且已核验的容器 ID。
				if (ownedId !== undefined) await runDocker(["rm", "--force", ownedId]);
			}
		}, 40_000);

		it("实际执行既有隔离探针，候选打印 PASSED 仍不能形成审查通过", async () => {
			const probe = await readFile(
				new URL(
					"../../../scripts/adapter-candidate/sandbox-canary.mjs",
					import.meta.url,
				),
				"utf8",
			);
			const result = await executeCandidateSandbox(input(probe));
			expect(result.report).toMatchObject({
				outcome: "EXITED",
				exitCode: 0,
				reviewStatus: "NOT_RUN",
			});
			expect(result.untrustedStdout.toString("utf8").trim()).toBe(
				"LOCAL_SANDBOX_CANARY_PASSED",
			);
			expect(result.reportSha256).toBe(
				createHash("sha256")
					.update(JSON.stringify(result.report))
					.digest("hex"),
			);
		}, 30_000);

		it.each([
			["损坏代码", "this is not javascript", "EXITED", 1],
			["安装失败", "process.exit(42)", "EXITED", 42],
			[
				"根目录越界",
				"import {writeFileSync} from 'node:fs'; writeFileSync('/escape','x')",
				"EXITED",
				1,
			],
			[
				"输出洪泛",
				"while(true) process.stdout.write('x'.repeat(65536))",
				"OUTPUT_LIMIT",
				null,
			],
			["超时", "setInterval(()=>{},1000)", "TIMED_OUT", null],
		] as const)(
			"%s 不伪装为成功审查",
			async (_name, source, outcome, exitCode) => {
				const result = await executeCandidateSandbox({
					...input(source),
					timeoutMs: 2500,
				});
				expect(result.report).toMatchObject({
					outcome,
					exitCode,
					reviewStatus: "NOT_RUN",
				});
				expect(result.untrustedStdout.byteLength).toBeLessThanOrEqual(65_536);
			},
			30_000,
		);

		it("运行中取消后回收槽位，下个候选能执行", async () => {
			const result = await executeCandidateSandbox({
				...input("setInterval(()=>{},1000)"),
				signal: AbortSignal.timeout(4000),
			});
			expect(result.report.outcome).toBe("CANCELLED");
			const next = await executeCandidateSandbox(input("console.log('next')"));
			expect(next.report.exitCode).toBe(0);
		}, 30_000);
	},
);
