import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);
const execFileAsync = promisify(execFile);
const REQUIRED_PNPM_VERSION = "11.21.0";
const REQUIRED_PNPM_COREPACK_HASH =
  "sha512.521705bce689924eac72f5a3587122f362689ef6571e55ba80076fd637c11132ecffada26fad4ea79c485bfddbfd3d5a2a5b05805a77e893de71ec8a6cca3bb1";
const DEFAULT_STAGE_TIMEOUTS: Partial<Record<CoreMindCompatibilityStage, StageTimeoutPolicy>> = {
  GIT_FETCH: { hardDeadlineMs: 15 * 60_000, idleTimeoutMs: 5 * 60_000 },
  NPM_CI: { hardDeadlineMs: 30 * 60_000, idleTimeoutMs: 5 * 60_000 },
  VERSION_SYNC: { hardDeadlineMs: 5 * 60_000, idleTimeoutMs: 2 * 60_000 },
  BUILD: { hardDeadlineMs: 15 * 60_000, idleTimeoutMs: 5 * 60_000 },
  NPM_VIEW: { hardDeadlineMs: 5 * 60_000, idleTimeoutMs: 2 * 60_000 },
  PACK: { hardDeadlineMs: 10 * 60_000, idleTimeoutMs: 3 * 60_000 },
  CHOICEMIND_COPY: { hardDeadlineMs: 10 * 60_000, idleTimeoutMs: 3 * 60_000 },
  CANDIDATE_INSTALL: {
    hardDeadlineMs: 6 * 60 * 60_000,
    idleTimeoutMs: 11 * 60_000
  },
  DEPENDENCY_RESOLUTION: {
    hardDeadlineMs: 5 * 60_000,
    idleTimeoutMs: 2 * 60_000
  },
  INTERFACE_TYPECHECK: {
    hardDeadlineMs: 10 * 60_000,
    idleTimeoutMs: 3 * 60_000
  },
  INTERFACE_BUILD: { hardDeadlineMs: 10 * 60_000, idleTimeoutMs: 3 * 60_000 },
  CONTRACT_TEST: { hardDeadlineMs: 15 * 60_000, idleTimeoutMs: 5 * 60_000 },
  VERTICAL_TEST: { hardDeadlineMs: 15 * 60_000, idleTimeoutMs: 5 * 60_000 },
  ROOT_VERIFY: { hardDeadlineMs: 30 * 60_000, idleTimeoutMs: 5 * 60_000 },
  RESOURCE_CLEANUP: { hardDeadlineMs: 5 * 60_000, idleTimeoutMs: 2 * 60_000 },
  LOCAL_MODEL_SMOKE: { hardDeadlineMs: 3 * 60_000, idleTimeoutMs: 150_000 }
};

import {
  CORE_MIND_PACKAGE_NAMES,
  CORE_MIND_RUNTIME_DEPENDENCIES,
  type CoreMindCompatibilityStage,
  type CoreMindMaterializationStage,
  type CoreMindRuntimePackageName,
  type CoreMindVerificationGate,
  type GitCommitCandidate,
  type NpmReleaseCandidate
} from "./index.js";
import {
  CoreMindArtifactMaterializationError,
  CoreMindCandidateVerificationError,
  LOCAL_QWEN_GATE_CONFIGURATION,
  type CoreMindCompatibilitySystem,
  type CoreMindCandidateVerification,
  type CoreMindCompatibilityEnvironment,
  type CoreMindCompatibilityPolicy,
  type CoreMindMaterializationFailureReason,
  type LocalModelGateConfiguration,
  type CoreMindSafeDiagnosticCode,
  type CoreMindSafeCleanupFailure,
  type CoreMindSafeProgress,
  type CoreMindTestFailureKind,
  type CoreMindVerificationSubject,
  type MaterializedCoreMindCandidate,
  type MaterializedCoreMindPackage
} from "./internal-types.js";
import { materializeWithReuse } from "./materialization.js";
import { trustedPnpmContentSha512 } from "./pnpm-trust.js";
import {
  CANDIDATE_DEPENDENCY_FETCH_POLICY,
  DEFAULT_DEPENDENCY_REGISTRY,
  normalizeDependencyRegistry
} from "./registry.js";
import { combineAbortSignals, isPermissionError } from "./utilities.js";

export interface CommandRequest {
  command: "git" | "node" | "npm" | "pnpm";
  args: string[];
  acceptedExitCodes?: readonly [1];
  captureStdout?: boolean;
  classifyNetworkFailure?: boolean;
  cwd?: string;
  environment?: Record<string, string>;
  progressPaths?: string[];
  reportProgress?: () => void;
  signal?: AbortSignal;
  stage?: CoreMindCompatibilityStage;
}

export type CommandExecutor = (request: CommandRequest) => Promise<Buffer>;

export interface StageTimeoutPolicy {
  hardDeadlineMs: number;
  idleTimeoutMs: number;
}

export interface SystemCompatibilityOptions {
  artifactDirectory: string;
  choiceMindRoot: string;
  corepackHome?: string;
  dependencyRegistry?: string;
  materializationAllowedRoot: string;
  materializationDirectory?: string;
  materializationConcurrency?: number;
  materializationLockTimeoutMs?: number;
  localModelGate?: Readonly<LocalModelGateConfiguration>;
  commandTimeoutMs?: number;
  stageTimeouts?: Partial<Record<CoreMindCompatibilityStage, StageTimeoutPolicy>>;
  execute?: CommandExecutor;
  removeDirectory?: typeof rm;
  signal?: AbortSignal;
}

export function createSystemCompatibilitySystem(
  options: SystemCompatibilityOptions
): CoreMindCompatibilitySystem {
  requireAbsolutePath(options.artifactDirectory, "artifactDirectory");
  requireAbsolutePath(options.choiceMindRoot, "choiceMindRoot");
  requireAbsolutePath(options.materializationAllowedRoot, "materializationAllowedRoot");
  if (options.materializationDirectory !== undefined) {
    requireAbsolutePath(options.materializationDirectory, "materializationDirectory");
  }
  if (
    options.localModelGate !== undefined &&
    (options.localModelGate.providerBaseUrl !==
      LOCAL_QWEN_GATE_CONFIGURATION.providerBaseUrl ||
      options.localModelGate.model !== LOCAL_QWEN_GATE_CONFIGURATION.model)
  ) {
    throw new Error("Gate G 只允许已冻结的本地 Qwen3.8-27B 服务");
  }
  const dependencyRegistry = normalizeDependencyRegistry(
    options.dependencyRegistry ?? DEFAULT_DEPENDENCY_REGISTRY
  );
  const materializationAllowedRoot = options.materializationAllowedRoot;
  requireWithinAllowedRoot(
    options.artifactDirectory,
    materializationAllowedRoot,
    "artifactDirectory"
  );
  if (options.materializationDirectory !== undefined) {
    requireWithinAllowedRoot(
      options.materializationDirectory,
      materializationAllowedRoot,
      "materializationDirectory"
    );
  }
  if (
    options.materializationConcurrency !== undefined &&
    (!Number.isSafeInteger(options.materializationConcurrency) ||
      options.materializationConcurrency < 1 ||
      options.materializationConcurrency > 16)
  ) {
    throw new Error("materializationConcurrency 必须是 1 到 16 的整数");
  }
  if (
    options.materializationLockTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.materializationLockTimeoutMs) ||
      options.materializationLockTimeoutMs <= 0)
  ) {
    throw new Error("materializationLockTimeoutMs 必须是正整数毫秒");
  }
  for (const policy of Object.values(options.stageTimeouts ?? {})) {
    if (
      !policy ||
      !Number.isSafeInteger(policy.hardDeadlineMs) ||
      policy.hardDeadlineMs <= 0 ||
      !Number.isSafeInteger(policy.idleTimeoutMs) ||
      policy.idleTimeoutMs <= 0
    ) {
      throw new Error("阶段超时策略必须使用正整数毫秒");
    }
  }
  const baseExecutor = options.execute ?? executeSystemCommand;
  const runControlledOperation = <T>(
    operation: (execute: CommandExecutor, deadlines: StageDeadlineTracker) => Promise<T>
  ): Promise<T> => {
    const deadlines = new StageDeadlineTracker(options);
    const execute: CommandExecutor = (request) =>
      executeWithControl(
        baseExecutor,
        request,
        combineAbortSignals(options.signal, deadlines.signal(request.stage)),
        deadlines.commandPolicy(request)
      );
    return stageDeadlineStorage.run(deadlines, async () => {
      try {
        return await operation(execute, deadlines);
      } finally {
        deadlines.dispose();
      }
    });
  };
  const packageDirectory = path.join(options.artifactDirectory, "packages");
  const compatibilityPolicy = compatibilityPolicySummary(options, dependencyRegistry);
  let reportedEnvironment: CoreMindCompatibilityEnvironment | undefined;
  const materializationEnvironment = () => ({
    nodeVersion: reportedEnvironment?.nodeVersion ?? process.versions.node,
    workspacePackageManager: reportedEnvironment?.workspacePackageManager ?? "unreported",
    artifactPackageManager: reportedEnvironment?.artifactPackageManager ?? "unreported",
    platform: process.platform,
    architecture: process.arch
  });

  return {
    compatibilityPolicy,
    materializeGitCommit: async (candidate) =>
      runControlledOperation((execute, deadlines) =>
        materializeWithReuse(
          { ...options, stageDeadline: deadlines },
          candidate,
          packageDirectory,
          materializationEnvironment(),
          () =>
            withNpmSandbox(options.artifactDirectory, execute, (isolatedExecute) =>
              materializeGitCommit(candidate, packageDirectory, isolatedExecute)
            )
        )
      ),
    materializeNpmRelease: async (candidate) =>
      runControlledOperation((execute, deadlines) =>
        materializeWithReuse(
          { ...options, stageDeadline: deadlines },
          candidate,
          packageDirectory,
          materializationEnvironment(),
          () =>
            withNpmSandbox(options.artifactDirectory, execute, (isolatedExecute) =>
              materializeNpmRelease(candidate, packageDirectory, isolatedExecute)
            )
        )
      ),
    describeEnvironment: async () =>
      runControlledOperation(async (execute) => {
        reportedEnvironment = {
          ...(await describeEnvironment(options.choiceMindRoot, execute)),
          compatibilityPolicy
        };
        return reportedEnvironment;
      }),
    verifyCandidateCompatibility: async (candidate, environment) =>
      runControlledOperation((execute) =>
        verifyCandidateCompatibility(options, candidate, environment, execute, dependencyRegistry)
      )
  };
}

