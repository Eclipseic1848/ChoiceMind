import type {
  CoreMindCompatibilityStage,
  CoreMindMaterializationStage,
  CoreMindRuntimePackageName,
  CoreMindVerificationGate,
  GitCommitCandidate,
  NpmReleaseCandidate
} from "./index.js";

export type CoreMindMaterializationFailureReason =
  | "TIMEOUT"
  | "DEADLINE_TIMEOUT"
  | "IDLE_TIMEOUT"
  | "PERMISSION_DENIED"
  | "CLEANUP_FAILED"
  | "LOCK_LOST"
  | "LOCK_TIMEOUT"
  | "CANCELLED"
  | "NETWORK_FAILED"
  | "COMMAND_FAILED"
  | "LAUNCH_FAILED";

export type CoreMindDependencyResolutionFailureReason =
  | "RESOLUTION_OUTPUT_INVALID"
  | "CANDIDATE_CONTENT_INVALID"
  | "PACKAGE_IDENTITY_INVALID"
  | "UNKNOWN_PACKAGE"
  | "VERSION_MISMATCH"
  | "PATH_INVALID"
  | "CONTENT_MISMATCH"
  | "DEPENDENCY_GRAPH_MISMATCH";

export type CoreMindVerificationFailureReason =
  | CoreMindMaterializationFailureReason
  | CoreMindDependencyResolutionFailureReason
  | "TEST_FAILED"
  | "TEST_RESULT_INVALID";

export type CoreMindSafeDiagnosticCode =
  | `ERR_PNPM_${Uppercase<string>}`
  | "ERR_PNPM_META_FETCH_FAIL"
  | "ERR_PNPM_FETCH_FAIL"
  | "ERR_PNPM_FETCH_403"
  | "ERR_PNPM_FETCH_404"
  | `ERR_PNPM_FETCH_${Uppercase<string>}`
  | "ERR_PNPM_TARBALL_INTEGRITY"
  | "ERR_PNPM_NO_MATCHING_VERSION"
  | "ERR_PNPM_PEER_DEP_ISSUES"
  | "ERR_PNPM_OUTDATED_LOCKFILE"
  | "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH"
  | "ERR_PNPM_UNEXPECTED_STORE"
  | "ERR_PNPM_UNEXPECTED_VIRTUAL_STORE"
  | "ECONNRESET"
  | "ECONNREFUSED"
  | "ETIMEDOUT"
  | "ENOTFOUND"
  | "EAI_AGAIN"
  | "ERR_SOCKET_TIMEOUT"
  | "UND_ERR_CONNECT_TIMEOUT"
  | "ENOSPC"
  | "EACCES"
  | "EPERM";

export interface CoreMindDependencyResolutionSubject {
  packageName?: CoreMindRuntimePackageName;
  dependencyName?: CoreMindRuntimePackageName;
}

export type CoreMindVerificationStep =
  | "COREMIND_ADAPTER_CONTRACT"
  | "DECISION_CONTRACT"
  | "VERTICAL_HTTP"
  | "ROOT_VERIFY"
  | "RESOURCE_CLEANUP";

export type CoreMindTestFailureKind =
  | "MODULE_NOT_FOUND"
  | "EXPORT_NOT_FOUND"
  | "SYNTAX_ERROR"
  | "TYPE_ERROR"
  | "REFERENCE_ERROR"
  | "UNKNOWN_SUITE_FAILURE";

export type CoreMindVerificationSubject =
  | CoreMindDependencyResolutionSubject
  | { diagnosticCodes: readonly CoreMindSafeDiagnosticCode[] }
  | {
      verificationStep: CoreMindVerificationStep;
      failedTests?: readonly string[];
      testFailureKinds?: readonly CoreMindTestFailureKind[];
      missingPackageNames?: readonly string[];
      diagnosticCodes?: readonly CoreMindSafeDiagnosticCode[];
    };

export interface CoreMindSafeProgress {
  elapsedMs: number;
  observedProgressEvents: number;
  cacheBytes: number;
  cacheFileCount: number;
  lastProgressAgeMs: number;
}

export interface CoreMindSafeCleanupFailure {
  stage: CoreMindMaterializationStage;
  reason: CoreMindMaterializationFailureReason;
}

export class CoreMindArtifactMaterializationError extends Error {
  readonly stage: CoreMindMaterializationStage;
  readonly reason: CoreMindMaterializationFailureReason | undefined;
  readonly progress: CoreMindSafeProgress | undefined;
  readonly cleanupFailure: CoreMindSafeCleanupFailure | undefined;
  readonly cleanupFailures: CoreMindSafeCleanupFailure[];

