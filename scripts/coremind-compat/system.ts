import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);
const execFileAsync = promisify(execFile);
const REQUIRED_PNPM_VERSION = "11.21.0";
const REQUIRED_PNPM_COREPACK_HASH =
  "sha512.521705bce689924eac72f5a3587122f362689ef6571e55ba80076fd637c11132ecffada26fad4ea79c485bfddbfd3d5a2a5b05805a77e893de71ec8a6cca3bb1";

import {
  CORE_MIND_PACKAGE_NAMES,
  CORE_MIND_RUNTIME_DEPENDENCIES,
  type CoreMindCompatibilityStage,
  type CoreMindMaterializationStage,
  type CoreMindVerificationGate,
  type GitCommitCandidate,
  type NpmReleaseCandidate
} from "./index.js";
import {
  CoreMindArtifactMaterializationError,
  CoreMindCandidateVerificationError,
  type CoreMindCompatibilitySystem,
  type CoreMindCandidateVerification,
  type CoreMindCompatibilityEnvironment,
  type CoreMindMaterializationFailureReason,
  type MaterializedCoreMindCandidate,
  type MaterializedCoreMindPackage
} from "./internal-types.js";
import { trustedPnpmContentSha512 } from "./pnpm-trust.js";

export interface CommandRequest {
  command: "git" | "node" | "npm" | "pnpm";
  args: string[];
  cwd?: string;
  environment?: Record<string, string>;
  signal?: AbortSignal;
}

export type CommandExecutor = (request: CommandRequest) => Promise<Buffer>;

export interface SystemCompatibilityOptions {
  artifactDirectory: string;
  choiceMindRoot: string;
  corepackHome?: string;
  commandTimeoutMs?: number;
  execute?: CommandExecutor;
  signal?: AbortSignal;
}

export function createSystemCompatibilitySystem(
  options: SystemCompatibilityOptions
): CoreMindCompatibilitySystem {
  const baseExecutor = options.execute ?? executeSystemCommand;
  const execute: CommandExecutor = (request) =>
    executeWithControl(
      baseExecutor,
      request,
      options.signal,
      options.commandTimeoutMs ?? 10 * 60 * 1000
    );
  const packageDirectory = path.join(options.artifactDirectory, "packages");

  return {
    materializeGitCommit: async (candidate) =>
      withNpmSandbox(options.artifactDirectory, execute, (isolatedExecute) =>
        materializeGitCommit(candidate, packageDirectory, isolatedExecute)
      ),
    materializeNpmRelease: async (candidate) =>
      withNpmSandbox(options.artifactDirectory, execute, (isolatedExecute) =>
        materializeNpmRelease(candidate, packageDirectory, isolatedExecute)
      ),
    describeEnvironment: async () => describeEnvironment(options.choiceMindRoot, execute),
    verifyCandidateCompatibility: async (candidate, environment) =>
      verifyCandidateCompatibility(options, candidate, environment, execute)
  };
}