const stageDeadlineStorage = new AsyncLocalStorage<StageDeadlineTracker>();

class StageDeadlineTracker {
  private readonly states = new Map<
    CoreMindCompatibilityStage,
    {
      committed: boolean;
      controller: AbortController;
      startedAt: number;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(private readonly options: SystemCompatibilityOptions) {}

  commandPolicy(request: CommandRequest): {
    hardDeadlineMs: number;
    idleTimeoutMs: number | undefined;
    deadlineReason: "TIMEOUT" | "DEADLINE_TIMEOUT";
  } {
    const policy = this.stagePolicy(request.stage);
    return {
      hardDeadlineMs:
        policy === undefined || request.stage === undefined
          ? (this.options.commandTimeoutMs ?? 10 * 60 * 1000)
          : Math.max(1, this.remaining(request.stage, policy.hardDeadlineMs)),
      idleTimeoutMs: (request.progressPaths?.length ?? 0) > 0 ? policy?.idleTimeoutMs : undefined,
      deadlineReason: policy === undefined ? "TIMEOUT" : "DEADLINE_TIMEOUT"
    };
  }

  signal(stage: CoreMindCompatibilityStage | undefined): AbortSignal | undefined {
    const policy = this.stagePolicy(stage);
    if (stage === undefined || policy === undefined) return undefined;
    return this.state(stage, policy.hardDeadlineMs).controller.signal;
  }

  async run<T>(stage: CoreMindCompatibilityStage, operation: () => Promise<T>): Promise<T> {
    const policy = this.stagePolicy(stage);
    if (policy === undefined) return operation();
    this.assertWithinDeadline(stage, policy.hardDeadlineMs);
    const result = await operation();
    if (!this.state(stage, policy.hardDeadlineMs).committed) {
      this.assertWithinDeadline(stage, policy.hardDeadlineMs);
    }
    return result;
  }

  async commit<T>(stage: CoreMindCompatibilityStage, operation: () => Promise<T>): Promise<T> {
    const policy = this.stagePolicy(stage);
    if (policy === undefined) return operation();
    this.assertWithinDeadline(stage, policy.hardDeadlineMs);
    const result = await operation();
    this.state(stage, policy.hardDeadlineMs).committed = true;
    return result;
  }

  dispose(): void {
    for (const state of this.states.values()) clearTimeout(state.timeout);
    this.states.clear();
  }

  private stagePolicy(
    stage: CoreMindCompatibilityStage | undefined
  ): StageTimeoutPolicy | undefined {
    if (stage === undefined) return undefined;
    return (
      this.options.stageTimeouts?.[stage] ??
      (this.options.commandTimeoutMs === undefined ? DEFAULT_STAGE_TIMEOUTS[stage] : undefined)
    );
  }

  private remaining(stage: CoreMindCompatibilityStage, hardDeadlineMs: number): number {
    return hardDeadlineMs - (Date.now() - this.state(stage, hardDeadlineMs).startedAt);
  }

  private assertWithinDeadline(stage: CoreMindCompatibilityStage, hardDeadlineMs: number): void {
    if (
      this.state(stage, hardDeadlineMs).controller.signal.aborted ||
      this.remaining(stage, hardDeadlineMs) <= 0
    ) {
      throw new CoreMindCommandExecutionError("DEADLINE_TIMEOUT");
    }
  }

  private state(
    stage: CoreMindCompatibilityStage,
    hardDeadlineMs: number
  ): {
    committed: boolean;
    controller: AbortController;
    startedAt: number;
    timeout: NodeJS.Timeout;
  } {
    const existing = this.states.get(stage);
    if (existing) return existing;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("deadline-timeout"), hardDeadlineMs);
    timeout.unref();
    const state = {
      committed: false,
      controller,
      startedAt: Date.now(),
      timeout
    };
    this.states.set(stage, state);
    return state;
  }
}

function compatibilityPolicySummary(
  options: SystemCompatibilityOptions,
  dependencyRegistry: string
): CoreMindCompatibilityPolicy {
  const stageTimeouts: Record<string, StageTimeoutPolicy> = {};
  if (options.commandTimeoutMs === undefined) {
    for (const [stage, policy] of Object.entries(DEFAULT_STAGE_TIMEOUTS)) {
      const configured = options.stageTimeouts?.[stage as CoreMindCompatibilityStage];
      stageTimeouts[stage] = configured ?? policy;
    }
  }
  for (const [stage, policy] of Object.entries(options.stageTimeouts ?? {})) {
    if (policy) stageTimeouts[stage] = policy;
  }
  return {
    dependencyRegistry,
    dependencyFetch: CANDIDATE_DEPENDENCY_FETCH_POLICY,
    materializationConcurrency: options.materializationConcurrency ?? 2,
    stageTimeouts,
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { legacyCommandTimeoutMs: options.commandTimeoutMs })
  };
}