  constructor(
    stage: CoreMindMaterializationStage,
    cause?: unknown,
    reason?: CoreMindMaterializationFailureReason,
    progress?: CoreMindSafeProgress,
    cleanupFailure?: CoreMindSafeCleanupFailure,
    cleanupFailures?: CoreMindSafeCleanupFailure[]
  ) {
    super(`CoreMind 制品物化失败：${stage}`, { cause });
    this.name = "CoreMindArtifactMaterializationError";
    this.stage = stage;
    this.reason = reason;
    this.progress = progress;
    this.cleanupFailure = cleanupFailure;
    this.cleanupFailures = cleanupFailures ?? (cleanupFailure ? [cleanupFailure] : []);
  }
}

export interface MaterializedCoreMindPackage {
  name: string;
  version: string;
  fileName: string;
  integrity: string;
  sha256: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

export interface MaterializedCoreMindCandidate {
  version: string;
  lockfileSha256?: string;
  identity:
    | { kind: "git-source-archive"; sha256: string }
    | { kind: "npm-package-set"; sha256: string };
  packages: MaterializedCoreMindPackage[];
}

export interface CoreMindCompatibilityEnvironment {
  choiceMindCommit: string;
  nodeVersion: string;
  workspacePackageManager: string;
  artifactPackageManager: string;
  compatibilityPolicy?: CoreMindCompatibilityPolicy;
}

export interface CoreMindCompatibilityPolicy {
  dependencyRegistry: string;
  dependencyFetch: {
    fetchRetries: number;
    fetchRetryFactor: number;
    fetchRetryMaxTimeoutMs: number;
    fetchRetryMinTimeoutMs: number;
    fetchTimeoutMs: number;
    installConcurrency: number;
    networkConcurrency: number;
  };
  materializationConcurrency: number;
  stageTimeouts: Record<string, { hardDeadlineMs: number; idleTimeoutMs: number }>;
  legacyCommandTimeoutMs?: number;
}

export class CoreMindCandidateVerificationError extends Error {
  readonly gate: CoreMindVerificationGate;
  readonly stage: CoreMindCompatibilityStage;
  readonly reason: CoreMindVerificationFailureReason | undefined;
  readonly progress: CoreMindSafeProgress | undefined;
  readonly cleanupFailure: CoreMindSafeCleanupFailure | undefined;
  readonly cleanupFailures: CoreMindSafeCleanupFailure[];
  readonly subject: CoreMindVerificationSubject | undefined;

  constructor(
    gate: CoreMindVerificationGate,
    stage: CoreMindCompatibilityStage,
    cause?: unknown,
    reason?: CoreMindVerificationFailureReason,
    progress?: CoreMindSafeProgress,
    cleanupFailure?: CoreMindSafeCleanupFailure,
    cleanupFailures?: CoreMindSafeCleanupFailure[],
    subject?: CoreMindVerificationSubject
  ) {
    super(`CoreMind 候选兼容验证失败：Gate ${gate} / ${stage}`, { cause });
    this.name = "CoreMindCandidateVerificationError";
    this.gate = gate;
    this.stage = stage;
    this.reason = reason;
    this.progress = progress;
    this.cleanupFailure = cleanupFailure;
    this.cleanupFailures = cleanupFailures ?? (cleanupFailure ? [cleanupFailure] : []);
    this.subject = subject;
  }
}

export interface CoreMindResolvedRuntimePackage {
  name: string;
  version: string;
}

export interface LocalModelGateConfiguration {
  providerBaseUrl: string;
  model: string;
}

export const LOCAL_QWEN_GATE_CONFIGURATION = {
  providerBaseUrl: "http://192.168.121.32:6013/v1",
  model: "Qwen3.8-27B"
} as const satisfies LocalModelGateConfiguration;

export interface CoreMindCandidateVerification {
  resolvedRuntimePackages: CoreMindResolvedRuntimePackage[];
  testCounts: Record<"D" | "E", number>;
  localModelSmoke?: {
    endpoint: string;
    model: string;
    executedAt: string;
    evidenceNonce: string;
    synthetic: true;
    scope: "INTEGRATION_SMOKE_ONLY";
    requestCount: number;
    toolName: "submit_decision_draft";
    decisionStatus: "NEED_MORE_INFO";
  };
}

export interface CoreMindCompatibilitySystem {
  readonly compatibilityPolicy?: CoreMindCompatibilityPolicy;
  materializeGitCommit(candidate: GitCommitCandidate): Promise<MaterializedCoreMindCandidate>;
  materializeNpmRelease(candidate: NpmReleaseCandidate): Promise<MaterializedCoreMindCandidate>;
  describeEnvironment(): Promise<CoreMindCompatibilityEnvironment>;
  verifyCandidateCompatibility(
    candidate: MaterializedCoreMindCandidate,
    environment: CoreMindCompatibilityEnvironment
  ): Promise<CoreMindCandidateVerification>;
}