async function verifyCandidateCompatibility(
  options: SystemCompatibilityOptions,
  candidate: MaterializedCoreMindCandidate,
  environment: CoreMindCompatibilityEnvironment,
  execute: CommandExecutor
): Promise<CoreMindCandidateVerification> {
  const packageManagerSetup = await atVerificationStage(
    "C",
    "CANDIDATE_INSTALL",
    async () => {
      const configuredHome = options.corepackHome ?? defaultCorepackHome();
      if (!configuredHome.trim()) throw new Error("Corepack 来源目录不能为空");
      const version = environment.workspacePackageManager.match(/^pnpm@([^+]+)(?:\+.+)?$/u)?.[1];
      if (!version) throw new Error("工作区 packageManager 必须是精确 pnpm 版本");
      if (version !== REQUIRED_PNPM_VERSION) {
        throw new Error(`Gate C 必须使用 pnpm ${REQUIRED_PNPM_VERSION}`);
      }
      const sourceCorepackHome = path.resolve(configuredHome);
      const sourcePackageDirectory = path.join(
        sourceCorepackHome,
        "v1",
        "pnpm",
        version
      );
      const cachedManifest = JSON.parse(
        await readFile(path.join(sourcePackageDirectory, "package.json"), "utf8")
      ) as { name?: unknown; version?: unknown };
      if (cachedManifest.name !== "pnpm" || cachedManifest.version !== version) {
        throw new Error("Corepack 来源 pnpm 清单身份不匹配");
      }
      const corepackMetadata = JSON.parse(
        await readFile(path.join(sourcePackageDirectory, ".corepack"), "utf8")
      ) as {
        hash?: unknown;
        locator?: { name?: unknown; reference?: unknown };
      };
      if (
        corepackMetadata.locator?.name !== "pnpm" ||
        corepackMetadata.hash !== REQUIRED_PNPM_COREPACK_HASH ||
        corepackMetadata.locator.reference !== `${version}+${REQUIRED_PNPM_COREPACK_HASH}`
      ) {
        throw new Error("Corepack 来源 pnpm 完整性元数据不匹配");
      }
      const trustedContentSha512 = trustedPnpmContentSha512(options);
      if ((await sha512Directory(sourcePackageDirectory)) !== trustedContentSha512) {
        throw new Error("Corepack 来源 pnpm 内容摘要不匹配");
      }
      return { sourceCorepackHome, trustedContentSha512, version };
    }
  );
  const temporaryRoot = await atVerificationStage("C", "CHOICEMIND_COPY", () =>
    mkdtemp(path.join(os.tmpdir(), "choicemind-coremind-runner-"))
  );
  const choiceMindRoot = path.join(temporaryRoot, "workspace");
  let sandboxDirectory: string | undefined;
  let failure: CoreMindCandidateVerificationError | undefined;
  let verification: CoreMindCandidateVerification | undefined;

  try {
    await atVerificationStage("C", "CHOICEMIND_COPY", async () => {
      await execute({
        command: "git",
        args: ["clone", "--no-hardlinks", "--no-checkout", options.choiceMindRoot, choiceMindRoot]
      });
      await execute({
        command: "git",
        args: ["-C", choiceMindRoot, "checkout", "--detach", environment.choiceMindCommit]
      });
      const actualCommit = (
        await execute({
          command: "git",
          args: ["-C", choiceMindRoot, "rev-parse", "HEAD"]
        })
      )
        .toString("utf8")
        .trim()
        .toLowerCase();
      if (actualCommit !== environment.choiceMindCommit) {
        throw new Error("临时 ChoiceMind 副本 commit 身份不一致");
      }
    });

    const isolatedEnvironment = await atVerificationStage(
      "C",
      "CANDIDATE_INSTALL",
      async () => {
        const currentSandboxDirectory = await mkdtemp(
          path.join(options.artifactDirectory, ".pnpm-runner-sandbox-")
        );
        sandboxDirectory = currentSandboxDirectory;
        const storeDirectory = path.join(currentSandboxDirectory, "store");
        const cacheDirectory = path.join(currentSandboxDirectory, "cache");
        const corepackDirectory = path.join(currentSandboxDirectory, "corepack");
        const globalConfigPath = path.join(currentSandboxDirectory, "globalconfig");
        const userConfigPath = path.join(currentSandboxDirectory, "userconfig");
        await mkdir(storeDirectory, { recursive: true });
        await mkdir(cacheDirectory, { recursive: true });
        await mkdir(corepackDirectory, { recursive: true });
        await seedPnpmCorepackCache(
          packageManagerSetup.sourceCorepackHome,
          corepackDirectory,
          packageManagerSetup.version,
          packageManagerSetup.trustedContentSha512
        );
        await writeFile(globalConfigPath, "", "utf8");
        await writeFile(userConfigPath, "", "utf8");
        const commandEnvironment = {
          COREPACK_ENABLE_NETWORK: "0",
          COREPACK_HOME: corepackDirectory,
          npm_config_cache: cacheDirectory,
          npm_config_cache_dir: cacheDirectory,
          npm_config_globalconfig: globalConfigPath,
          npm_config_userconfig: userConfigPath
        };
        const seededPnpmVersion = (
          await execute({
            command: "pnpm",
            args: ["--version"],
            cwd: choiceMindRoot,
            environment: commandEnvironment
          })
        )
          .toString("utf8")
          .trim();
        if (seededPnpmVersion !== REQUIRED_PNPM_VERSION) {
          throw new Error(`Gate C 必须预置 pnpm ${REQUIRED_PNPM_VERSION}`);
        }
        await injectCandidateOverrides(choiceMindRoot, options.artifactDirectory, candidate);
        await execute({
          command: "pnpm",
          args: [
            "install",
            "--ignore-scripts",
            "--no-frozen-lockfile",
            "--store-dir",
            storeDirectory
          ],
          cwd: choiceMindRoot,
          environment: commandEnvironment
        });
        return commandEnvironment;
      }
    );

    const resolvedRuntimePackages = await atVerificationStage(
      "C",
      "DEPENDENCY_RESOLUTION",
      async () => {
        const probePath = path.join(
          choiceMindRoot,
          "apps",
          "orchestrator",
          ".coremind-compat-probe.mjs"
        );
        await writeFile(probePath, dependencyProbeSource(), "utf8");
        const output = await execute({
          command: "node",
          args: [probePath],
          cwd: path.dirname(probePath),
          environment: isolatedEnvironment
        });
        return parseResolvedRuntimePackages(output, candidate.version);
      }
    );

    await atVerificationStage("C", "INTERFACE_TYPECHECK", () =>
      execute({
        command: "pnpm",
        args: ["--filter", "@choicemind/orchestrator", "typecheck"],
        cwd: choiceMindRoot,
        environment: isolatedEnvironment
      })
    );
    await atVerificationStage("C", "INTERFACE_BUILD", () =>
      execute({
        command: "pnpm",
        args: ["--filter", "@choicemind/orchestrator", "build"],
        cwd: choiceMindRoot,
        environment: isolatedEnvironment
      })
    );
    const contractTestCount = await atVerificationStage("D", "CONTRACT_TEST", async () => {
      const adapterTestCount = await executeVitestAndRequireTests(execute, {
        command: "pnpm",
        args: [
          "--filter",
          "@choicemind/orchestrator",
          "exec",
          "vitest",
          "run",
          "src/runtime/coremind-agent-runtime-adapter.test.ts",
          "--testNamePattern",
          "Gate D:",
          "--reporter=json"
        ],
        cwd: choiceMindRoot,
        environment: isolatedEnvironment
      });
      const contractTestCount = await executeVitestAndRequireTests(execute, {
        command: "pnpm",
        args: [
          "--filter",
          "@choicemind/orchestrator",
          "exec",
          "vitest",
          "run",
          "src/runtime/agent-runtime-factory.test.ts",
          "src/decision-tasks/executor.test.ts",
          "--reporter=json"
        ],
        cwd: choiceMindRoot,
        environment: isolatedEnvironment
      });
      return adapterTestCount + contractTestCount;
    });
    const verticalTestCount = await atVerificationStage("E", "VERTICAL_TEST", () =>
      executeVitestAndRequireTests(
        execute,
        {
          command: "pnpm",
          args: [
            "--filter",
            "@choicemind/orchestrator",
            "exec",
            "vitest",
            "run",
            "src/runtime/coremind-agent-runtime-adapter.test.ts",
            "--testNamePattern",
            "Gate E:",
            "--reporter=json"
          ],
          cwd: choiceMindRoot,
          environment: isolatedEnvironment
        },
        2
      )
    );
    await atVerificationStage("F", "ROOT_VERIFY", async () => {
      const nodeVersion = (
        await execute({
          command: "node",
          args: ["--version"],
          cwd: choiceMindRoot,
          environment: isolatedEnvironment
        })
      )
        .toString("utf8")
        .trim();
      if (nodeVersion !== "v22.22.1") {
        throw new Error("Gate F 必须使用 Node 22.22.1");
      }
      const pnpmVersion = (
        await execute({
          command: "pnpm",
          args: ["--version"],
          cwd: choiceMindRoot,
          environment: isolatedEnvironment
        })
      )
        .toString("utf8")
        .trim();
      if (pnpmVersion !== REQUIRED_PNPM_VERSION) {
        throw new Error(`Gate F 必须使用 pnpm ${REQUIRED_PNPM_VERSION}`);
      }
      await execute({
        command: "pnpm",
        args: ["verify"],
        cwd: choiceMindRoot,
        environment: isolatedEnvironment
      });
    });
    await atVerificationStage("F", "RESOURCE_CLEANUP", () =>
      execute({
        command: "node",
        args: ["-e", portAvailabilityProbeSource()],
        cwd: choiceMindRoot,
        environment: isolatedEnvironment
      })
    );
    verification = {
      resolvedRuntimePackages,
      testCounts: { D: contractTestCount, E: verticalTestCount }
    };
  } catch (error) {
    failure =
      error instanceof CoreMindCandidateVerificationError
        ? error
        : new CoreMindCandidateVerificationError("C", "CHOICEMIND_COPY", error);
  }

  const cleanupTargets = [
    rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100
    })
  ];
  if (sandboxDirectory !== undefined) {
    cleanupTargets.push(
      rm(sandboxDirectory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100
      })
    );
  }
  const cleanupResults = await Promise.allSettled(cleanupTargets);
  const cleanupFailure = cleanupResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (cleanupFailure) {
    throw new CoreMindCandidateVerificationError(
      failure?.gate ?? "F",
      "CLEANUP",
      cleanupFailure.reason,
      failure?.reason
    );
  }
  if (failure) throw failure;
  if (!verification) {
    throw new CoreMindCandidateVerificationError("F", "ROOT_VERIFY");
  }
  return verification;
}

