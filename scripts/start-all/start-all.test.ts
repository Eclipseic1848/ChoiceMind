import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

process.env.CHOICEMIND_START_ALL_NO_PAUSE = "1";

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
);
describe("start_all.bat", () => {
	test("本地开发使用持久身份并监听 Identity 与 Conversation 包源码", () => {
		const batchScript = readFileSync(
			resolve(repositoryRoot, "start_all.bat"),
			"utf8",
		);
		const startScript = readFileSync(
			resolve(repositoryRoot, "scripts/start-all/start-all.ps1"),
			"utf8",
		);
		const rootManifest = JSON.parse(
			readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
		) as { scripts: { dev: string; predev: string } };
		const identityManifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "packages/identity-access/package.json"),
				"utf8",
			),
		) as { scripts: Record<string, string> };
		const conversationManifest = JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "packages/conversation/package.json"),
				"utf8",
			),
		) as { scripts: Record<string, string> };
		const apiManifest = JSON.parse(
			readFileSync(resolve(repositoryRoot, "apps/api/package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		const compose = readFileSync(
			resolve(repositoryRoot, "deploy/compose/compose.yaml"),
			"utf8",
		);

		expect(startScript).toContain("CHOICEMIND_IDENTITY_MODE = 'persistent'");
		expect(startScript).not.toContain("CHOICEMIND_SYNTHETIC_IDENTITIES_JSON");
		expect(rootManifest.scripts.predev).toContain(
			"@choicemind/identity-access build",
		);
		expect(rootManifest.scripts.predev).toContain(
			"@choicemind/conversation build",
		);
		expect(rootManifest.scripts.predev).toContain("@choicemind/security build");
		expect(rootManifest.scripts.predev).toContain(
			"@choicemind/task-persistence build",
		);
		expect(rootManifest.scripts.dev).toContain(
			"@choicemind/identity-access dev",
		);
		expect(rootManifest.scripts.dev).toContain("@choicemind/conversation dev");
		expect(rootManifest.scripts.predev).toContain(
			"@choicemind/source-access build",
		);
		expect(rootManifest.scripts.predev).toContain(
			"@choicemind/source-research build",
		);
		expect(rootManifest.scripts.dev).toContain("@choicemind/source-access dev");
		expect(rootManifest.scripts.dev).toContain(
			"@choicemind/source-research dev",
		);
		expect(rootManifest.scripts.dev).toContain("@choicemind/source-worker dev");
		expect(rootManifest.scripts.dev).toContain(
			"src/identity-lifecycle-worker.ts",
		);
		expect(identityManifest.scripts.dev).toContain("--watch");
		expect(conversationManifest.scripts.dev).toContain("--watch");
		expect(apiManifest.scripts["start:identity-lifecycle"]).toContain(
			"identity-lifecycle-worker.js",
		);
		const lifecycleWorker = readFileSync(
			resolve(repositoryRoot, "apps/api/src/identity-lifecycle-worker.ts"),
			"utf8",
		);
		expect(lifecycleWorker).toContain(
			"const identityAccess = await openPostgresIdentityAccess",
		);
		expect(
			lifecycleWorker.indexOf(
				"const identityAccess = await openPostgresIdentityAccess",
			),
		).toBeLessThan(
			lifecycleWorker.indexOf(
				"const worker = await openPostgresIdentityLifecycleWorker",
			),
		);
		expect(compose).toContain("identity-lifecycle-worker:");
		expect(compose).toContain("source-worker:");
		expect(startScript).toContain(
			"Remove-Item Env:CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64",
		);
		expect(batchScript).toContain("[Console]::IsInputRedirected");
		expect(batchScript).toContain("CHOICEMIND_START_ALL_NO_PAUSE");
		expect(batchScript).toContain(
			"ChoiceMind 启动文件：%CHOICEMIND_ROOT%start_all.bat",
		);
		expect(batchScript).toContain("按 Enter 键关闭此窗口");
		expect(rootManifest.scripts.dev).toContain(
			"run-with-credential-key.mjs pnpm --filter @choicemind/api dev",
		);
	});
	test("主启动进程意外消失后清理守护进程会停止基础容器", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const dockerLogPath = resolve(commandDirectory, "docker.log");
		const applicationPidPath = resolve(commandDirectory, "application.pid");
		const applicationProcess = spawn(process.execPath, [
			"--eval",
			"setInterval(() => {}, 1000)",
		]);
		if (applicationProcess.pid === undefined) {
			throw new Error("无法创建清理守护进程测试子进程");
		}
		writeFileSync(applicationPidPath, String(applicationProcess.pid), "ascii");
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			`@echo %*>>"${dockerLogPath}"\r\n@exit /b 0\r\n`,
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
		].join(";");

		try {
			const result = spawnSync(
				resolve(windowsRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
				[
					"-NoProfile",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					resolve(repositoryRoot, "scripts/start-all/cleanup.ps1"),
					"-ParentProcessId",
					"2147483647",
					"-ApplicationPidPath",
					applicationPidPath,
				],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status).toBe(0);
			expect(readFileSync(dockerLogPath, "utf8")).toContain(
				"stop postgres redis",
			);
			expect(() => process.kill(applicationProcess.pid as number, 0)).toThrow();
		} finally {
			if (applicationProcess.exitCode === null) {
				applicationProcess.kill();
			}
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("预检时 LOCALAPPDATA 缺失会返回失败而不是假成功", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v22.22.1\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "pnpm.cmd"),
			"@echo 11.21.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "uv.cmd"),
			"@exit /b 0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			"@exit /b 0\r\n",
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		delete environment.LOCALAPPDATA;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		environment.CHOICEMIND_START_ALL_TEST_PORT_OFFSET = "20000";

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"LOCALAPPDATA 不可用",
			);
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("缺少 Node 时返回失败并给出中文安装提示", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		const result = spawnSync(
			process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
			["/d", "/c", "start_all.bat --preflight-only"],
			{
				cwd: repositoryRoot,
				encoding: "utf8",
				env: environment,
			},
		);

		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("缺少必需命令：node");
		expect(`${result.stdout}${result.stderr}`).toContain(
			"请安装 Node.js 22.22.1 或 fnm",
		);
	}, 10_000);

	test("缺少 Node 时也通过已安装的 fnm 使用仓库固定版本", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const fnmLogPath = resolve(commandDirectory, "fnm.log");
		writeFileSync(
			resolve(commandDirectory, "fnm.cmd"),
			[
				"@echo off",
				`echo %*>>"${fnmLogPath}"`,
				'echo %*| findstr /c:"node --version" >nul && (echo v22.22.1& exit /b 0)',
				"exit /b 37",
			].join("\r\n"),
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status).toBe(37);
			expect(readFileSync(fnmLogPath, "utf8")).toContain(
				"exec --using=22.22.1 --",
			);
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("Node 版本与仓库要求不一致时拒绝启动", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v20.0.0\r\n",
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"Node.js 版本不匹配：需要 22.22.1",
			);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"请安装 fnm，或手动切换到 Node.js 22.22.1",
			);
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("Node 版本不匹配时通过已安装的 fnm 使用仓库固定版本", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const fnmLogPath = resolve(commandDirectory, "fnm.log");
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v24.16.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "fnm.cmd"),
			[
				"@echo off",
				`echo %*>>"${fnmLogPath}"`,
				'echo %*| findstr /c:"node --version" >nul && (echo v22.22.1& exit /b 0)',
				"exit /b 37",
			].join("\r\n"),
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status).toBe(37);
			expect(readFileSync(fnmLogPath, "utf8")).toContain(
				"exec --using=22.22.1 --",
			);
			expect(readFileSync(fnmLogPath, "utf8")).toContain("-PreflightOnly");
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("fnm 已确认固定 Node 可用后保留内层启动失败原因", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v24.16.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "fnm.cmd"),
			[
				"@echo off",
				'echo %*| findstr /c:"node --version" >nul && (echo v22.22.1& exit /b 0)',
				"exit /b 23",
			].join("\r\n"),
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status, `${result.stdout}${result.stderr}`).toBe(23);
			expect(`${result.stdout}${result.stderr}`).not.toContain(
				"fnm 无法使用项目要求的 Node.js",
			);
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("fnm 重启标记存在时不会再次重启脚本", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const fnmLogPath = resolve(commandDirectory, "fnm.log");
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v24.16.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "fnm.cmd"),
			`@echo %*>>"${fnmLogPath}"\r\n@exit /b 37\r\n`,
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		environment.CHOICEMIND_FNM_RELAUNCHED = "1";

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status).toBe(1);
			expect(existsSync(fnmLogPath)).toBe(false);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"无法通过 fnm 自动切换",
			);
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("fnm 缺少项目 Node 版本时给出中文安装命令", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v24.16.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "fnm.cmd"),
			"@echo requested version is not installed 1>&2\r\n@exit /b 44\r\n",
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status, `${result.stdout}${result.stderr}`).toBe(44);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"fnm install 22.22.1",
			);
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("依赖与端口可用时输出服务地址和数据卷策略", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const localAppData = mkdtempSync(
			resolve(tmpdir(), "choicemind-local-app-data-"),
		);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v22.22.1\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "pnpm.cmd"),
			"@echo 11.21.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "uv.cmd"),
			"@echo uv 0.9.5\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			[
				"@echo off",
				'if "%1"=="--version" echo Docker version 28.0.0& exit /b 0',
				'if "%1"=="info" exit /b 0',
				'if "%1"=="compose" echo Docker Compose version v2.0.0& exit /b 0',
				"exit /b 0",
			].join("\r\n"),
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		environment.LOCALAPPDATA = localAppData;
		environment.CHOICEMIND_START_ALL_TEST_PORT_OFFSET = "20000";

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);
			const output = `${result.stdout}${result.stderr}`;

			expect(result.status).toBe(0);
			expect(output).toContain(
				"依赖检查：Node.js 22.22.1、pnpm 11.21.0、uv、Docker Compose 均可用",
			);
			expect(output).toContain("Web：http://192.168.50.123:1029");
			expect(output).toContain("API：http://127.0.0.1:3100");
			expect(output).toContain("Orchestrator：http://127.0.0.1:3200");
			expect(output).toContain("Data Worker：http://127.0.0.1:3300");
			expect(output).toContain(
				"退出时停止本次基础服务，PostgreSQL 与 Redis 数据卷保留",
			);
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
			rmSync(localAppData, { force: true, recursive: true });
		}
	});

	test("PID 状态不可用但 ChoiceMind 服务健康时重复启动不会报告端口冲突", async () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const localAppData = mkdtempSync(
			resolve(tmpdir(), "choicemind-local-app-data-"),
		);
		const healthServerPath = resolve(commandDirectory, "existing-health.mjs");
		const offset = 10_000;
		writeFileSync(
			healthServerPath,
			[
				'import { createServer } from "node:http";',
				`const ports = [1029, 3100, 3200, 3300].map((port) => port + ${offset});`,
				"const servers = ports.map((port) => createServer((_request, response) => { const delay = port === 13100 ? 1500 : 0; setTimeout(() => { response.writeHead(200); response.end('healthy'); }, delay); }).listen(port, '127.0.0.1'));",
				"Promise.all(servers.map((server) => new Promise((resolve) => server.on('listening', resolve)))).then(() => console.log('READY'));",
				"setInterval(() => {}, 1000);",
			].join("\n"),
			"utf8",
		);
		const healthProcess = spawn(process.execPath, [healthServerPath]);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v22.22.1\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "pnpm.cmd"),
			"@echo 11.21.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "uv.cmd"),
			"@echo uv 0.9.5\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			"@exit /b 0\r\n",
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		environment.CHOICEMIND_START_ALL_TEST_PORT_OFFSET = String(offset);
		environment.LOCALAPPDATA = localAppData;

		try {
			await new Promise<void>((resolveReady, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("健康测试进程启动超时")),
					5_000,
				);
				healthProcess.once("error", reject);
				healthProcess.stdout?.on("data", (chunk: Buffer) => {
					if (chunk.toString("utf8").includes("READY")) {
						clearTimeout(timeout);
						resolveReady();
					}
				});
			});
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);
			const output = `${result.stdout}${result.stderr}`;
			expect(result.status).toBe(0);
			expect(output).toContain("ChoiceMind 已经在运行");
			expect(output).toContain("http://192.168.50.123:1029");
			expect(output).not.toContain("端口 1029 已被占用");
		} finally {
			healthProcess.kill();
			rmSync(commandDirectory, { force: true, recursive: true });
			rmSync(localAppData, { force: true, recursive: true });
		}
	}, 15_000);

	test("Web 端口被占用时指出冲突服务和端口", async () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v22.22.1\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "pnpm.cmd"),
			"@echo 11.21.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "uv.cmd"),
			"@echo uv 0.9.5\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			"@exit /b 0\r\n",
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		const occupiedPort = createServer();
		await new Promise<void>((resolveListen, reject) => {
			occupiedPort.once("error", reject);
			occupiedPort.listen(1029, "127.0.0.1", resolveListen);
		});

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"Web 端口 1029 已被占用",
			);
		} finally {
			await new Promise<void>((resolveClose) =>
				occupiedPort.close(() => resolveClose()),
			);
			rmSync(commandDirectory, { force: true, recursive: true });
		}
	});

	test("PostgreSQL 或 Redis 启动失败时停止并说明原因", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const localAppData = mkdtempSync(
			resolve(tmpdir(), "choicemind-local-app-data-"),
		);
		const dockerLogPath = resolve(commandDirectory, "docker.log");
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v22.22.1\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "pnpm.cmd"),
			"@echo 11.21.0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "uv.cmd"),
			"@echo uv 0.9.5\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			[
				"@echo off",
				`echo %*>>"${dockerLogPath}"`,
				'if "%1"=="info" exit /b 0',
				'if "%1"=="compose" if "%2"=="version" exit /b 0',
				'if "%1"=="compose" exit /b 17',
				"exit /b 0",
			].join("\r\n"),
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		environment.LOCALAPPDATA = localAppData;
		environment.CHOICEMIND_START_ALL_TEST_PORT_OFFSET = "20000";

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			const dockerLog = readFileSync(dockerLogPath, "utf8");
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"PostgreSQL/Redis 基础服务启动失败",
			);
			expect(dockerLog).toContain("stop postgres redis");
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
			rmSync(localAppData, { force: true, recursive: true });
		}
	});

	test("业务子进程在健康检查前退出时报告真实退出码", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const localAppData = mkdtempSync(
			resolve(tmpdir(), "choicemind-local-app-data-"),
		);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v22.22.1\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "pnpm.cmd"),
			[
				"@echo off",
				'if "%1"=="--version" (echo 11.21.0& exit /b 0)',
				"exit /b 23",
			].join("\r\n"),
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "uv.cmd"),
			"@echo uv 0.9.5\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			[
				"@echo off",
				'if "%1"=="compose" if not "%2"=="version" if not "%CHOICEMIND_IDENTITY_MODE%"=="persistent" exit /b 29',
				"exit /b 0",
			].join("\r\n"),
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		environment.LOCALAPPDATA = localAppData;
		environment.CHOICEMIND_START_ALL_TEST_PORT_OFFSET = "20000";

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			const output = `${result.stdout}${result.stderr}`;
			expect(output).toContain("应用进程在健康检查完成前退出（退出码 23）");
			expect(result.status).not.toBe(0);
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
			rmSync(localAppData, { force: true, recursive: true });
		}
	}, 15_000);

	test("业务子进程退出后即使清理进程失败也会停止基础容器", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const localAppData = mkdtempSync(
			resolve(tmpdir(), "choicemind-local-app-data-"),
		);
		const dockerLogPath = resolve(commandDirectory, "docker.log");
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v22.22.1\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "pnpm.cmd"),
			[
				"@echo off",
				'if "%1"=="--version" (echo 11.21.0& exit /b 0)',
				"exit /b 23",
			].join("\r\n"),
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "uv.cmd"),
			"@exit /b 0\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			`@echo %*>>"${dockerLogPath}"\r\n@exit /b 0\r\n`,
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		environment.LOCALAPPDATA = localAppData;
		environment.CHOICEMIND_START_ALL_TEST_PORT_OFFSET = "20000";

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);
			const dockerLog = readFileSync(dockerLogPath, "utf8");

			expect(result.status).not.toBe(0);
			expect(dockerLog).toContain("stop postgres redis");
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
			rmSync(localAppData, { force: true, recursive: true });
		}
	}, 15_000);

	test("四个服务健康后宣布热更新就绪并停止本次基础容器", () => {
		const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
		const commandDirectory = mkdtempSync(
			resolve(tmpdir(), "choicemind-start-all-"),
		);
		const localAppData = mkdtempSync(
			resolve(tmpdir(), "choicemind-local-app-data-"),
		);
		const healthServerPath = resolve(commandDirectory, "health-child.mjs");
		const offset = 20_000;
		const dockerLogPath = resolve(commandDirectory, "docker.log");
		writeFileSync(
			healthServerPath,
			[
				'import { createServer } from "node:http";',
				"const checked = new Set();",
				"const deadline = setTimeout(() => process.exit(1), 10000);",
				`const servers = [1029, 3100, 3200, 3300].map((port) => createServer((_request, response) => { response.on('finish', () => { checked.add(port); if (checked.size === 4) { clearTimeout(deadline); Promise.all(servers.map((server) => new Promise((done) => server.close(done)))).then(() => process.exit(0)); } }); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"healthy"}'); }).listen(port + ${offset}, '127.0.0.1'));`,
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "node.cmd"),
			"@echo v22.22.1\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "pnpm.cmd"),
			[
				"@echo off",
				'if "%1"=="--version" goto version',
				'if "%1"=="dev" goto dev',
				"exit /b 0",
				":version",
				"echo 11.21.0",
				"exit /b 0",
				":dev",
				`"${process.execPath}" "${healthServerPath}"`,
				"exit /b %ERRORLEVEL%",
			].join("\r\n"),
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "uv.cmd"),
			"@echo uv 0.9.5\r\n",
			"utf8",
		);
		writeFileSync(
			resolve(commandDirectory, "docker.cmd"),
			`@echo %*>>"${dockerLogPath}"\r\n@exit /b 0\r\n`,
			"utf8",
		);
		const environment = { ...process.env };
		delete environment.PATH;
		delete environment.Path;
		environment.PATH = [
			commandDirectory,
			resolve(windowsRoot, "System32"),
			resolve(windowsRoot, "System32/WindowsPowerShell/v1.0"),
		].join(";");
		environment.LOCALAPPDATA = localAppData;
		environment.CHOICEMIND_START_ALL_TEST_PORT_OFFSET = String(offset);

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);
			const output = `${result.stdout}${result.stderr}`;
			const dockerLog = readFileSync(dockerLogPath, "utf8");

			expect(result.status, output).toBe(0);
			expect(output).toContain("ChoiceMind Alpha 已启动，前端开发热更新已启用");
			expect(output).toContain("Identity Lifecycle Worker 后台进程：运行中");
			expect(output).toContain(`Web 健康：http://127.0.0.1:${1029 + offset}/health/live`);
			expect(output).toContain("API Publisher 后台进程：运行中");
			expect(output).toContain("Orchestrator Worker 后台进程：运行中");
			expect(dockerLog).toContain("stop postgres redis");
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
			rmSync(localAppData, { force: true, recursive: true });
		}
	}, 20_000);
});
