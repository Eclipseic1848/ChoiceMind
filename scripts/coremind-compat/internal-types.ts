import type {
  CoreMindCompatibilityStage,
  CoreMindMaterializationStage,
  CoreMindVerificationGate,
  GitCommitCandidate,
  NpmReleaseCandidate
} from "./index.js";

export type CoreMindMaterializationFailureReason =
  | "TIMEOUT"
  | "CANCELLED"
  | "COMMAND_FAILED"
  | "LAUNCH_FAILED";

export class CoreMindArtifactMaterializationError extends Error {
  readonly stage: CoreMindMaterializationStage;
  readonly reason: CoreMindMaterializationFailureReason | undefined;

  constructor(
    stage: CoreMindMaterializationStage,
    cause?: unknown,
    reason?: CoreMindMaterializationFailureReason
  ) {
    super(`CoreMind 制品物化失败：${stage}`, { cause });
    this.name = "CoreMindArtifactMaterializationError";
    this.stage = stage;
    this.reason = reason;
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
}

export class CoreMindCandidateVerificationError extends Error {
  readonly gate: CoreMindVerificationGate;
  readonly stage: CoreMindCompatibilityStage;
  readonly reason: CoreMindMaterializationFailureReason | undefined;

  constructor(
    gate: CoreMindVerificationGate,
    stage: CoreMindCompatibilityStage,
    cause?: unknown,
    reason?: CoreMindMaterializationFailureReason
  ) {
    super(`CoreMind 候选兼容验证失败：Gate ${gate} / ${stage}`, { cause });
    this.name = "CoreMindCandidateVerificationError";
    this.gate = gate;
    this.stage = stage;
    this.reason = reason;
  }
}

export interface CoreMindResolvedRuntimePackage {
  name: string;
  version: string;
}

export interface CoreMindCandidateVerification {
  resolvedRuntimePackages: CoreMindResolvedRuntimePackage[];
  testCounts: Record<"D" | "E", number>;
}

export interface CoreMindCompatibilitySystem {
  materializeGitCommit(candidate: GitCommitCandidate): Promise<MaterializedCoreMindCandidate>;
  materializeNpmRelease(candidate: NpmReleaseCandidate): Promise<MaterializedCoreMindCandidate>;
  describeEnvironment(): Promise<CoreMindCompatibilityEnvironment>;
  verifyCandidateCompatibility(
    candidate: MaterializedCoreMindCandidate,
    environment: CoreMindCompatibilityEnvironment
  ): Promise<CoreMindCandidateVerification>;
}