async function seedPnpmCorepackCache(
  sourceCorepackHome: string,
  targetCorepackHome: string,
  version: string,
  trustedContentSha512: string
): Promise<void> {
  const relativePackagePath = path.join("v1", "pnpm", version);
  const sourcePackageDirectory = path.join(sourceCorepackHome, relativePackagePath);
  const targetPackageDirectory = path.join(targetCorepackHome, relativePackagePath);
  await mkdir(path.dirname(targetPackageDirectory), { recursive: true });
  await cp(sourcePackageDirectory, targetPackageDirectory, {
    errorOnExist: true,
    force: false,
    recursive: true
  });
  if ((await sha512Directory(targetPackageDirectory)) !== trustedContentSha512) {
    throw new Error("隔离 Corepack pnpm 内容摘要不匹配");
  }
}

async function sha512Directory(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      } else {
        throw new Error("Corepack pnpm 缓存包含不受支持的文件类型");
      }
    }
  };
  await visit(root);

  const hash = createHash("sha512");
  for (const filePath of files) {
    const relativePath = Buffer.from(path.relative(root, filePath).replaceAll("\\", "/"));
    const content = await readFile(filePath);
    hash.update(uint64(relativePath.length));
    hash.update(relativePath);
    hash.update(uint64(content.length));
    hash.update(content);
  }
  return `sha512.${hash.digest("hex")}`;
}

