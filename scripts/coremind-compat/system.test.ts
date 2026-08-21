import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "vitest";

import { CORE_MIND_PACKAGE_NAMES, runCoreMindCompatibility } from "./index.js";
import { createMaterializedCandidate } from "./test-fixtures.js";
import {
  createSystemCompatibilitySystem,
  executeSystemCommand,
  type CommandExecutor,
  type CommandRequest
} from "./system.js";

const commit = "57e5765471cf6fe7f7da14d9ed4882e0c53ec322";
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((temporaryPath) =>
      rm(temporaryPath, { force: true, recursive: true })
    )
  );
});

test("真实命令取消后父子进程均已退出", async () => {
  const root = await createTemporaryDirectory();
  const pidPath = path.join(root, "processes.json");
  const controller = new AbortController();
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]), "utf8");',
    'setInterval(() => {}, 1000);'
  ].join("");
  const running = executeSystemCommand({
    command: "node",
    args: ["-e", script, pidPath],
    signal: controller.signal
  });
  const pids = await waitForProcessIds(pidPath);

  controller.abort("cancelled");

  await expect(running).rejects.toThrow("已取消");
  await expect(waitUntilProcessesExit(pids)).resolves.toBeUndefined();
});

test.each([
  ["成功", 0],
  ["失败", 7]
] as const)("普通命令%s后不遗留子进程", async (_outcome, exitCode) => {
  const root = await createTemporaryDirectory();
  const pidPath = path.join(root, "detached-child.json");
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
    '  { detached: process.platform === "win32", stdio: "ignore", windowsHide: true });',
    "child.unref();",
    'writeFileSync(process.argv[1], JSON.stringify([child.pid]), "utf8");',
    "process.exitCode = Number(process.argv[2]);"
  ].join("");
  const running = executeSystemCommand({
    command: "node",
    args: ["-e", script, pidPath, String(exitCode)]
  });
  const completion =
    exitCode === 0
      ? expect(running).resolves.toBeInstanceOf(Buffer)
      : expect(running).rejects.toThrow("外部命令执行失败");
  const [childPid] = await waitForProcessIds(pidPath, 1);
  if (childPid === undefined) throw new Error("测试子进程 PID 缺失");

  try {
    await completion;
    await expect(waitUntilProcessesExit([childPid])).resolves.toBeUndefined();
  } finally {
    if (isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
  }
});

test.runIf(process.platform === "win32")("Windows npm 参数中的空格保持完整", async () => {
  const root = await createTemporaryDirectory();
  const prefix = path.join(root, "prefix with space");
  await mkdir(prefix, { recursive: true });

  const output = await executeSystemCommand({
    command: "npm",
    args: ["prefix", "--prefix", prefix]
  });

  expect(path.normalize(output.toString("utf8").trim())).toBe(path.normalize(prefix));
});

test.runIf(process.platform === "win32")(
  "Windows pnpm 参数中的空格保持完整",
  async () => {
    const root = await createTemporaryDirectory();
    const workspace = path.join(root, "workspace with space");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "package.json"),
      `${JSON.stringify({
        name: "pnpm-space-test",
        private: true,
        packageManager: "pnpm@11.21.0"
      })}\n`,
      "utf8"
    );

    const output = await executeSystemCommand({
      command: "pnpm",
      args: ["--dir", workspace, "--version"],
      signal: AbortSignal.timeout(15_000)
    });

    expect(output.toString("utf8").trim()).toBe("11.21.0");
  },
  20_000
);

