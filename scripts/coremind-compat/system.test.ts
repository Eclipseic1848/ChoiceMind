import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test, vi } from "vitest";

import { CORE_MIND_PACKAGE_NAMES, runCoreMindCompatibility } from "./index.js";
import { setTrustedPnpmContentSha512ForTest } from "./pnpm-trust.js";
import { createMaterializedCandidate } from "./test-fixtures.js";
import {
  materializeWithReuse,
  type MaterializationPermissionFileSystem,
  type MaterializationStageDeadline
} from "./materialization.js";
import {
  createSystemCompatibilitySystem as createSystemCompatibilitySystemImpl,
  executeSystemCommand,
  type CommandExecutor,
  type CommandRequest,
  type SystemCompatibilityOptions
} from "./system.js";

vi.setConfig({ testTimeout: 15_000 });

const commit = "57e5765471cf6fe7f7da14d9ed4882e0c53ec322";
const trustedPnpmCorepackHash =
  "sha512.521705bce689924eac72f5a3587122f362689ef6571e55ba80076fd637c11132ecffada26fad4ea79c485bfddbfd3d5a2a5b05805a77e893de71ec8a6cca3bb1";
const trustedPnpmFixtureContentSha512 =
  "sha512.58f03cfe26af8947ea1ab55f0acce648aa210fcb8c8b0d57cecc556b026147b369a5eb7472ddfa7551eda846f54d74e495e5044df9d662f08c81144267ae280f";
const temporaryPaths: string[] = [];
const materializationProcesses = new Set<{
  child: ReturnType<typeof spawn>;
  closed: Promise<void>;
  completion: Promise<void>;
}>();

function createSystemCompatibilitySystem(
  options: Omit<SystemCompatibilityOptions, "materializationAllowedRoot"> & {
    materializationAllowedRoot?: string;
  }
) {
  const artifactRoot = path.parse(path.resolve(options.artifactDirectory)).root;
  options.materializationAllowedRoot ??= artifactRoot;
  return createSystemCompatibilitySystemImpl(options as SystemCompatibilityOptions);
}

afterEach(async () => {
  const activeProcesses = [...materializationProcesses];
  await Promise.all(activeProcesses.map(stopMaterializationProcess));
  await Promise.allSettled(activeProcesses.map(({ completion }) => completion));
  materializationProcesses.clear();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((temporaryPath) => rm(temporaryPath, { force: true, recursive: true }))
  );
});