function requireAbsolutePath(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${name} 必须是绝对路径`);
  }
}

function requireWithinAllowedRoot(value: string, allowedRoot: string, name: string): void {
  const resolvedRoot = realpathSync(path.resolve(allowedRoot));
  const resolvedValue = path.resolve(value);
  const lexicalRelative = path.relative(path.resolve(allowedRoot), resolvedValue);
  let existingAncestor = resolvedValue;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const canonicalRelative = path.relative(resolvedRoot, realpathSync(existingAncestor));
  if (
    lexicalRelative.startsWith("..") ||
    path.isAbsolute(lexicalRelative) ||
    canonicalRelative.startsWith("..") ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(`${name} 必须位于允许根目录内`);
  }
}

async function verifyCandidateCompatibility(
  options: SystemCompatibilityOptions,
  candidate: MaterializedCoreMindCandidate,
  environment: CoreMindCompatibilityEnvironment,
  execute: CommandExecutor,
  dependencyRegistry: string
): Promise<CoreMindCandidateVerification> {
  const packageManagerSetup = await atVerificationStage("C", "CANDIDATE_INSTALL", async () => {
    const configuredHome = options.corepackHome ?? defaultCorepackHome();
    if (!configuredHome.trim()) throw new Error("Corepack 来源目录不能为空");
    const version = environment.workspacePackageManager.match(/^pnpm@([^+]+)(?:\+.+)?$/u)?.[1];
    if (!version) throw new Error("工作区 packageManager 必须是精确 pnpm 版本");
    if (version !== REQUIRED_PNPM_VERSION) {
      throw new Error(`Gate C 必须使用 pnpm ${REQUIRED_PNPM_VERSION}`);
    }
    const sourceCorepackHome = path.resolve(configuredHome);
    const sourcePackageDirectory = path.join(sourceCorepackHome, "v1", "pnpm", version);
    const cachedManifest = JSON.parse(
      await readFile(path.join(sourcePackageDirectory, "package.json"), "utf8")
    ) as {
      name?: unknown;
      version?: unknown;
    };
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
  });
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
        args: ["clone", "--no-hardlinks", "--no-checkout", options.choiceMindRoot, choiceMindRoot],
        stage: "CHOICEMIND_COPY"
      });
      await execute({
        command: "git",
        args: ["-C", choiceMindRoot, "checkout", "--detach", environment.choiceMindCommit],
        stage: "CHOICEMIND_COPY"
      });
      const actualCommit = (
        await execute({
          command: "git",
          args: ["-C", choiceMindRoot, "rev-parse", "HEAD"],
          stage: "CHOICEMIND_COPY"
        })
      )
        .toString("utf8")
        .trim()
        .toLowerCase();
      if (actualCommit !== environment.choiceMindCommit) {
        throw new Error("临时 ChoiceMind 副本 commit 身份不一致");
      }
    });

    const isolatedEnvironment = await atVerificationStage("C", "CANDIDATE_INSTALL", async () => {
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
          environment: commandEnvironment,
          stage: "CANDIDATE_INSTALL"
        })
      )
        .toString("utf8")
        .trim();
      if (seededPnpmVersion !== REQUIRED_PNPM_VERSION) {
        throw new Error(`Gate C 必须预置 pnpm ${REQUIRED_PNPM_VERSION}`);
      }
      const candidateOverrides = await createCandidateOverrides(
        options.artifactDirectory,
        candidate
      );
      const configuredOverrides = parsePnpmWorkspaceOverrides(
        await execute({
          command: "pnpm",
          args: ["config", "get", "--location", "project", "--json", "overrides"],
          cwd: choiceMindRoot,
          environment: commandEnvironment,
          stage: "CANDIDATE_INSTALL"
        })
      );
      await execute({
        command: "pnpm",
        args: [
          "config",
          "set",
          "--location",
          "project",
          "--json",
          "overrides",
          JSON.stringify({ ...configuredOverrides, ...candidateOverrides })
        ],
        cwd: choiceMindRoot,
        environment: commandEnvironment,
        stage: "CANDIDATE_INSTALL"
      });
      await candidateInstallSemaphore.run(
        combineAbortSignals(
          options.signal,
          stageDeadlineStorage.getStore()?.signal("CANDIDATE_INSTALL")
        ),
        () =>
          execute({
            command: "pnpm",
            args: [
              "install",
              "--ignore-scripts",
              "--no-frozen-lockfile",
              "--fetch-retries",
              String(CANDIDATE_DEPENDENCY_FETCH_POLICY.fetchRetries),
              "--fetch-retry-factor",
              String(CANDIDATE_DEPENDENCY_FETCH_POLICY.fetchRetryFactor),
              "--fetch-retry-maxtimeout",
              String(CANDIDATE_DEPENDENCY_FETCH_POLICY.fetchRetryMaxTimeoutMs),
              "--fetch-retry-mintimeout",
              String(CANDIDATE_DEPENDENCY_FETCH_POLICY.fetchRetryMinTimeoutMs),
              "--fetch-timeout",
              String(CANDIDATE_DEPENDENCY_FETCH_POLICY.fetchTimeoutMs),
              "--network-concurrency",
              String(CANDIDATE_DEPENDENCY_FETCH_POLICY.networkConcurrency),
              "--reporter",
              "ndjson",
              "--store-dir",
              storeDirectory,
              "--registry",
              dependencyRegistry
            ],
            captureStdout: false,
            classifyNetworkFailure: true,
            cwd: choiceMindRoot,
            environment: commandEnvironment,
            progressPaths: [cacheDirectory, storeDirectory],
            stage: "CANDIDATE_INSTALL"
          })
      );
      return commandEnvironment;
    });

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
          environment: isolatedEnvironment,
          stage: "DEPENDENCY_RESOLUTION"
        });
        return parseResolvedRuntimePackages(
          output,
          candidate,
          options.artifactDirectory,
          choiceMindRoot
        );
      }
    );

    await atVerificationStage("C", "INTERFACE_TYPECHECK", () =>
      execute({
        command: "pnpm",
        args: ["--filter", "@choicemind/orchestrator", "typecheck"],
        cwd: choiceMindRoot,
        environment: isolatedEnvironment,
        stage: "INTERFACE_TYPECHECK"
      })
    );
    await atVerificationStage("C", "INTERFACE_BUILD", () =>
      execute({
        command: "pnpm",
        args: ["--filter", "@choicemind/orchestrator...", "build"],
        cwd: choiceMindRoot,
        environment: isolatedEnvironment,
        stage: "INTERFACE_BUILD"
      })
    );
    const contractTestCount = await atVerificationStage("D", "CONTRACT_TEST", async () => {
      const adapterTestCount = await atVerificationStage(
        "D",
        "CONTRACT_TEST",
        () =>
          executeVitestAndRequireTests(execute, {
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
            environment: isolatedEnvironment,
            stage: "CONTRACT_TEST"
          }),
        { verificationStep: "COREMIND_ADAPTER_CONTRACT" }
      );
      const contractTestCount = await atVerificationStage(
        "D",
        "CONTRACT_TEST",
        () =>
          executeVitestAndRequireTests(execute, {
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
            environment: isolatedEnvironment,
            stage: "CONTRACT_TEST"
          }),
        { verificationStep: "DECISION_CONTRACT" }
      );
      return adapterTestCount + contractTestCount;
    });
    const verticalTestCount = await atVerificationStage(
      "E",
      "VERTICAL_TEST",
      () =>
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
            environment: isolatedEnvironment,
            stage: "VERTICAL_TEST"
          },
          2
        ),
      { verificationStep: "VERTICAL_HTTP" }
    );
    await atVerificationStage(
      "F",
      "ROOT_VERIFY",
      async () => {
        const nodeVersion = (
          await execute({
            command: "node",
            args: ["--version"],
            cwd: choiceMindRoot,
            environment: isolatedEnvironment,
            stage: "ROOT_VERIFY"
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
            environment: isolatedEnvironment,
            stage: "ROOT_VERIFY"
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
          environment: isolatedEnvironment,
          stage: "ROOT_VERIFY"
        });
      },
      { verificationStep: "ROOT_VERIFY" }
    );
    await atVerificationStage(
      "F",
      "RESOURCE_CLEANUP",
      () =>
        execute({
          command: "node",
          args: ["-e", portAvailabilityProbeSource()],
          cwd: choiceMindRoot,
          environment: isolatedEnvironment,
          stage: "RESOURCE_CLEANUP"
        }),
      { verificationStep: "RESOURCE_CLEANUP" }
    );
    const localModelGate = options.localModelGate;
    const localModelSmoke =
      localModelGate === undefined
        ? undefined
        : await atVerificationStage("G", "LOCAL_MODEL_SMOKE", async () => {
            const evidenceNonce = randomUUID();
            const summaryPath = path.join(
              choiceMindRoot,
              "apps",
              "orchestrator",
              ".artifacts",
              `coremind-qwen-smoke-${evidenceNonce}.json`
            );
            await rm(summaryPath, { force: true });
            await execute({
              command: "pnpm",
              args: ["--filter", "@choicemind/orchestrator", "smoke:coremind:qwen"],
              captureStdout: false,
              cwd: choiceMindRoot,
              environment: {
                ...isolatedEnvironment,
                CHOICEMIND_COREMIND_PROVIDER_BASE_URL: localModelGate.providerBaseUrl,
                CHOICEMIND_COREMIND_MODEL: localModelGate.model,
                CHOICEMIND_COREMIND_SMOKE_NONCE: evidenceNonce,
                CHOICEMIND_COREMIND_SMOKE_SUMMARY_PATH: summaryPath
              },
              stage: "LOCAL_MODEL_SMOKE"
            });
            const summaryFile = await stat(summaryPath);
            if (!summaryFile.isFile() || summaryFile.size < 1 || summaryFile.size > 16 * 1024) {
              throw new Error("Gate G 摘要文件大小无效");
            }
            const summary = parseLocalModelSmokeSummary(
              await readFile(summaryPath),
              evidenceNonce
            );
            await execute({
              command: "node",
              args: ["-e", portAvailabilityProbeSource()],
              cwd: choiceMindRoot,
              environment: isolatedEnvironment,
              stage: "LOCAL_MODEL_SMOKE"
            });
            return summary;
          });
    verification = {
      resolvedRuntimePackages,
      testCounts: { D: contractTestCount, E: verticalTestCount },
      ...(localModelSmoke === undefined ? {} : { localModelSmoke })
    };
  } catch (error) {
    failure =
      error instanceof CoreMindCandidateVerificationError
        ? error
        : new CoreMindCandidateVerificationError("C", "CHOICEMIND_COPY", error);
  }

  const cleanupTargets = [
    (options.removeDirectory ?? rm)(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100
    })
  ];
  if (sandboxDirectory !== undefined) {
    cleanupTargets.push(
      (options.removeDirectory ?? rm)(sandboxDirectory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100
      })
    );
  }
  const cleanupResults = await Promise.allSettled(cleanupTargets);
  const cleanupFailures = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(
      (result): CoreMindSafeCleanupFailure => ({
        stage: "CLEANUP",
        reason: isPermissionError(result.reason) ? "PERMISSION_DENIED" : "CLEANUP_FAILED"
      })
    );
  const cleanupFailure = cleanupFailures[0];
  if (cleanupFailure) {
    if (failure) {
      const allCleanupFailures = [...failure.cleanupFailures, ...cleanupFailures];
      throw new CoreMindCandidateVerificationError(
        failure.gate,
        failure.stage,
        failure,
        failure.reason,
        failure.progress,
        allCleanupFailures[0],
        allCleanupFailures,
        failure.subject
      );
    }
    throw new CoreMindCandidateVerificationError(
      "F",
      "CLEANUP",
      cleanupResults.find((result) => result.status === "rejected"),
      cleanupFailure.reason,
      undefined,
      cleanupFailure,
      cleanupFailures
    );
  }
  if (failure) throw failure;
  if (!verification) {
    throw new CoreMindCandidateVerificationError("F", "ROOT_VERIFY");
  }
  return verification;
}

function parseLocalModelSmokeSummary(output: Buffer, expectedEvidenceNonce: string): NonNullable<
  CoreMindCandidateVerification["localModelSmoke"]
> {
  let value: unknown;
  try {
    value = JSON.parse(output.toString("utf8")) as unknown;
  } catch {
    throw new Error("Gate G 未返回合法 JSON 摘要");
  }
  if (!isPlainRecord(value)) throw new Error("Gate G 摘要必须是对象");
  const provider = value.provider;
  const observations = value.providerObservations;
  const executedAt =
    typeof value.executedAt === "string" &&
    !Number.isNaN(Date.parse(value.executedAt)) &&
    new Date(value.executedAt).toISOString() === value.executedAt
      ? value.executedAt
      : undefined;
  const requestCount =
    isPlainRecord(observations) &&
    typeof observations.requestCount === "number" &&
    Number.isSafeInteger(observations.requestCount) &&
    observations.requestCount >= 1 &&
    observations.requestCount <= 2
      ? observations.requestCount
      : undefined;
  if (
    value.ok !== true ||
    value.taskState !== "COMPLETED" ||
    value.decisionStatus !== "NEED_MORE_INFO" ||
    executedAt === undefined ||
    value.evidenceNonce !== expectedEvidenceNonce ||
    value.synthetic !== true ||
    value.scope !== "INTEGRATION_SMOKE_ONLY" ||
    !isPlainRecord(provider) ||
    provider.endpoint !== LOCAL_QWEN_GATE_CONFIGURATION.providerBaseUrl ||
    provider.model !== LOCAL_QWEN_GATE_CONFIGURATION.model ||
    !isPlainRecord(observations) ||
    requestCount === undefined ||
    !Array.isArray(observations.responseStatuses) ||
    observations.responseStatuses.length !== requestCount ||
    observations.responseStatuses.some((status) => status !== 200) ||
    !arrayEquals(observations.toolNames, ["submit_decision_draft"]) ||
    !arrayEquals(observations.toolArgumentsJsonValid, [true]) ||
    !arrayEquals(observations.toolArgumentsMatchExpected, [true])
  ) {
    throw new Error("Gate G 摘要未证明一次有效的合成 Tool 调用");
  }
  return {
    endpoint: provider.endpoint,
    model: provider.model,
    executedAt,
    evidenceNonce: expectedEvidenceNonce,
    synthetic: true,
    scope: "INTEGRATION_SMOKE_ONLY",
    requestCount,
    toolName: "submit_decision_draft",
    decisionStatus: "NEED_MORE_INFO"
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayEquals(value: unknown, expected: readonly unknown[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
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
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
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
    cacheRoot ?? path.join(os.homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
    "node",
    "corepack"
  );
}

async function createCandidateOverrides(
  artifactDirectory: string,
  candidate: MaterializedCoreMindCandidate
): Promise<Record<string, string>> {
  const overrides: Record<string, string> = {};
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
  return overrides;
}

function parsePnpmWorkspaceOverrides(output: Buffer): Record<string, string> {
  const text = output.toString("utf8").trim();
  if (text === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("无法解析临时 workspace 的 pnpm overrides", {
      cause: error
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("临时 workspace 的 pnpm overrides 必须是对象");
  }
  const overrides: Record<string, string> = {};
  for (const [key, configured] of Object.entries(value)) {
    if (!key.trim() || typeof configured !== "string" || !configured.trim()) {
      throw new Error("临时 workspace 的 pnpm overrides 包含无效条目");
    }
    overrides[key] = configured;
  }
  return overrides;
}

function dependencyProbeSource(): string {
  return [
    'import { createHash } from "node:crypto";',
    'import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `const names = ${JSON.stringify(CORE_MIND_RUNTIME_DEPENDENCIES)};`,
    "const internalNames = new Set(names);",
    "const locate = (name, entryPath) => {",
    "  let directory = path.dirname(entryPath);",
    "  const root = path.parse(directory).root;",
    "  while (directory !== root) {",
    '    const manifestPath = path.join(directory, "package.json");',
    "    if (existsSync(manifestPath)) {",
    '      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));',
    '      if (manifest.name === name && typeof manifest.version === "string") {',
    "        return { directory: realpathSync(directory), manifest, manifestPath };",
    "      }",
    "    }",
    "    directory = path.dirname(directory);",
    "  }",
    '  throw new Error("无法解析 " + name + " 的 package.json");',
    "};",
    "const locateDependency = (name, owner) => {",
    "  let directory = owner.directory;",
    "  const root = path.parse(directory).root;",
    "  while (directory !== root) {",
    '    const candidateDirectory = path.join(directory, "node_modules", name);',
    '    const manifestPath = path.join(candidateDirectory, "package.json");',
    "    if (existsSync(manifestPath)) {",
    '      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));',
    '      if (manifest.name === name && typeof manifest.version === "string") {',
    "        const realDirectory = realpathSync(candidateDirectory);",
    '        return { directory: realDirectory, manifest, manifestPath: path.join(realDirectory, "package.json") };',
    "      }",
    "    }",
    "    directory = path.dirname(directory);",
    "  }",
    '  throw new Error("无法从 " + owner.manifest.name + " 解析内部依赖 " + name);',
    "};",
    "const contentSha256 = (directory) => {",
    "  const files = [];",
    "  const visit = (current, relative) => {",
    "    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {",
    '      if (relative === "" && entry.name === "node_modules") continue;',
    '      const entryRelative = relative ? relative + "/" + entry.name : entry.name;',
    "      const entryPath = path.join(current, entry.name);",
    "      const entryStat = lstatSync(entryPath);",
    '      if (entryStat.isSymbolicLink()) throw new Error("候选运行包包含符号链接");',
    "      if (entryStat.isDirectory()) visit(entryPath, entryRelative);",
    "      else if (entryStat.isFile()) files.push([entryRelative, readFileSync(entryPath)]);",
    '      else throw new Error("候选运行包包含不受支持的文件类型");',
    "    }",
    "  };",
    '  visit(directory, "");',
    '  const hash = createHash("sha256");',
    "  for (const [relative, content] of files.sort((a, b) => a[0].localeCompare(b[0]))) {",
    '    hash.update(Buffer.byteLength(relative) + ":");',
    "    hash.update(relative);",
    '    hash.update(content.length + ":");',
    "    hash.update(content);",
    "  }",
    '  return hash.digest("hex");',
    "};",
    'const coreMindAiEntryUrl = import.meta.resolve("coremind-ai");',
    "await import(coreMindAiEntryUrl);",
    'const coreMindAi = locate("coremind-ai", fileURLToPath(coreMindAiEntryUrl));',
    'const roots = new Map([["coremind-ai", coreMindAi]]);',
    'for (const name of names.filter((candidateName) => candidateName !== "coremind-ai")) {',
    "  roots.set(name, locateDependency(name, coreMindAi));",
    "}",
    "const result = names.map((name) => {",
    "  const root = roots.get(name);",
    "  const dependencyNames = new Set();",
    '  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {',
    "    for (const dependencyName of Object.keys(root.manifest[field] ?? {})) {",
    "      if (internalNames.has(dependencyName)) dependencyNames.add(dependencyName);",
    "    }",
    "  }",
    "  const resolvedDependencies = [...dependencyNames].sort().map((dependencyName) => ({",
    "    name: dependencyName,",
    "    location: locateDependency(dependencyName, root).directory",
    "  }));",
    "  return {",
    "    name,",
    "    version: root.manifest.version,",
    "    location: root.directory,",
    "    contentSha256: contentSha256(root.directory),",
    "    resolvedDependencies",
    "  };",
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

async function parseResolvedRuntimePackages(
  output: Buffer,
  candidate: MaterializedCoreMindCandidate,
  artifactDirectory: string,
  choiceMindRoot: string
): Promise<CoreMindCandidateVerification["resolvedRuntimePackages"]> {
  let value: unknown;
  try {
    value = JSON.parse(output.toString("utf8")) as unknown;
  } catch (error) {
    throw dependencyResolutionError("RESOLUTION_OUTPUT_INVALID", undefined, undefined, error);
  }
  if (!Array.isArray(value)) throw dependencyResolutionError("RESOLUTION_OUTPUT_INVALID");
  let expectedContent: Map<string, string>;
  try {
    expectedContent = await candidatePackageContentSha256(candidate, artifactDirectory);
  } catch (error) {
    throw dependencyResolutionError("CANDIDATE_CONTENT_INVALID", undefined, undefined, error);
  }
  const resolved = new Map<
    string,
    {
      version: string;
      location: string;
      contentSha256: string;
      resolvedDependencies: Array<{ name: string; location: string }>;
    }
  >();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw dependencyResolutionError("RESOLUTION_OUTPUT_INVALID");
    }
    const { name, version, location, contentSha256, resolvedDependencies } = item as {
      name?: unknown;
      version?: unknown;
      location?: unknown;
      contentSha256?: unknown;
      resolvedDependencies?: unknown;
    };
    if (
      typeof name !== "string" ||
      typeof version !== "string" ||
      typeof location !== "string" ||
      typeof contentSha256 !== "string" ||
      !Array.isArray(resolvedDependencies) ||
      resolved.has(name)
    ) {
      throw dependencyResolutionError("PACKAGE_IDENTITY_INVALID");
    }
    if (!isCoreMindRuntimePackageName(name)) {
      throw dependencyResolutionError("UNKNOWN_PACKAGE");
    }
    if (version !== candidate.version) {
      throw dependencyResolutionError("VERSION_MISMATCH", name);
    }
    assertPathWithinWorkspace(location, choiceMindRoot, name);
    if (contentSha256 !== expectedContent.get(name)) {
      throw dependencyResolutionError("CONTENT_MISMATCH", name);
    }
    const parsedDependencies = resolvedDependencies.map((dependency) => {
      if (typeof dependency !== "object" || dependency === null || Array.isArray(dependency)) {
        throw dependencyResolutionError("DEPENDENCY_GRAPH_MISMATCH", name);
      }
      const parsed = dependency as { name?: unknown; location?: unknown };
      if (typeof parsed.name !== "string" || typeof parsed.location !== "string") {
        throw dependencyResolutionError("DEPENDENCY_GRAPH_MISMATCH", name);
      }
      return { name: parsed.name, location: parsed.location };
    });
    resolved.set(name, {
      version,
      location,
      contentSha256,
      resolvedDependencies: parsedDependencies
    });
  }
  for (const name of CORE_MIND_RUNTIME_DEPENDENCIES) {
    if (!resolved.has(name)) throw dependencyResolutionError("PACKAGE_IDENTITY_INVALID", name);
  }
  const artifacts = new Map(candidate.packages.map((artifact) => [artifact.name, artifact]));
  for (const name of CORE_MIND_RUNTIME_DEPENDENCIES) {
    const actual = resolved.get(name);
    const artifact = artifacts.get(name);
    if (!actual || !artifact) throw dependencyResolutionError("PACKAGE_IDENTITY_INVALID", name);
    const expectedDependencies = new Set(
      [artifact.dependencies, artifact.optionalDependencies, artifact.peerDependencies]
        .flatMap((dependencies) => Object.keys(dependencies))
        .filter(isCoreMindRuntimePackageName)
    );
    const actualDependencies = new Map(
      actual.resolvedDependencies.map((dependency) => [dependency.name, dependency.location])
    );
    if (
      actualDependencies.size !== actual.resolvedDependencies.length ||
      actualDependencies.size !== expectedDependencies.size
    ) {
      throw dependencyResolutionError("DEPENDENCY_GRAPH_MISMATCH", name);
    }
    for (const dependencyName of expectedDependencies) {
      const target = resolved.get(dependencyName);
      if (!target || actualDependencies.get(dependencyName) !== target.location) {
        throw dependencyResolutionError("DEPENDENCY_GRAPH_MISMATCH", name, dependencyName);
      }
    }
  }
  return CORE_MIND_RUNTIME_DEPENDENCIES.map((name) => ({
    name,
    version: resolved.get(name)?.version ?? candidate.version
  }));
}

function isCoreMindRuntimePackageName(value: string): value is CoreMindRuntimePackageName {
  return (CORE_MIND_RUNTIME_DEPENDENCIES as readonly string[]).includes(value);
}

function assertPathWithinWorkspace(
  location: string,
  workspaceRoot: string,
  packageName: CoreMindRuntimePackageName
): void {
  if (!path.isAbsolute(location)) throw dependencyResolutionError("PATH_INVALID", packageName);
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(location));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw dependencyResolutionError("PATH_INVALID", packageName);
  }
}

function dependencyResolutionError(
  reason: import("./internal-types.js").CoreMindDependencyResolutionFailureReason,
  packageName?: CoreMindRuntimePackageName,
  dependencyName?: CoreMindRuntimePackageName,
  cause?: unknown
): CoreMindCandidateVerificationError {
  const subject =
    packageName === undefined && dependencyName === undefined
      ? undefined
      : {
          ...(packageName === undefined ? {} : { packageName }),
          ...(dependencyName === undefined ? {} : { dependencyName })
        };
  return new CoreMindCandidateVerificationError(
    "C",
    "DEPENDENCY_RESOLUTION",
    cause,
    reason,
    undefined,
    undefined,
    undefined,
    subject
  );
}

async function candidatePackageContentSha256(
  candidate: MaterializedCoreMindCandidate,
  artifactDirectory: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const artifact of candidate.packages) {
    if (!(CORE_MIND_RUNTIME_DEPENDENCIES as readonly string[]).includes(artifact.name)) continue;
    const tarballPath = path.join(artifactDirectory, "packages", artifact.fileName);
    const archive = await gunzipAsync(await readFile(tarballPath));
    const files: Array<[string, Buffer]> = [];
    for (let offset = 0; offset + 512 <= archive.length; ) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const name = readTarText(header, 0, 100);
      const prefix = readTarText(header, 345, 155);
      const entryPath = prefix ? `${prefix}/${name}` : name;
      const size = Number.parseInt(readTarText(header, 124, 12).trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${artifact.name} tgz 条目无效`);
      const contentOffset = offset + 512;
      const contentEnd = contentOffset + size;
      if (contentEnd > archive.length) throw new Error(`${artifact.name} tgz 被截断`);
      const type = header[156];
      if (type === 0 || type === "0".charCodeAt(0)) {
        if (!entryPath.startsWith("package/")) throw new Error(`${artifact.name} tgz 路径越界`);
        const relative = entryPath.slice("package/".length);
        if (
          !relative ||
          relative.includes("\\") ||
          path.posix.normalize(relative) !== relative ||
          relative === ".." ||
          relative.startsWith("../") ||
          relative === "node_modules" ||
          relative.startsWith("node_modules/")
        ) {
          throw new Error(`${artifact.name} tgz 路径无效`);
        }
        files.push([relative, archive.subarray(contentOffset, contentEnd)]);
      } else if (type !== "5".charCodeAt(0)) {
        throw new Error(`${artifact.name} tgz 包含不受支持的条目类型`);
      }
      offset = contentOffset + Math.ceil(size / 512) * 512;
    }
    const hash = createHash("sha256");
    for (const [relative, content] of files.sort(([left], [right]) => left.localeCompare(right))) {
      hash.update(`${Buffer.byteLength(relative)}:`);
      hash.update(relative);
      hash.update(`${content.length}:`);
      hash.update(content);
    }
    result.set(artifact.name, hash.digest("hex"));
  }
  return result;
}

