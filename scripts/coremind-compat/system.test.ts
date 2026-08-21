import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "vitest";

import { CORE_MIND_PACKAGE_NAMES, runCoreMindCandidateAssembly } from "./index.js";
import {
  createSystemArtifactSource,
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

test("环境报告同时记录工作区 pnpm 声明与实际 npm 版本", async () => {
  const root = await createTemporaryDirectory();
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ packageManager: "pnpm@11.21.0" })}\n`,
    "utf8"
  );
  const source = createSystemArtifactSource({
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
    const source = createSystemArtifactSource({
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
    ).rejects.toMatchObject({ stage });
  });

  test("版本同步命令成功但版本未更新时报告 VERSION_SYNC", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemArtifactSource({
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
    const source = createSystemArtifactSource({
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

  test("构建失败时仍删除临时 CoreMind 源码", async () => {
    const root = await createTemporaryDirectory();
    const executor = createGitCandidateExecutor();
    const source = createSystemArtifactSource({
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
    const source = createSystemArtifactSource({
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
    const source = createSystemArtifactSource({
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
    const source = createSystemArtifactSource({
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
    expect(caches.size).toBe(1);
    expect(userConfigs.size).toBe(1);
    const cache = [...caches][0];
    const userConfig = [...userConfigs][0];
    expect(cache).toMatch(/^.+[\\/]\.npm-sandbox[\\/]cache$/u);
    expect(userConfig).toMatch(/^.+[\\/]\.npm-sandbox[\\/]userconfig$/u);
    expect(path.resolve(cache ?? "").startsWith(path.resolve(artifactDirectory))).toBe(true);
    await expect(access(path.join(artifactDirectory, ".npm-sandbox"))).rejects.toThrow();
  });

  test("精确 RC 逐包核验 registry integrity 并下载八包", async () => {
    const root = await createTemporaryDirectory();
    const version = "0.3.1-rc.1";
    const packages = Object.fromEntries(
      CORE_MIND_PACKAGE_NAMES.map((name) => [name, { integrity: npmIntegrity(name, version) }])
    ) as Record<(typeof CORE_MIND_PACKAGE_NAMES)[number], { integrity: string }>;
    const source = createSystemArtifactSource({
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
    const systemSource = createSystemArtifactSource({
      artifactDirectory: path.join(root, "artifacts"),
      choiceMindRoot: root,
      execute: createNpmCandidateExecutor(version, {
        packedCoreMindRuntimeVersion: "0.3.0"
      })
    });
    const source = {
      ...systemSource,
      describeEnvironment: async () => ({
        choiceMindCommit: "b".repeat(40),
        nodeVersion: "22.22.1",
        workspacePackageManager: "pnpm@11.21.0",
        artifactPackageManager: "npm@10.9.4"
      })
    };

    await expect(
      runCoreMindCandidateAssembly(
        { schemaVersion: 1, kind: "npm-release", version, packages },
        source
      )
    ).rejects.toMatchObject({ gate: "B", code: "ATOMIC_ASSEMBLY_INVALID" });
  });
});

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

function createNpmCandidateExecutor(
  version: string,
  options: { packedCoreMindRuntimeVersion?: string } = {}
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
  options: { packedCoreMindRuntimeVersion?: string } = {}
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
        : {}
  });
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function createPackageTarball(manifest: {
  name: string;
  version: string;
  dependencies: Record<string, string>;
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

async function waitForProcessIds(pidPath: string): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(pidPath, "utf8")) as unknown;
      if (
        Array.isArray(value) &&
        value.length === 2 &&
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