test("真实命令不继承宿主秘密或 PowerShell 模块路径且能完成清理", async () => {
  vi.stubEnv("CHOICEMIND_TEST_HOST_SECRET", "synthetic-secret");
  try {
    const output = await executeSystemCommand({
      command: "node",
      args: [
        "-e",
        'process.stdout.write(JSON.stringify([process.env.CHOICEMIND_TEST_HOST_SECRET ?? null, process.env.PSModulePath ?? null]));'
      ]
    });
    expect(JSON.parse(output.toString("utf8"))).toEqual([null, null]);
  } finally {
    vi.unstubAllEnvs();
  }
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
    "setInterval(() => {}, 1000);"
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

test("真实命令把隔离目录写入识别为安全进度", async () => {
  const root = await createTemporaryDirectory();
  const progressDirectory = path.join(root, "cache");
  await mkdir(progressDirectory, { recursive: true });
  let progressCount = 0;
  const script = [
    'const { writeFileSync } = require("node:fs");',
    "let index = 0;",
    "const timer = setInterval(() => {",
    '  writeFileSync(process.argv[1] + "/" + index + ".bin", "progress");',
    "  index += 1;",
    "  if (index === 3) { clearInterval(timer); setTimeout(() => {}, 25); }",
    "}, 25);"
  ].join("");

  await executeSystemCommand({
    command: "node",
    args: ["-e", script, progressDirectory.replaceAll("\\", "/")],
    progressPaths: [progressDirectory],
    reportProgress: () => {
      progressCount += 1;
    }
  });

  expect(progressCount).toBeGreaterThan(0);
});

test("普通命令即使输出网络标记也不误报依赖网络失败", async () => {
  let failure: unknown;
  try {
    await executeSystemCommand({
      command: "node",
      args: [
        "-e",
        'process.stderr.write("ERR_PNPM_META_FETCH_FAIL private-token"); process.exit(1);'
      ]
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({
    reason: "COMMAND_FAILED",
    diagnosticCodes: ["ERR_PNPM_META_FETCH_FAIL"]
  });
  expect(JSON.stringify(failure)).not.toContain("private-token");
});

test("真实命令只在明确的依赖网络阶段分类网络失败", async () => {
  let failure: unknown;
  try {
    await executeSystemCommand({
      command: "node",
      args: [
        "-e",
        'process.stderr.write("ERR_PNPM_META_FETCH_FAIL private-token"); process.exit(1);'
      ],
      classifyNetworkFailure: true
    } as CommandRequest & { classifyNetworkFailure: boolean });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({
    reason: "NETWORK_FAILED",
    diagnosticCodes: ["ERR_PNPM_META_FETCH_FAIL"]
  });
  expect(JSON.stringify(failure)).not.toContain("private-token");
});

test("真实命令只从 pnpm ndjson 提取受限 fetch 错误码", async () => {
  let failure: unknown;
  try {
    await executeSystemCommand({
      command: "node",
      args: [
        "-e",
        `process.stderr.write(JSON.stringify({ level: "error", name: "pnpm", code: "ERR_PNPM_FETCH_502", err: { message: "https://private.example/token" } })); process.exit(1);`
      ],
      classifyNetworkFailure: true
    } as CommandRequest & { classifyNetworkFailure: boolean });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({
    reason: "NETWORK_FAILED",
    diagnosticCodes: ["ERR_PNPM_FETCH_502"]
  });
  expect(JSON.stringify(failure)).not.toContain("private.example");
  expect(JSON.stringify(failure)).not.toContain("token");
});

test("真实命令在长日志挤出诊断环形缓冲后仍保留 pnpm 错误码", async () => {
  let failure: unknown;
  try {
    await executeSystemCommand({
      command: "node",
      args: [
        "-e",
        `process.stderr.write(JSON.stringify({ level: "error", name: "pnpm", code: "ERR_PNPM_BROKEN_LOCKFILE", err: { message: "private-token" } }) + "\n"); process.stderr.write("x".repeat(70 * 1024)); process.exit(1);`
      ]
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({
    reason: "COMMAND_FAILED",
    diagnosticCodes: ["ERR_PNPM_BROKEN_LOCKFILE"]
  });
  expect(JSON.stringify(failure)).not.toContain("private-token");
});

test("真实命令 stdout 超过统一上限时失败关闭", async () => {
  await expect(
    executeSystemCommand({
      command: "node",
      args: ["-e", 'process.stdout.write("x".repeat(5 * 1024 * 1024));']
    })
  ).rejects.toMatchObject({ reason: "COMMAND_FAILED" });
});

test("真实命令只在显式接受时返回非零退出码的 stdout", async () => {
  const output = await executeSystemCommand({
    command: "node",
    args: ["-e", 'process.stdout.write("safe-json"); process.exit(1);'],
    acceptedExitCodes: [1]
  } as CommandRequest & { acceptedExitCodes: number[] });

  expect(output.toString("utf8")).toBe("safe-json");
});

test("真实命令把隔离文件等长覆盖识别为持续进度", async () => {
  const root = await createTemporaryDirectory();
  const progressDirectory = path.join(root, "cache");
  const progressFile = path.join(progressDirectory, "same-size.bin");
  await mkdir(progressDirectory, { recursive: true });
  await writeFile(progressFile, "00000000", "utf8");
  let progressCount = 0;
  const script = [
    'const { writeFileSync } = require("node:fs");',
    "let index = 0;",
    "const timer = setInterval(() => {",
    '  writeFileSync(process.argv[1], String(index).padStart(8, "0"));',
    "  index += 1;",
    "  if (index === 6) { clearInterval(timer); setTimeout(() => {}, 100); }",
    "}, 50);"
  ].join("");

  await executeSystemCommand({
    command: "node",
    args: ["-e", script, progressFile.replaceAll("\\", "/")],
    progressPaths: [progressDirectory],
    reportProgress: () => {
      progressCount += 1;
    }
  });

  expect(progressCount).toBeGreaterThan(1);
});

test("隔离目录没有增长时噪声输出不计为安全进度", async () => {
  const root = await createTemporaryDirectory();
  const progressDirectory = path.join(root, "cache");
  await mkdir(progressDirectory, { recursive: true });
  let progressCount = 0;
  const script = [
    "let count = 0;",
    "const timer = setInterval(() => {",
    '  process.stderr.write("still waiting\\n");',
    "  count += 1;",
    "  if (count === 4) clearInterval(timer);",
    "}, 20);"
  ].join("");

  await executeSystemCommand({
    command: "node",
    args: ["-e", script],
    progressPaths: [progressDirectory],
    reportProgress: () => {
      progressCount += 1;
    }
  });

  expect(progressCount).toBe(0);
});

test("没有可验证进度路径时噪声输出同样不计为进度", async () => {
  let progressCount = 0;
  await executeSystemCommand({
    command: "node",
    args: ["-e", 'process.stdout.write("noise"); process.stderr.write("noise");'],
    reportProgress: () => {
      progressCount += 1;
    }
  });

  expect(progressCount).toBe(0);
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

test.each([
  ["artifactDirectory 为空白", { artifactDirectory: "   ", choiceMindRoot: "C:\\ChoiceMind" }],
  [
    "artifactDirectory 是相对路径",
    { artifactDirectory: "artifacts", choiceMindRoot: "C:\\ChoiceMind" }
  ],
  ["choiceMindRoot 为空白", { artifactDirectory: "C:\\artifacts", choiceMindRoot: "\t" }],
  [
    "choiceMindRoot 是相对路径",
    { artifactDirectory: "C:\\artifacts", choiceMindRoot: "ChoiceMind" }
  ]
] as const)("系统入口拒绝无效路径：%s", (_name, options) => {
  expect(() =>
    createSystemCompatibilitySystem({
      ...options,
      execute: async () => {
        throw new Error("无效路径不得进入外部命令");
      }
    })
  ).toThrow("必须是绝对路径");
});

test("系统入口拒绝允许根目录之外的物化写入路径", async () => {
  const root = await createTemporaryDirectory();
  await mkdir(path.join(root, "allowed"), { recursive: true });
  expect(() =>
    createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "allowed", "run"),
      choiceMindRoot: root,
      materializationAllowedRoot: path.join(root, "allowed"),
      materializationDirectory: path.join(root, "outside")
    })
  ).toThrow("必须位于允许根目录内");
});

test("系统入口要求显式提供物化允许根目录", () => {
  expect(() =>
    createSystemCompatibilitySystemImpl({
      artifactDirectory: "C:\\artifacts",
      choiceMindRoot: "C:\\ChoiceMind"
    } as SystemCompatibilityOptions)
  ).toThrow("materializationAllowedRoot 必须是绝对路径");
});

test("系统入口拒绝包含凭据的依赖 registry", () => {
  expect(() =>
    createSystemCompatibilitySystem({
      artifactDirectory: "C:\\artifacts",
      choiceMindRoot: "C:\\ChoiceMind",
      dependencyRegistry: "https://build-user:private-token@registry.example.com/"
    })
  ).toThrow("registry URL 不得包含凭据");
});

test.each(["mkdir", "writeFile", "rename", "rm"] as const)(
  "物化预检把 %s 权限失败稳定归类为 PERMISSION_DENIED",
  async (operation) => {
    const root = await createTemporaryDirectory();
    const permissionFileSystem: Partial<MaterializationPermissionFileSystem> = {};
    if (operation === "mkdir") {
      permissionFileSystem.mkdir = async () => {
        throw permissionError("EACCES");
      };
    } else if (operation === "writeFile") {
      permissionFileSystem.writeFile = async () => {
        throw permissionError("EACCES");
      };
    } else if (operation === "rename") {
      permissionFileSystem.rename = async () => {
        throw permissionError("EACCES");
      };
    } else {
      permissionFileSystem.rm = async (target, options) => {
        if (!options?.recursive) throw permissionError("EACCES");
        await rm(target, options);
      };
    }

    await expect(runPermissionPreflight(root, permissionFileSystem)).rejects.toMatchObject({
      stage: "MATERIALIZATION_PREFLIGHT",
      reason: "PERMISSION_DENIED"
    });
  }
);

test("物化预检同时保留主权限失败与清理权限失败", async () => {
  const root = await createTemporaryDirectory();
  await expect(
    runPermissionPreflight(root, {
      writeFile: async () => {
        throw permissionError("EACCES");
      },
      rm: async () => {
        throw permissionError("EPERM");
      }
    })
  ).rejects.toMatchObject({
    stage: "MATERIALIZATION_PREFLIGHT",
    reason: "PERMISSION_DENIED",
    cleanupFailure: { stage: "CLEANUP", reason: "PERMISSION_DENIED" }
  });
});

test("物化预检单独的清理权限失败归类到 CLEANUP", async () => {
  const root = await createTemporaryDirectory();
  await expect(
    runPermissionPreflight(root, {
      rm: async (target, options) => {
        if (options?.recursive) throw permissionError("EPERM");
        await rm(target, options);
      }
    })
  ).rejects.toMatchObject({
    stage: "CLEANUP",
    reason: "PERMISSION_DENIED"
  });
});

test.runIf(process.platform === "win32")("系统入口拒绝通过 junction 绕过允许根目录", async () => {
  const root = await createTemporaryDirectory();
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  const junction = path.join(allowed, "linked-outside");
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, junction, "junction");

  expect(() =>
    createSystemCompatibilitySystemImpl({
      artifactDirectory: path.join(junction, "run"),
      choiceMindRoot: root,
      materializationAllowedRoot: allowed
    })
  ).toThrow("必须位于允许根目录内");
});

test.each([
  ["hard deadline 为零", { hardDeadlineMs: 0, idleTimeoutMs: 10 }],
  ["idle timeout 为零", { hardDeadlineMs: 10, idleTimeoutMs: 0 }],
  ["hard deadline 不是整数", { hardDeadlineMs: 10.5, idleTimeoutMs: 5 }]
] as const)("系统入口拒绝无效阶段超时：%s", (_name, policy) => {
  expect(() =>
    createSystemCompatibilitySystem({
      artifactDirectory: "C:\\artifacts",
      choiceMindRoot: "C:\\ChoiceMind",
      stageTimeouts: { NPM_CI: policy }
    })
  ).toThrow("阶段超时策略必须使用正整数毫秒");
});

test("默认候选安装允许慢速活跃下载，同时保留空闲超时", () => {
  const source = createSystemCompatibilitySystem({
    artifactDirectory: "C:\\artifacts",
    choiceMindRoot: "C:\\ChoiceMind"
  });

  expect(source.compatibilityPolicy?.stageTimeouts.CANDIDATE_INSTALL).toEqual({
    hardDeadlineMs: 6 * 60 * 60_000,
    idleTimeoutMs: 11 * 60_000
  });
});

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

test("环境报告记录规范化的依赖 registry", async () => {
  const root = await createTemporaryDirectory();
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ packageManager: "pnpm@11.21.0" })}\n`,
    "utf8"
  );
  const source = createSystemCompatibilitySystem({
    artifactDirectory: path.join(root, "artifacts"),
    choiceMindRoot: root,
    dependencyRegistry: "https://registry.npmmirror.com",
    execute: async (request) => {
      if (request.command === "git") return Buffer.from(`${"b".repeat(40)}\n`);
      if (request.command === "npm" && request.args[0] === "--version") {
        return Buffer.from("10.9.4\n");
      }
      throw new Error("测试收到非环境探测命令");
    }
  });

  await expect(source.describeEnvironment()).resolves.toMatchObject({
    compatibilityPolicy: {
      dependencyRegistry: "https://registry.npmmirror.com/",
      dependencyFetch: {
        fetchRetries: 5,
        installConcurrency: 1,
        networkConcurrency: 1
      }
    }
  });
});

test("Gate C 默认 idle 门禁覆盖完整 pnpm 慢网重试包络", async () => {
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
      if (request.command === "git") return Buffer.from(`${commit}\n`);
      if (request.command === "npm" && request.args[0] === "--version") {
        return Buffer.from("10.9.4\n");
      }
      throw new Error("测试收到非环境探测命令");
    }
  });

  await expect(source.describeEnvironment()).resolves.toMatchObject({
    compatibilityPolicy: {
      dependencyFetch: {
        fetchRetries: 5,
        fetchRetryFactor: 10,
        fetchRetryMinTimeoutMs: 10_000,
        fetchRetryMaxTimeoutMs: 60_000,
        fetchTimeoutMs: 60_000
      },
      stageTimeouts: {
        CANDIDATE_INSTALL: {
          hardDeadlineMs: 21_600_000,
          idleTimeoutMs: 660_000
        }
      }
    }
  });
});

test("候选六包只在临时 ChoiceMind 副本中解析并通过 Gate C-F", async () => {
  const root = await createTemporaryDirectory();
  const artifactDirectory = path.join(root, "artifacts");
  const packageDirectory = path.join(artifactDirectory, "packages");
  const corepackHome = path.join(root, "corepack-home");
  await createCorepackPnpmFixture(corepackHome, "11.21.0");
  const candidate = createMaterializedCandidate();
  const resolvedContentSha256 = new Map<string, string>();
  for (const artifact of candidate.packages) {
    const manifest = {
      name: artifact.name,
      version: artifact.version,
      dependencies: artifact.dependencies,
      peerDependencies: artifact.peerDependencies
    };
    const bytes = createPackageTarball(manifest);
    artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
    artifact.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    resolvedContentSha256.set(artifact.name, packageContentSha256(manifest));
  }
  await mkdir(packageDirectory, { recursive: true });
  await Promise.all(
    candidate.packages.map((artifact) =>
      writeFile(
        path.join(packageDirectory, artifact.fileName),
        createPackageTarball({
          name: artifact.name,
          version: artifact.version,
          dependencies: artifact.dependencies,
          peerDependencies: artifact.peerDependencies
        })
      )
    )
  );
  let temporaryChoiceMindRoot = "";
  const commands: string[] = [];
  const vitestResultPaths: string[] = [];
  const systemOptions = {
    artifactDirectory,
    choiceMindRoot: path.join(root, "stable-choice-mind"),
    corepackHome,
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
        const probeChoiceMindRoot = path.resolve(request.cwd ?? "", "..", "..");
        return Buffer.from(
          JSON.stringify(
            candidate.packages
              .filter((artifact) => !["coremind-worker", "coremind-cli"].includes(artifact.name))
              .map((artifact) => ({
                name: artifact.name,
                version: artifact.version,
                location: path.join(probeChoiceMindRoot, "node_modules", artifact.name),
                contentSha256: resolvedContentSha256.get(artifact.name),
                resolvedDependencies: Object.keys(artifact.dependencies).map((name) => ({
                  name,
                  location: path.join(probeChoiceMindRoot, "node_modules", name)
                }))
              }))
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
        const result = JSON.stringify({
          numPassedTests: request.args.includes("Gate E:") ? 2 : 14,
          numFailedTests: 0,
          numPendingTests: 0,
          success: true
        });
        const outputFileIndex = request.args.indexOf("--outputFile");
        if (outputFileIndex >= 0) {
          const outputFile = request.args[outputFileIndex + 1];
          if (!outputFile || !request.cwd) throw new Error("测试缺少 Vitest 结果文件路径");
          if (!path.isAbsolute(outputFile)) throw new Error("Vitest 结果文件必须使用绝对路径");
          const resultPath = path.resolve(request.cwd, outputFile);
          vitestResultPaths.push(resultPath);
          await writeFile(resultPath, result, "utf8");
        }
        return Buffer.from(`污染 stdout\n${result}`);
      }
      return Buffer.alloc(0);
    }
  } satisfies Parameters<typeof createSystemCompatibilitySystem>[0];
  setTrustedPnpmContentSha512ForTest(systemOptions, trustedPnpmFixtureContentSha512);
  const source = createSystemCompatibilitySystem(systemOptions);

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
  expect(vitestResultPaths).toHaveLength(3);
  expect(commands).toEqual(
    expect.arrayContaining([
      expect.stringContaining("git clone --no-hardlinks --no-checkout"),
      expect.stringContaining("pnpm install"),
      expect.stringContaining("pnpm --filter @choicemind/orchestrator typecheck"),
      expect.stringContaining("pnpm --filter @choicemind/orchestrator... build"),
      expect.stringContaining("--testNamePattern Gate D: --reporter=json"),
      expect.stringContaining("--testNamePattern Gate E: --reporter=json"),
      expect.stringContaining("pnpm verify"),
      expect.stringContaining("node -e")
    ])
  );
  await expect(access(temporaryChoiceMindRoot)).rejects.toThrow();
  await expect(access(path.join(artifactDirectory, ".pnpm-runner-sandbox"))).rejects.toThrow();
});

test("Gate G 在候选隔离工作区执行冻结的本地 Qwen 合成 Tool 冒烟", async () => {
  const harness = await createCompatibilityRunnerHarness({
    localModelGate: {
      providerBaseUrl: "http://192.168.121.32:6013/v1",
      model: "Qwen3.8-27B"
    },
    localModelSmokeOutput: {
      ok: true,
      executedAt: "2026-08-23T20:00:00.000Z",
      synthetic: true,
      scope: "INTEGRATION_SMOKE_ONLY",
      provider: {
        endpoint: "http://192.168.121.32:6013/v1",
        model: "Qwen3.8-27B"
      },
      taskState: "COMPLETED",
      decisionStatus: "NEED_MORE_INFO",
      eventStates: ["CREATED", "COMPLETED"],
      providerObservations: {
        requestCount: 2,
        responseStatuses: [200, 200],
        finishReasons: ["tool_calls", "stop"],
        toolNames: ["submit_decision_draft"],
        toolArgumentsJsonValid: [true],
        toolArgumentsMatchExpected: [true]
      }
    }
  });

  const result = await harness.source.verifyCandidateCompatibility(
    harness.candidate,
    harness.environment
  );

  expect(result.localModelSmoke).toEqual({
    endpoint: "http://192.168.121.32:6013/v1",
    model: "Qwen3.8-27B",
    executedAt: "2026-08-23T20:00:00.000Z",
    evidenceNonce: expect.any(String),
    synthetic: true,
    scope: "INTEGRATION_SMOKE_ONLY",
    requestCount: 2,
    toolName: "submit_decision_draft",
    decisionStatus: "NEED_MORE_INFO"
  });
  expect(harness.commands).toContain(
    "pnpm --filter @choicemind/orchestrator smoke:coremind:qwen"
  );
  expect(harness.localModelEnvironment).toMatchObject({
    CHOICEMIND_COREMIND_PROVIDER_BASE_URL: "http://192.168.121.32:6013/v1",
    CHOICEMIND_COREMIND_MODEL: "Qwen3.8-27B",
    CHOICEMIND_COREMIND_SMOKE_NONCE: expect.any(String),
    CHOICEMIND_COREMIND_SMOKE_SUMMARY_PATH: expect.any(String)
  });
  expect(harness.localModelEnvironment).not.toHaveProperty(
    "CHOICEMIND_COREMIND_PROVIDER_API_KEY"
  );
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate G 不得把本次运行前的旧摘要当作新证据", async () => {
  const validSummary = {
    ok: true,
    executedAt: "2026-08-23T20:00:00.000Z",
    synthetic: true,
    scope: "INTEGRATION_SMOKE_ONLY",
    provider: { endpoint: "http://192.168.121.32:6013/v1", model: "Qwen3.8-27B" },
    taskState: "COMPLETED",
    decisionStatus: "NEED_MORE_INFO",
    providerObservations: {
      requestCount: 2,
      responseStatuses: [200, 200],
      toolNames: ["submit_decision_draft"],
      toolArgumentsJsonValid: [true],
      toolArgumentsMatchExpected: [true]
    }
  };
  const harness = await createCompatibilityRunnerHarness({
    localModelGate: {
      providerBaseUrl: "http://192.168.121.32:6013/v1",
      model: "Qwen3.8-27B"
    },
    preexistingLocalModelSmokeOutput: validSummary,
    skipLocalModelSmokeWrite: true
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "G", stage: "LOCAL_MODEL_SMOKE" });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate G 拒绝不属于本次运行 nonce 的摘要", async () => {
  const harness = await createCompatibilityRunnerHarness({
    localModelGate: {
      providerBaseUrl: "http://192.168.121.32:6013/v1",
      model: "Qwen3.8-27B"
    },
    localModelSmokeOutput: {
      ok: true,
      executedAt: "2026-08-23T20:00:00.000Z",
      evidenceNonce: "stale-run-nonce",
      synthetic: true,
      scope: "INTEGRATION_SMOKE_ONLY",
      provider: { endpoint: "http://192.168.121.32:6013/v1", model: "Qwen3.8-27B" },
      taskState: "COMPLETED",
      decisionStatus: "NEED_MORE_INFO",
      providerObservations: {
        requestCount: 2,
        responseStatuses: [200, 200],
        toolNames: ["submit_decision_draft"],
        toolArgumentsJsonValid: [true],
        toolArgumentsMatchExpected: [true]
      }
    }
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "G", stage: "LOCAL_MODEL_SMOKE" });
  await expectStableWorkspaceUnchanged(harness);
});

test.each([
  ["空摘要", undefined],
  [
    "重复请求",
    {
      ok: true,
      executedAt: "2026-08-23T20:00:00.000Z",
      synthetic: true,
      scope: "INTEGRATION_SMOKE_ONLY",
      provider: { endpoint: "http://192.168.121.32:6013/v1", model: "Qwen3.8-27B" },
      taskState: "COMPLETED",
      decisionStatus: "NEED_MORE_INFO",
      providerObservations: {
        requestCount: 3,
        responseStatuses: [200, 200, 200],
        toolNames: ["submit_decision_draft"],
        toolArgumentsJsonValid: [true],
        toolArgumentsMatchExpected: [true]
      }
    }
  ],
  [
    "错误 Tool",
    {
      ok: true,
      executedAt: "2026-08-23T20:00:00.000Z",
      synthetic: true,
      scope: "INTEGRATION_SMOKE_ONLY",
      provider: { endpoint: "http://192.168.121.32:6013/v1", model: "Qwen3.8-27B" },
      taskState: "COMPLETED",
      decisionStatus: "NEED_MORE_INFO",
      providerObservations: {
        requestCount: 1,
        responseStatuses: [200],
        toolNames: ["other_tool"],
        toolArgumentsJsonValid: [true],
        toolArgumentsMatchExpected: [true]
      }
    }
  ],
  [
    "Tool 参数不匹配",
    {
      ok: true,
      executedAt: "2026-08-23T20:00:00.000Z",
      synthetic: true,
      scope: "INTEGRATION_SMOKE_ONLY",
      provider: { endpoint: "http://192.168.121.32:6013/v1", model: "Qwen3.8-27B" },
      taskState: "COMPLETED",
      decisionStatus: "NEED_MORE_INFO",
      providerObservations: {
        requestCount: 1,
        responseStatuses: [200],
        toolNames: ["submit_decision_draft"],
        toolArgumentsJsonValid: [true],
        toolArgumentsMatchExpected: [false]
      }
    }
  ],
  [
    "不安全 Decision",
    {
      ok: true,
      executedAt: "2026-08-23T20:00:00.000Z",
      synthetic: true,
      scope: "INTEGRATION_SMOKE_ONLY",
      provider: { endpoint: "http://192.168.121.32:6013/v1", model: "Qwen3.8-27B" },
      taskState: "COMPLETED",
      decisionStatus: "BUY_IF_PRICE",
      providerObservations: {
        requestCount: 1,
        responseStatuses: [200],
        toolNames: ["submit_decision_draft"],
        toolArgumentsJsonValid: [true],
        toolArgumentsMatchExpected: [true]
      }
    }
  ]
])("Gate G 对%s失败关闭", async (_case, localModelSmokeOutput) => {
  const harness = await createCompatibilityRunnerHarness({
    localModelGate: {
      providerBaseUrl: "http://192.168.121.32:6013/v1",
      model: "Qwen3.8-27B"
    },
    localModelSmokeOutput
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "G", stage: "LOCAL_MODEL_SMOKE" });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 拒绝版本相同但内容不属于候选制品的运行包", async () => {
  const harness = await createCompatibilityRunnerHarness({
    resolvedContentSha256: "f".repeat(64)
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "DEPENDENCY_RESOLUTION",
    reason: "CONTENT_MISMATCH",
    subject: { packageName: "coremind-ai" }
  });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 拒绝候选包内部依赖解析到另一份同名运行包", async () => {
  const harness = await createCompatibilityRunnerHarness({
    resolveCoreMindRuntimeFrom: "nested-foreign-coremind-runtime"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "DEPENDENCY_RESOLUTION",
    reason: "DEPENDENCY_GRAPH_MISMATCH",
    subject: { packageName: "coremind-ai", dependencyName: "coremind-runtime" }
  });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 的无主体解析失败不生成空 subject", async () => {
  const harness = await createCompatibilityRunnerHarness({
    dependencyProbeOutput: Buffer.from("{}")
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "DEPENDENCY_RESOLUTION",
    reason: "RESOLUTION_OUTPUT_INVALID",
    subject: undefined
  });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 解析主失败与清理失败同时保留", async () => {
  const harness = await createCompatibilityRunnerHarness({
    cleanupFailure: true,
    resolvedContentSha256: "f".repeat(64)
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "DEPENDENCY_RESOLUTION",
    reason: "CONTENT_MISMATCH",
    subject: { packageName: "coremind-ai" },
    cleanupFailure: { stage: "CLEANUP", reason: "PERMISSION_DENIED" },
    cleanupFailures: [{ stage: "CLEANUP", reason: "PERMISSION_DENIED" }]
  });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 将安装后不可读取的候选内容归类且不泄露主体", async () => {
  const harness = await createCompatibilityRunnerHarness({
    tamperCandidateContentBeforeResolution: true
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "DEPENDENCY_RESOLUTION",
    reason: "CANDIDATE_CONTENT_INVALID",
    subject: undefined
  });
  await expectStableWorkspaceUnchanged(harness);
});

test.each([
  [
    "缺少候选运行包",
    (items: Array<Record<string, unknown>>) =>
      items.filter((item) => item.name !== "coremind-tools"),
    "PACKAGE_IDENTITY_INVALID",
    { packageName: "coremind-tools" }
  ],
  [
    "出现未知包名",
    (items: Array<Record<string, unknown>>) => [
      ...items,
      { ...items[0], name: "attacker-controlled-package" }
    ],
    "UNKNOWN_PACKAGE",
    undefined
  ],
  [
    "候选版本回退",
    (items: Array<Record<string, unknown>>) =>
      items.map((item) => (item.name === "coremind-ai" ? { ...item, version: "0.3.0" } : item)),
    "VERSION_MISMATCH",
    { packageName: "coremind-ai" }
  ],
  [
    "解析路径不是绝对路径",
    (items: Array<Record<string, unknown>>) =>
      items.map((item) =>
        item.name === "coremind-ai" ? { ...item, location: "relative/coremind-ai" } : item
      ),
    "PATH_INVALID",
    { packageName: "coremind-ai" }
  ],
  [
    "绝对解析路径逃出隔离工作区",
    (items: Array<Record<string, unknown>>) =>
      items.map((item) =>
        item.name === "coremind-ai"
          ? {
              ...item,
              location: path.join(path.parse(process.cwd()).root, "outside-coremind-ai")
            }
          : item
      ),
    "PATH_INVALID",
    { packageName: "coremind-ai" }
  ]
] as const)("Gate C 安全归类：%s", async (_name, dependencyProbeTransform, reason, subject) => {
  const harness = await createCompatibilityRunnerHarness({
    dependencyProbeTransform
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "DEPENDENCY_RESOLUTION",
    reason,
    subject
  });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 可在 pnpm 严格布局中沿 coremind-ai 依赖解析全部候选运行包", async () => {
  const harness = await createCompatibilityRunnerHarness({
    runRealDependencyProbe: true
  });

  const result = await harness.source.verifyCandidateCompatibility(
    harness.candidate,
    harness.environment
  );

  expect(result.resolvedRuntimePackages).toEqual([
    { name: "coremind-ai", version: harness.candidate.version },
    { name: "coremind-config", version: harness.candidate.version },
    { name: "coremind-protocol", version: harness.candidate.version },
    { name: "coremind-runtime", version: harness.candidate.version },
    { name: "coremind-tools", version: harness.candidate.version },
    { name: "coremind-templates", version: harness.candidate.version }
  ]);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 实际加载 coremind-ai 公开入口并拒绝缺失的导出目标", async () => {
  const harness = await createCompatibilityRunnerHarness({
    runRealDependencyProbe: true,
    coreMindAiEntrypoint: "missing"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "DEPENDENCY_RESOLUTION",
    reason: "COMMAND_FAILED"
  });
  expect(harness.commands.some((command) => command.includes("Gate D:"))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate F 拒绝非锁定的 Node 版本", async () => {
  const harness = await createCompatibilityRunnerHarness({
    actualNodeVersion: "v22.21.0"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "F", stage: "ROOT_VERIFY" });
  expect(harness.commands).not.toContain("pnpm verify");
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate E 零项实际通过时即使 Vitest 成功退出也失败关闭", async () => {
  const harness = await createCompatibilityRunnerHarness({
    gateEPassedTests: 0
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "E", stage: "VERTICAL_TEST" });
  await expect(access(harness.temporaryChoiceMindRoot)).rejects.toThrow();
  await expect(
    access(path.join(harness.artifactDirectory, ".pnpm-runner-sandbox"))
  ).rejects.toThrow();
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate D 只报告固定测试名而不泄露失败消息", async () => {
  const failedTest =
    "CoreMind AgentRuntimeRunPort Gate D: runs through the public CoreMind HTTP/SSE and Tool path before finalizing a Decision";
  const harness = await createCompatibilityRunnerHarness({ gateDAdapterFailureName: failedTest });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "D",
    stage: "CONTRACT_TEST",
    reason: "TEST_FAILED",
    subject: {
      verificationStep: "COREMIND_ADAPTER_CONTRACT",
      failedTests: [failedTest]
    }
  });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate D 将 suite 加载失败归类为测试失败且只报告相对测试文件", async () => {
  const harness = await createCompatibilityRunnerHarness({ gateDAdapterSuiteFailure: true });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "D",
    stage: "CONTRACT_TEST",
    reason: "TEST_FAILED",
    subject: {
      verificationStep: "COREMIND_ADAPTER_CONTRACT",
      failedTests: ["src/runtime/coremind-agent-runtime-adapter.test.ts"],
      testFailureKinds: ["EXPORT_NOT_FOUND"]
    }
  });
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate D 只报告经过校验的缺失包名且不泄露导入路径", async () => {
  const harness = await createCompatibilityRunnerHarness({
    gateDAdapterSuiteFailureMessage:
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@private-scope/missing-runtime' imported from C:\\private-token\\adapter.test.ts"
  });

  const verification = harness.source.verifyCandidateCompatibility(
    harness.candidate,
    harness.environment
  );
  await expect(verification).rejects.toMatchObject({
    gate: "D",
    stage: "CONTRACT_TEST",
    reason: "TEST_FAILED",
    subject: {
      verificationStep: "COREMIND_ADAPTER_CONTRACT",
      failedTests: ["src/runtime/coremind-agent-runtime-adapter.test.ts"],
      testFailureKinds: ["MODULE_NOT_FOUND"],
      missingPackageNames: ["@private-scope/missing-runtime"]
    }
  });
  await expect(verification).rejects.not.toThrow("private-token");
  await expectStableWorkspaceUnchanged(harness);
});

test.each([
  [
    "CANDIDATE_INSTALL",
    "C",
    undefined,
    (request: CommandRequest) => request.command === "pnpm" && request.args[0] === "install"
  ],
  [
    "INTERFACE_TYPECHECK",
    "C",
    undefined,
    (request: CommandRequest) => request.command === "pnpm" && request.args.at(-1) === "typecheck"
  ],
  [
    "INTERFACE_BUILD",
    "C",
    undefined,
    (request: CommandRequest) => request.command === "pnpm" && request.args.at(-1) === "build"
  ],
  [
    "CONTRACT_TEST",
    "D",
    "COREMIND_ADAPTER_CONTRACT",
    (request: CommandRequest) => request.command === "pnpm" && request.args.includes("Gate D:")
  ],
  [
    "CONTRACT_TEST",
    "D",
    "DECISION_CONTRACT",
    (request: CommandRequest) =>
      request.command === "pnpm" &&
      request.args.includes("src/runtime/agent-runtime-factory.test.ts")
  ],
  [
    "VERTICAL_TEST",
    "E",
    "VERTICAL_HTTP",
    (request: CommandRequest) => request.command === "pnpm" && request.args.includes("Gate E:")
  ],
  [
    "ROOT_VERIFY",
    "F",
    "ROOT_VERIFY",
    (request: CommandRequest) => request.command === "pnpm" && request.args[0] === "verify"
  ],
  [
    "RESOURCE_CLEANUP",
    "F",
    "RESOURCE_CLEANUP",
    (request: CommandRequest) => request.command === "node" && request.args[0] === "-e"
  ]
] as const)(
  "%s 命令失败归属 Gate %s 并清理隔离环境",
  async (stage, gate, verificationStep, shouldFail) => {
    const harness = await createCompatibilityRunnerHarness({ shouldFail });

    await expect(
      harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
    ).rejects.toMatchObject({
      gate,
      stage,
      reason: "COMMAND_FAILED",
      ...(verificationStep === undefined ? {} : { subject: { verificationStep } })
    });
    await expect(access(harness.temporaryChoiceMindRoot)).rejects.toThrow();
    await expect(
      access(path.join(harness.artifactDirectory, ".pnpm-runner-sandbox"))
    ).rejects.toThrow();
    await expectStableWorkspaceUnchanged(harness);
  }
);

test("候选依赖解析回退稳定版本时在 Gate C 失败", async () => {
  const harness = await createCompatibilityRunnerHarness({
    resolvedVersion: "0.3.0"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "DEPENDENCY_RESOLUTION" });
  await expectStableWorkspaceUnchanged(harness);
});

test("候选 tarball 在安装前被篡改时失败且不运行 pnpm", async () => {
  const harness = await createCompatibilityRunnerHarness();
  const runtime = harness.candidate.packages.find(
    (artifact) => artifact.name === "coremind-runtime"
  );
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

  expect(harness.installedLegacyOverrides).toEqual({});
  expect(Object.keys(harness.installedOverrides)).toEqual([
    "coremind-ai",
    "coremind-config",
    "coremind-protocol",
    "coremind-runtime",
    "coremind-tools",
    "coremind-templates"
  ]);
  expect(Object.keys(harness.installEnvironment).sort()).toEqual([
    "COREPACK_ENABLE_NETWORK",
    "COREPACK_HOME",
    "npm_config_cache",
    "npm_config_cache_dir",
    "npm_config_globalconfig",
    "npm_config_userconfig"
  ]);
  expect(harness.installEnvironment.COREPACK_ENABLE_NETWORK).toBe("0");
  const installCommand = harness.commands.find((command) => command.startsWith("pnpm install"));
  expect(installCommand).toContain("--fetch-retries 5");
  expect(installCommand).toContain("--fetch-retry-factor 10");
  expect(installCommand).toContain("--fetch-retry-maxtimeout 60000");
  expect(installCommand).toContain("--fetch-retry-mintimeout 10000");
  expect(installCommand).toContain("--fetch-timeout 60000");
  expect(installCommand).toContain("--network-concurrency 1");
  expect(installCommand).toContain("--reporter ndjson");
  const cacheDirectory = path.resolve(harness.installEnvironment.npm_config_cache_dir ?? "");
  const sandboxDirectory = path.dirname(cacheDirectory);
  expect(path.dirname(sandboxDirectory)).toBe(path.resolve(harness.artifactDirectory));
  expect(path.basename(sandboxDirectory)).toMatch(/^\.pnpm-runner-sandbox-/u);
  await expect(access(sandboxDirectory)).rejects.toThrow();
  expect(await readFile(harness.stableMarkerPath, "utf8")).toBe("stable\n");
  await expectStableWorkspaceUnchanged(harness);
});

test("候选 workspace overrides 保留无关规则并覆盖 CoreMind 稳定规则", async () => {
  const harness = await createCompatibilityRunnerHarness({
    workspaceOverridesOutput: JSON.stringify({
      "left-pad": "1.3.0",
      "coremind-ai": "0.3.0"
    })
  });

  await harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment);

  expect(harness.installedOverrides["left-pad"]).toBe("1.3.0");
  expect(harness.installedOverrides["coremind-ai"]).toMatch(/^file:/u);
  await expectStableWorkspaceUnchanged(harness);
});

test("候选 workspace overrides 畸形时在安装前失败关闭", async () => {
  const harness = await createCompatibilityRunnerHarness({
    workspaceOverridesOutput: "[]"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });
  expect(harness.commands.some((command) => command.startsWith("pnpm install"))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("显式 registry 只作用于 Gate C 候选安装", async () => {
  const registry = "https://registry.npmmirror.com/";
  const harness = await createCompatibilityRunnerHarness({
    dependencyRegistry: registry
  });

  await harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment);

  const commandsWithRegistry = harness.commands.filter((command) => command.includes("--registry"));
  expect(commandsWithRegistry).toEqual([
    expect.stringMatching(
      new RegExp(`^pnpm install .* --registry ${registry.replaceAll(".", "\\.")}$`, "u")
    )
  ]);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 在安装前把锁定 pnpm 预置到独立 Corepack 缓存", async () => {
  const corepackHome = await createTemporaryDirectory();
  await createCorepackPnpmFixture(corepackHome, "11.21.0");
  let preparedBeforeInstall = false;
  const harness = await createCompatibilityRunnerHarness({
    corepackHome,
    onInstall: async (request) => {
      expect((request as CommandRequest & { captureStdout?: boolean }).captureStdout).toBe(false);
      expect(
        (request as CommandRequest & { classifyNetworkFailure?: boolean }).classifyNetworkFailure
      ).toBe(true);
      const isolatedCorepackHome = request.environment?.COREPACK_HOME;
      if (!isolatedCorepackHome) throw new Error("测试缺少隔离 COREPACK_HOME");
      expect(path.resolve(isolatedCorepackHome)).not.toBe(path.resolve(corepackHome));
      const manifest = JSON.parse(
        await readFile(
          path.join(isolatedCorepackHome, "v1", "pnpm", "11.21.0", "package.json"),
          "utf8"
        )
      ) as { name?: unknown; version?: unknown };
      expect(manifest).toEqual({ name: "pnpm", version: "11.21.0" });
      expect(
        await readFile(
          path.join(isolatedCorepackHome, "v1", "pnpm", "11.21.0", "bin", "pnpm.mjs"),
          "utf8"
        )
      ).toBe("export {};\n");
      preparedBeforeInstall = true;
    }
  });

  await harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment);

  expect(preparedBeforeInstall).toBe(true);
  await expectStableWorkspaceUnchanged(harness);
}, 15_000);

test("Gate C 对空白 Corepack 来源失败关闭且不创建候选副本", async () => {
  const harness = await createCompatibilityRunnerHarness({
    corepackHome: "   "
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });

  expect(harness.commands.some((command) => command.startsWith("git clone"))).toBe(false);
  expect(harness.commands.some((command) => command.startsWith("pnpm "))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 忽略空的缓存环境变量并回退到有效用户缓存", async () => {
  const localAppData = await createTemporaryDirectory();
  await createCorepackPnpmFixture(path.join(localAppData, "node", "corepack"), "11.21.0");
  const previousCorepackHome = process.env.COREPACK_HOME;
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  delete process.env.COREPACK_HOME;
  process.env.XDG_CACHE_HOME = "";
  process.env.LOCALAPPDATA = localAppData;

  try {
    const harness = await createCompatibilityRunnerHarness({
      useDefaultCorepackHome: true
    });

    await expect(
      harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
    ).resolves.toBeDefined();
    await expectStableWorkspaceUnchanged(harness);
  } finally {
    restoreEnvironmentVariable("COREPACK_HOME", previousCorepackHome);
    restoreEnvironmentVariable("XDG_CACHE_HOME", previousXdgCacheHome);
    restoreEnvironmentVariable("LOCALAPPDATA", previousLocalAppData);
  }
});

test("Gate C 对空白工作区包管理器失败关闭且不创建候选副本", async () => {
  const corepackHome = await createTemporaryDirectory();
  const harness = await createCompatibilityRunnerHarness({
    corepackHome,
    workspacePackageManager: ""
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });

  expect(harness.commands.some((command) => command.startsWith("git clone"))).toBe(false);
  expect(harness.commands.some((command) => command.startsWith("pnpm "))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 在读取缓存前拒绝非锁定 pnpm 版本", async () => {
  const corepackHome = await createTemporaryDirectory();
  await createCorepackPnpmFixture(corepackHome, "11.20.0");
  const harness = await createCompatibilityRunnerHarness({
    corepackHome,
    workspacePackageManager: "pnpm@11.20.0"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });

  expect(harness.commands.some((command) => command.startsWith("git clone"))).toBe(false);
  expect(harness.commands.some((command) => command.startsWith("pnpm "))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 在复制前拒绝内容被篡改的 pnpm 缓存", async () => {
  const corepackHome = await createTemporaryDirectory();
  await createCorepackPnpmFixture(corepackHome, "11.21.0");
  await writeFile(
    path.join(corepackHome, "v1", "pnpm", "11.21.0", "bin", "pnpm.mjs"),
    "throw new Error('tampered');\n",
    "utf8"
  );
  const harness = await createCompatibilityRunnerHarness({ corepackHome });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });

  expect(harness.commands.some((command) => command.startsWith("git clone"))).toBe(false);
  expect(harness.commands.some((command) => command.startsWith("pnpm "))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 在来源 pnpm 缓存缺失或不可访问时不创建候选副本", async () => {
  const emptyCorepackHome = await createTemporaryDirectory();
  const harness = await createCompatibilityRunnerHarness({
    corepackHome: emptyCorepackHome
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });

  expect(harness.commands.some((command) => command.startsWith("git clone"))).toBe(false);
  expect(harness.commands.some((command) => command.startsWith("pnpm "))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 在来源 pnpm 清单身份不匹配时失败关闭", async () => {
  const corepackHome = await createTemporaryDirectory();
  await createCorepackPnpmFixture(corepackHome, "11.21.0");
  await writeFile(
    path.join(corepackHome, "v1", "pnpm", "11.21.0", "package.json"),
    `${JSON.stringify({ name: "not-pnpm", version: "11.21.0" })}\n`,
    "utf8"
  );
  const harness = await createCompatibilityRunnerHarness({ corepackHome });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });

  expect(harness.commands.some((command) => command.startsWith("git clone"))).toBe(false);
  expect(harness.commands.some((command) => command.startsWith("pnpm "))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 在 Corepack locator 或完整性元数据不匹配时失败关闭", async () => {
  const corepackHome = await createTemporaryDirectory();
  await createCorepackPnpmFixture(corepackHome, "11.21.0");
  const packageDirectory = path.join(corepackHome, "v1", "pnpm", "11.21.0");
  await writeFile(
    path.join(packageDirectory, ".corepack"),
    `${JSON.stringify({
      locator: { name: "pnpm", reference: `11.20.0+sha512.${"b".repeat(128)}` },
      hash: `sha512.${"b".repeat(128)}`
    })}\n`,
    "utf8"
  );
  const harness = await createCompatibilityRunnerHarness({ corepackHome });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });

  expect(harness.commands.some((command) => command.startsWith("git clone"))).toBe(false);
  expect(harness.commands.some((command) => command.startsWith("pnpm "))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("Gate C 只在隔离 pnpm 实际版本核验通过后执行安装", async () => {
  const corepackHome = await createTemporaryDirectory();
  await createCorepackPnpmFixture(corepackHome, "11.21.0");
  const harness = await createCompatibilityRunnerHarness({
    actualPnpmVersion: "11.20.0",
    corepackHome
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({ gate: "C", stage: "CANDIDATE_INSTALL" });

  expect(harness.commands).toContain("pnpm --version");
  expect(harness.commands.some((command) => command.startsWith("pnpm install"))).toBe(false);
  await expectStableWorkspaceUnchanged(harness);
});

test("隔离 pnpm 启动核验超时后不安装并清理本次缓存", async () => {
  const harness = await createCompatibilityRunnerHarness({
    commandTimeoutMs: 20,
    shouldHang: (request) => request.command === "pnpm" && request.args[0] === "--version"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "CANDIDATE_INSTALL",
    reason: "TIMEOUT"
  });

  expect(harness.commands.some((command) => command.startsWith("pnpm install"))).toBe(false);
  const isolatedCorepackHome = harness.pnpmEnvironments[0]?.COREPACK_HOME;
  if (!isolatedCorepackHome) throw new Error("测试未观察到隔离 COREPACK_HOME");
  await expect(access(isolatedCorepackHome)).rejects.toThrow();
  await expectStableWorkspaceUnchanged(harness);
});

test("隔离 pnpm 启动异常时不安装并清理本次缓存", async () => {
  const harness = await createCompatibilityRunnerHarness({
    shouldFail: (request) => request.command === "pnpm" && request.args[0] === "--version"
  });

  await expect(
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ).rejects.toMatchObject({
    gate: "C",
    stage: "CANDIDATE_INSTALL",
    reason: "COMMAND_FAILED"
  });

  expect(harness.commands.some((command) => command.startsWith("pnpm install"))).toBe(false);
  const isolatedCorepackHome = harness.pnpmEnvironments[0]?.COREPACK_HOME;
  if (!isolatedCorepackHome) throw new Error("测试未观察到隔离 COREPACK_HOME");
  await expect(access(isolatedCorepackHome)).rejects.toThrow();
  await expectStableWorkspaceUnchanged(harness);
});

test("隔离 pnpm 启动核验取消后不安装并清理本次缓存", async () => {
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const harness = await createCompatibilityRunnerHarness({
    onHangStarted: () => markStarted?.(),
    shouldHang: (request) => request.command === "pnpm" && request.args[0] === "--version",
    signal: controller.signal
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
  expect(harness.commands.some((command) => command.startsWith("pnpm install"))).toBe(false);
  const isolatedCorepackHome = harness.pnpmEnvironments[0]?.COREPACK_HOME;
  if (!isolatedCorepackHome) throw new Error("测试未观察到隔离 COREPACK_HOME");
  await expect(access(isolatedCorepackHome)).rejects.toThrow();
  await expectStableWorkspaceUnchanged(harness);
});

test("重复候选请求各自使用新的隔离缓存并完成清理", async () => {
  const corepackHome = await createTemporaryDirectory();
  await createCorepackPnpmFixture(corepackHome, "11.21.0");
  const harness = await createCompatibilityRunnerHarness({ corepackHome });

  await harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment);
  await harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment);

  expect(harness.installEnvironments).toHaveLength(2);
  expect(
    new Set(harness.installEnvironments.map((environment) => environment.COREPACK_HOME)).size
  ).toBe(2);
  for (const environment of harness.installEnvironments) {
    await expect(access(environment.COREPACK_HOME ?? "")).rejects.toThrow();
  }
  await expectStableWorkspaceUnchanged(harness);
});

test("并发候选请求使用互不共享的工作副本和缓存", async () => {
  const corepackHome = await createTemporaryDirectory();
  await createCorepackPnpmFixture(corepackHome, "11.21.0");
  let activeInstalls = 0;
  let maximumActiveInstalls = 0;
  const harness = await createCompatibilityRunnerHarness({
    corepackHome,
    onInstall: async () => {
      activeInstalls += 1;
      maximumActiveInstalls = Math.max(maximumActiveInstalls, activeInstalls);
      await new Promise((resolve) => setTimeout(resolve, 30));
      activeInstalls -= 1;
    }
  });

  await Promise.all([
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment),
    harness.source.verifyCandidateCompatibility(harness.candidate, harness.environment)
  ]);

  expect(new Set(harness.installWorkingDirectories).size).toBe(2);
  expect(maximumActiveInstalls).toBe(1);
  expect(
    new Set(harness.installEnvironments.map((environment) => environment.COREPACK_HOME)).size
  ).toBe(2);
  for (const directory of [
    ...harness.installWorkingDirectories,
    ...harness.installEnvironments.map((environment) => environment.COREPACK_HOME ?? "")
  ]) {
    await expect(access(directory)).rejects.toThrow();
  }
  await expectStableWorkspaceUnchanged(harness);
});

test("等待安装并发门禁的候选请求可独立取消", async () => {
  let markFirstInstallStarted: (() => void) | undefined;
  let releaseFirstInstall: (() => void) | undefined;
  const firstInstallStarted = new Promise<void>((resolve) => {
    markFirstInstallStarted = resolve;
  });
  const firstInstallRelease = new Promise<void>((resolve) => {
    releaseFirstInstall = resolve;
  });
  const first = await createCompatibilityRunnerHarness({
    onInstall: async () => {
      markFirstInstallStarted?.();
      await firstInstallRelease;
    }
  });
  const secondController = new AbortController();
  const second = await createCompatibilityRunnerHarness({
    signal: secondController.signal
  });
  const firstRunning = first.source.verifyCandidateCompatibility(
    first.candidate,
    first.environment
  );
  await firstInstallStarted;
  const secondRunning = second.source.verifyCandidateCompatibility(
    second.candidate,
    second.environment
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (second.commands.some((command) => command === "pnpm --version")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(second.commands).toContain("pnpm --version");

  secondController.abort("cancelled");

  await expect(secondRunning).rejects.toMatchObject({
    gate: "C",
    stage: "CANDIDATE_INSTALL",
    reason: "CANCELLED"
  });
  releaseFirstInstall?.();
  await expect(firstRunning).resolves.toBeDefined();
  await expectStableWorkspaceUnchanged(first);
  await expectStableWorkspaceUnchanged(second);
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
    [
      "GIT_FETCH",
      (request: CommandRequest) => request.command === "git" && request.args.includes("fetch")
    ],
    ["NPM_CI", (request: CommandRequest) => request.command === "npm" && request.args[0] === "ci"],
    [
      "VERSION_SYNC",
      (request: CommandRequest) =>
        request.command === "node" && request.args[0] === "scripts/release-version.mjs"
    ],
    ["BUILD", (request: CommandRequest) => request.command === "npm" && request.args[0] === "run"],
    ["PACK", (request: CommandRequest) => request.command === "npm" && request.args[0] === "pack"]
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

  test.each(["EACCES", "EPERM"])("npm ci 权限错误 %s 分类为 PERMISSION_DENIED", async (code) => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: async (request) => {
        if (request.command === "npm" && request.args[0] === "ci") {
          throw Object.assign(new Error("不得进入安全报告的权限错误"), {
            code
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
    ).rejects.toMatchObject({ stage: "NPM_CI", reason: "PERMISSION_DENIED" });
  });

  test("npm ci 超时报告安全原因并清理临时目录", async () => {
    const root = await createTemporaryDirectory();
    const artifactDirectory = path.join(root, "artifacts");
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory,
      choiceMindRoot: root,
      commandTimeoutMs: 10,
      stageTimeouts: {
        GIT_FETCH: { hardDeadlineMs: 1_000, idleTimeoutMs: 500 }
      },
      execute: async (request) => {
        if (request.command === "npm" && request.args[0] === "ci") {
          return new Promise<Buffer>((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("不得进入安全报告的原始超时错误")),
              {
                once: true
              }
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

  test("同一 GIT_FETCH 阶段的多条命令共享 hard deadline", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      stageTimeouts: {
        GIT_FETCH: { hardDeadlineMs: 150, idleTimeoutMs: 75 }
      },
      execute: async (request) => {
        if (request.stage === "GIT_FETCH") {
          await new Promise<void>((resolve, reject) => {
            const completed = setTimeout(resolve, 60);
            request.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(completed);
                reject(new Error("阶段总时限已到"));
              },
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
    ).rejects.toMatchObject({ stage: "GIT_FETCH", reason: "DEADLINE_TIMEOUT" });
  });

  test("阶段操作在命令返回后仍按总耗时失败关闭", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      stageTimeouts: {
        GIT_FETCH: { hardDeadlineMs: 30, idleTimeoutMs: 15 }
      },
      execute: async (request) => {
        const result = await executor.execute(request);
        if (request.command === "git" && request.args.includes("archive")) {
          const deadline = Date.now() + 60;
          while (Date.now() < deadline) {
            // 模拟命令完成边界后的同步摘要工作，定时器无法在事件循环恢复前触发。
          }
        }
        return result;
      }
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({ stage: "GIT_FETCH", reason: "DEADLINE_TIMEOUT" });
  });

  test("阶段 hard deadline 等待底层确认取消后再释放", async () => {
    const root = await createTemporaryDirectory();
    let cancellationObserved = false;
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      stageTimeouts: {
        GIT_FETCH: { hardDeadlineMs: 30, idleTimeoutMs: 15 }
      },
      execute: async (request) =>
        new Promise<Buffer>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              cancellationObserved = true;
              setTimeout(() => reject(new Error("底层已确认停止")), 20);
            },
            { once: true }
          );
        })
    });

    const startedAt = Date.now();
    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({ stage: "GIT_FETCH", reason: "DEADLINE_TIMEOUT" });
    expect(cancellationObserved).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
  }, 500);

  test("npm ci 持续有进度时不受旧统一超时误杀", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      commandTimeoutMs: 50,
      stageTimeouts: {
        NPM_CI: { hardDeadlineMs: 250, idleTimeoutMs: 30 }
      },
      execute: async (request) => {
        if (request.command === "npm" && request.args[0] === "ci") {
          await new Promise<void>((resolve, reject) => {
            const progress = setInterval(() => request.reportProgress?.(), 10);
            request.signal?.addEventListener(
              "abort",
              () => {
                clearInterval(progress);
                reject(new Error("测试命令被超时中断"));
              },
              { once: true }
            );
            setTimeout(() => {
              clearInterval(progress);
              resolve();
            }, 120);
          });
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
    ).resolves.toMatchObject({ packages: expect.any(Array) });
  });

  test("npm ci 长时间无进度时报告 IDLE_TIMEOUT", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      commandTimeoutMs: 50,
      stageTimeouts: {
        NPM_CI: { hardDeadlineMs: 250, idleTimeoutMs: 30 }
      },
      execute: async (request) => {
        if (request.command === "npm" && request.args[0] === "ci") {
          return new Promise<Buffer>((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("测试停滞命令已中断")),
              { once: true }
            );
          });
        }
        return executor.execute(request);
      }
    });

    let failure: unknown;
    try {
      await source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      stage: "NPM_CI",
      reason: "IDLE_TIMEOUT",
      progress: {
        elapsedMs: expect.any(Number),
        observedProgressEvents: expect.any(Number),
        cacheBytes: expect.any(Number),
        cacheFileCount: expect.any(Number),
        lastProgressAgeMs: expect.any(Number)
      }
    });
    expect(JSON.stringify(failure)).not.toContain("测试停滞命令已中断");
  });

  test("npm ci 持续有进度但超过总时限时报告 DEADLINE_TIMEOUT", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      commandTimeoutMs: 50,
      stageTimeouts: {
        NPM_CI: { hardDeadlineMs: 80, idleTimeoutMs: 30 }
      },
      execute: async (request) => {
        if (request.command === "npm" && request.args[0] === "ci") {
          return new Promise<Buffer>((_resolve, reject) => {
            const progress = setInterval(() => request.reportProgress?.(), 10);
            request.signal?.addEventListener(
              "abort",
              () => {
                clearInterval(progress);
                reject(new Error("测试长命令已中断"));
              },
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
    ).rejects.toMatchObject({ stage: "NPM_CI", reason: "DEADLINE_TIMEOUT" });
  });

  test("版本同步命令成功但版本未更新时报告 VERSION_SYNC", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: async (request) => {
        if (request.command === "node" && request.args[0] === "scripts/release-version.mjs") {
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

  test("重复候选跨运行重新核验并复用不可变八包制品", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const firstExecutor = createGitCandidateExecutor();
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: firstExecutor.execute
    });

    const firstResult = await first.materializeGitCommit(candidate);
    let repeatedCommands = 0;
    const second = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: async () => {
        repeatedCommands += 1;
        throw new Error("复用制品时不得再次执行外部物化命令");
      }
    });

    await expect(second.materializeGitCommit(candidate)).resolves.toEqual(firstResult);
    expect(repeatedCommands).toBe(0);
    await expect(readdir(path.join(root, "run-2", "packages"))).resolves.toHaveLength(8);
  });

  test("ARTIFACT_REUSE deadline 覆盖 pointer 与不可变制品复核", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const environment = materializationTestEnvironment();
    const firstArtifactDirectory = path.join(root, "run-1");
    await materializeWithReuse(
      { artifactDirectory: firstArtifactDirectory, materializationDirectory },
      candidate,
      path.join(firstArtifactDirectory, "packages"),
      environment,
      () => writeMaterializationTestCandidate(path.join(firstArtifactDirectory, "packages"))
    );
    const [artifactKey] = await readdir(path.join(materializationDirectory, "artifacts"));
    if (!artifactKey) throw new Error("测试缺少持久制品目录");
    const [fileName] = await readdir(
      path.join(materializationDirectory, "artifacts", artifactKey, "packages")
    );
    if (!fileName) throw new Error("测试缺少持久 tarball");
    await writeFile(
      path.join(materializationDirectory, "artifacts", artifactKey, "packages", fileName),
      "tampered",
      "utf8"
    );
    const deadline: MaterializationStageDeadline = {
      run: async (stage, operation) => {
        if (stage === "ARTIFACT_REUSE") {
          throw Object.assign(new Error("测试阶段截止"), {
            reason: "DEADLINE_TIMEOUT"
          });
        }
        return operation();
      },
      commit: async (_stage, operation) => operation(),
      signal: () => undefined
    };
    const secondArtifactDirectory = path.join(root, "run-2");

    await expect(
      materializeWithReuse(
        {
          artifactDirectory: secondArtifactDirectory,
          materializationDirectory,
          stageDeadline: deadline
        },
        candidate,
        path.join(secondArtifactDirectory, "packages"),
        environment,
        async () => {
          throw new Error("复用阶段截止后不得重新物化");
        }
      )
    ).rejects.toMatchObject({
      stage: "ARTIFACT_REUSE",
      reason: "DEADLINE_TIMEOUT"
    });
  });

  test("ARTIFACT_REUSE 与当前 acquisition owner 互斥", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [pointerFile] = await readdir(path.join(materializationDirectory, "acquisitions"));
    if (!pointerFile) throw new Error("测试缺少 acquisition pointer");
    const acquisitionKey = path.basename(pointerFile, ".json");
    const lockDirectory = path.join(materializationDirectory, "locks", acquisitionKey);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        ownerId: "active-writer",
        pid: process.pid,
        createdAt: Date.now(),
        materializationKey: acquisitionKey,
        heartbeatAt: Date.now()
      })}\n`,
      "utf8"
    );
    const second = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      materializationLockTimeoutMs: 20,
      choiceMindRoot: root,
      execute: async () => {
        throw new Error("复用等待 owner 时不得重新物化");
      }
    });

    await expect(second.materializeGitCommit(candidate)).rejects.toMatchObject({
      stage: "MATERIALIZATION_LOCK",
      reason: "LOCK_TIMEOUT"
    });
  });

  test("重复候选拒绝复用被篡改的不可变制品", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [artifactKey] = await readdir(path.join(materializationDirectory, "artifacts"));
    if (!artifactKey) throw new Error("测试缺少持久制品目录");
    const [fileName] = await readdir(
      path.join(materializationDirectory, "artifacts", artifactKey, "packages")
    );
    if (!fileName) throw new Error("测试缺少持久 tarball");
    await writeFile(
      path.join(materializationDirectory, "artifacts", artifactKey, "packages", fileName),
      "tampered",
      "utf8"
    );
    let repeatedCommands = 0;
    const second = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: async () => {
        repeatedCommands += 1;
        throw new Error("篡改后不得静默重新物化");
      }
    });

    await expect(second.materializeGitCommit(candidate)).rejects.toMatchObject({
      stage: "TARBALL_VALIDATE"
    });
    expect(repeatedCommands).toBe(0);
  });

  test("重复候选拒绝复用缺少完成标记的制品目录", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [artifactKey] = await readdir(path.join(materializationDirectory, "artifacts"));
    if (!artifactKey) throw new Error("测试缺少持久制品目录");
    await rm(path.join(materializationDirectory, "artifacts", artifactKey, "complete.json"));
    let repeatedCommands = 0;
    const second = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: async () => {
        repeatedCommands += 1;
        throw new Error("不完整制品不得静默重新物化");
      }
    });

    await expect(second.materializeGitCommit(candidate)).rejects.toMatchObject({
      stage: "TARBALL_VALIDATE"
    });
    expect(repeatedCommands).toBe(0);
  });

  test("重复候选拒绝 manifest 中的路径穿越文件名", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [artifactKey] = await readdir(path.join(materializationDirectory, "artifacts"));
    if (!artifactKey) throw new Error("测试缺少持久制品目录");
    const manifestPath = path.join(
      materializationDirectory,
      "artifacts",
      artifactKey,
      "manifest.json"
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifacts: { packages: Array<{ fileName: string }> };
    };
    const firstPackage = manifest.artifacts.packages[0];
    if (!firstPackage) throw new Error("测试缺少包身份");
    firstPackage.fileName = "..\\outside.tgz";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const second = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: async () => {
        throw new Error("恶意清单不得进入外部命令");
      }
    });

    await expect(second.materializeGitCommit(candidate)).rejects.toMatchObject({
      stage: "TARBALL_VALIDATE"
    });
    await expect(
      access(path.join(materializationDirectory, "artifacts", "outside.tgz"))
    ).rejects.toThrow();
  });

  test("攻击者同步更新 SHA-256 后仍因 SHA-512 不匹配而拒绝复用", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [pointerName] = await readdir(path.join(materializationDirectory, "acquisitions"));
    if (!pointerName) throw new Error("测试缺少 acquisition pointer");
    const pointerPath = path.join(materializationDirectory, "acquisitions", pointerName);
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
      artifactKey: string;
    };
    const oldArtifactDirectory = path.join(
      materializationDirectory,
      "artifacts",
      pointer.artifactKey
    );
    const manifest = JSON.parse(
      await readFile(path.join(oldArtifactDirectory, "manifest.json"), "utf8")
    ) as {
      acquisitionKey: string;
      artifactKey: string;
      artifacts: {
        packages: Array<{ fileName: string; sha256: string }>;
      };
    };
    const firstPackage = manifest.artifacts.packages[0];
    if (!firstPackage) throw new Error("测试缺少包身份");
    const tamperedBytes = Buffer.from("tampered-but-sha256-updated", "utf8");
    await writeFile(
      path.join(oldArtifactDirectory, "packages", firstPackage.fileName),
      tamperedBytes
    );
    firstPackage.sha256 = createHash("sha256").update(tamperedBytes).digest("hex");
    const newArtifactKey = createHash("sha256")
      .update(
        JSON.stringify({
          acquisitionKey: manifest.acquisitionKey,
          artifacts: manifest.artifacts
        })
      )
      .digest("hex");
    manifest.artifactKey = newArtifactKey;
    const newArtifactDirectory = path.join(materializationDirectory, "artifacts", newArtifactKey);
    await rename(oldArtifactDirectory, newArtifactDirectory);
    await writeFile(
      path.join(newArtifactDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(newArtifactDirectory, "complete.json"),
      `${JSON.stringify({ schemaVersion: 1, artifactKey: newArtifactKey })}\n`,
      "utf8"
    );
    await writeFile(pointerPath, `${JSON.stringify({ artifactKey: newArtifactKey })}\n`, "utf8");
    const second = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: async () => {
        throw new Error("篡改制品不得进入外部命令");
      }
    });

    await expect(second.materializeGitCommit(candidate)).rejects.toMatchObject({
      stage: "TARBALL_VALIDATE"
    });
  });

  test("重复候选把 null 指针稳定归类为 TARBALL_VALIDATE", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [pointerName] = await readdir(path.join(materializationDirectory, "acquisitions"));
    if (!pointerName) throw new Error("测试缺少 acquisition pointer");
    await writeFile(
      path.join(materializationDirectory, "acquisitions", pointerName),
      "null\n",
      "utf8"
    );
    const second = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: async () => {
        throw new Error("无效指针不得进入外部命令");
      }
    });

    await expect(second.materializeGitCommit(candidate)).rejects.toMatchObject({
      stage: "TARBALL_VALIDATE"
    });
  });

  test("owner 失租后不能提升持久制品", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const baseExecutor = createGitCandidateExecutor();
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: async (request) => {
        const result = await baseExecutor.execute(request);
        if (request.command === "npm" && request.args[0] === "ci") {
          const [acquisitionKey] = await readdir(path.join(materializationDirectory, "locks"));
          if (!acquisitionKey) throw new Error("测试缺少 acquisition lock");
          const ownerPath = path.join(
            materializationDirectory,
            "locks",
            acquisitionKey,
            "owner.json"
          );
          const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
          owner.ownerId = "replacement-owner";
          await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, "utf8");
        }
        return result;
      }
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({
      stage: "MATERIALIZATION_LOCK",
      reason: "LOCK_LOST"
    });
    await expect(access(path.join(materializationDirectory, "acquisitions"))).rejects.toThrow();
  });

  test("ARTIFACT_PERSIST deadline 到期后不提升 final 或 pointer", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const source = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run"),
      materializationDirectory,
      choiceMindRoot: root,
      stageTimeouts: {
        ARTIFACT_PERSIST: { hardDeadlineMs: 1, idleTimeoutMs: 1 }
      },
      execute: createGitCandidateExecutor().execute
    });

    await expect(
      source.materializeGitCommit({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      })
    ).rejects.toMatchObject({
      stage: "ARTIFACT_PERSIST",
      reason: "DEADLINE_TIMEOUT"
    });
    await expect(directoryEntriesOrEmpty(path.join(materializationDirectory, "acquisitions"))).resolves.toEqual([]);
    await expect(directoryEntriesOrEmpty(path.join(materializationDirectory, "artifacts"))).resolves.toEqual([]);
  });

  test.each(["artifacts", "acquisitions"] as const)(
    "ARTIFACT_PERSIST deadline 在 %s rename 期间到期时遵守原子提交边界",
    async (renameTarget) => {
      const root = await createTemporaryDirectory();
      const artifactDirectory = path.join(root, "run");
      const materializationDirectory = path.join(root, "materialized");
      const controller = new AbortController();
      let committed = false;
      let pointerStagingPath: string | undefined;
      const deadline: MaterializationStageDeadline = {
        run: async (stage, operation) => {
          if (stage !== "ARTIFACT_PERSIST") return operation();
          const result = await operation();
          if (controller.signal.aborted && !committed) {
            throw Object.assign(new Error("测试阶段截止"), {
              reason: "DEADLINE_TIMEOUT"
            });
          }
          return result;
        },
        commit: async (_stage, operation) => {
          const result = await operation();
          committed = true;
          return result;
        },
        signal: (stage) => (stage === "ARTIFACT_PERSIST" ? controller.signal : undefined)
      };

      const operation = materializeWithReuse(
        {
          artifactDirectory,
          materializationDirectory,
          stageDeadline: deadline,
          permissionFileSystem: {
            writeFile: async (filePath, content, encoding) => {
              if (filePath.endsWith(".tmp")) pointerStagingPath = filePath;
              await writeFile(filePath, content, encoding);
            },
            rename: async (source, target) => {
              if (path.dirname(target) === path.join(materializationDirectory, renameTarget)) {
                await rename(source, target);
                controller.abort("deadline-timeout");
                return;
              }
              await rename(source, target);
            }
          }
        },
        {
          schemaVersion: 1,
          kind: "git-commit",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          commit
        },
        path.join(artifactDirectory, "packages"),
        materializationTestEnvironment(),
        () => writeMaterializationTestCandidate(path.join(artifactDirectory, "packages"))
      );
      if (renameTarget === "artifacts") {
        await expect(operation).rejects.toMatchObject({
          stage: "ARTIFACT_PERSIST",
          reason: "DEADLINE_TIMEOUT"
        });
        await expect(readdir(path.join(materializationDirectory, "acquisitions"))).resolves.toEqual(
          []
        );
      } else {
        await expect(operation).resolves.toMatchObject({
          packages: expect.any(Array)
        });
        expect(pointerStagingPath).toMatch(
          /\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u
        );
        await expect(
          readdir(path.join(materializationDirectory, "acquisitions"))
        ).resolves.toHaveLength(1);
      }
      await expect(readdir(path.join(materializationDirectory, "artifacts"))).resolves.toHaveLength(
        1
      );
    }
  );

  test.each(["artifacts", "acquisitions"] as const)(
    "ARTIFACT_PERSIST 在 %s rename 期间失锁时保留对象供新 owner 接管",
    async (renameTarget) => {
      const root = await createTemporaryDirectory();
      const artifactDirectory = path.join(root, "run-1");
      const materializationDirectory = path.join(root, "materialized");
      const candidate = {
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      } as const;
      let ownershipReplaced = false;

      const firstOperation = materializeWithReuse(
        {
          artifactDirectory,
          materializationDirectory,
          permissionFileSystem: {
            rename: async (source, target) => {
              await rename(source, target);
              if (
                !ownershipReplaced &&
                path.dirname(target) === path.join(materializationDirectory, renameTarget)
              ) {
                ownershipReplaced = true;
                const [acquisitionKey] = await readdir(
                  path.join(materializationDirectory, "locks")
                );
                if (!acquisitionKey) throw new Error("测试缺少 acquisition lock");
                await writeFile(
                  path.join(materializationDirectory, "locks", acquisitionKey, "owner.json"),
                  `${JSON.stringify({
                    ownerId: "replacement-owner",
                    pid: 999_999,
                    createdAt: 0,
                    materializationKey: acquisitionKey,
                    heartbeatAt: 0
                  })}\n`,
                  "utf8"
                );
              }
            }
          }
        },
        candidate,
        path.join(artifactDirectory, "packages"),
        materializationTestEnvironment(),
        () => writeMaterializationTestCandidate(path.join(artifactDirectory, "packages"))
      );
      if (renameTarget === "artifacts") {
        await expect(firstOperation).rejects.toMatchObject({
          reason: "LOCK_LOST"
        });
      } else {
        await expect(firstOperation).resolves.toMatchObject({
          packages: expect.any(Array)
        });
      }

      await expect(readdir(path.join(materializationDirectory, "artifacts"))).resolves.toHaveLength(
        1
      );
      const pointerCountBeforeRecovery = (
        await readdir(path.join(materializationDirectory, "acquisitions"))
      ).length;
      expect(pointerCountBeforeRecovery).toBe(renameTarget === "acquisitions" ? 1 : 0);

      const secondArtifactDirectory = path.join(root, "run-2");
      let recoveryMaterializations = 0;
      await expect(
        materializeWithReuse(
          {
            artifactDirectory: secondArtifactDirectory,
            materializationDirectory,
            materializationLockTimeoutMs: 500
          },
          candidate,
          path.join(secondArtifactDirectory, "packages"),
          materializationTestEnvironment(),
          async () => {
            recoveryMaterializations += 1;
            return writeMaterializationTestCandidate(
              path.join(secondArtifactDirectory, "packages")
            );
          }
        )
      ).resolves.toMatchObject({ packages: expect.any(Array) });
      expect(recoveryMaterializations).toBe(renameTarget === "artifacts" ? 1 : 0);
      await expect(
        readdir(path.join(materializationDirectory, "acquisitions"))
      ).resolves.toHaveLength(1);
      await expect(readdir(path.join(materializationDirectory, "artifacts"))).resolves.toHaveLength(
        1
      );
    }
  );

  test("owner 消失且心跳过期时安全恢复同候选物化", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const controller = new AbortController();
    const interrupted = createInterruptibleExecutor();
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: interrupted.execute,
      signal: controller.signal
    });
    const firstRun = first.materializeGitCommit(candidate);
    await interrupted.started;
    const [acquisitionKey] = await readdir(path.join(materializationDirectory, "locks"));
    if (!acquisitionKey) throw new Error("测试缺少 acquisition lock");
    controller.abort();
    await expect(firstRun).rejects.toMatchObject({ reason: "CANCELLED" });

    const staleLockDirectory = path.join(materializationDirectory, "locks", acquisitionKey);
    await mkdir(staleLockDirectory, { recursive: true });
    const staleOwnerPath = path.join(staleLockDirectory, "owner.json");
    await writeFile(
      staleOwnerPath,
      `${JSON.stringify({
        ownerId: "stale-owner",
        pid: 2_147_483_647,
        createdAt: Date.now() - 60_000,
        materializationKey: acquisitionKey,
        heartbeatAt: Date.now() - 60_000
      })}\n`,
      "utf8"
    );
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(staleOwnerPath, staleTime, staleTime);
    const recovered = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });

    await expect(recovered.materializeGitCommit(candidate)).resolves.toMatchObject({
      packages: expect.any(Array)
    });
    await expect(access(staleLockDirectory)).rejects.toThrow();
  });

  test("mkdir 后未写 owner 的过期孤儿锁可以恢复", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [pointerName] = await readdir(path.join(materializationDirectory, "acquisitions"));
    if (!pointerName) throw new Error("测试缺少 acquisition pointer");
    await rm(path.join(materializationDirectory, "acquisitions", pointerName));
    const acquisitionKey = path.basename(pointerName, ".json");
    const orphanLock = path.join(materializationDirectory, "locks", acquisitionKey);
    await mkdir(orphanLock, { recursive: true });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(orphanLock, staleTime, staleTime);
    const recovered = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });

    await expect(recovered.materializeGitCommit(candidate)).resolves.toMatchObject({
      packages: expect.any(Array)
    });
    await expect(access(orphanLock)).rejects.toThrow();
  });

  test("活 owner 不被偷锁且等待达到总时限后安全失败", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [pointerName] = await readdir(path.join(materializationDirectory, "acquisitions"));
    if (!pointerName) throw new Error("测试缺少 acquisition pointer");
    await rm(path.join(materializationDirectory, "acquisitions", pointerName));
    const acquisitionKey = path.basename(pointerName, ".json");
    const liveLock = path.join(materializationDirectory, "locks", acquisitionKey);
    await mkdir(liveLock, { recursive: true });
    await writeFile(
      path.join(liveLock, "owner.json"),
      `${JSON.stringify({
        ownerId: "live-owner",
        pid: process.pid,
        createdAt: Date.now(),
        materializationKey: acquisitionKey,
        heartbeatAt: Date.now()
      })}\n`,
      "utf8"
    );
    const waiting = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      materializationLockTimeoutMs: 50,
      choiceMindRoot: root,
      execute: async () => {
        throw new Error("活 owner 存在时不得执行重复物化");
      }
    });

    await expect(waiting.materializeGitCommit(candidate)).rejects.toMatchObject({
      stage: "MATERIALIZATION_LOCK",
      reason: "LOCK_TIMEOUT"
    });
  });

  test("最大租期已过时即使原 PID 仍存活也回收锁", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [pointerName] = await readdir(path.join(materializationDirectory, "acquisitions"));
    if (!pointerName) throw new Error("测试缺少 acquisition pointer");
    await rm(path.join(materializationDirectory, "acquisitions", pointerName));
    const acquisitionKey = path.basename(pointerName, ".json");
    const expiredLock = path.join(materializationDirectory, "locks", acquisitionKey);
    await mkdir(expiredLock, { recursive: true });
    await writeFile(
      path.join(expiredLock, "owner.json"),
      `${JSON.stringify({
        ownerId: "expired-live-owner",
        pid: process.pid,
        createdAt: Date.now() - 2 * 60 * 60_000 - 1,
        materializationKey: acquisitionKey,
        heartbeatAt: Date.now()
      })}\n`,
      "utf8"
    );
    const recovered = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      materializationLockTimeoutMs: 500,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });

    await expect(recovered.materializeGitCommit(candidate)).resolves.toMatchObject({
      packages: expect.any(Array)
    });
  });

  test("锁目录创建后 owner 写入失败会立即清理空锁", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const artifactDirectory = path.join(root, "artifacts");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;

    await expect(
      materializeWithReuse(
        {
          artifactDirectory,
          materializationDirectory,
          permissionFileSystem: {
            writeFile: async (filePath, content, encoding) => {
              if (path.basename(filePath) === "owner.json") throw permissionError("EACCES");
              await writeFile(filePath, content, encoding);
            }
          }
        },
        candidate,
        path.join(artifactDirectory, "packages"),
        {
          nodeVersion: "22.22.1",
          workspacePackageManager: "pnpm@11.21.0",
          artifactPackageManager: "npm@10.9.4",
          platform: process.platform,
          architecture: process.arch
        },
        async () => {
          throw new Error("owner 写入失败后不得进入物化回调");
        }
      )
    ).rejects.toMatchObject({
      stage: "MATERIALIZATION_LOCK",
      reason: "PERMISSION_DENIED"
    });
    await expect(readdir(path.join(materializationDirectory, "locks"))).resolves.toEqual([]);
  });

  test("null owner 在目录过期后按损坏锁恢复", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });
    await first.materializeGitCommit(candidate);
    const [pointerName] = await readdir(path.join(materializationDirectory, "acquisitions"));
    if (!pointerName) throw new Error("测试缺少 acquisition pointer");
    await rm(path.join(materializationDirectory, "acquisitions", pointerName));
    const acquisitionKey = path.basename(pointerName, ".json");
    const invalidLock = path.join(materializationDirectory, "locks", acquisitionKey);
    await mkdir(invalidLock, { recursive: true });
    await writeFile(path.join(invalidLock, "owner.json"), "null\n", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(invalidLock, staleTime, staleTime);
    const recovered = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createGitCandidateExecutor().execute
    });

    await expect(recovered.materializeGitCommit(candidate)).resolves.toMatchObject({
      packages: expect.any(Array)
    });
  });

  test("同候选并发跨运行只允许一个 owner 执行物化", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const candidate = {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    } as const;
    let npmCiCount = 0;
    let markFirstNpmCiStarted: (() => void) | undefined;
    const firstNpmCiStarted = new Promise<void>((resolve) => {
      markFirstNpmCiStarted = resolve;
    });
    let releaseFirstNpmCi: (() => void) | undefined;
    const firstNpmCiRelease = new Promise<void>((resolve) => {
      releaseFirstNpmCi = resolve;
    });
    const createExecutor = (): CommandExecutor => {
      const fixture = createGitCandidateExecutor();
      return async (request) => {
        if (request.command === "npm" && request.args[0] === "ci") {
          npmCiCount += 1;
          if (npmCiCount === 1) {
            markFirstNpmCiStarted?.();
            await firstNpmCiRelease;
          }
        }
        return fixture.execute(request);
      };
    };
    const first = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-1"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createExecutor()
    });
    const second = createSystemCompatibilitySystem({
      artifactDirectory: path.join(root, "run-2"),
      materializationDirectory,
      choiceMindRoot: root,
      execute: createExecutor()
    });

    const firstRun = first.materializeGitCommit(candidate);
    await firstNpmCiStarted;
    const secondRun = second.materializeGitCommit(candidate);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirstNpmCi?.();

    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
    expect(secondResult).toEqual(firstResult);
    expect(npmCiCount).toBe(1);
  });

  test("真实双进程同候选只执行一次物化回调", async () => {
    const root = await createTemporaryDirectory();
    const first = runMaterializationProcess(root, "same-1", commit, 2);
    let second: Promise<void> | undefined;
    try {
      await waitForStartedCount(root, 1);
      second = runMaterializationProcess(root, "same-2", commit, 2);
      await waitForLockWait(root, "same-2:acquisition");
      await expect(readStartedIds(root)).resolves.toHaveLength(1);
      await writeFile(path.join(root, "release-same-1"), "release\n", "utf8");
      await Promise.all([first, second]);

      await expect(readStartedIds(root)).resolves.toEqual(["same-1"]);
      await expect(readdir(path.join(root, "run-same-2", "packages"))).resolves.toHaveLength(8);
    } finally {
      await Promise.all(
        ["same-1", "same-2"].map((id) =>
          writeFile(path.join(root, `release-${id}`), "release\n", "utf8")
        )
      );
      await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
    }
  }, 20_000);

  test("跨进程物化夹具等待 release 文件时具有硬时限", async () => {
    const root = await createTemporaryDirectory();

    await expect(
      runMaterializationProcess(root, "release-timeout", commit, 1, 50)
    ).rejects.toThrow("等待 release 文件超时");
  }, 3_000);

  test("真实多进程不同候选遵守全局并发槽上限", async () => {
    const root = await createTemporaryDirectory();
    const commits = ["1".repeat(40), "2".repeat(40), "3".repeat(40)] as const;
    const first = runMaterializationProcess(root, "slot-1", commits[0], 2);
    const second = runMaterializationProcess(root, "slot-2", commits[1], 2);
    let third: Promise<void> | undefined;
    try {
      await waitForStartedCount(root, 2);
      third = runMaterializationProcess(root, "slot-3", commits[2], 2);
      await waitForLockWait(root, "slot-3:slot");
      await expect(readStartedIds(root)).resolves.toHaveLength(2);
      await writeFile(path.join(root, "release-slot-1"), "release\n", "utf8");
      await waitForStartedCount(root, 3);
      await Promise.all(
        ["slot-2", "slot-3"].map((id) =>
          writeFile(path.join(root, `release-${id}`), "release\n", "utf8")
        )
      );
      await Promise.all([first, second, third]);

      await expect(readStartedIds(root)).resolves.toHaveLength(3);
    } finally {
      await Promise.all(
        ["slot-1", "slot-2", "slot-3"].map((id) =>
          writeFile(path.join(root, `release-${id}`), "release\n", "utf8")
        )
      );
      await Promise.allSettled([first, second, ...(third === undefined ? [] : [third])]);
    }
  }, 20_000);

  test("不同候选跨运行遵守物化并发上限", async () => {
    const root = await createTemporaryDirectory();
    const materializationDirectory = path.join(root, "materialized");
    const commits = ["1".repeat(40), "2".repeat(40)] as const;
    let activeNpmCi = 0;
    let maximumActiveNpmCi = 0;
    let markFirstNpmCiStarted: (() => void) | undefined;
    const firstNpmCiStarted = new Promise<void>((resolve) => {
      markFirstNpmCiStarted = resolve;
    });
    let releaseFirstNpmCi: (() => void) | undefined;
    const firstNpmCiRelease = new Promise<void>((resolve) => {
      releaseFirstNpmCi = resolve;
    });
    const createSystem = (candidateCommit: string, runName: string) => {
      const fixture = createGitCandidateExecutor();
      return createSystemCompatibilitySystem({
        artifactDirectory: path.join(root, runName),
        materializationDirectory,
        materializationConcurrency: 1,
        choiceMindRoot: root,
        execute: async (request) => {
          if (request.command === "git" && request.args.includes("rev-parse")) {
            return Buffer.from(`${candidateCommit}\n`);
          }
          if (request.command === "npm" && request.args[0] === "ci") {
            activeNpmCi += 1;
            maximumActiveNpmCi = Math.max(maximumActiveNpmCi, activeNpmCi);
            if (candidateCommit === commits[0]) {
              markFirstNpmCiStarted?.();
              await firstNpmCiRelease;
            }
            activeNpmCi -= 1;
          }
          return fixture.execute(request);
        }
      });
    };
    const first = createSystem(commits[0], "run-1");
    const second = createSystem(commits[1], "run-2");
    const candidate = (candidateCommit: string) => ({
      schemaVersion: 1 as const,
      kind: "git-commit" as const,
      repository: "https://github.com/Eclipseic1848/CoreMind.git" as const,
      commit: candidateCommit
    });

    const firstRun = first.materializeGitCommit(candidate(commits[0]));
    await firstNpmCiStarted;
    const secondRun = second.materializeGitCommit(candidate(commits[1]));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(maximumActiveNpmCi).toBe(1);
    releaseFirstNpmCi?.();
    await Promise.all([firstRun, secondRun]);
    expect(maximumActiveNpmCi).toBe(1);
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
    const progressPaths: Array<string[] | undefined> = [];
    const baseExecutor = createNpmCandidateExecutor(version);
    const source = createSystemCompatibilitySystem({
      artifactDirectory,
      choiceMindRoot: root,
      execute: async (request) => {
        if (request.command === "npm") {
          environments.push(request.environment);
          progressPaths.push(request.progressPaths);
        }
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
    expect(progressPaths.every((paths) => paths?.includes(cache ?? ""))).toBe(true);
    expect(
      progressPaths.every((paths) =>
        paths?.every((progressPath) =>
          path.resolve(progressPath).startsWith(path.resolve(artifactDirectory))
        )
      )
    ).toBe(true);
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
          dependencies: expect.objectContaining({
            "coremind-runtime": version
          })
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
      runCoreMindCompatibility({ schemaVersion: 1, kind: "npm-release", version, packages }, source)
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
      runCoreMindCompatibility({ schemaVersion: 1, kind: "npm-release", version, packages }, source)
    ).rejects.toMatchObject({ gate: "B", code: "ATOMIC_ASSEMBLY_INVALID" });
  });
});