test("环境报告同时记录工作区 pnpm 声明与实际 npm 版本", async () => {
  const root = await createTemporaryDirectory();
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ packageManager: "pnpm@11.21.0" })}\n`,
    "utf8"
  );
  const source = createSystemCompatibilitySystem({
    artifactDirectory: path.join(root, "artifacts"),
    choiceMindRoot: root,
    execute: async (request) => {
      if (request.command === "git") return Buffer.from(`${"b".repeat(40)}\n`);
      if (request.command === "npm" && request.args[0] === "--version") {
        return Buffer.from("10.9.4\n");
      }
      throw new Error("测试收到非环境探测命令");
    }
  });

  await expect(source.describeEnvironment()).resolves.toMatchObject({
    choiceMindCommit: "b".repeat(40),
    nodeVersion: process.versions.node,
    workspacePackageManager: "pnpm@11.21.0",
    artifactPackageManager: "npm@10.9.4"
  });
});

test("候选六包只在临时 ChoiceMind 副本中解析并通过 Gate C-F", async () => {
  const root = await createTemporaryDirectory();
  const artifactDirectory = path.join(root, "artifacts");
  const packageDirectory = path.join(artifactDirectory, "packages");
  const candidate = createMaterializedCandidate();
  for (const artifact of candidate.packages) {
    artifact.sha256 = createHash("sha256").update(artifact.name).digest("hex");
  }
  await mkdir(packageDirectory, { recursive: true });
  await Promise.all(
    candidate.packages.map((artifact) =>
      writeFile(path.join(packageDirectory, artifact.fileName), artifact.name, "utf8")
    )
  );
  let temporaryChoiceMindRoot = "";
  const commands: string[] = [];
  const source = createSystemCompatibilitySystem({
    artifactDirectory,
    choiceMindRoot: path.join(root, "stable-choice-mind"),
    execute: async (request) => {
      commands.push(`${request.command} ${request.args.join(" ")}`);
      if (request.command === "git" && request.args[0] === "clone") {
        temporaryChoiceMindRoot = request.args.at(-1) ?? "";
        await mkdir(path.join(temporaryChoiceMindRoot, "apps", "orchestrator"), {
          recursive: true
        });
        await writeFile(
          path.join(temporaryChoiceMindRoot, "package.json"),
          `${JSON.stringify({ name: "choicemind", private: true })}\n`,
          "utf8"
        );
        await writeFile(
          path.join(temporaryChoiceMindRoot, "apps", "orchestrator", "package.json"),
          `${JSON.stringify({
            name: "@choicemind/orchestrator",
            dependencies: { "coremind-ai": "0.3.0" }
          })}\n`,
          "utf8"
        );
        return Buffer.alloc(0);
      }
      if (request.command === "git" && request.args.includes("rev-parse")) {
        return Buffer.from(`${"b".repeat(40)}\n`);
      }
      if (request.command === "node" && request.args[0]?.endsWith("probe.mjs")) {
        return Buffer.from(
          JSON.stringify(
            candidate.packages
              .filter((artifact) => !["coremind-worker", "coremind-cli"].includes(artifact.name))
              .map((artifact) => ({ name: artifact.name, version: artifact.version }))
          )
        );
      }
      if (request.command === "node" && request.args[0] === "--version") {
        return Buffer.from("v22.22.1\n");
      }
      if (request.command === "pnpm" && request.args[0] === "--version") {
        return Buffer.from("11.21.0\n");
      }
      if (request.command === "pnpm" && request.args.includes("--reporter=json")) {
        return Buffer.from(
          JSON.stringify({
            numPassedTests: request.args.includes("Gate E:") ? 2 : 14,
            numFailedTests: 0,
            numPendingTests: 0,
            success: true
          })
        );
      }
      return Buffer.alloc(0);
    }
  });

  const result = await source.verifyCandidateCompatibility(candidate, {
    choiceMindCommit: "b".repeat(40),
    nodeVersion: "22.22.1",
    workspacePackageManager: "pnpm@11.21.0",
    artifactPackageManager: "npm@10.9.4"
  });

  expect(result.resolvedRuntimePackages).toHaveLength(6);
  expect(result.resolvedRuntimePackages).toContainEqual({
    name: "coremind-ai",
    version: candidate.version
  });
  expect(result.testCounts).toEqual({ D: 28, E: 2 });
  expect(commands).toEqual(
    expect.arrayContaining([
      expect.stringContaining("git clone --no-hardlinks --no-checkout"),
      expect.stringContaining("pnpm install"),
      expect.stringContaining("pnpm --filter @choicemind/orchestrator typecheck"),
      expect.stringContaining("pnpm --filter @choicemind/orchestrator build"),
      expect.stringContaining("--testNamePattern Gate D: --reporter=json"),
      expect.stringContaining("--testNamePattern Gate E: --reporter=json"),
      expect.stringContaining("pnpm verify"),
      expect.stringContaining("node -e")
    ])
  );
  await expect(access(temporaryChoiceMindRoot)).rejects.toThrow();
  await expect(access(path.join(artifactDirectory, ".pnpm-runner-sandbox"))).rejects.toThrow();
});

test.each([
  ["Node", { actualNodeVersion: "v22.21.0" }],
  ["pnpm", { actualPnpmVersion: "11.20.0" }]
] as const)("Gate F 拒绝非锁定的 %s 工具链版本", async (_tool, options) => {
  const harness = await createCompatibilityRunnerHarness(options);

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "F", stage: "ROOT_VERIFY" });
  expect(harness.commands).not.toContain("pnpm verify");
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate E 零项实际通过时即使 Vitest 成功退出也失败关闭", async () => {
  const harness = await createCompatibilityRunnerHarness({ gateEPassedTests: 0 });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "E", stage: "VERTICAL_TEST" });
  await expect(access(harness.temporaryChoiceMindRoot)).rejects.toThrow();
  await expect(
    access(path.join(harness.artifactDirectory, ".pnpm-runner-sandbox"))
  ).rejects.toThrow();
  await expectStableWorkspaceUnchanged(harness);
});

test.each([
  ["CANDIDATE_INSTALL", "C", (request: CommandRequest) => request.command === "pnpm" && request.args[0] === "install"],
  ["INTERFACE_TYPECHECK", "C", (request: CommandRequest) => request.command === "pnpm" && request.args.at(-1) === "typecheck"],
  ["INTERFACE_BUILD", "C", (request: CommandRequest) => request.command === "pnpm" && request.args.at(-1) === "build"],
  ["CONTRACT_TEST", "D", (request: CommandRequest) => request.command === "pnpm" && request.args.includes("Gate D:")],
  ["VERTICAL_TEST", "E", (request: CommandRequest) => request.command === "pnpm" && request.args.includes("Gate E:")],
  ["ROOT_VERIFY", "F", (request: CommandRequest) => request.command === "pnpm" && request.args[0] === "verify"],
  ["RESOURCE_CLEANUP", "F", (request: CommandRequest) => request.command === "node" && request.args[0] === "-e"]
] as const)("%s 命令失败归属 Gate %s 并清理隔离环境", async (stage, gate, shouldFail) => {
  const harness = await createCompatibilityRunnerHarness({ shouldFail });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate, stage, reason: "COMMAND_FAILED" });
  await expect(access(harness.temporaryChoiceMindRoot)).rejects.toThrow();
  await expect(
    access(path.join(harness.artifactDirectory, ".pnpm-runner-sandbox"))
  ).rejects.toThrow();
  await expectStableWorkspaceUnchanged(harness);
});

test("候选依赖解析回退稳定版本时在 Gate C 失败", async () => {
  const harness = await createCompatibilityRunnerHarness({ resolvedVersion: "0.3.0" });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "DEPENDENCY_RESOLUTION" });
  await expectStableWorkspaceUnchanged(harness);
});

test("候选 tarball 在安装前被篡改时失败且不运行 pnpm", async () => {
  const harness = await createCompatibilityRunnerHarness();
  const runtime = harness.candidate.packages.find((artifact) => artifact.name === "coremind-runtime");
  if (!runtime) throw new Error("测试候选缺少 coremind-runtime");
  await writeFile(
    path.join(harness.artifactDirectory, "packages", runtime.fileName),
    "tampered",
    "utf8"
  );

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });
  expect(harness.commands.some((command) => command.startsWith("pnpm install"))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("候选安装只注入六包 overrides 和隔离配置", async () => {
  const harness = await createCompatibilityRunnerHarness();

  await harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment);

  expect(Object.keys(harness.installedOverrides)).toEqual([
    "coremind-ai",
    "coremind-config",
    "coremind-protocol",
    "coremind-runtime",
    "coremind-tools",
    "coremind-templates"
  ]);
  expect(Object.keys(harness.installEnvironment).sort()).toEqual([
    "COREPACK_HOME",
    "npm_config_cache",
    "npm_config_cache_dir",
    "npm_config_globalconfig",
    "npm_config_userconfig"
  ]);
  expect(path.resolve(harness.installEnvironment.npm_config_cache_dir ?? "")).toBe(
    path.resolve(harness.artifactDirectory, ".pnpm-runner-sandbox", "cache")
  );
  await expect(
    access(path.join(harness.artifactDirectory, ".pnpm-runner-sandbox"))
  ).rejects.toThrow();
  expect(await readFile(harness.stableMarkerPath, "utf8")).toBe("stable\n");
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 取消后确认命令结束并清理隔离环境", async () => {
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const harness = await createCompatibilityRunnerHarness({
    signal: controller.signal,
    shouldHang: (request) => request.command === "pnpm" && request.args[0] === "install",
    onHangStarted: () => markStarted?.()
  });
  const running = harness.source.verifyCandidateCompatibility(
    harness.candidate,
    harness.environment
  );
  await started;

  controller.abort("cancelled");

  await expect(running).rejects.toMatchObject({
    gate: "C",
    stage: "CANDIDATE_INSTALL",
    reason: "CANCELLED"
  });
  await expect(access(harness.temporaryChoiceMindRoot)).rejects.toThrow();
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 超时后确认命令结束并清理隔离环境", async () => {
  const harness = await createCompatibilityRunnerHarness({
    commandTimeoutMs: 20,
    shouldHang: (request) => request.command === "pnpm" && request.args[0] === "install"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "CANDIDATE_INSTALL",
    reason: "TIMEOUT"
  });
  await expect(access(harness.temporaryChoiceMindRoot)).rejects.toThrow();
  await expectStableWorkspaceUnchanged(harness);
});

describe("CoreMind Git 制品边界", () => {
  test.each([
    ["GIT_FETCH", (request: CommandRequest) => request.command === "git" && request.args.includes("fetch")],
    ["NPM_CI", (request: CommandRequest) => request.command === "npm" && request.args[0] === "ci"],
    [
      "VERSION_SYNC",
      (request: CommandRequest) =>
        request.command === "node" && request.args[0] === "scripts/release-version.mjs"
    ],
    [
      "BUILD",
      (request: CommandRequest) => request.command === "npm" && request.args[0] === "run"
    ],
    [
      "PACK",
      (request: CommandRequest) => request.command === "npm" && request.args[0] === "pack"
    ]
  ] as const)("外部命令失败报告安全阶段 %s", async (stage, shouldFail) => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: async (request) => {
        if (shouldFail(request)) throw new Error("不得进入安全报告的原始失败");
        return executor.execute(request);
      }
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({ stage, reason: "COMMAND_FAILED" });
  });

  test("npm ci 超时报告安全原因并清理临时目录", async () => {
    const root = await createTemporaryDirectory();
    const artifactDirectory = path.join(root, "artifacts");
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory,
      choiceMindRoot: root,
      commandTimeoutMs: 10,
      execute: async (request) => {
        if (request.command === "npm" && request.args[0] === "ci") {
          return new Promise<Buffer>((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("不得进入安全报告的原始超时错误")),
              { once: true }
            );
          });
        }
        return executor.execute(request);
      }
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({ stage: "NPM_CI", reason: "TIMEOUT" });
    await expect(access(executor.sourceDirectory)).rejects.toThrow();
    await expect(access(path.join(artifactDirectory, ".npm-sandbox"))).rejects.toThrow();
  });

  test("版本同步命令成功但版本未更新时报告 VERSION_SYNC", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: async (request) => {
        if (
          request.command === "node" &&
          request.args[0] === "scripts/release-version.mjs"
        ) {
          return Buffer.alloc(0);
        }
        return executor.execute(request);
      }
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({ stage: "VERSION_SYNC" });
  });

  test("精确 checkout 后构建并保留同源八包，临时源码被清理", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: executor.execute
    });

    const result = await source.materializeGitCommit({
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    });

    expect(result.packages).toHaveLength(8);
    expect(result.identity).toEqual({
      kind: "git-source-archive",
      sha256: createHash("sha256").update("deterministic-source-archive").digest("hex")
    });
    expect(result.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "coremind-ai",
          fileName: expect.stringMatching(/^coremind-ai-.*\.tgz$/u),
          dependencies: expect.objectContaining({
            "coremind-runtime": result.version
          })
        })
      ])
    );
    await expect(access(executor.sourceDirectory)).rejects.toThrow();
  });

  test("tgz 字节被篡改时失败关闭并清理临时资源", async () => {
    const root = await createTemporaryDirectory();
    const artifactDirectory = path.join(root, "artifacts");
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory,
      choiceMindRoot: root,
      execute: async (request) => {
        const output = await executor.execute(request);
        if (
          request.command === "npm" &&
          request.args[0] === "pack" &&
          request.args.includes("coremind-ai")
        ) {
          const packed = JSON.parse(output.toString("utf8")) as [{ filename: string }];
          const destinationIndex = request.args.indexOf("--pack-destination");
          const destination = request.args[destinationIndex + 1];
          if (!destination) throw new Error("测试 pack 命令缺少目标目录");
          const tarballPath = path.join(destination, packed[0].filename);
          const bytes = await readFile(tarballPath);
          await writeFile(tarballPath, Buffer.concat([bytes, gzipSync(Buffer.alloc(0))]));
        }
        return output;
      }
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({ stage: "TARBALL_VALIDATE" });
    await expect(access(executor.sourceDirectory)).rejects.toThrow();
    await expect(access(path.join(artifactDirectory, ".npm-sandbox"))).rejects.toThrow();
  });

  test("构建失败时仍删除临时 CoreMind 源码", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: async (request) => {
        const output = await executor.execute(request);
        if (request.command === "npm" && request.args[0] === "run") {
          throw new Error("合成构建失败");
        }
        return output;
      }
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({ stage: "BUILD" });
    await expect(access(executor.sourceDirectory)).rejects.toThrow();
  });

  test("取消当前命令后删除临时 CoreMind 源码", async () => {
    const root = await createTemporaryDirectory();
    const controller = new AbortController();
    const executor = createInterruptibleExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: executor.execute,
      signal: controller.signal
    });

    const running = source.materializeGitCommit({
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    });
    await executor.started;
    controller.abort();

    await expect(running).rejects.toMatchObject({ stage: "GIT_FETCH" });
    await expect(access(executor.sourceDirectory)).rejects.toThrow();
  });

  test("命令超时后删除临时 CoreMind 源码", async () => {
    const root = await createTemporaryDirectory();
    const executor = createInterruptibleExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      commandTimeoutMs: 10,
      execute: executor.execute
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({ stage: "GIT_FETCH" });
    await expect(access(executor.sourceDirectory)).rejects.toThrow();
  });
});

describe("CoreMind npm 制品边界", () => {
  test("所有 npm 命令使用本次装配独立缓存且结束后清理", async () => {
    const root = await createTemporaryDirectory();
    const artifactDirectory = path.join(root, "artifacts");
    const version = "0.3.1-rc.1";
    const environments: Array<Record<string, string> | undefined> = [];
    const baseExecutor = createNpmCandidateExecutor(version);
    const source = createSystemCompatibilitySystem({
      artifactDirectory,
      choiceMindRoot: root,
      execute: async (request) => {
        if (request.command === "npm") environments.push(request.environment);
        return baseExecutor(request);
      }
    });

    await source.materializeNpmRelease({
      schemaVersion: 1,
      kind: "npm-release",
      version,
      packages: Object.fromEntries(
        CORE_MIND_PACKAGE_NAMES.map((name) => [name, { integrity: npmIntegrity(name, version) }])
      ) as Record<(typeof CORE_MIND_PACKAGE_NAMES)[number], { integrity: string }>
    });

    expect(environments).not.toHaveLength(0);
    const caches = new Set(environments.map((environment) => environment?.npm_config_cache));
    const userConfigs = new Set(
      environments.map((environment) => environment?.npm_config_userconfig)
    );
    const globalConfigs = new Set(
      environments.map((environment) => environment?.npm_config_globalconfig)
    );
    expect(caches.size).toBe(1);
    expect(userConfigs.size).toBe(1);
    expect(globalConfigs.size).toBe(1);
    const cache = [...caches][0];
    const userConfig = [...userConfigs][0];
    const globalConfig = [...globalConfigs][0];
    expect(cache).toMatch(/^.+[\\/]\.npm-sandbox[\\/]cache$/u);
    expect(userConfig).toMatch(/^.+[\\/]\.npm-sandbox[\\/]userconfig$/u);
    expect(globalConfig).toMatch(/^.+[\\/]\.npm-sandbox[\\/]globalconfig$/u);
    expect(path.resolve(cache ?? "").startsWith(path.resolve(artifactDirectory))).toBe(true);
    await expect(access(path.join(artifactDirectory, ".npm-sandbox"))).rejects.toThrow();
  });

  test("精确 RC 逐包核验 registry integrity 并下载八包", async () => {
    const root = await createTemporaryDirectory();
    const version = "0.3.1-rc.1";
    const packages = Object.fromEntries(
      CORE_MIND_PACKAGE_NAMES.map((name) => [name, { integrity: npmIntegrity(name, version) }])
    ) as Record<(typeof CORE_MIND_PACKAGE_NAMES)[number], { integrity: string }>;
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: createNpmCandidateExecutor(version)
    });

    const result = await source.materializeNpmRelease({
      schemaVersion: 1,
      kind: "npm-release",
      version,
      packages
    });

    expect(result.version).toBe(version);
    expect(result.packages).toHaveLength(8);
    expect(result.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "coremind-ai",
          integrity: packages["coremind-ai"].integrity,
          dependencies: expect.objectContaining({ "coremind-runtime": version })
        })
      ])
    );
  });

  test("tgz 内部稳定依赖不能被 registry metadata 掩盖", async () => {
    const root = await createTemporaryDirectory();
    const version = "0.3.1-rc.1";
    const packages = Object.fromEntries(
      CORE_MIND_PACKAGE_NAMES.map((name) => [
        name,
        {
          integrity: npmIntegrity(name, version, {
            packedCoreMindRuntimeVersion: "0.3.0"
          })
        }
      ])
    ) as Record<(typeof CORE_MIND_PACKAGE_NAMES)[number], { integrity: string }>;
    const compatibilitySystem = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: createNpmCandidateExecutor(version, {
        packedCoreMindRuntimeVersion: "0.3.0"
      })
    });
    const source = {
      ...compatibilitySystem,
      describeEnvironment: async () => ({
        choiceMindCommit: "b".repeat(40),
        nodeVersion: "22.22.1",
        workspacePackageManager: "pnpm@11.21.0",
        artifactPackageManager: "npm@10.9.4"
      })
    };

    await expect(
      runCoreMindCompatibility(
        { schemaVersion: 1, kind: "npm-release", version, packages },
        source
      )
    ).rejects.toMatchObject({ gate: "B", code: "ATOMIC_ASSEMBLY_INVALID" });
  });

  test("tgz peerDependencies 中的稳定 CoreMind 包回退失败关闭", async () => {
    const root = await createTemporaryDirectory();
    const version = "0.3.1-rc.1";
    const options = { packedCoreMindRuntimePeerVersion: "0.3.0" };
    const packages = Object.fromEntries(
      CORE_MIND_PACKAGE_NAMES.map((name) => [
        name,
        { integrity: npmIntegrity(name, version, options) }
      ])
    ) as Record<(typeof CORE_MIND_PACKAGE_NAMES)[number], { integrity: string }>;
    const compatibilitySystem = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: createNpmCandidateExecutor(version, options)
    });
    const source = {
      ...compatibilitySystem,
      describeEnvironment: async () => ({
        choiceMindCommit: "b".repeat(40),
        nodeVersion: "22.22.1",
        workspacePackageManager: "pnpm@11.21.0",
        artifactPackageManager: "npm@10.9.4"
      })
    };

    await expect(
      runCoreMindCompatibility(
        { schemaVersion: 1, kind: "npm-release", version, packages },
        source
      )
    ).rejects.toMatchObject({ gate: "B", code: "ATOMIC_ASSEMBLY_INVALID" });
  });
});

interface CompatibilityRunnerHarnessOptions {
  actualNodeVersion?: string;
  actualPnpmVersion?: string;
  commandTimeoutMs?: number;
  gateEPassedTests?: number;
  onHangStarted?: () => void;
  resolvedVersion?: string;
  shouldHang?: (request: CommandRequest) => boolean;
  shouldFail?: (request: CommandRequest) => boolean;
  signal?: AbortSignal;
}

async function createCompatibilityRunnerHarness(
  options: CompatibilityRunnerHarnessOptions = {}
) {
  const root = await createTemporaryDirectory();
  const artifactDirectory = path.join(root, "artifacts");
  const packageDirectory = path.join(artifactDirectory, "packages");
  const stableChoiceMindRoot = path.join(root, "stable-choice-mind");
  const stableMarkerPath = path.join(stableChoiceMindRoot, "stable.txt");
  const stablePackagePath = path.join(stableChoiceMindRoot, "package.json");
  const stableLockfilePath = path.join(stableChoiceMindRoot, "pnpm-lock.yaml");
  const stableNodeModulesMarkerPath = path.join(
    stableChoiceMindRoot,
    "node_modules",
    ".stable-marker"
  );
  const candidate = createMaterializedCandidate();
  const commands: string[] = [];
  const installedOverrides: Record<string, string> = {};
  const installEnvironment: Record<string, string> = {};
  let temporaryChoiceMindRoot = "";

  await mkdir(packageDirectory, { recursive: true });
  await mkdir(path.dirname(stableNodeModulesMarkerPath), { recursive: true });
  await writeFile(stableMarkerPath, "stable\n", "utf8");
  await writeFile(stablePackagePath, '{"name":"stable-choice-mind","private":true}\n', "utf8");
  await writeFile(stableLockfilePath, "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(stableNodeModulesMarkerPath, "stable-node-modules\n", "utf8");
  runGit(["init", "--quiet", stableChoiceMindRoot]);
  runGit([
    "-C",
    stableChoiceMindRoot,
    "add",
    "-f",
    "--",
    "package.json",
    "pnpm-lock.yaml",
    "stable.txt",
    "node_modules/.stable-marker"
  ]);
  runGit([
    "-C",
    stableChoiceMindRoot,
    "-c",
    "user.name=ChoiceMind Test",
    "-c",
    "user.email=choicemind-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "test baseline"
  ]);
  const stableWorkspaceBefore = await captureStableWorkspace(stableChoiceMindRoot);
  for (const artifact of candidate.packages) {
    const bytes = Buffer.from(artifact.name);
    artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(packageDirectory, artifact.fileName), bytes);
  }

  const source = createSystemCompatibilitySystem({
    artifactDirectory,
    choiceMindRoot: stableChoiceMindRoot,
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    execute: async (request) => {
      commands.push(`${request.command} ${request.args.join(" ")}`);
      if (request.command === "git" && request.args[0] === "clone") {
        temporaryChoiceMindRoot = request.args.at(-1) ?? "";
        await mkdir(path.join(temporaryChoiceMindRoot, "apps", "orchestrator"), {
          recursive: true
        });
        await writeFile(
          path.join(temporaryChoiceMindRoot, "package.json"),
          `${JSON.stringify({ name: "choicemind", private: true })}\n`,
          "utf8"
        );
        await writeFile(
          path.join(temporaryChoiceMindRoot, "apps", "orchestrator", "package.json"),
          `${JSON.stringify({
            name: "@choicemind/orchestrator",
            dependencies: { "coremind-ai": "0.3.0" }
          })}\n`,
          "utf8"
        );
        return Buffer.alloc(0);
      }
      if (request.command === "git" && request.args.includes("rev-parse")) {
        return Buffer.from(`${"b".repeat(40)}\n`);
      }
      if (options.shouldFail?.(request)) {
        throw new Error("不得进入安全报告的原始命令错误");
      }
      if (options.shouldHang?.(request)) {
        options.onHangStarted?.();
        return new Promise<Buffer>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new Error("测试命令已中断")),
            { once: true }
          );
        });
      }
      if (request.command === "pnpm" && request.args[0] === "install") {
        const manifest = JSON.parse(
          await readFile(path.join(temporaryChoiceMindRoot, "package.json"), "utf8")
        ) as { pnpm?: { overrides?: Record<string, string> } };
        Object.assign(installedOverrides, manifest.pnpm?.overrides ?? {});
        Object.assign(installEnvironment, request.environment ?? {});
        return Buffer.alloc(0);
      }
      if (request.command === "node" && request.args[0] === "--version") {
        return Buffer.from(`${options.actualNodeVersion ?? "v22.22.1"}\n`);
      }
      if (request.command === "pnpm" && request.args[0] === "--version") {
        return Buffer.from(`${options.actualPnpmVersion ?? "11.21.0"}\n`);
      }
      if (request.command === "node" && request.args[0]?.endsWith("probe.mjs")) {
        return Buffer.from(
          JSON.stringify(
            candidate.packages
              .filter((artifact) => !["coremind-worker", "coremind-cli"].includes(artifact.name))
              .map((artifact) => ({
                name: artifact.name,
                version: options.resolvedVersion ?? artifact.version
              }))
          )
        );
      }
      if (request.command === "pnpm" && request.args.includes("--reporter=json")) {
        return Buffer.from(
          JSON.stringify({
            numPassedTests: request.args.includes("Gate E:")
              ? (options.gateEPassedTests ?? 2)
              : 14,
            numFailedTests: 0,
            success: true
          })
        );
      }
      return Buffer.alloc(0);
    }
  });

  return {
    artifactDirectory,
    candidate,
    commands,
    environment: {
      choiceMindCommit: "b".repeat(40),
      nodeVersion: "22.22.1",
      workspacePackageManager: "pnpm@11.21.0",
      artifactPackageManager: "npm@10.9.4"
    },
    installEnvironment,
    installedOverrides,
    source,
    stableChoiceMindRoot,
    stableMarkerPath,
    stableWorkspaceBefore,
    get temporaryChoiceMindRoot() {
      return temporaryChoiceMindRoot;
    }
  };
}

async function captureStableWorkspace(root: string) {
  const gitHead = runGit(["-C", root, "rev-parse", "HEAD"]).trim();
  const gitStatus = runGit(["-C", root, "status", "--short", "--untracked-files=all"]);
  return {
    gitHead,
    gitStatus,
    lockfile: await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"),
    nodeModulesMarker: await readFile(path.join(root, "node_modules", ".stable-marker"), "utf8"),
    packageManifest: await readFile(path.join(root, "package.json"), "utf8")
  };
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("测试 Git 快照失败");
  return result.stdout;
}

async function expectStableWorkspaceUnchanged(
  harness: Awaited<ReturnType<typeof createCompatibilityRunnerHarness>>
): Promise<void> {
  await expect(captureStableWorkspace(harness.stableChoiceMindRoot)).resolves.toEqual(
    harness.stableWorkspaceBefore
  );
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "choicemind-coremind-system-test-"))
  );
  temporaryPaths.push(directory);
  return directory;
}

function createGitCandidateExecutor(): {
  execute: CommandExecutor;
  readonly sourceDirectory: string;
} {
  let sourceDirectory = "";

  return {
    get sourceDirectory() {
      return sourceDirectory;
    },
    execute: async (request: CommandRequest) => {
      if (request.command === "git" && request.args[0] === "init") {
        sourceDirectory = request.args[1] ?? "";
        await createCoreMindFixture(sourceDirectory, "0.3.0");
        return Buffer.alloc(0);
      }
      if (request.command === "git" && request.args.includes("rev-parse")) {
        return Buffer.from(`${commit}\n`);
      }
      if (request.command === "git" && request.args.includes("archive")) {
        return Buffer.from("deterministic-source-archive");
      }
      if (
        request.command === "node" &&
        request.args[0] === "scripts/release-version.mjs"
      ) {
        const version = request.args[1];
        if (!version) throw new Error("测试执行器缺少候选版本");
        await updateFixtureVersions(sourceDirectory, version);
        return Buffer.alloc(0);
      }
      if (request.command === "npm" && request.args[0] === "pack") {
        return packFixture(request, sourceDirectory);
      }
      return Buffer.alloc(0);
    }
  };
}

async function createCoreMindFixture(root: string, version: string): Promise<void> {
  for (const name of CORE_MIND_PACKAGE_NAMES) {
    const directory = name === "coremind-ai" ? "coremind" : name;
    const packageDirectory = path.join(root, "packages", directory);
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify({
        name,
        version,
        dependencies:
          name === "coremind-ai"
            ? {
                "coremind-config": version,
                "coremind-protocol": version,
                "coremind-runtime": version,
                "coremind-tools": version,
                "coremind-templates": version
              }
            : {}
      })}\n`,
      "utf8"
    );
  }
}