async function executeVitestAndRequireTests(
  execute: CommandExecutor,
  request: CommandRequest,
  minimumPassedTests = 1
): Promise<number> {
  if (!request.cwd) throw new CoreMindTestVerificationError("TEST_RESULT_INVALID");
  const outputFileName = `.choicemind-vitest-${randomUUID()}.json`;
  const outputFilePath = path.join(request.cwd, outputFileName);
  let result: number | undefined;
  let failure: unknown;
  try {
    const commandOutput = await execute({
      ...request,
      acceptedExitCodes: [1],
      args: [...request.args, "--outputFile", outputFilePath]
    });
    let output = commandOutput;
    try {
      const outputFileStat = await stat(outputFilePath);
      if (!outputFileStat.isFile() || outputFileStat.size > MAX_COMMAND_STDOUT_BYTES) {
        throw new CoreMindTestVerificationError("TEST_RESULT_INVALID");
      }
      output = await readFile(outputFilePath);
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
    result = requireValidVitestResult(output, minimumPassedTests);
  } catch (error) {
    failure = error;
  }
  try {
    await rm(outputFilePath, { force: true });
  } catch (error) {
    failure ??= new CoreMindTestVerificationError("TEST_RESULT_INVALID", error);
  }
  if (failure) throw failure;
  if (result === undefined) throw new CoreMindTestVerificationError("TEST_RESULT_INVALID");
  return result;
}

function requireValidVitestResult(output: Buffer, minimumPassedTests: number): number {
  let value: {
    numPassedTests?: unknown;
    numFailedTests?: unknown;
    numFailedTestSuites?: unknown;
    success?: unknown;
    testResults?: unknown;
  };
  try {
    value = JSON.parse(output.toString("utf8")) as typeof value;
  } catch (error) {
    throw new CoreMindTestVerificationError("TEST_RESULT_INVALID", error);
  }
  if (
    value.success === true &&
    Number.isSafeInteger(value.numPassedTests) &&
    (value.numPassedTests as number) >= minimumPassedTests &&
    value.numFailedTests === 0
  ) {
    return value.numPassedTests as number;
  }
  if (
    value.success === false &&
    ((Number.isSafeInteger(value.numFailedTests) && (value.numFailedTests as number) > 0) ||
      (Number.isSafeInteger(value.numFailedTestSuites) &&
        (value.numFailedTestSuites as number) > 0))
  ) {
    throw new CoreMindTestVerificationError(
      "TEST_FAILED",
      undefined,
      safeFailedTestNames(value.testResults),
      safeTestFailureKinds(value.testResults),
      safeMissingPackageNames(value.testResults)
    );
  }
  throw new CoreMindTestVerificationError("TEST_RESULT_INVALID");
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

class CoreMindTestVerificationError extends Error {
  constructor(
    readonly reason: "TEST_FAILED" | "TEST_RESULT_INVALID",
    cause?: unknown,
    readonly failedTests: string[] = [],
    readonly testFailureKinds: CoreMindTestFailureKind[] = [],
    readonly missingPackageNames: string[] = []
  ) {
    super("Vitest 验证失败", { cause });
    this.name = "CoreMindTestVerificationError";
  }
}

function safeFailedTestNames(testResults: unknown): string[] {
  if (!Array.isArray(testResults)) return [];
  const names: string[] = [];
  for (const result of testResults) {
    if (typeof result !== "object" || result === null || Array.isArray(result)) continue;
    const namesBeforeResult = names.length;
    const assertions = (result as { assertionResults?: unknown }).assertionResults;
    if (Array.isArray(assertions)) {
      for (const assertion of assertions) {
        if (typeof assertion !== "object" || assertion === null || Array.isArray(assertion)) continue;
        const { fullName, status } = assertion as { fullName?: unknown; status?: unknown };
        if (
          status === "failed" &&
          typeof fullName === "string" &&
          fullName.length > 0 &&
          fullName.length <= 200 &&
          !hasControlCharacters(fullName)
        ) {
          names.push(fullName);
          if (names.length === 10) return names;
        }
      }
    }
    if (names.length === namesBeforeResult && (result as { status?: unknown }).status === "failed") {
      const sourceName = safeFailedSuiteName((result as { name?: unknown }).name);
      if (sourceName) names.push(sourceName);
      if (names.length === 10) return names;
    }
  }
  return names;
}

function safeFailedSuiteName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || hasControlCharacters(value)) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const marker = "/apps/orchestrator/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const relative = normalized.slice(markerIndex + marker.length);
  return /^src\/[A-Za-z0-9_./-]+\.test\.ts$/u.test(relative) && relative.length <= 200
    ? relative
    : undefined;
}