interface CompatibilityRunnerHarnessOptions {
  coreMindAiEntrypoint?: "valid" | "missing";
  actualNodeVersion?: string;
  actualPnpmVersion?: string;
  corepackHome?: string;
  cleanupFailure?: boolean;
  commandTimeoutMs?: number;
  dependencyRegistry?: string;
  dependencyProbeOutput?: Buffer;
  dependencyProbeTransform?: (
    items: Array<Record<string, unknown>>
  ) => Array<Record<string, unknown>>;
  gateEPassedTests?: number;
  gateDAdapterFailureName?: string;
  gateDAdapterSuiteFailure?: boolean;
  gateDAdapterSuiteFailureMessage?: string;
  localModelGate?: Readonly<{ providerBaseUrl: string; model: string }>;
  localModelSmokeOutput?: unknown;
  preexistingLocalModelSmokeOutput?: unknown;
  skipLocalModelSmokeWrite?: boolean;
  onInstall?: (request: CommandRequest) => Promise<void>;
  onHangStarted?: () => void;
  resolvedVersion?: string;
  resolvedContentSha256?: string;
  resolveCoreMindRuntimeFrom?: string;
  runRealDependencyProbe?: boolean;
  shouldHang?: (request: CommandRequest) => boolean;
  shouldFail?: (request: CommandRequest) => boolean;
  signal?: AbortSignal;
  tamperCandidateContentBeforeResolution?: boolean;
  useDefaultCorepackHome?: boolean;
  workspacePackageManager?: string;
  workspaceOverridesOutput?: string;
}