async function updateFixtureVersions(root: string, version: string): Promise<void> {
  const packageRoot = path.join(root, "packages");
  const directories = await import("node:fs/promises").then(({ readdir }) =>
    readdir(packageRoot)
  );
  for (const directory of directories) {
    const manifestPath = path.join(packageRoot, directory, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
    };
    manifest.version = version;
    for (const name of Object.keys(manifest.dependencies)) {
      manifest.dependencies[name] = version;
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  }
}

async function packFixture(request: CommandRequest, sourceRoot: string): Promise<Buffer> {
  const workspaceIndex = request.args.indexOf("--workspace");
  const destinationIndex = request.args.indexOf("--pack-destination");
  const name = request.args[workspaceIndex + 1];
  const destination = request.args[destinationIndex + 1];
  if (!name || !destination) throw new Error("测试执行器缺少 npm pack 参数");
  const directory = name === "coremind-ai" ? "coremind" : name;
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, "packages", directory, "package.json"), "utf8")
  ) as { name: string; version: string; dependencies: Record<string, string> };
  const fileName = `${name}-${manifest.version}.tgz`;
  const bytes = createPackageTarball(manifest);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, fileName), bytes);
  return Buffer.from(
    JSON.stringify([
      {
        name,
        version: manifest.version,
        filename: fileName,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
      }
    ])
  );
}