function safeTestFailureKinds(testResults: unknown): CoreMindTestFailureKind[] {
  if (!Array.isArray(testResults)) return [];
  const kinds = new Set<CoreMindTestFailureKind>();
  for (const result of testResults) {
    if (typeof result !== "object" || result === null || Array.isArray(result)) continue;
    if ((result as { status?: unknown }).status !== "failed") continue;
    const assertions = (result as { assertionResults?: unknown }).assertionResults;
    if (
      Array.isArray(assertions) &&
      assertions.some(
        (assertion) =>
          typeof assertion === "object" &&
          assertion !== null &&
          !Array.isArray(assertion) &&
          (assertion as { status?: unknown }).status === "failed"
      )
    ) {
      continue;
    }
    const candidateMessages = [
      (result as { failureMessage?: unknown }).failureMessage,
      (result as { message?: unknown }).message
    ];
    const message = candidateMessages.filter((value): value is string => typeof value === "string").join("\n");
    if (/DOES NOT PROVIDE AN EXPORT NAMED|NO MATCHING EXPORT/iu.test(message)) {
      kinds.add("EXPORT_NOT_FOUND");
    } else if (/ERR_MODULE_NOT_FOUND|CANNOT FIND (?:MODULE|PACKAGE)/iu.test(message)) {
      kinds.add("MODULE_NOT_FOUND");
    } else if (/SYNTAXERROR/iu.test(message)) {
      kinds.add("SYNTAX_ERROR");
    } else if (/REFERENCEERROR/iu.test(message)) {
      kinds.add("REFERENCE_ERROR");
    } else if (/TYPEERROR/iu.test(message)) {
      kinds.add("TYPE_ERROR");
    } else {
      kinds.add("UNKNOWN_SUITE_FAILURE");
    }
  }
  return [...kinds];
}