function uint64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function defaultCorepackHome(): string {
  const configuredHome = process.env.COREPACK_HOME;
  if (configuredHome?.trim()) return configuredHome;
  const cacheRoot = [process.env.XDG_CACHE_HOME, process.env.LOCALAPPDATA].find((value) =>
    value?.trim()
  );
  return path.join(
    cacheRoot ??
      path.join(os.homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
    "node",
    "corepack"
  );
}

async function injectCandidateOverrides(
  choiceMindRoot: string,
  artifactDirectory: string,
  candidate: MaterializedCoreMindCandidate
): Promise<void> {
  const manifestPath = path.join(choiceMindRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    pnpm?: { overrides?: Record<string, string> };
  };
  const overrides = { ...(manifest.pnpm?.overrides ?? {}) };
  const packages = new Map(candidate.packages.map((artifact) => [artifact.name, artifact]));
  for (const name of CORE_MIND_RUNTIME_DEPENDENCIES) {
    const artifact = packages.get(name);
    if (!artifact || path.basename(artifact.fileName) !== artifact.fileName) {
      throw new Error(`候选运行依赖 ${name} 制品路径无效`);
    }
    const tarballPath = path.join(artifactDirectory, "packages", artifact.fileName);
    const bytes = await readFile(tarballPath);
    if (sha256(bytes) !== artifact.sha256) {
      throw new Error(`${name} 候选制品 SHA-256 在安装前发生变化`);
    }
    assertPackedIntegrity(bytes, artifact.integrity, name);
    overrides[name] = `file:${path.resolve(tarballPath).replaceAll("\\", "/")}`;
  }
  manifest.pnpm = { ...(manifest.pnpm ?? {}), overrides };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function dependencyProbeSource(): string {
  return [
    'import { existsSync, readFileSync } from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `const names = ${JSON.stringify(CORE_MIND_RUNTIME_DEPENDENCIES)};`,
    "const result = names.map((name) => {",
    "  let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));",
    "  const root = path.parse(directory).root;",
    "  while (directory !== root) {",
    '    const manifestPath = path.join(directory, "package.json");',
    "    if (existsSync(manifestPath)) {",
    '      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));',
    "      if (manifest.name === name && typeof manifest.version === \"string\") {",
    "        return { name, version: manifest.version };",
    "      }",
    "    }",
    "    directory = path.dirname(directory);",
    "  }",
    '  throw new Error("无法解析 " + name + " 的 package.json");',
    "});",
    "process.stdout.write(JSON.stringify(result));"
  ].join("\n");
}

function portAvailabilityProbeSource(): string {
  return [
    'const { createServer } = require("node:net");',
    "const ports = [3000, 3100, 3200, 3300];",
    "(async () => {",
    "  for (const port of ports) {",
    "    await new Promise((resolve, reject) => {",
    "      const server = createServer();",
    '      server.once("error", reject);',
    '      server.listen(port, "127.0.0.1", () => server.close(resolve));',
    "    });",
    "  }",
    "})().catch(() => { process.exitCode = 1; });"
  ].join("\n");
}

function parseResolvedRuntimePackages(
  output: Buffer,
  expectedVersion: string
): CoreMindCandidateVerification["resolvedRuntimePackages"] {
  const value = JSON.parse(output.toString("utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("候选运行依赖解析结果不是数组");
  const resolved = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("候选运行依赖解析项无效");
    }
    const { name, version } = item as { name?: unknown; version?: unknown };
    if (typeof name !== "string" || typeof version !== "string" || resolved.has(name)) {
      throw new Error("候选运行依赖解析项身份无效");
    }
    if (!(CORE_MIND_RUNTIME_DEPENDENCIES as readonly string[]).includes(name)) {
      throw new Error(`候选环境解析到未知 CoreMind 运行包 ${name}`);
    }
    if (version !== expectedVersion) {
      throw new Error(`${name}=${version} 未解析到候选版本 ${expectedVersion}`);
    }
    resolved.set(name, version);
  }
  for (const name of CORE_MIND_RUNTIME_DEPENDENCIES) {
    if (!resolved.has(name)) throw new Error(`候选环境缺少运行依赖 ${name}`);
  }
  return CORE_MIND_RUNTIME_DEPENDENCIES.map((name) => ({
    name,
    version: resolved.get(name) ?? expectedVersion
  }));
}

async function executeVitestAndRequireTests(
  execute: CommandExecutor,
  request: CommandRequest,
  minimumPassedTests = 1
): Promise<number> {
  const output = await execute(request);
  const value = JSON.parse(output.toString("utf8")) as {
    numPassedTests?: unknown;
    numFailedTests?: unknown;
    success?: unknown;
  };
  if (
    value.success !== true ||
    !Number.isSafeInteger(value.numPassedTests) ||
    (value.numPassedTests as number) < minimumPassedTests ||
    value.numFailedTests !== 0
  ) {
    throw new Error("Vitest 未产生足够的通过测试证据");
  }
  return value.numPassedTests as number;
}

async function atVerificationStage<T>(
  gate: CoreMindVerificationGate,
  stage: CoreMindCompatibilityStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CoreMindCandidateVerificationError) throw error;
    throw new CoreMindCandidateVerificationError(
      gate,
      stage,
      error,
      error instanceof CoreMindCommandExecutionError ? error.reason : undefined
    );
  }
}