interface NpmCandidateFixtureOptions {
  packedCoreMindRuntimeVersion?: string;
  packedCoreMindRuntimePeerVersion?: string;
}

function createNpmCandidateExecutor(
  version: string,
  options: NpmCandidateFixtureOptions = {}
): CommandExecutor {
  return async (request) => {
    if (request.command !== "npm") return Buffer.alloc(0);
    if (request.args[0] === "view") {
      const name = packageNameFromSpecifier(request.args[1], version);
      return Buffer.from(
        JSON.stringify({
          name,
          version,
          dist: { integrity: npmIntegrity(name, version, options) },
          dependencies:
            name === "coremind-ai"
              ? {
                  "coremind-config": version,
                  "coremind-protocol": version,
                  "coremind-runtime": version,
                  "coremind-tools": version,
                  "coremind-templates": version
                }
              : {},
          peerDependencies:
            name === "coremind-ai" && options.packedCoreMindRuntimePeerVersion
              ? { "coremind-runtime": options.packedCoreMindRuntimePeerVersion }
              : {}
        })
      );
    }
    if (request.args[0] === "pack") {
      const name = packageNameFromSpecifier(request.args[1], version);
      const destinationIndex = request.args.indexOf("--pack-destination");
      const destination = request.args[destinationIndex + 1];
      if (!destination) throw new Error("测试执行器缺少 npm pack 目录");
      const fileName = `${name}-${version}.tgz`;
      const bytes = createPackageTarball({
        name,
        version,
        dependencies:
          name === "coremind-ai"
            ? {
                "coremind-config": version,
                "coremind-protocol": version,
                "coremind-runtime": options.packedCoreMindRuntimeVersion ?? version,
                "coremind-tools": version,
                "coremind-templates": version
              }
            : {},
        peerDependencies:
          name === "coremind-ai" && options.packedCoreMindRuntimePeerVersion
            ? { "coremind-runtime": options.packedCoreMindRuntimePeerVersion }
            : {}
      });
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, fileName), bytes);
      return Buffer.from(
        JSON.stringify([
          {
            name,
            version,
            filename: fileName,
            integrity: npmIntegrity(name, version, options)
          }
        ])
      );
    }
    return Buffer.alloc(0);
  };
}