function safeMissingPackageNames(testResults: unknown): string[] {
  if (!Array.isArray(testResults)) return [];
  const names = new Set<string>();
  for (const result of testResults) {
    if (typeof result !== "object" || result === null || Array.isArray(result)) continue;
    if ((result as { status?: unknown }).status !== "failed") continue;
    const message = [
      (result as { failureMessage?: unknown }).failureMessage,
      (result as { message?: unknown }).message
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    for (const match of message.matchAll(/CANNOT FIND (?:PACKAGE|MODULE)\s+['"]([^'"\r\n]{1,300})['"]/giu)) {
      const packageName = safePackageNameFromSpecifier(match[1]);
      if (packageName) names.add(packageName);
      if (names.size === 10) return [...names];
    }
  }
  return [...names];
}

function safePackageNameFromSpecifier(specifier: string | undefined): string | undefined {
  if (!specifier || hasControlCharacters(specifier)) return undefined;
  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return packageName !== undefined &&
    packageName.length <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName)
    ? packageName
    : undefined;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

async function atVerificationStage<T>(
  gate: CoreMindVerificationGate,
  stage: CoreMindCompatibilityStage,
  operation: () => Promise<T>,
  subject?: CoreMindVerificationSubject
): Promise<T> {
  try {
    const deadlines = stageDeadlineStorage.getStore();
    return await (deadlines ? deadlines.run(stage, operation) : operation());
  } catch (error) {
    if (error instanceof CoreMindCandidateVerificationError) throw error;
    let verificationSubject = subject;
    if (
      error instanceof CoreMindTestVerificationError &&
      subject !== undefined &&
      "verificationStep" in subject
    ) {
      verificationSubject = {
        ...subject,
        ...(error.failedTests.length > 0 ? { failedTests: error.failedTests } : {}),
        ...(error.testFailureKinds.length > 0
          ? { testFailureKinds: error.testFailureKinds }
          : {}),
        ...(error.missingPackageNames.length > 0
          ? { missingPackageNames: error.missingPackageNames }
          : {})
      };
    }
    if (error instanceof CoreMindCommandExecutionError && error.diagnosticCodes.length > 0) {
      verificationSubject =
        subject !== undefined && "verificationStep" in subject
          ? { ...subject, diagnosticCodes: error.diagnosticCodes }
          : { diagnosticCodes: error.diagnosticCodes };
    }
    throw new CoreMindCandidateVerificationError(
      gate,
      stage,
      error,
      error instanceof CoreMindCommandExecutionError
        ? error.reason
        : error instanceof CoreMindTestVerificationError
          ? error.reason
          : isPermissionError(error)
            ? "PERMISSION_DENIED"
            : undefined,
      error instanceof CoreMindCommandExecutionError ? error.progress : undefined,
      undefined,
      undefined,
      verificationSubject
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
      return {
        sandboxDirectory,
        cacheDirectory,
        globalConfigPath,
        userConfigPath
      };
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
            },
            progressPaths: [...(request.progressPaths ?? []), cacheDirectory]
          }
        : request
    );
  let operationFailure: unknown;
  try {
    return await operation(isolatedExecute);
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    await cleanupMaterializationWithoutMasking(
      () =>
        rm(sandboxDirectory, {
          force: true,
          maxRetries: 5,
          recursive: true,
          retryDelay: 100
        }),
      operationFailure
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
  let operationFailure: unknown;

  try {
    const sourceArchive = await atMaterializationStage("GIT_FETCH", async () => {
      await execute({
        command: "git",
        args: ["init", sourceDirectory],
        stage: "GIT_FETCH"
      });
      await execute({
        command: "git",
        args: ["-C", sourceDirectory, "remote", "add", "origin", candidate.repository],
        stage: "GIT_FETCH"
      });
      await execute({
        command: "git",
        args: ["-C", sourceDirectory, "fetch", "--depth=1", "origin", candidate.commit],
        stage: "GIT_FETCH"
      });
      await execute({
        command: "git",
        args: ["-C", sourceDirectory, "checkout", "--detach", "FETCH_HEAD"],
        stage: "GIT_FETCH"
      });
      const actualCommit = (
        await execute({
          command: "git",
          args: ["-C", sourceDirectory, "rev-parse", "HEAD"],
          stage: "GIT_FETCH"
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
        args: ["-C", sourceDirectory, "archive", "--format=tar", "HEAD"],
        stage: "GIT_FETCH"
      });
    });
    const sourceSha256 = sha256(sourceArchive);
    const lockfileSha256 = await atMaterializationStage("GIT_FETCH", async () =>
      sha256(await readFile(path.join(sourceDirectory, "package-lock.json")))
    );

    await atMaterializationStage("NPM_CI", () =>
      execute({
        command: "npm",
        args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd: sourceDirectory,
        progressPaths: [sourceDirectory],
        stage: "NPM_CI"
      })
    );
    await atMaterializationStage("VERSION_SYNC", () =>
      execute({
        command: "node",
        args: ["scripts/release-version.mjs", candidateVersion, "--no-lock"],
        cwd: sourceDirectory,
        progressPaths: [sourceDirectory],
        stage: "VERSION_SYNC"
      })
    );
    await atMaterializationStage("BUILD", () =>
      execute({
        command: "npm",
        args: ["run", "build"],
        cwd: sourceDirectory,
        progressPaths: [sourceDirectory],
        stage: "BUILD"
      })
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
      lockfileSha256,
      identity: { kind: "git-source-archive", sha256: sourceSha256 },
      packages
    };
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    await cleanupMaterializationWithoutMasking(
      () =>
        rm(temporaryRoot, {
          force: true,
          maxRetries: 5,
          recursive: true,
          retryDelay: 100
        }),
      operationFailure
    );
  }
}

async function cleanupMaterializationWithoutMasking(
  cleanup: () => Promise<void>,
  operationFailure: unknown
): Promise<void> {
  try {
    await atMaterializationStage("CLEANUP", cleanup);
  } catch (cleanupFailure) {
    if (operationFailure === undefined) {
      if (
        cleanupFailure instanceof CoreMindArtifactMaterializationError &&
        cleanupFailure.reason !== undefined
      ) {
        throw cleanupFailure;
      }
      throw new CoreMindArtifactMaterializationError("CLEANUP", cleanupFailure, "CLEANUP_FAILED");
    }
    const primary =
      operationFailure instanceof CoreMindArtifactMaterializationError
        ? operationFailure
        : new CoreMindArtifactMaterializationError("CLEANUP", operationFailure);
    throw new CoreMindArtifactMaterializationError(
      primary.stage,
      primary,
      primary.reason,
      primary.progress,
      {
        stage: "CLEANUP",
        reason:
          cleanupFailure instanceof CoreMindArtifactMaterializationError &&
          cleanupFailure.reason !== undefined
            ? cleanupFailure.reason
            : "CLEANUP_FAILED"
      }
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
          args: ["pack", "--workspace", name, "--pack-destination", packageDirectory, "--json"],
          cwd: sourceDirectory,
          progressPaths: [packageDirectory],
          stage: "PACK"
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
          args: ["view", `${name}@${candidate.version}`, "--json"],
          stage: "NPM_VIEW"
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
          ],
          progressPaths: [packageDirectory],
          stage: "PACK"
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
    identity: {
      kind: "npm-package-set",
      sha256: sha256(Buffer.from(identity))
    },
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
  ) as {
    packageManager?: unknown;
  };
  if (typeof rootManifest.packageManager !== "string") {
    throw new Error("ChoiceMind packageManager 身份缺失");
  }
  const npmVersion = (await execute({ command: "npm", args: ["--version"] }))
    .toString("utf8")
    .trim();
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
  const packed = value[0] as {
    name?: unknown;
    filename?: unknown;
    integrity?: unknown;
  };
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
    const deadlines = stageDeadlineStorage.getStore();
    return await (deadlines ? deadlines.run(stage, operation) : operation());
  } catch (error) {
    if (error instanceof CoreMindArtifactMaterializationError) throw error;
    throw new CoreMindArtifactMaterializationError(
      stage,
      error,
      error instanceof CoreMindCommandExecutionError
        ? error.reason
        : isPermissionError(error)
          ? "PERMISSION_DENIED"
          : undefined,
      error instanceof CoreMindCommandExecutionError ? error.progress : undefined
    );
  }
}

class CoreMindCommandExecutionError extends Error {
  readonly reason: CoreMindMaterializationFailureReason;
  readonly progress: CoreMindSafeProgress | undefined;
  readonly diagnosticCodes: CoreMindSafeDiagnosticCode[];

  constructor(
    reason: CoreMindMaterializationFailureReason,
    cause?: unknown,
    progress?: CoreMindSafeProgress,
    diagnosticCodes: CoreMindSafeDiagnosticCode[] = []
  ) {
    super(
      {
        TIMEOUT: "外部命令超时",
        DEADLINE_TIMEOUT: "外部命令达到阶段总时限",
        IDLE_TIMEOUT: "外部命令长时间无进度",
        PERMISSION_DENIED: "外部命令权限不足",
        CLEANUP_FAILED: "资源清理失败",
        LOCK_LOST: "物化锁租约已失效",
        LOCK_TIMEOUT: "等待物化锁超时",
        CANCELLED: "外部命令已取消",
        NETWORK_FAILED: "外部命令网络访问失败",
        COMMAND_FAILED: "外部命令执行失败",
        LAUNCH_FAILED: "外部命令无法启动"
      }[reason],
      { cause }
    );
    this.name = "CoreMindCommandExecutionError";
    this.reason = reason;
    this.progress = progress;
    this.diagnosticCodes = diagnosticCodes;
  }
}

class AbortableSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    grant: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly capacity: number) {}

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(commandInterruptionError(signal.reason));
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        grant: () => resolve(() => this.release()),
        reject,
        ...(signal === undefined ? {} : { signal })
      };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(commandInterruptionError(signal?.reason));
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.active -= 1;
      return;
    }
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.grant();
  }
}