async function withNpmSandbox<T>(
  artifactDirectory: string,
  execute: CommandExecutor,
  operation: (isolatedExecute: CommandExecutor) => Promise<T>
): Promise<T> {
  const { sandboxDirectory, cacheDirectory, globalConfigPath, userConfigPath } =
    await atMaterializationStage("NPM_SANDBOX", async () => {
      const sandboxDirectory = path.join(artifactDirectory, ".npm-sandbox");
      const cacheDirectory = path.join(sandboxDirectory, "cache");
      const globalConfigPath = path.join(sandboxDirectory, "globalconfig");
      const userConfigPath = path.join(sandboxDirectory, "userconfig");
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(globalConfigPath, "", "utf8");
      await writeFile(userConfigPath, "", "utf8");
      return { sandboxDirectory, cacheDirectory, globalConfigPath, userConfigPath };
    });
  const isolatedExecute: CommandExecutor = (request) =>
    execute(
      request.command === "npm"
        ? {
            ...request,
            environment: {
              ...request.environment,
              npm_config_cache: cacheDirectory,
              npm_config_globalconfig: globalConfigPath,
              npm_config_userconfig: userConfigPath
            }
          }
        : request
    );
  try {
    return await operation(isolatedExecute);
  } finally {
    await atMaterializationStage("CLEANUP", () =>
      rm(sandboxDirectory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100
      })
    );
  }
}

async function materializeGitCommit(
  candidate: GitCommitCandidate,
  packageDirectory: string,
  execute: CommandExecutor
): Promise<MaterializedCoreMindCandidate> {
  const temporaryRoot = await atMaterializationStage("GIT_FETCH", () =>
    mkdtemp(path.join(os.tmpdir(), "choicemind-coremind-candidate-"))
  );
  const sourceDirectory = path.join(temporaryRoot, "source");
  const candidateVersion = commitCandidateVersion(candidate.commit);

  try {
    const sourceArchive = await atMaterializationStage("GIT_FETCH", async () => {
      await execute({ command: "git", args: ["init", sourceDirectory] });
      await execute({
        command: "git",
        args: ["-C", sourceDirectory, "remote", "add", "origin", candidate.repository]
      });
      await execute({
        command: "git",
        args: ["-C", sourceDirectory, "fetch", "--depth=1", "origin", candidate.commit]
      });
      await execute({
        command: "git",
        args: ["-C", sourceDirectory, "checkout", "--detach", "FETCH_HEAD"]
      });
      const actualCommit = (
        await execute({
          command: "git",
          args: ["-C", sourceDirectory, "rev-parse", "HEAD"]
        })
      )
        .toString("utf8")
        .trim()
        .toLowerCase();
      if (actualCommit !== candidate.commit) {
        throw new Error("Git checkout 身份与候选 commit 不一致");
      }
      return execute({
        command: "git",
        args: ["-C", sourceDirectory, "archive", "--format=tar", "HEAD"]
      });
    });
    const sourceSha256 = sha256(sourceArchive);

    await atMaterializationStage("NPM_CI", () =>
      execute({
        command: "npm",
        args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd: sourceDirectory
      })
    );
    await atMaterializationStage("VERSION_SYNC", () =>
      execute({
        command: "node",
        args: ["scripts/release-version.mjs", candidateVersion, "--no-lock"],
        cwd: sourceDirectory
      })
    );
    await atMaterializationStage("BUILD", () =>
      execute({ command: "npm", args: ["run", "build"], cwd: sourceDirectory })
    );
    await atMaterializationStage("PACK", () => mkdir(packageDirectory, { recursive: true }));
    const packages = await packGitPackages(
      sourceDirectory,
      packageDirectory,
      candidateVersion,
      execute
    );
    return {
      version: candidateVersion,
      identity: { kind: "git-source-archive", sha256: sourceSha256 },
      packages
    };
  } finally {
    await atMaterializationStage("CLEANUP", () =>
      rm(temporaryRoot, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100
      })
    );
  }
}