async function createCompatibilityRunnerHarness(options: CompatibilityRunnerHarnessOptions = {}) {
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
  const corepackHome = options.corepackHome ?? path.join(root, "corepack-home");
  const candidate = createMaterializedCandidate();
  const resolvedContentSha256 = new Map<string, string>();
  const commands: string[] = [];
  const installedOverrides: Record<string, string> = {};
  const installedLegacyOverrides: Record<string, string> = {};
  const installEnvironment: Record<string, string> = {};
  const installEnvironments: Array<Record<string, string>> = [];
  const installWorkingDirectories: string[] = [];
  const pnpmEnvironments: Array<Record<string, string>> = [];
  const localModelEnvironment: Record<string, string> = {};
  let temporaryChoiceMindRoot = "";
  let cleanupFailed = false;

  await mkdir(packageDirectory, { recursive: true });
  if (options.corepackHome === undefined && !options.useDefaultCorepackHome) {
    await createCorepackPnpmFixture(corepackHome, "11.21.0");
  }
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
    const isCoreMindAi = artifact.name === "coremind-ai";
    const entrypointFiles =
      options.runRealDependencyProbe && isCoreMindAi && options.coreMindAiEntrypoint !== "missing"
        ? { "index.js": "export const fixture = true;\n" }
        : {};
    const manifest = {
      name: artifact.name,
      version: artifact.version,
      dependencies: artifact.dependencies,
      peerDependencies: artifact.peerDependencies,
      ...(options.runRealDependencyProbe
        ? {
            type: "module",
            exports: {
              ".": {
                import:
                  isCoreMindAi && options.coreMindAiEntrypoint === "missing"
                    ? "./missing.js"
                    : "./index.js"
              }
            }
          }
        : {})
    };
    const bytes = createPackageTarball(manifest, entrypointFiles);
    artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
    artifact.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    resolvedContentSha256.set(
      artifact.name,
      packageContentSha256(manifest, entrypointFiles)
    );
    await writeFile(path.join(packageDirectory, artifact.fileName), bytes);
  }

  const systemOptions = {
    artifactDirectory,
    choiceMindRoot: stableChoiceMindRoot,
    ...(options.dependencyRegistry === undefined
      ? {}
      : { dependencyRegistry: options.dependencyRegistry }),
    ...(options.useDefaultCorepackHome ? {} : { corepackHome }),
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.localModelGate === undefined ? {} : { localModelGate: options.localModelGate }),
    ...(options.cleanupFailure
      ? {
          removeDirectory: async (...args: Parameters<typeof rm>): Promise<void> => {
            if (!cleanupFailed) {
              cleanupFailed = true;
              throw Object.assign(new Error("不得进入安全报告的清理错误"), {
                code: "EPERM"
              });
            }
            await rm(...args);
          }
        }
      : {}),
    execute: async (request) => {
      commands.push(`${request.command} ${request.args.join(" ")}`);
      if (request.command === "pnpm") {
        pnpmEnvironments.push({ ...(request.environment ?? {}) });
      }
      if (request.command === "git" && request.args[0] === "clone") {
        const clonedChoiceMindRoot = request.args.at(-1) ?? "";
        temporaryChoiceMindRoot = clonedChoiceMindRoot;
        await mkdir(path.join(clonedChoiceMindRoot, "apps", "orchestrator"), {
          recursive: true
        });
        await writeFile(
          path.join(clonedChoiceMindRoot, "package.json"),
          `${JSON.stringify({ name: "choicemind", private: true })}\n`,
          "utf8"
        );
        await writeFile(
          path.join(clonedChoiceMindRoot, "apps", "orchestrator", "package.json"),
          `${JSON.stringify({
            name: "@choicemind/orchestrator",
            dependencies: { "coremind-ai": "0.3.0" }
          })}\n`,
          "utf8"
        );
        if (options.preexistingLocalModelSmokeOutput !== undefined) {
          const summaryDirectory = path.join(
            clonedChoiceMindRoot,
            "apps",
            "orchestrator",
            ".artifacts"
          );
          await mkdir(summaryDirectory, { recursive: true });
          await writeFile(
            path.join(summaryDirectory, "coremind-qwen-smoke.json"),
            `${JSON.stringify(options.preexistingLocalModelSmokeOutput)}\n`,
            "utf8"
          );
        }
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
          request.signal?.addEventListener("abort", () => reject(new Error("测试命令已中断")), {
            once: true
          });
        });
      }
      if (request.command === "pnpm" && request.args[0] === "install") {
        await options.onInstall?.(request);
        if (!request.cwd) throw new Error("测试缺少候选安装工作目录");
        const manifest = JSON.parse(
          await readFile(path.join(request.cwd, "package.json"), "utf8")
        ) as {
          pnpm?: { overrides?: Record<string, string> };
        };
        Object.assign(installedLegacyOverrides, manifest.pnpm?.overrides ?? {});
        Object.assign(installEnvironment, request.environment ?? {});
        installEnvironments.push({ ...(request.environment ?? {}) });
        installWorkingDirectories.push(request.cwd);
        if (options.runRealDependencyProbe) {
          await createStrictPnpmRuntimeLayout(
            request.cwd,
            candidate.packages,
            options.coreMindAiEntrypoint ?? "valid"
          );
        }
        return Buffer.alloc(0);
      }
      if (request.command === "pnpm" && request.args[0] === "config" && request.args[1] === "get") {
        return Buffer.from(options.workspaceOverridesOutput ?? "");
      }
      if (request.command === "pnpm" && request.args[0] === "config" && request.args[1] === "set") {
        const rawOverrides = request.args.at(-1);
        if (!rawOverrides) throw new Error("测试缺少 workspace overrides");
        Object.assign(installedOverrides, JSON.parse(rawOverrides) as Record<string, string>);
        return Buffer.alloc(0);
      }
      if (request.command === "node" && request.args[0] === "--version") {
        return Buffer.from(`${options.actualNodeVersion ?? "v22.22.1"}\n`);
      }
      if (request.command === "pnpm" && request.args[0] === "--version") {
        return Buffer.from(`${options.actualPnpmVersion ?? "11.21.0"}\n`);
      }
      if (request.command === "pnpm" && request.args.includes("smoke:coremind:qwen")) {
        Object.assign(localModelEnvironment, request.environment ?? {});
        if (options.skipLocalModelSmokeWrite) return Buffer.alloc(0);
        if (!request.cwd) throw new Error("测试缺少 Gate G 工作目录");
        const summaryPath = request.environment?.CHOICEMIND_COREMIND_SMOKE_SUMMARY_PATH;
        const evidenceNonce = request.environment?.CHOICEMIND_COREMIND_SMOKE_NONCE;
        if (!summaryPath || !evidenceNonce) throw new Error("测试缺少 Gate G 证据绑定");
        const summaryDirectory = path.dirname(summaryPath);
        await mkdir(summaryDirectory, { recursive: true });
        const smokeOutput =
          options.localModelSmokeOutput !== null &&
          typeof options.localModelSmokeOutput === "object" &&
          !Array.isArray(options.localModelSmokeOutput) &&
          !("evidenceNonce" in options.localModelSmokeOutput)
            ? { ...options.localModelSmokeOutput, evidenceNonce }
            : options.localModelSmokeOutput;
        await writeFile(
          summaryPath,
          `${JSON.stringify(smokeOutput)}\n`,
          "utf8"
        );
        return Buffer.from("不得参与 Gate G 摘要解析的 pnpm stdout");
      }
      if (request.command === "node" && request.args[0]?.endsWith("probe.mjs")) {
        if (options.tamperCandidateContentBeforeResolution) {
          const artifact = candidate.packages.find((item) => item.name === "coremind-ai");
          if (!artifact) throw new Error("测试候选缺少 coremind-ai");
          await writeFile(path.join(packageDirectory, artifact.fileName), "not-a-gzip", "utf8");
        }
        if (options.dependencyProbeOutput !== undefined) {
          return options.dependencyProbeOutput;
        }
        if (options.runRealDependencyProbe) {
          return runNodeProbe(request);
        }
        const probeChoiceMindRoot = path.resolve(request.cwd ?? "", "..", "..");
        const probeItems: Array<Record<string, unknown>> = candidate.packages
          .filter((artifact) => !["coremind-worker", "coremind-cli"].includes(artifact.name))
          .map((artifact) => ({
            name: artifact.name,
            version: options.resolvedVersion ?? artifact.version,
            location: path.join(probeChoiceMindRoot, "node_modules", artifact.name),
            contentSha256:
              options.resolvedContentSha256 ?? resolvedContentSha256.get(artifact.name),
            resolvedDependencies:
              artifact.name === "coremind-ai"
                ? Object.keys(artifact.dependencies).map((name) => ({
                    name,
                    location:
                      name === "coremind-runtime" && options.resolveCoreMindRuntimeFrom
                        ? path.join(
                            probeChoiceMindRoot,
                            "node_modules",
                            "coremind-ai",
                            "node_modules",
                            name
                          )
                        : path.join(probeChoiceMindRoot, "node_modules", name)
                  }))
                : []
          }));
        return Buffer.from(
          JSON.stringify(options.dependencyProbeTransform?.(probeItems) ?? probeItems)
        );
      }
      if (request.command === "pnpm" && request.args.includes("--reporter=json")) {
        if (
          request.args.includes("Gate D:") &&
          (options.gateDAdapterSuiteFailure || options.gateDAdapterSuiteFailureMessage)
        ) {
          return Buffer.from(
            JSON.stringify({
              numPassedTests: 0,
              numFailedTests: 0,
              numFailedTestSuites: 1,
              success: false,
              testResults: [
                {
                  name: "C:\\private-token\\apps\\orchestrator\\src\\runtime\\coremind-agent-runtime-adapter.test.ts",
                  status: "failed",
                  message:
                    options.gateDAdapterSuiteFailureMessage ??
                    "SyntaxError: coremind-ai does not provide an export named 'private-token'"
                }
              ]
            })
          );
        }
        if (request.args.includes("Gate D:") && options.gateDAdapterFailureName) {
          return Buffer.from(
            JSON.stringify({
              numPassedTests: 13,
              numFailedTests: 1,
              success: false,
              testResults: [
                {
                  assertionResults: [
                    {
                      fullName: options.gateDAdapterFailureName,
                      status: "failed",
                      failureMessages: ["不得进入安全报告的原始断言失败"]
                    }
                  ]
                }
              ]
            })
          );
        }
        return Buffer.from(
          JSON.stringify({
            numPassedTests: request.args.includes("Gate E:") ? (options.gateEPassedTests ?? 2) : 14,
            numFailedTests: 0,
            success: true
          })
        );
      }
      return Buffer.alloc(0);
    }
  } satisfies Parameters<typeof createSystemCompatibilitySystem>[0];
  setTrustedPnpmContentSha512ForTest(systemOptions, trustedPnpmFixtureContentSha512);
  const source = createSystemCompatibilitySystem(systemOptions);

  return {
    artifactDirectory,
    candidate,
    commands,
    environment: {
      choiceMindCommit: "b".repeat(40),
      nodeVersion: "22.22.1",
      workspacePackageManager: options.workspacePackageManager ?? "pnpm@11.21.0",
      artifactPackageManager: "npm@10.9.4"
    },
    installEnvironment,
    installEnvironments,
    installWorkingDirectories,
    installedLegacyOverrides,
    pnpmEnvironments,
    localModelEnvironment,
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
  const result = spawnSync("git", args, {
    encoding: "utf8",
    windowsHide: true
  });
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

async function directoryEntriesOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "choicemind-coremind-system-test-"))
  );
  temporaryPaths.push(directory);
  return directory;
}