function packageNameFromSpecifier(specifier: string | undefined, version: string): string {
  if (!specifier?.endsWith(`@${version}`)) throw new Error("测试执行器收到非精确版本");
  return specifier.slice(0, -version.length - 1);
}

function npmIntegrity(
  name: string,
  version: string,
  options: NpmCandidateFixtureOptions = {}
): string {
  const bytes = createPackageTarball({
    name,
    version,
    dependencies:
      name === "coremind-ai"
        ? {
            "coremind-config": version,
            "coremind-protocol": version,
            "coremind-runtime": options.packedCoreMindRuntimeVersion ?? version,
            "coremind-tools": version,
            "coremind-templates": version
          }
        : {},
    peerDependencies:
      name === "coremind-ai" && options.packedCoreMindRuntimePeerVersion
        ? { "coremind-runtime": options.packedCoreMindRuntimePeerVersion }
        : {}
  });
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function createPackageTarball(manifest: {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
}): Buffer {
  const content = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, "package/package.json");
  writeTarText(header, 100, 8, "0000644\0");
  writeTarText(header, 108, 8, "0000000\0");
  writeTarText(header, 116, 8, "0000000\0");
  writeTarText(header, 124, 12, `${content.length.toString(8).padStart(11, "0")}\0`);
  writeTarText(header, 136, 12, "00000000000\0");
  header.fill(32, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

function writeTarText(
  target: Buffer,
  offset: number,
  length: number,
  value: string
): void {
  target.write(value, offset, length, "ascii");
}

async function waitForProcessIds(pidPath: string, expectedCount = 2): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(pidPath, "utf8")) as unknown;
      if (
        Array.isArray(value) &&
        value.length === expectedCount &&
        value.every((pid) => Number.isSafeInteger(pid) && pid > 0)
      ) {
        return value as number[];
      }
    } catch {
      // 子进程尚未写出 PID。
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("测试进程未及时写出 PID");
}

async function waitUntilProcessesExit(pids: number[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pids.every((pid) => !isProcessAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`取消返回后仍有进程存活：${pids.filter(isProcessAlive).join(",")}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createInterruptibleExecutor(): {
  execute: CommandExecutor;
  readonly sourceDirectory: string;
  readonly started: Promise<void>;
} {
  let sourceDirectory = "";
  let initialized = false;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    get sourceDirectory() {
      return sourceDirectory;
    },
    started,
    execute: async (request) => {
      if (!initialized && request.command === "git" && request.args[0] === "init") {
        initialized = true;
        sourceDirectory = request.args[1] ?? "";
        await createCoreMindFixture(sourceDirectory, "0.3.0");
        markStarted?.();
        return Buffer.alloc(0);
      }
      return new Promise<Buffer>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(new Error(request.signal?.reason === "timeout" ? "命令超时" : "命令已取消")),
          { once: true }
        );
      });
    }
  };
}