async function packGitPackages(
  sourceDirectory: string,
  packageDirectory: string,
  expectedVersion: string,
  execute: CommandExecutor
): Promise<MaterializedCoreMindPackage[]> {
  const packages: MaterializedCoreMindPackage[] = [];
  for (const name of CORE_MIND_PACKAGE_NAMES) {
    await atMaterializationStage("VERSION_SYNC", async () => {
      const value = await readPackageManifest(sourceDirectory, name);
      if (value.version !== expectedVersion) {
        throw new Error(`${name} 未同步到临时候选版本`);
      }
    });
    const packed = await atMaterializationStage("PACK", async () =>
      parsePackedPackage(
        await execute({
          command: "npm",
          args: [
            "pack",
            "--workspace",
            name,
            "--pack-destination",
            packageDirectory,
            "--json"
          ],
          cwd: sourceDirectory
        }),
        name
      )
    );
    const tarballPath = path.join(packageDirectory, packed.filename);
    const { packedManifest, tarball } = await atMaterializationStage(
      "TARBALL_VALIDATE",
      async () => {
        const manifest = await readPackedPackageManifest(tarballPath, name);
        if (manifest.version !== expectedVersion) {
          throw new Error(`${name} tgz 版本与候选不一致`);
        }
        const bytes = await readFile(tarballPath);
        assertPackedIntegrity(bytes, packed.integrity, name);
        return { packedManifest: manifest, tarball: bytes };
      }
    );
    packages.push({
      name,
      version: packedManifest.version,
      fileName: packed.filename,
      integrity: packed.integrity,
      sha256: sha256(tarball),
      dependencies: packedManifest.dependencies,
      optionalDependencies: packedManifest.optionalDependencies,
      peerDependencies: packedManifest.peerDependencies
    });
  }
  return packages;
}

async function materializeNpmRelease(
  candidate: NpmReleaseCandidate,
  packageDirectory: string,
  execute: CommandExecutor
): Promise<MaterializedCoreMindCandidate> {
  await atMaterializationStage("PACK", () => mkdir(packageDirectory, { recursive: true }));
  const packages: MaterializedCoreMindPackage[] = [];
  for (const name of CORE_MIND_PACKAGE_NAMES) {
    const metadata = await atMaterializationStage("NPM_VIEW", async () => {
      const value = parseNpmMetadata(
        await execute({
          command: "npm",
          args: ["view", `${name}@${candidate.version}`, "--json"]
        }),
        name
      );
      if (value.version !== candidate.version) {
        throw new Error(`${name} registry 版本与候选不一致`);
      }
      if (value.integrity !== candidate.packages[name].integrity) {
        throw new Error(`${name} registry integrity 与候选描述不一致`);
      }
      return value;
    });
    const packed = await atMaterializationStage("PACK", async () =>
      parsePackedPackage(
        await execute({
          command: "npm",
          args: [
            "pack",
            `${name}@${candidate.version}`,
            "--pack-destination",
            packageDirectory,
            "--json",
            "--ignore-scripts"
          ]
        }),
        name
      )
    );
    const tarballPath = path.join(packageDirectory, packed.filename);
    const { packedManifest, tarball } = await atMaterializationStage(
      "TARBALL_VALIDATE",
      async () => {
        if (packed.integrity !== metadata.integrity) {
          throw new Error(`${name} 下载制品 integrity 与 registry 元数据不一致`);
        }
        const manifest = await readPackedPackageManifest(tarballPath, name);
        if (manifest.version !== candidate.version) {
          throw new Error(`${name} tgz 版本与候选不一致`);
        }
        const bytes = await readFile(tarballPath);
        assertPackedIntegrity(bytes, packed.integrity, name);
        return { packedManifest: manifest, tarball: bytes };
      }
    );
    packages.push({
      name,
      version: packedManifest.version,
      fileName: packed.filename,
      integrity: packed.integrity,
      sha256: sha256(tarball),
      dependencies: packedManifest.dependencies,
      optionalDependencies: packedManifest.optionalDependencies,
      peerDependencies: packedManifest.peerDependencies
    });
  }
  const identity = CORE_MIND_PACKAGE_NAMES.map(
    (name) => `${name}\0${candidate.version}\0${candidate.packages[name].integrity}`
  ).join("\n");
  return {
    version: candidate.version,
    identity: { kind: "npm-package-set", sha256: sha256(Buffer.from(identity)) },
    packages
  };
}

async function describeEnvironment(
  choiceMindRoot: string,
  execute: CommandExecutor
): Promise<CoreMindCompatibilityEnvironment> {
  const choiceMindCommit = (
    await execute({
      command: "git",
      args: ["-C", choiceMindRoot, "rev-parse", "HEAD"]
    })
  )
    .toString("utf8")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(choiceMindCommit)) {
    throw new Error("无法确定 ChoiceMind commit 身份");
  }
  const rootManifest = JSON.parse(
    await readFile(path.join(choiceMindRoot, "package.json"), "utf8")
  ) as { packageManager?: unknown };
  if (typeof rootManifest.packageManager !== "string") {
    throw new Error("ChoiceMind packageManager 身份缺失");
  }
  const npmVersion = (
    await execute({ command: "npm", args: ["--version"] })
  ).toString("utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(npmVersion)) {
    throw new Error("无法确定实际 npm 版本");
  }
  return {
    choiceMindCommit,
    nodeVersion: process.versions.node,
    workspacePackageManager: rootManifest.packageManager,
    artifactPackageManager: `npm@${npmVersion}`
  };
}

interface PackageManifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