const candidateInstallSemaphore = new AbortableSemaphore(
  CANDIDATE_DEPENDENCY_FETCH_POLICY.installConcurrency
);

export async function executeSystemCommand(request: CommandRequest): Promise<Buffer> {
  if (request.signal?.aborted) {
    throw commandInterruptionError(request.signal.reason);
  }
  const invocation = resolveCommandInvocation(request);
  return new Promise((resolve, reject) => {
    const progressWatchers: FSWatcher[] = [];
    const observesProgressPaths = (request.progressPaths?.length ?? 0) > 0;
    let progressObservationClosed = false;
    const observeMaterialProgress = () => {
      if (!observesProgressPaths || progressObservationClosed) return;
      request.reportProgress?.();
    };
    for (const progressPath of request.progressPaths ?? []) {
      try {
        progressWatchers.push(watch(progressPath, { recursive: true }, observeMaterialProgress));
      } catch {
        try {
          progressWatchers.push(watch(progressPath, observeMaterialProgress));
        } catch {
          // 进度观察失败不改变命令语义，hard deadline 仍提供最终上界。
        }
      }
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: request.cwd,
      env: { ...minimalEnvironment(), ...request.environment },
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutLimitExceeded = false;
    let diagnosticOutput: Buffer = Buffer.alloc(0);
    const observedDiagnosticCodes = new Set<CoreMindSafeDiagnosticCode>();
    let diagnosticScanTail = "";
    const observeDiagnosticChunk = (chunk: Buffer) => {
      const text = diagnosticScanTail + chunk.toString("utf8");
      for (const code of extractSafeDiagnosticCodes(text)) observedDiagnosticCodes.add(code);
      diagnosticScanTail = text.slice(-64);
    };
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
      progressObservationClosed = true;
      for (const watcher of progressWatchers) watcher.close();
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
        else if (stdoutLimitExceeded) {
          reject(new CoreMindCommandExecutionError("COMMAND_FAILED"));
        } else if (code === 0 || (code === 1 && request.acceptedExitCodes?.[0] === 1)) {
          resolve(Buffer.concat(stdout));
        } else {
          const diagnosis = classifyCommandFailure(
            diagnosticOutput,
            request.classifyNetworkFailure === true,
            observedDiagnosticCodes
          );
          reject(
            new CoreMindCommandExecutionError(
              diagnosis.reason,
              undefined,
              undefined,
              diagnosis.diagnosticCodes
            )
          );
        }
      })();
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (request.captureStdout !== false && !stdoutLimitExceeded) {
        const remainingBytes = MAX_COMMAND_STDOUT_BYTES - stdoutBytes;
        if (chunk.length <= remainingBytes) {
          stdout.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          if (remainingBytes > 0) stdout.push(chunk.subarray(0, remainingBytes));
          stdoutLimitExceeded = true;
        }
      }
      observeDiagnosticChunk(chunk);
      diagnosticOutput = appendBoundedDiagnosticOutput(diagnosticOutput, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      observeDiagnosticChunk(chunk);
      diagnosticOutput = appendBoundedDiagnosticOutput(diagnosticOutput, chunk);
    });
    child.once("error", () => settle(null, true));
    child.once("close", (code) => settle(code, false));
  });
}

