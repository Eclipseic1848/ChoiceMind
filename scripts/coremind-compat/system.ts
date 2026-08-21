import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);

import {
  CORE_MIND_PACKAGE_NAMES,
  type CoreMindMaterializationStage,
  type GitCommitCandidate,
  type NpmReleaseCandidate
} from "./index.js";
import {
  CoreMindArtifactMaterializationError,
  type CoreMindArtifactSource,
  type CoreMindCompatibilityEnvironment,
  type MaterializedCoreMindCandidate,
  type MaterializedCoreMindPackage
} from "./internal-types.js";

export interface CommandRequest {
  command: "git" | "node" | "npm";
  args: string[];
  cwd?: string;
  environment?: Record<string, string>;
  signal?: AbortSignal;
}

export type CommandExecutor = (request: CommandRequest) => Promise<Buffer>;

export interface SystemArtifactSourceOptions {
  artifactDirectory: string;
  choiceMindRoot: string;
  commandTimeoutMs?: number;
  execute?: CommandExecutor;
  signal?: AbortSignal;
}

export function createSystemArtifactSource(
  options: SystemArtifactSourceOptions
): CoreMindArtifactSource {
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
    describeEnvironment: async () => describeEnvironment(options.choiceMindRoot, execute)
  };
}

async function withNpmSandbox<T>(
  artifactDirectory: string,
  execute: CommandExecutor,
  operation: (isolatedExecute: CommandExecutor) => Promise<T>
): Promise<T> {
  const { sandboxDirectory, cacheDirectory, userConfigPath } =
    await atMaterializationStage("NPM_SANDBOX", async () => {
      const sandboxDirectory = path.join(artifactDirectory, ".npm-sandbox");
      const cacheDirectory = path.join(sandboxDirectory, "cache");
      const userConfigPath = path.join(sandboxDirectory, "userconfig");
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(userConfigPath, "", "utf8");
      return { sandboxDirectory, cacheDirectory, userConfigPath };
    });
  const isolatedExecute: CommandExecutor = (request) =>
    execute(
      request.command === "npm"
        ? {
            ...request,
            environment: {
              ...request.environment,
              npm_config_cache: cacheDirectory,
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
    throw new CoreMindArtifactMaterializationError(stage, error);
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
      void (async () => {
        try {
          await termination;
        } catch (error) {
          reject(error);
          return;
        }
        if (interrupted) reject(commandInterruptionError(request.signal?.reason));
        else if (launchFailed) reject(new Error(`${request.command} 无法启动`));
        else if (code === 0) resolve(Buffer.concat(stdout));
        else reject(new Error(`${request.command} 执行失败（退出码 ${code ?? "unknown"}）`));
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
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", cancel);
  }
}

function commandInterruptionError(reason: unknown): Error {
  return new Error(reason === "timeout" ? "外部命令超时" : "外部命令已取消");
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