async function readPackageManifest(root: string, packageName: string): Promise<PackageManifest> {
  const directory = packageName === "coremind-ai" ? "coremind" : packageName;
  const value = JSON.parse(
    await readFile(path.join(root, "packages", directory, "package.json"), "utf8")
  ) as {
    name?: unknown;
    version?: unknown;
    dependencies?: unknown;
    optionalDependencies?: unknown;
    peerDependencies?: unknown;
  };
  if (value.name !== packageName) throw new Error(`${packageName} 包名不一致`);
  if (typeof value.version !== "string") throw new Error(`${packageName} 缺少版本`);
  return {
    name: packageName,
    version: value.version,
    dependencies: parseDependencies(value.dependencies, packageName),
    optionalDependencies: parseDependencies(value.optionalDependencies, packageName),
    peerDependencies: parseDependencies(value.peerDependencies, packageName)
  };
}

async function readPackedPackageManifest(
  tarballPath: string,
  expectedName: string
): Promise<PackageManifest> {
  const archive = await gunzipAsync(await readFile(tarballPath));
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarText(header, 124, 12).trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`${expectedName} tgz tar 条目大小无效`);
    }
    const contentOffset = offset + 512;
    const contentEnd = contentOffset + size;
    if (contentEnd > archive.length) throw new Error(`${expectedName} tgz 被截断`);
    if (entryPath === "package/package.json") {
      const value = JSON.parse(archive.subarray(contentOffset, contentEnd).toString("utf8")) as {
        name?: unknown;
        version?: unknown;
        dependencies?: unknown;
        optionalDependencies?: unknown;
        peerDependencies?: unknown;
      };
      if (value.name !== expectedName) throw new Error(`${expectedName} tgz 包名不一致`);
      if (typeof value.version !== "string") throw new Error(`${expectedName} tgz 缺少版本`);
      return {
        name: expectedName,
        version: value.version,
        dependencies: parseDependencies(value.dependencies, expectedName),
        optionalDependencies: parseDependencies(value.optionalDependencies, expectedName),
        peerDependencies: parseDependencies(value.peerDependencies, expectedName)
      };
    }
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${expectedName} tgz 缺少 package/package.json`);
}

function readTarText(header: Buffer, offset: number, length: number): string {
  const end = header.indexOf(0, offset);
  const boundedEnd = end === -1 || end > offset + length ? offset + length : end;
  return header.subarray(offset, boundedEnd).toString("utf8");
}

function assertPackedIntegrity(tarball: Buffer, expected: string, packageName: string): void {
  const actual = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (actual !== expected) throw new Error(`${packageName} tgz 字节与 integrity 不一致`);
}

function parseDependencies(value: unknown, packageName: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${packageName} dependencies 不是对象`);
  }
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") throw new Error(`${packageName} 依赖版本无效`);
    dependencies[name] = version;
  }
  return dependencies;
}