const MAX_COMMAND_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_DIAGNOSTIC_BYTES = 64 * 1024;

function appendBoundedDiagnosticOutput(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= MAX_COMMAND_DIAGNOSTIC_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_COMMAND_DIAGNOSTIC_BYTES);
}

const SAFE_COMMAND_DIAGNOSTIC_CODES = [
  "ERR_PNPM_META_FETCH_FAIL",
  "ERR_PNPM_FETCH_FAIL",
  "ERR_PNPM_FETCH_403",
  "ERR_PNPM_FETCH_404",
  "ERR_PNPM_TARBALL_INTEGRITY",
  "ERR_PNPM_NO_MATCHING_VERSION",
  "ERR_PNPM_PEER_DEP_ISSUES",
  "ERR_PNPM_OUTDATED_LOCKFILE",
  "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
  "ERR_PNPM_UNEXPECTED_STORE",
  "ERR_PNPM_UNEXPECTED_VIRTUAL_STORE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_SOCKET_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ENOSPC",
  "EACCES",
  "EPERM"
] as const satisfies readonly CoreMindSafeDiagnosticCode[];

const NETWORK_DIAGNOSTIC_CODES = new Set<CoreMindSafeDiagnosticCode>([
  "ERR_PNPM_META_FETCH_FAIL",
  "ERR_PNPM_FETCH_FAIL",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_SOCKET_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT"
]);

function classifyCommandFailure(
  output: Buffer,
  classifyNetworkFailure: boolean,
  observedDiagnosticCodes: Iterable<CoreMindSafeDiagnosticCode> = []
): {
  reason: CoreMindMaterializationFailureReason;
  diagnosticCodes: CoreMindSafeDiagnosticCode[];
} {
  const diagnosticCodes = [
    ...new Set<CoreMindSafeDiagnosticCode>([
      ...observedDiagnosticCodes,
      ...extractSafeDiagnosticCodes(output.toString("utf8"))
    ])
  ];
  const networkFailure =
    classifyNetworkFailure &&
    diagnosticCodes.some(
      (code) => NETWORK_DIAGNOSTIC_CODES.has(code) || code.startsWith("ERR_PNPM_FETCH_")
    );
  return { reason: networkFailure ? "NETWORK_FAILED" : "COMMAND_FAILED", diagnosticCodes };
}

function extractSafeDiagnosticCodes(text: string): CoreMindSafeDiagnosticCode[] {
  const normalizedText = text.toUpperCase();
  const pnpmCodes = (text.match(/\bERR_PNPM_[A-Z0-9_]{1,48}\b/gu) ?? []).map(
    (code) => code as CoreMindSafeDiagnosticCode
  );
  return [
    ...new Set<CoreMindSafeDiagnosticCode>([
      ...SAFE_COMMAND_DIAGNOSTIC_CODES.filter((code) => normalizedText.includes(code)),
      ...pnpmCodes
    ])
  ];
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
    "$processes = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId | Select-Object ProcessId, ParentProcessId)",
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
  policy: {
    hardDeadlineMs: number;
    idleTimeoutMs: number | undefined;
    deadlineReason: "TIMEOUT" | "DEADLINE_TIMEOUT";
  }
): Promise<Buffer> {
  if (!Number.isSafeInteger(policy.hardDeadlineMs) || policy.hardDeadlineMs <= 0) {
    throw new Error("阶段 hard deadline 必须为正整数毫秒");
  }
  if (
    policy.idleTimeoutMs !== undefined &&
    (!Number.isSafeInteger(policy.idleTimeoutMs) || policy.idleTimeoutMs <= 0)
  ) {
    throw new Error("阶段 idle timeout 必须为正整数毫秒");
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let observedProgressEvents = 0;
  const cancel = () =>
    controller.abort(outerSignal?.reason === "deadline-timeout" ? "deadline-timeout" : "cancelled");
  if (outerSignal?.aborted) cancel();
  else outerSignal?.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(
    () => controller.abort(policy.deadlineReason === "TIMEOUT" ? "timeout" : "deadline-timeout"),
    policy.hardDeadlineMs
  );
  let idleTimeout: NodeJS.Timeout | undefined;
  const scheduleIdleTimeout = () => {
    if (policy.idleTimeoutMs === undefined || controller.signal.aborted) return;
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => controller.abort("idle-timeout"), policy.idleTimeoutMs);
  };
  const reportProgress = () => {
    observedProgressEvents += 1;
    lastProgressAt = Date.now();
    request.reportProgress?.();
    scheduleIdleTimeout();
  };
  const safeProgress = async (): Promise<CoreMindSafeProgress> => {
    const cache = await summarizeProgressPaths(request.progressPaths ?? []);
    const now = Date.now();
    return {
      elapsedMs: now - startedAt,
      observedProgressEvents,
      cacheBytes: cache.bytes,
      cacheFileCount: cache.files,
      lastProgressAgeMs: now - lastProgressAt
    };
  };
  scheduleIdleTimeout();
  try {
    if (controller.signal.aborted) {
      throw commandInterruptionError(controller.signal.reason, await safeProgress());
    }
    const result = await execute({
      ...request,
      reportProgress,
      signal: controller.signal
    });
    if (controller.signal.aborted) {
      throw commandInterruptionError(controller.signal.reason, await safeProgress());
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw commandInterruptionError(controller.signal.reason, await safeProgress());
    }
    if (error instanceof CoreMindCommandExecutionError) {
      throw new CoreMindCommandExecutionError(
        error.reason,
        error,
        error.progress ?? (await safeProgress()),
        error.diagnosticCodes
      );
    }
    if (isPermissionError(error)) {
      throw new CoreMindCommandExecutionError("PERMISSION_DENIED", error, await safeProgress());
    }
    throw new CoreMindCommandExecutionError("COMMAND_FAILED", error, await safeProgress());
  } finally {
    clearTimeout(deadline);
    if (idleTimeout) clearTimeout(idleTimeout);
    outerSignal?.removeEventListener("abort", cancel);
  }
}

function commandInterruptionError(
  reason: unknown,
  progress?: CoreMindSafeProgress
): CoreMindCommandExecutionError {
  if (reason === "timeout") {
    return new CoreMindCommandExecutionError("TIMEOUT", undefined, progress);
  }
  if (reason === "deadline-timeout") {
    return new CoreMindCommandExecutionError("DEADLINE_TIMEOUT", undefined, progress);
  }
  if (reason === "idle-timeout") {
    return new CoreMindCommandExecutionError("IDLE_TIMEOUT", undefined, progress);
  }
  return new CoreMindCommandExecutionError("CANCELLED", undefined, progress);
}

async function summarizeProgressPaths(
  progressPaths: string[]
): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await stat(entryPath)).size;
        } catch {
          // 包管理器可能在摘要扫描期间原子替换文件。
        }
      }
    }
  };
  for (const progressPath of progressPaths) await visit(progressPath);
  return { bytes, files };
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
    const npmCli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    );
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