function runMaterializationProcess(
  root: string,
  runId: string,
  candidateCommit: string,
  concurrency: number,
  releaseWaitTimeoutMs?: number
): Promise<void> {
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const fixture = path.join(
    process.cwd(),
    "scripts",
    "coremind-compat",
    "process-materialization-fixture.ts"
  );
  const child = spawn(
    process.execPath,
    [tsxCli, fixture, root, runId, candidateCommit, String(concurrency)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(releaseWaitTimeoutMs === undefined
          ? {}
          : { CHOICEMIND_FIXTURE_RELEASE_TIMEOUT_MS: String(releaseWaitTimeoutMs) })
      },
      windowsHide: true
    }
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => {
      if (child.pid === undefined) resolve();
    });
  });
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `跨进程物化夹具失败（${runId} / ${String(code)}）：${Buffer.concat(stderr).toString("utf8")}${Buffer.concat(stdout).toString("utf8")}`
          )
        );
      }
    });
  });
  void completion.catch(() => undefined);
  const processRecord = { child, closed, completion };
  materializationProcesses.add(processRecord);
  void closed.then(() => materializationProcesses.delete(processRecord));
  return completion;
}

async function stopMaterializationProcess(
  record: (typeof materializationProcesses extends Set<infer Entry> ? Entry : never)
): Promise<void> {
  const { child, closed } = record;
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    await waitForProcessClose(closed, 2_000);
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 2_000,
      windowsHide: true
    });
  } else {
    child.kill("SIGTERM");
    if (!(await waitForProcessClose(closed, 500, false))) child.kill("SIGKILL");
  }
  await waitForProcessClose(closed, 2_000);
}

