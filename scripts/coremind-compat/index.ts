import type {
  CoreMindArtifactSource,
  CoreMindCompatibilityEnvironment,
  MaterializedCoreMindCandidate,
  MaterializedCoreMindPackage
} from "./internal-types.js";

export const CORE_MIND_REPOSITORY = "https://github.com/Eclipseic1848/CoreMind.git";

export const CORE_MIND_PACKAGE_NAMES = [
  "coremind-ai",
  "coremind-config",
  "coremind-protocol",
  "coremind-runtime",
  "coremind-tools",
  "coremind-templates",
  "coremind-worker",
  "coremind-cli"
] as const;

const CORE_MIND_RUNTIME_DEPENDENCIES = [
  "coremind-ai",
  "coremind-config",
  "coremind-protocol",
  "coremind-runtime",
  "coremind-tools",
  "coremind-templates"
] as const;

const CORE_MIND_AI_DEPENDENCIES = CORE_MIND_RUNTIME_DEPENDENCIES.filter(
  (name) => name !== "coremind-ai"
);

type CoreMindPackageName = (typeof CORE_MIND_PACKAGE_NAMES)[number];
type GateState = "PASSED" | "FAILED" | "NOT_RUN";

export class CoreMindCompatibilityError extends Error {
  readonly gate: "A" | "B";
  readonly code:
    | "CANDIDATE_INVALID"
    | "ENVIRONMENT_IDENTITY_FAILED"
    | "ARTIFACT_MATERIALIZATION_FAILED"
    | "ARTIFACT_IDENTITY_INVALID"
    | "ATOMIC_ASSEMBLY_INVALID";

  constructor(
    gate: "A" | "B",
    code: CoreMindCompatibilityError["code"],
    message: string
  ) {
    super(message);
    this.name = "CoreMindCompatibilityError";
    this.gate = gate;
    this.code = code;
  }
}

export interface GitCommitCandidate {
  schemaVersion: 1;
  kind: "git-commit";
  repository: typeof CORE_MIND_REPOSITORY;
  commit: string;
}

export interface NpmReleasePackageIdentity {
  integrity: string;
}

export interface NpmReleaseCandidate {
  schemaVersion: 1;
  kind: "npm-release";
  version: string;
  packages: Record<CoreMindPackageName, NpmReleasePackageIdentity>;
}

export type CoreMindCandidate = GitCommitCandidate | NpmReleaseCandidate;

export interface CoreMindCandidateAssemblyReport {
  schemaVersion: 1;
  candidate: CoreMindCandidate;
  environment: CoreMindCompatibilityEnvironment;
  gates: Record<"A" | "B" | "C" | "D" | "E" | "F" | "G" | "H", GateState>;
  artifacts: MaterializedCoreMindCandidate;
}

export interface CoreMindCandidateAssemblyFailureReport {
  schemaVersion: 1;
  gates: Record<"A" | "B" | "C" | "D" | "E" | "F" | "G" | "H", GateState>;
  failure: { code: CoreMindCompatibilityError["code"] };
}

export type CoreMindCompatibilityReport =
  | CoreMindCandidateAssemblyReport
  | CoreMindCandidateAssemblyFailureReport;

export async function runCoreMindCandidateAssembly(
  input: unknown,
  artifactSource: CoreMindArtifactSource
): Promise<CoreMindCandidateAssemblyReport> {
  let candidate: CoreMindCandidate;
  try {
    candidate = parseCandidate(input);
  } catch (error) {
    throw compatibilityError("A", "CANDIDATE_INVALID", error);
  }
  let environment: CoreMindCompatibilityEnvironment;
  try {
    environment = await artifactSource.describeEnvironment();
  } catch (error) {
    throw compatibilityError("A", "ENVIRONMENT_IDENTITY_FAILED", error);
  }
  let artifacts: MaterializedCoreMindCandidate;
  try {
    artifacts =
      candidate.kind === "git-commit"
        ? await artifactSource.materializeGitCommit(candidate)
        : await artifactSource.materializeNpmRelease(candidate);
  } catch (error) {
    throw compatibilityError("A", "ARTIFACT_MATERIALIZATION_FAILED", error);
  }

  validateMaterializedCandidate(
    artifacts,
    candidate.kind === "git-commit" ? "git-source-archive" : "npm-package-set"
  );
  if (candidate.kind === "npm-release") {
    validateNpmReleaseArtifacts(candidate, artifacts);
  }

  return {
    schemaVersion: 1,
    candidate,
    environment,
    gates: {
      A: "PASSED",
      B: "PASSED",
      C: "NOT_RUN",
      D: "NOT_RUN",
      E: "NOT_RUN",
      F: "NOT_RUN",
      G: "NOT_RUN",
      H: "NOT_RUN"
    },
    artifacts
  };
}