function parsePackedPackage(
  output: Buffer,
  expectedName: string
): { filename: string; integrity: string } {
  const value = JSON.parse(output.toString("utf8")) as unknown;
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${expectedName} npm pack 未返回唯一制品`);
  }
  const packed = value[0] as { name?: unknown; filename?: unknown; integrity?: unknown };
  if (
    packed.name !== expectedName ||
    typeof packed.filename !== "string" ||
    path.basename(packed.filename) !== packed.filename ||
    typeof packed.integrity !== "string"
  ) {
    throw new Error(`${expectedName} npm pack 元数据无效`);
  }
  return { filename: packed.filename, integrity: packed.integrity };
}

function parseNpmMetadata(
  output: Buffer,
  expectedName: string
): {
  version: string;
  integrity: string;
  dependencies: Record<string, string>;
} {
  const value = JSON.parse(output.toString("utf8")) as {
    name?: unknown;
    version?: unknown;
    dist?: { integrity?: unknown };
    dependencies?: unknown;
  };
  if (
    value.name !== expectedName ||
    typeof value.version !== "string" ||
    typeof value.dist?.integrity !== "string"
  ) {
    throw new Error(`${expectedName} registry 元数据无效`);
  }
  return {
    version: value.version,
    integrity: value.dist.integrity,
    dependencies: parseDependencies(value.dependencies, expectedName)
  };
}

function commitCandidateVersion(commit: string): string {
  return `0.0.0-rc.${BigInt(`0x${commit}`).toString(10)}`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atMaterializationStage<T>(
  stage: CoreMindMaterializationStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CoreMindArtifactMaterializationError) throw error;
    throw new CoreMindArtifactMaterializationError(
      stage,
      error,
      error instanceof CoreMindCommandExecutionError ? error.reason : undefined
    );
  }
}

class CoreMindCommandExecutionError extends Error {
  readonly reason: CoreMindMaterializationFailureReason;

  constructor(reason: CoreMindMaterializationFailureReason, cause?: unknown) {
    super(
      {
        TIMEOUT: "外部命令超时",
        CANCELLED: "外部命令已取消",
        COMMAND_FAILED: "外部命令执行失败",
        LAUNCH_FAILED: "外部命令无法启动"
      }[reason],
      { cause }
    );
    this.name = "CoreMindCommandExecutionError";
    this.reason = reason;
  }
}

export async function executeSystemCommand(request: CommandRequest): Promise<Buffer> {
  if (request.signal?.aborted) {
    throw commandInterruptionError(request.signal.reason);
  }
  const invocation = resolveCommandInvocation(request);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: request.cwd,
      env: { ...minimalEnvironment(), ...request.environment },
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    let interrupted = false;
    let settling = false;
    let termination: Promise<void> | undefined;
    const abort = () => {
      interrupted = true;
      termination ??= terminateProcessTree(child.pid);
      settle(null, false);
    };
    const settle = (code: number | null, launchFailed: boolean) => {
      if (settling) return;
      settling = true;
      request.signal?.removeEventListener("abort", abort);
      if (!interrupted && !launchFailed) {
        termination ??= terminateRemainingProcessTree(child.pid);
      }
      void (async () => {
        try {
          await termination;
        } catch (error) {
          reject(error);
          return;
        }
        if (interrupted) reject(commandInterruptionError(request.signal?.reason));
        else if (launchFailed) reject(new CoreMindCommandExecutionError("LAUNCH_FAILED"));
        else if (code === 0) resolve(Buffer.concat(stdout));
        else reject(new CoreMindCommandExecutionError("COMMAND_FAILED"));
      })();
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once("error", () => settle(null, true));
    child.once("close", (code) => settle(code, false));
  });
}

async function terminateRemainingProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    await terminateProcessTree(pid);
    return;
  }
  const descendants = await listWindowsDescendantPids(pid);
  for (const descendantPid of descendants.reverse()) {
    if (!(await runTaskkill(descendantPid)) && isProcessAlive(descendantPid)) {
      throw new Error(`无法终止遗留子进程（PID ${descendantPid}）`);
    }
  }
  if (!(await waitForExit(() => descendants.some(isProcessAlive), 2000))) {
    throw new Error(`无法确认遗留子进程已退出（根 PID ${pid}）`);
  }
}

async function listWindowsDescendantPids(rootPid: number): Promise<number[]> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = [uint32]${rootPid}`,
    "$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
    "$pending = @($rootPid)",
    "$descendants = @()",
    "while ($pending.Count -gt 0) {",
    "  $parents = @($pending)",
    "  $pending = @()",
    "  foreach ($item in $processes) {",
    "    $processId = [uint32]$item.ProcessId",
    "    if (($parents -contains [uint32]$item.ParentProcessId) -and ($descendants -notcontains $processId)) {",
    "      $descendants += $processId",
    "      $pending += $processId",
    "    }",
    "  }",
    "}",
    "[Console]::Out.Write(($descendants -join ','))"
  ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: minimalEnvironment(),
      timeout: 5000,
      windowsHide: true
    }
  );
  const output = stdout.trim();
  if (output === "") return [];
  return output.split(",").map((value) => {
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("无法解析 Windows 子进程树");
    }
    return pid;
  });
}

async function executeWithControl(
  execute: CommandExecutor,
  request: CommandRequest,
  outerSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Buffer> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("命令超时配置必须为正整数毫秒");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort("cancelled");
  if (outerSignal?.aborted) cancel();
  else outerSignal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    if (controller.signal.aborted) {
      throw commandInterruptionError(controller.signal.reason);
    }
    return await execute({ ...request, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw commandInterruptionError(controller.signal.reason);
    }
    if (error instanceof CoreMindCommandExecutionError) throw error;
    throw new CoreMindCommandExecutionError("COMMAND_FAILED", error);
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", cancel);
  }
}

function commandInterruptionError(reason: unknown): CoreMindCommandExecutionError {
  return new CoreMindCommandExecutionError(reason === "timeout" ? "TIMEOUT" : "CANCELLED");
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (!(await runTaskkill(pid))) {
      throw new Error(`无法确认 taskkill 已终止进程树（PID ${pid}）`);
    }
    if (!(await waitForExit(() => isProcessAlive(pid), 2000))) {
      throw new Error(`无法确认进程树已退出（PID ${pid}）`);
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // 子进程可能已在取消信号到达前退出。
  }
  if (await waitForExit(() => isProcessGroupAlive(pid), 1000)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 进程组可能已在升级信号前退出。
  }
  if (!(await waitForExit(() => isProcessGroupAlive(pid), 500))) {
    throw new Error(`无法确认进程树已退出（PID ${pid}）`);
  }
}

async function runTaskkill(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    let settled = false;
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(succeeded);
    };
    const timeout = setTimeout(() => {
      killer.kill();
      finish(false);
    }, 5000);
    timeout.unref();
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

async function waitForExit(isAlive: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!isAlive()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return !isAlive();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveCommandInvocation(request: CommandRequest): {
  command: string;
  args: string[];
} {
  if (request.command === "node") {
    return { command: process.execPath, args: request.args };
  }
  if (request.command === "npm" && process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    return { command: process.execPath, args: [npmCli, ...request.args] };
  }
  if (request.command === "pnpm") {
    const pnpmCli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "corepack",
      "dist",
      "pnpm.js"
    );
    return { command: process.execPath, args: [pnpmCli, ...request.args] };
  }
  return { command: request.command, args: request.args };
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "COMSPEC",
    "ComSpec"
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.NO_COLOR = "1";
  return environment;
}
