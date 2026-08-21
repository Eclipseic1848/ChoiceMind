import type {
  CoreMindMaterializationStage,
  GitCommitCandidate,
  NpmReleaseCandidate
} from "./index.js";

export class CoreMindArtifactMaterializationError extends Error {
  readonly stage: CoreMindMaterializationStage;

  constructor(stage: CoreMindMaterializationStage, cause?: unknown) {
    super(`CoreMind 制品物化失败：${stage}`, { cause });
    this.name = "CoreMindArtifactMaterializationError";
    this.stage = stage;
  }
}

export interface MaterializedCoreMindPackage {
  name: string;
  version: string;
  fileName: string;
  integrity: string;
  sha256: string;
  dependencies: Record<string, string>;
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
