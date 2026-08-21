import type {
  CoreMindMaterializationStage,
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

export interface CoreMindArtifactSource {
  materializeGitCommit(candidate: GitCommitCandidate): Promise<MaterializedCoreMindCandidate>;
  materializeNpmRelease(candidate: NpmReleaseCandidate): Promise<MaterializedCoreMindCandidate>;
  describeEnvironment(): Promise<CoreMindCompatibilityEnvironment>;
}