function parseCandidate(input: unknown): CoreMindCandidate {
  const value = requireRecord(input, "候选描述必须是 JSON 对象");
  if (value.schemaVersion !== 1) {
    throw new Error("候选描述 schemaVersion 必须为 1");
  }
  if (value.kind === "git-commit") {
    assertExactKeys(value, ["schemaVersion", "kind", "repository", "commit"]);
    if (value.repository !== CORE_MIND_REPOSITORY) {
      throw new Error(`Git 候选 repository 必须固定为 ${CORE_MIND_REPOSITORY}`);
    }
    if (typeof value.commit !== "string" || !/^[0-9a-f]{40}$/iu.test(value.commit)) {
      throw new Error("Git 候选必须提供完整 40 位 commit SHA");
    }
    return {
      schemaVersion: 1,
      kind: "git-commit",
      repository: CORE_MIND_REPOSITORY,
      commit: value.commit.toLowerCase()
    };
  }
  if (value.kind === "npm-release") {
    assertExactKeys(value, ["schemaVersion", "kind", "version", "packages"]);
    if (
      typeof value.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(value.version)
    ) {
      throw new Error("npm-release 候选必须使用精确 RC 或正式版本");
    }
    const packageInput = requireRecord(value.packages, "npm-release 必须提供八包 integrity");
    assertExactKeys(packageInput, [...CORE_MIND_PACKAGE_NAMES]);
    const packages = {} as Record<CoreMindPackageName, NpmReleasePackageIdentity>;
    for (const name of CORE_MIND_PACKAGE_NAMES) {
      const identity = requireRecord(packageInput[name], `${name} identity 必须是对象`);
      assertExactKeys(identity, ["integrity"]);
      if (
        typeof identity.integrity !== "string" ||
        !isSha512Integrity(identity.integrity)
      ) {
        throw new Error(`${name} 必须提供有效 registry integrity`);
      }
      packages[name] = { integrity: identity.integrity };
    }
    return {
      schemaVersion: 1,
      kind: "npm-release",
      version: value.version,
      packages
    };
  }
  throw new Error("候选 kind 只能是 git-commit 或 npm-release");
}

function validateNpmReleaseArtifacts(
  candidate: NpmReleaseCandidate,
  artifacts: MaterializedCoreMindCandidate
): void {
  if (artifacts.version !== candidate.version) {
    throw assemblyError(
      `npm 制品版本 ${artifacts.version} 与候选 ${candidate.version} 不一致`
    );
  }
  const byName = new Map(artifacts.packages.map((artifact) => [artifact.name, artifact]));
  for (const name of CORE_MIND_PACKAGE_NAMES) {
    if (byName.get(name)?.integrity !== candidate.packages[name].integrity) {
      throw new CoreMindCompatibilityError(
        "A",
        "ARTIFACT_IDENTITY_INVALID",
        `${name} integrity 与候选描述不一致`
      );
    }
  }
}

function validateMaterializedCandidate(
  candidate: MaterializedCoreMindCandidate,
  expectedIdentityKind: MaterializedCoreMindCandidate["identity"]["kind"]
): void {
  if (candidate.identity.kind !== expectedIdentityKind) {
    throw new CoreMindCompatibilityError(
      "A",
      "ARTIFACT_IDENTITY_INVALID",
      `候选制品身份类型必须为 ${expectedIdentityKind}`
    );
  }
  if (!isSha256(candidate.identity.sha256)) {
    throw new CoreMindCompatibilityError(
      "A",
      "ARTIFACT_IDENTITY_INVALID",
      "候选制品身份必须具有 SHA-256"
    );
  }
  const packages = new Map<string, MaterializedCoreMindPackage>();
  for (const artifact of candidate.packages) {
    if (packages.has(artifact.name)) {
      throw assemblyError(`候选制品重复包含 ${artifact.name}`);
    }
    packages.set(artifact.name, artifact);
  }
  for (const name of CORE_MIND_PACKAGE_NAMES) {
    const artifact = packages.get(name);
    if (!artifact) throw assemblyError(`候选制品缺少 ${name}`);
    if (artifact.version !== candidate.version) {
      throw assemblyError(`${name} 版本 ${artifact.version} 与候选 ${candidate.version} 不一致`);
    }
    if (!isSha256(artifact.sha256)) {
      throw new CoreMindCompatibilityError(
        "A",
        "ARTIFACT_IDENTITY_INVALID",
        `${name} 缺少有效 SHA-256`
      );
    }
    if (!isSha512Integrity(artifact.integrity)) {
      throw new CoreMindCompatibilityError(
        "A",
        "ARTIFACT_IDENTITY_INVALID",
        `${name} 缺少有效 registry integrity`
      );
    }
    for (const [dependencyName, version] of Object.entries(artifact.dependencies)) {
      if (isCoreMindPackageName(dependencyName) && version !== candidate.version) {
        throw assemblyError(
          `${name} 的内部依赖 ${dependencyName}=${version} 发生混装或稳定版本回退`
        );
      }
    }
  }
  if (packages.size !== CORE_MIND_PACKAGE_NAMES.length) {
    const extras = [...packages.keys()].filter((name) => !isCoreMindPackageName(name));
    throw assemblyError(`候选制品包含未知包：${extras.join(", ")}`);
  }
  const entry = packages.get("coremind-ai");
  if (!entry) throw assemblyError("候选制品缺少 coremind-ai");
  for (const name of CORE_MIND_AI_DEPENDENCIES) {
    if (entry.dependencies[name] !== candidate.version) {
      throw assemblyError(`coremind-ai 未原子绑定 ${name}@${candidate.version}`);
    }
  }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `候选字段不符合合同：缺失 [${missing.join(", ")}]，额外 [${unexpected.join(", ")}]`
    );
  }
}

function isCoreMindPackageName(value: string): value is CoreMindPackageName {
  return (CORE_MIND_PACKAGE_NAMES as readonly string[]).includes(value);
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/iu.test(value);
}

function isSha512Integrity(value: string): boolean {
  if (!value.startsWith("sha512-")) return false;
  const encoded = value.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  return digest.length === 64 && digest.toString("base64") === encoded;
}

function assemblyError(message: string): CoreMindCompatibilityError {
  return new CoreMindCompatibilityError("B", "ATOMIC_ASSEMBLY_INVALID", message);
}

function compatibilityError(
  gate: "A" | "B",
  code: CoreMindCompatibilityError["code"],
  error: unknown
): CoreMindCompatibilityError {
  if (error instanceof CoreMindCompatibilityError) return error;
  return new CoreMindCompatibilityError(
    gate,
    code,
    error instanceof Error ? error.message : "CoreMind 候选验证失败"
  );
}