async function waitForProcessClose(
  closed: Promise<void>,
  timeoutMs: number,
  throwOnTimeout = true
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    })
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!completed && throwOnTimeout) throw new Error("跨进程物化夹具未在时限内退出");
  return completed;
}

async function readStartedIds(root: string): Promise<string[]> {
  try {
    return (await readFile(path.join(root, "started.log"), "utf8")).split(/\r?\n/u).filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForStartedCount(root: string, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await readStartedIds(root)).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待跨进程物化开始超时：${expected}`);
}

async function waitForLockWait(root: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const waits = (await readFile(path.join(root, "waiting.log"), "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean);
      if (waits.includes(expected)) return;
    } catch {
      // 子进程可能尚未创建握手文件。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待跨进程锁竞争握手超时：${expected}`);
}

async function runPermissionPreflight(
  root: string,
  permissionFileSystem: Partial<MaterializationPermissionFileSystem>
) {
  const artifactDirectory = path.join(root, "artifacts");
  return materializeWithReuse(
    { artifactDirectory, permissionFileSystem },
    {
      schemaVersion: 1,
      kind: "git-commit",
      repository: "https://github.com/Eclipseic1848/CoreMind.git",
      commit
    },
    path.join(artifactDirectory, "packages"),
    {
      nodeVersion: "22.22.1",
      workspacePackageManager: "pnpm@11.21.0",
      artifactPackageManager: "npm@10.9.4",
      platform: process.platform,
      architecture: process.arch
    },
    async () => {
      throw new Error("权限预检失败后不得进入物化回调");
    }
  );
}

