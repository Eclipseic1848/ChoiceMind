import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
);
describe("start_all.bat", () => {
	test("本地开发使用持久身份并监听 Identity 与 Conversation 包源码", () => {
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
		expect(rootManifest.scripts.dev).toContain(
			"@choicemind/identity-access dev",
		);
		expect(rootManifest.scripts.dev).toContain("@choicemind/conversation dev");
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
			expect(output).toContain("Web：http://127.0.0.1:3000");
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
			occupiedPort.listen(3000, "127.0.0.1", resolveListen);
		});

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat --preflight-only"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);

			expect(result.status).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"Web 端口 3000 已被占用",
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
		const dockerLogPath = resolve(commandDirectory, "docker.log");
		writeFileSync(
			healthServerPath,
			[
				'import { createServer } from "node:http";',
				"const servers = [3000, 3100, 3200, 3300].map((port) => createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{\"status\":\"healthy\"}'); }).listen(port, '127.0.0.1'));",
				"setTimeout(() => Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose)))).then(() => process.exit(0)), 1800);",
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

		try {
			const result = spawnSync(
				process.env.ComSpec ?? resolve(windowsRoot, "System32/cmd.exe"),
				["/d", "/c", "start_all.bat"],
				{ cwd: repositoryRoot, encoding: "utf8", env: environment },
			);
			const output = `${result.stdout}${result.stderr}`;
			const dockerLog = readFileSync(dockerLogPath, "utf8");

			expect(result.status).toBe(0);
			expect(output).toContain("ChoiceMind Alpha 已启动，前端开发热更新已启用");
			expect(output).toContain("Identity Lifecycle Worker 后台进程：运行中");
			expect(output).toContain("Web 健康：http://127.0.0.1:3000/health/live");
			expect(output).toContain("API Publisher 后台进程：运行中");
			expect(output).toContain("Orchestrator Worker 后台进程：运行中");
			expect(dockerLog).toContain("stop postgres redis");
		} finally {
			rmSync(commandDirectory, { force: true, recursive: true });
			rmSync(localAppData, { force: true, recursive: true });
		}
	}, 20_000);
});