function materializationTestEnvironment() {
  return {
    nodeVersion: "22.22.1",
    workspacePackageManager: "pnpm@11.21.0",
    artifactPackageManager: "npm@10.9.4",
    platform: process.platform,
    architecture: process.arch
  };
}

async function writeMaterializationTestCandidate(packageDirectory: string) {
  const candidate = createMaterializedCandidate();
  await mkdir(packageDirectory, { recursive: true });
  const packages = [];
  for (const artifact of candidate.packages) {
    const content = Buffer.from(artifact.name, "utf8");
    await writeFile(path.join(packageDirectory, artifact.fileName), content);
    packages.push({
      ...artifact,
      sha256: createHash("sha256").update(content).digest("hex")
    });
  }
  return { ...candidate, lockfileSha256: "b".repeat(64), packages };
}

function permissionError(code: "EACCES" | "EPERM"): Error {
  return Object.assign(new Error("测试权限失败"), { code });
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function createCorepackPnpmFixture(corepackHome: string, version: string): Promise<void> {
  const packageDirectory = path.join(corepackHome, "v1", "pnpm", version);
  const hash = trustedPnpmCorepackHash;
  await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "pnpm", version })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, ".corepack"),
    `${JSON.stringify({ locator: { name: "pnpm", reference: `${version}+${hash}` }, hash })}\n`,
    "utf8"
  );
  await writeFile(path.join(packageDirectory, "bin", "pnpm.mjs"), "export {};\n", "utf8");
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
      if (request.command === "node" && request.args[0] === "scripts/release-version.mjs") {
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
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({ name: "coremind", lockfileVersion: 3 })}\n`,
    "utf8"
  );
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
  const directories = await import("node:fs/promises").then(({ readdir }) => readdir(packageRoot));
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
  ) as {
    name: string;
    version: string;
    dependencies: Record<string, string>;
  };
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
  type?: string;
  exports?: { ".": { import: string } };
}, additionalFiles: Readonly<Record<string, string>> = {}): Buffer {
  const files = [
    ["package/package.json", `${JSON.stringify(manifest)}\n`] as const,
    ...Object.entries(additionalFiles).map(
      ([name, content]) => [`package/${name}`, content] as const
    )
  ];
  const entries = files.map(([name, content]) => createTarFile(name, Buffer.from(content, "utf8")));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function createTarFile(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, name);
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
  return Buffer.concat([header, content, padding]);
}

function packageContentSha256(manifest: {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  type?: string;
  exports?: { ".": { import: string } };
}, additionalFiles: Readonly<Record<string, string>> = {}): string {
  const files = [
    ["package.json", Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8")] as const,
    ...Object.entries(additionalFiles).map(
      ([name, content]) => [name, Buffer.from(content, "utf8")] as const
    )
  ].sort(([left], [right]) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const [relativePath, content] of files) {
    hash
      .update(`${Buffer.byteLength(relativePath)}:`)
      .update(relativePath)
      .update(`${content.length}:`)
      .update(content);
  }
  return hash.digest("hex");
}

async function createStrictPnpmRuntimeLayout(
  choiceMindRoot: string,
  artifacts: ReturnType<typeof createMaterializedCandidate>["packages"],
  coreMindAiEntrypoint: "valid" | "missing"
): Promise<void> {
  const nodeModules = path.join(choiceMindRoot, "node_modules");
  const packageStore = path.join(nodeModules, ".pnpm-fixture");
  const runtimeArtifacts = artifacts.filter(
    (artifact) => !["coremind-worker", "coremind-cli"].includes(artifact.name)
  );
  const packageRoots = new Map<string, string>();
  await mkdir(packageStore, { recursive: true });
  for (const artifact of runtimeArtifacts) {
    const packageRoot = path.join(packageStore, artifact.name, "node_modules", artifact.name);
    packageRoots.set(artifact.name, packageRoot);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: artifact.name,
        version: artifact.version,
        dependencies: artifact.dependencies,
        peerDependencies: artifact.peerDependencies,
        type: "module",
        exports: {
          ".": {
            import:
              artifact.name === "coremind-ai" && coreMindAiEntrypoint === "missing"
                ? "./missing.js"
                : "./index.js"
          }
        }
      })}\n`,
      "utf8"
    );
    if (artifact.name === "coremind-ai" && coreMindAiEntrypoint !== "missing") {
      await writeFile(path.join(packageRoot, "index.js"), "export const fixture = true;\n", "utf8");
    }
  }
  for (const artifact of runtimeArtifacts) {
    const packageRoot = packageRoots.get(artifact.name);
    if (!packageRoot) throw new Error("测试缺少候选运行包目录");
    for (const dependencyName of Object.keys(artifact.dependencies).filter((name) =>
      packageRoots.has(name)
    )) {
      const dependencyRoot = packageRoots.get(dependencyName);
      if (!dependencyRoot) throw new Error("测试缺少候选内部依赖目录");
      const dependencyLink = path.join(path.dirname(packageRoot), dependencyName);
      await mkdir(path.dirname(dependencyLink), { recursive: true });
      await symlink(
        dependencyRoot,
        dependencyLink,
        process.platform === "win32" ? "junction" : "dir"
      );
    }
  }
  const coreMindAiRoot = packageRoots.get("coremind-ai");
  if (!coreMindAiRoot) throw new Error("测试缺少 coremind-ai");
  await symlink(
    coreMindAiRoot,
    path.join(nodeModules, "coremind-ai"),
    process.platform === "win32" ? "junction" : "dir"
  );
}

function runNodeProbe(request: CommandRequest): Buffer {
  const result = spawnSync(process.execPath, request.args, {
    cwd: request.cwd,
    encoding: "buffer",
    env: { ...process.env, ...request.environment },
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8"));
  }
  return result.stdout;
}

function writeTarText(target: Buffer, offset: number, length: number, value: string): void {
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
