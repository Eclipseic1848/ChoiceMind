import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  CORE_MIND_PACKAGE_NAMES,
  type CoreMindMaterializationStage,
  type GitCommitCandidate,
  type NpmReleaseCandidate
} from "./index.js";
import {
  CoreMindArtifactMaterializationError,
  type CoreMindMaterializationFailureReason,
  type MaterializedCoreMindCandidate
} from "./internal-types.js";
import { combineAbortSignals, isPermissionError } from "./utilities.js";

export interface MaterializationStageDeadline {
  run<T>(stage: CoreMindMaterializationStage, operation: () => Promise<T>): Promise<T>;
  commit<T>(stage: CoreMindMaterializationStage, operation: () => Promise<T>): Promise<T>;
  signal(stage: CoreMindMaterializationStage): AbortSignal | undefined;
}

export interface MaterializationOptions {
  artifactDirectory: string;
  materializationDirectory?: string;
  materializationConcurrency?: number;
  materializationLockTimeoutMs?: number;
  permissionFileSystem?: Partial<MaterializationPermissionFileSystem>;
  reportLockWait?: (kind: "acquisition" | "slot") => Promise<void>;
  signal?: AbortSignal;
  stageDeadline?: MaterializationStageDeadline;
}

export interface MaterializationPermissionFileSystem {
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(filePath: string, content: string, encoding: "utf8"): Promise<unknown>;
  rename(source: string, target: string): Promise<void>;
  rm(
    target: string,
    options?: { force?: boolean; recursive?: boolean }
  ): Promise<void>;
}

const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_MAX_LEASE_MS = 2 * 60 * 60_000;
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 2 * 60 * 60_000;

interface StoredMaterialization {
  acquisitionKey: string;
  artifactKey: string;
  candidate: GitCommitCandidate | NpmReleaseCandidate;
  artifacts: MaterializedCoreMindCandidate;
}

export async function materializeWithReuse(
  options: MaterializationOptions,
  candidate: GitCommitCandidate | NpmReleaseCandidate,
  packageDirectory: string,
  environment: {
    nodeVersion: string;
    workspacePackageManager: string;
    artifactPackageManager: string;
    platform: NodeJS.Platform;
    architecture: string;
  },
  materialize: () => Promise<MaterializedCoreMindCandidate>
): Promise<MaterializedCoreMindCandidate> {
  if (options.materializationDirectory === undefined) {
    await verifyMaterializationPermissions(
      options.artifactDirectory,
      options.permissionFileSystem,
      options.stageDeadline
    );
    return materialize();
  }
  const root = options.materializationDirectory;
  await verifyMaterializationPermissions(
    options.artifactDirectory,
    options.permissionFileSystem,
    options.stageDeadline
  );
  if (path.resolve(root) !== path.resolve(options.artifactDirectory)) {
    await verifyMaterializationPermissions(root, options.permissionFileSystem, options.stageDeadline);
  }
  const acquisitionKey = materializationAcquisitionKey(candidate, environment);
  const pointerPath = path.join(root, "acquisitions", `${acquisitionKey}.json`);
  const lockLease = await acquireMaterializationLock(
    root,
    acquisitionKey,
    options.signal,
    options.materializationLockTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
    options.reportLockWait,
    options.permissionFileSystem
  );
  let lockOperationFailure: unknown;
  try {
    const materializedByOwner = await atMaterializationStage(
      options.stageDeadline,
      "ARTIFACT_REUSE",
      async () => {
        const stored = await readReusableMaterialization(
          root,
          pointerPath,
          acquisitionKey,
          candidate
        );
        if (stored) await copyStoredPackages(root, stored, packageDirectory);
        return stored;
      }
    );
    if (materializedByOwner) {
      return materializedByOwner.artifacts;
    }
    const slotLease = await acquireMaterializationSlot(
      root,
      options.materializationConcurrency ?? 2,
      options.signal,
      options.materializationLockTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
      options.reportLockWait,
      options.permissionFileSystem
    );
    let slotOperationFailure: unknown;
    try {
      const artifacts = await materialize();
      await slotLease.assertOwnership();
      await lockLease.assertOwnership();
      const artifactKey = materializationArtifactKey(acquisitionKey, artifacts);
      const stored: StoredMaterialization = { acquisitionKey, artifactKey, candidate, artifacts };
      await atMaterializationStage(options.stageDeadline, "ARTIFACT_PERSIST", () =>
        persistMaterialization(root, stored, packageDirectory, async () => {
          await slotLease.assertOwnership();
          await lockLease.assertOwnership();
        }, combineAbortSignals(options.signal, options.stageDeadline?.signal("ARTIFACT_PERSIST")),
        options.permissionFileSystem, options.stageDeadline)
      );
      return artifacts;
    } catch (error) {
      slotOperationFailure = error;
      throw error;
    } finally {
      await releaseWithoutMasking(slotLease.release, slotOperationFailure);
    }
  } catch (error) {
    lockOperationFailure = error;
    throw error;
  } finally {
    await releaseWithoutMasking(lockLease.release, lockOperationFailure);
  }
}

async function releaseWithoutMasking(
  release: () => Promise<void>,
  operationFailure: unknown
): Promise<void> {
  try {
    await release();
  } catch (error) {
    if (operationFailure === undefined) {
      throw new CoreMindArtifactMaterializationError(
        "MATERIALIZATION_LOCK",
        error,
        isPermissionError(error) ? "PERMISSION_DENIED" : "CLEANUP_FAILED"
      );
    }
    throw attachCleanupFailure(operationFailure, "MATERIALIZATION_LOCK", error);
  }
}

function attachCleanupFailure(
  operationFailure: unknown,
  stage: CoreMindMaterializationStage,
  cleanupCause: unknown
): CoreMindArtifactMaterializationError {
  const primary =
    operationFailure instanceof CoreMindArtifactMaterializationError
      ? operationFailure
      : new CoreMindArtifactMaterializationError(stage, operationFailure);
  const cleanupFailure = {
    stage,
    reason: isPermissionError(cleanupCause) ? "PERMISSION_DENIED" : "CLEANUP_FAILED"
  } as const;
  return new CoreMindArtifactMaterializationError(
    primary.stage,
    primary,
    primary.reason,
    primary.progress,
    cleanupFailure,
    [...primary.cleanupFailures, cleanupFailure]
  );
}

async function verifyMaterializationPermissions(
  root: string,
  overrides: Partial<MaterializationPermissionFileSystem> | undefined,
  stageDeadline: MaterializationStageDeadline | undefined
): Promise<void> {
  const fileSystem: MaterializationPermissionFileSystem = {
    mkdir,
    mkdtemp,
    writeFile,
    rename,
    rm,
    ...overrides
  };
  await atMaterializationStage(stageDeadline, "MATERIALIZATION_PREFLIGHT", async () => {
    await fileSystem.mkdir(root, { recursive: true });
    const probeDirectory = await fileSystem.mkdtemp(path.join(root, ".permission-probe-"));
    const source = path.join(probeDirectory, "source");
    const target = path.join(probeDirectory, "target");
    let failure: unknown;
    try {
      await fileSystem.writeFile(source, "probe\n", "utf8");
      await fileSystem.rename(source, target);
      await fileSystem.rm(target);
    } catch (error) {
      failure = error;
    }
    try {
      await fileSystem.rm(probeDirectory, { force: true, recursive: true });
    } catch (error) {
      if (failure !== undefined) {
        throw attachCleanupFailure(
          new CoreMindArtifactMaterializationError(
            "MATERIALIZATION_PREFLIGHT",
            failure,
            isPermissionError(failure) ? "PERMISSION_DENIED" : undefined
          ),
          "CLEANUP",
          error
        );
      }
      throw new CoreMindArtifactMaterializationError(
        "CLEANUP",
        error,
        isPermissionError(error) ? "PERMISSION_DENIED" : "CLEANUP_FAILED"
      );
    }
    if (failure !== undefined) throw failure;
  });
}

async function acquireMaterializationSlot(
  root: string,
  concurrency: number,
  signal: AbortSignal | undefined,
  acquireTimeoutMs: number,
  reportLockWait: MaterializationOptions["reportLockWait"],
  fileSystemOverrides: Partial<MaterializationPermissionFileSystem> | undefined
): Promise<MaterializationLease> {
  const slotRoot = path.join(root, "slots");
  const startedAt = Date.now();
  await mkdir(slotRoot, { recursive: true });
  for (;;) {
    assertLockWaitWithinDeadline(startedAt, acquireTimeoutMs);
    if (signal?.aborted) {
      throw new CoreMindArtifactMaterializationError(
        "MATERIALIZATION_LOCK",
        undefined,
        "CANCELLED"
      );
    }
    for (let index = 0; index < concurrency; index += 1) {
      const slotDirectory = path.join(slotRoot, String(index));
      const ownerPath = path.join(slotDirectory, "owner.json");
      const ownerId = randomUUID();
      let directoryCreated = false;
      try {
        await mkdir(slotDirectory);
        directoryCreated = true;
        const owner: MaterializationLockOwner = {
          ownerId,
          pid: process.pid,
          createdAt: Date.now(),
          materializationKey: `slot:${index}`,
          heartbeatAt: Date.now()
        };
        await writeLockOwner(ownerPath, owner, fileSystemOverrides?.writeFile);
        const stopHeartbeat = startLockHeartbeat(ownerPath);
        return {
          assertOwnership: () => assertOwnedDirectory(ownerPath, ownerId),
          release: async () => {
            await stopHeartbeat();
            await releaseOwnedDirectory(slotDirectory, ownerPath, ownerId);
          }
        };
      } catch (error) {
        if (directoryCreated) {
          throw await cleanupFailedOwnerWrite(
            slotDirectory,
            error,
            fileSystemOverrides?.rm
          );
        }
        if (!isExistingPathError(error)) {
          throw new CoreMindArtifactMaterializationError(
            "MATERIALIZATION_LOCK",
            error,
            isPermissionError(error) ? "PERMISSION_DENIED" : undefined
          );
        }
        await recoverStaleMaterializationLock(slotDirectory, ownerPath, `slot:${index}`);
      }
    }
    await reportLockWait?.("slot");
    await waitForMaterializationLock(signal);
  }
}

interface MaterializationLockOwner {
  ownerId: string;
  pid: number;
  createdAt: number;
  materializationKey: string;
  heartbeatAt: number;
}

interface MaterializationLease {
  assertOwnership(): Promise<void>;
  release(): Promise<void>;
}

async function acquireMaterializationLock(
  root: string,
  acquisitionKey: string,
  signal: AbortSignal | undefined,
  acquireTimeoutMs: number,
  reportLockWait: MaterializationOptions["reportLockWait"],
  fileSystemOverrides: Partial<MaterializationPermissionFileSystem> | undefined
): Promise<MaterializationLease> {
  const lockRoot = path.join(root, "locks");
  const lockDirectory = path.join(lockRoot, acquisitionKey);
  const ownerPath = path.join(lockDirectory, "owner.json");
  const ownerId = randomUUID();
  const startedAt = Date.now();
  await mkdir(lockRoot, { recursive: true });

  for (;;) {
    assertLockWaitWithinDeadline(startedAt, acquireTimeoutMs);
    if (signal?.aborted) {
      throw new CoreMindArtifactMaterializationError(
        "MATERIALIZATION_LOCK",
        undefined,
        "CANCELLED"
      );
    }
    let directoryCreated = false;
    try {
      await mkdir(lockDirectory);
      directoryCreated = true;
      const owner: MaterializationLockOwner = {
        ownerId,
        pid: process.pid,
        createdAt: Date.now(),
        materializationKey: acquisitionKey,
        heartbeatAt: Date.now()
      };
      await writeLockOwner(ownerPath, owner, fileSystemOverrides?.writeFile);
      const stopHeartbeat = startLockHeartbeat(ownerPath);
      return {
        assertOwnership: () => assertOwnedDirectory(ownerPath, ownerId),
        release: async () => {
          await stopHeartbeat();
          await releaseOwnedDirectory(lockDirectory, ownerPath, ownerId);
        }
      };
    } catch (error) {
      if (directoryCreated) {
        throw await cleanupFailedOwnerWrite(
          lockDirectory,
          error,
          fileSystemOverrides?.rm
        );
      }
      if (!isExistingPathError(error)) {
        throw new CoreMindArtifactMaterializationError(
          "MATERIALIZATION_LOCK",
          error,
          isPermissionError(error) ? "PERMISSION_DENIED" : undefined
        );
      }
    }

    await recoverStaleMaterializationLock(lockDirectory, ownerPath, acquisitionKey);
    await reportLockWait?.("acquisition");
    await waitForMaterializationLock(signal);
  }
}

function assertLockWaitWithinDeadline(startedAt: number, acquireTimeoutMs: number): void {
  if (Date.now() - startedAt >= acquireTimeoutMs) {
    throw new CoreMindArtifactMaterializationError(
      "MATERIALIZATION_LOCK",
      undefined,
      "LOCK_TIMEOUT"
    );
  }
}

async function assertOwnedDirectory(ownerPath: string, ownerId: string): Promise<void> {
  let current: MaterializationLockOwner;
  try {
    current = JSON.parse(await readFile(ownerPath, "utf8")) as MaterializationLockOwner;
  } catch (error) {
    throw new CoreMindArtifactMaterializationError(
      "MATERIALIZATION_LOCK",
      error,
      isPermissionError(error) ? "PERMISSION_DENIED" : "LOCK_LOST"
    );
  }
  let ownerStat: Stats;
  try {
    ownerStat = await stat(ownerPath);
  } catch (error) {
    throw new CoreMindArtifactMaterializationError(
      "MATERIALIZATION_LOCK",
      error,
      isPermissionError(error) ? "PERMISSION_DENIED" : "LOCK_LOST"
    );
  }
  const now = Date.now();
  if (
    current?.ownerId !== ownerId ||
    typeof current.createdAt !== "number" ||
    now - current.createdAt > LOCK_MAX_LEASE_MS ||
    now - ownerStat.mtimeMs > LOCK_STALE_AFTER_MS
  ) {
    throw new CoreMindArtifactMaterializationError(
      "MATERIALIZATION_LOCK",
      undefined,
      "LOCK_LOST"
    );
  }
}

async function releaseOwnedDirectory(
  directory: string,
  ownerPath: string,
  ownerId: string
): Promise<void> {
  let current: MaterializationLockOwner | undefined;
  try {
    current = JSON.parse(await readFile(ownerPath, "utf8")) as MaterializationLockOwner;
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (current.ownerId !== ownerId) return;
  const releasedDirectory = `${directory}.released-${ownerId}`;
  try {
    await rename(directory, releasedDirectory);
    await rm(releasedDirectory, { force: true, recursive: true });
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

async function writeLockOwner(
  ownerPath: string,
  owner: MaterializationLockOwner,
  writeOwner: MaterializationPermissionFileSystem["writeFile"] = writeFile
): Promise<void> {
  await writeOwner(ownerPath, `${JSON.stringify(owner)}\n`, "utf8");
}

async function cleanupFailedOwnerWrite(
  directory: string,
  cause: unknown,
  removeDirectory: MaterializationPermissionFileSystem["rm"] = rm
): Promise<CoreMindArtifactMaterializationError> {
  const primary = new CoreMindArtifactMaterializationError(
    "MATERIALIZATION_LOCK",
    cause,
    isPermissionError(cause) ? "PERMISSION_DENIED" : undefined
  );
  try {
    await removeDirectory(directory, { force: true, recursive: true });
    return primary;
  } catch (cleanupCause) {
    return attachCleanupFailure(primary, "MATERIALIZATION_LOCK", cleanupCause);
  }
}

function startLockHeartbeat(ownerPath: string): () => Promise<void> {
  let pending = Promise.resolve();
  let heartbeatFailure: unknown;
  const heartbeat = setInterval(() => {
    const now = new Date();
    pending = pending
      .then(() => utimes(ownerPath, now, now))
      .catch((error) => {
        heartbeatFailure ??= error;
      });
  }, 5_000);
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    await pending;
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
  };
}

async function recoverStaleMaterializationLock(
  lockDirectory: string,
  ownerPath: string,
  expectedMaterializationKey: string
): Promise<void> {
  let owner: MaterializationLockOwner;
  let ownerStat: Stats;
  try {
    const parsedOwner = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
    if (typeof parsedOwner !== "object" || parsedOwner === null || Array.isArray(parsedOwner)) {
      throw new Error("物化锁 owner 无效");
    }
    owner = parsedOwner as MaterializationLockOwner;
    ownerStat = await stat(ownerPath);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new CoreMindArtifactMaterializationError(
        "MATERIALIZATION_LOCK",
        error,
        "PERMISSION_DENIED"
      );
    }
    try {
      const lockStat = await stat(lockDirectory);
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_AFTER_MS) {
        await removeStaleLockDirectory(lockDirectory);
      }
    } catch (statError) {
      if (!isMissingPathError(statError)) throw statError;
    }
    return;
  }
  const now = Date.now();
  const heartbeatAt = Math.max(owner.heartbeatAt, ownerStat.mtimeMs);
  const invalidOwner =
    typeof owner.ownerId !== "string" ||
    !Number.isSafeInteger(owner.pid) ||
    typeof owner.createdAt !== "number" ||
    owner.materializationKey !== expectedMaterializationKey ||
    typeof owner.heartbeatAt !== "number";
  if (!invalidOwner) {
    if (now - owner.createdAt > LOCK_MAX_LEASE_MS) {
      await removeStaleLockDirectory(lockDirectory);
      return;
    }
    if (
      now - heartbeatAt <= LOCK_STALE_AFTER_MS
    ) {
      return;
    }
    if (isProcessAlive(owner.pid)) return;
  } else {
    const lockStat = await stat(lockDirectory);
    if (now - lockStat.mtimeMs <= LOCK_STALE_AFTER_MS) return;
  }
  await removeStaleLockDirectory(lockDirectory);
}

async function removeStaleLockDirectory(lockDirectory: string): Promise<void> {
  const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    await rename(lockDirectory, staleDirectory);
    await rm(staleDirectory, { force: true, recursive: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw new CoreMindArtifactMaterializationError(
      "MATERIALIZATION_LOCK",
      error,
      isPermissionError(error) ? "PERMISSION_DENIED" : "CLEANUP_FAILED"
    );
  }
}

async function waitForMaterializationLock(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: CoreMindArtifactMaterializationError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(), 25);
    const cancel = () => {
      finish(
        new CoreMindArtifactMaterializationError(
          "MATERIALIZATION_LOCK",
          undefined,
          "CANCELLED"
        )
      );
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function materializationAcquisitionKey(
  candidate: GitCommitCandidate | NpmReleaseCandidate,
  environment: {
    nodeVersion: string;
    workspacePackageManager: string;
    artifactPackageManager: string;
    platform: NodeJS.Platform;
    architecture: string;
  }
): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        candidate,
        environment
      })
    )
  );
}

function materializationArtifactKey(
  acquisitionKey: string,
  artifacts: MaterializedCoreMindCandidate
): string {
  return sha256(Buffer.from(JSON.stringify({ acquisitionKey, artifacts })));
}

async function readReusableMaterialization(
  root: string,
  pointerPath: string,
  acquisitionKey: string,
  candidate: GitCommitCandidate | NpmReleaseCandidate
): Promise<StoredMaterialization | undefined> {
  let pointer: { artifactKey?: unknown };
  try {
    const parsed = JSON.parse(await readFile(pointerPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("物化指针无效");
    }
    pointer = parsed as { artifactKey?: unknown };
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw new CoreMindArtifactMaterializationError("TARBALL_VALIDATE", error);
  }
  if (typeof pointer.artifactKey !== "string" || !/^[0-9a-f]{64}$/u.test(pointer.artifactKey)) {
    throw new CoreMindArtifactMaterializationError("TARBALL_VALIDATE");
  }
  const manifestPath = path.join(root, "artifacts", pointer.artifactKey, "manifest.json");
  const completionPath = path.join(root, "artifacts", pointer.artifactKey, "complete.json");
  let stored: StoredMaterialization;
  try {
    const completion = JSON.parse(await readFile(completionPath, "utf8")) as {
      schemaVersion?: unknown;
      artifactKey?: unknown;
    } | null;
    if (
      completion === null ||
      completion.schemaVersion !== 1 ||
      completion.artifactKey !== pointer.artifactKey
    ) {
      throw new Error("物化完成标记无效");
    }
    const parsedStored = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (typeof parsedStored !== "object" || parsedStored === null || Array.isArray(parsedStored)) {
      throw new Error("物化清单无效");
    }
    stored = parsedStored as StoredMaterialization;
  } catch (error) {
    throw new CoreMindArtifactMaterializationError("TARBALL_VALIDATE", error);
  }
  if (
    stored.acquisitionKey !== acquisitionKey ||
    stored.artifactKey !== pointer.artifactKey ||
    JSON.stringify(stored.candidate) !== JSON.stringify(candidate) ||
    !isCompleteStoredArtifactIdentity(stored.artifacts, candidate.kind) ||
    materializationArtifactKey(acquisitionKey, stored.artifacts) !== stored.artifactKey
  ) {
    throw new CoreMindArtifactMaterializationError("TARBALL_VALIDATE");
  }
  await verifyStoredPackageBytes(root, stored);
  return stored;
}

function isCompleteStoredArtifactIdentity(
  artifacts: MaterializedCoreMindCandidate,
  candidateKind: GitCommitCandidate["kind"] | NpmReleaseCandidate["kind"]
): boolean {
  if (
    !artifacts ||
    typeof artifacts !== "object" ||
    typeof artifacts.version !== "string" ||
    !artifacts.version ||
    !artifacts.identity ||
    typeof artifacts.identity.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(artifacts.identity.sha256) ||
    !Array.isArray(artifacts.packages) ||
    artifacts.packages.length !== CORE_MIND_PACKAGE_NAMES.length
  ) {
    return false;
  }
  if (
    (candidateKind === "git-commit" &&
      (artifacts.identity.kind !== "git-source-archive" ||
        typeof artifacts.lockfileSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(artifacts.lockfileSha256))) ||
    (candidateKind === "npm-release" && artifacts.identity.kind !== "npm-package-set")
  ) {
    return false;
  }
  const expectedNames = new Set<string>(CORE_MIND_PACKAGE_NAMES);
  const observedNames = new Set<string>();
  for (const artifact of artifacts.packages) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      !expectedNames.has(artifact.name) ||
      observedNames.has(artifact.name) ||
      artifact.version !== artifacts.version ||
      typeof artifact.fileName !== "string" ||
      path.basename(artifact.fileName) !== artifact.fileName ||
      artifact.fileName.includes("/") ||
      artifact.fileName.includes("\\") ||
      typeof artifact.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(artifact.integrity) ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
      !isStringRecord(artifact.dependencies) ||
      !isStringRecord(artifact.optionalDependencies) ||
      !isStringRecord(artifact.peerDependencies)
    ) {
      return false;
    }
    observedNames.add(artifact.name);
  }
  return observedNames.size === expectedNames.size;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

async function verifyStoredPackageBytes(
  root: string,
  stored: StoredMaterialization
): Promise<void> {
  if (stored.artifacts.packages.length !== CORE_MIND_PACKAGE_NAMES.length) {
    throw new CoreMindArtifactMaterializationError("TARBALL_VALIDATE");
  }
  for (const artifact of stored.artifacts.packages) {
    const bytes = await readFile(
      path.join(root, "artifacts", stored.artifactKey, "packages", artifact.fileName)
    );
    if (sha256(bytes) !== artifact.sha256 || sha512Integrity(bytes) !== artifact.integrity) {
      throw new CoreMindArtifactMaterializationError("TARBALL_VALIDATE");
    }
  }
}

async function copyStoredPackages(
  root: string,
  stored: StoredMaterialization,
  packageDirectory: string
): Promise<void> {
  await mkdir(packageDirectory, { recursive: true });
  for (const artifact of stored.artifacts.packages) {
    await copyFile(
      path.join(root, "artifacts", stored.artifactKey, "packages", artifact.fileName),
      path.join(packageDirectory, artifact.fileName)
    );
  }
}

async function persistMaterialization(
  root: string,
  stored: StoredMaterialization,
  packageDirectory: string,
  assertOwnership: () => Promise<void>,
  signal: AbortSignal | undefined,
  fileSystemOverrides: Partial<MaterializationPermissionFileSystem> | undefined,
  stageDeadline: MaterializationStageDeadline | undefined
): Promise<void> {
  const fileSystem: MaterializationPermissionFileSystem = {
    mkdir,
    mkdtemp,
    writeFile,
    rename,
    rm,
    ...fileSystemOverrides
  };
  const artifactRoot = path.join(root, "artifacts");
  const acquisitionRoot = path.join(root, "acquisitions");
  await fileSystem.mkdir(artifactRoot, { recursive: true });
  await fileSystem.mkdir(acquisitionRoot, { recursive: true });
  const staging = await fileSystem.mkdtemp(path.join(root, ".staging-"));
  let operationFailure: unknown;
  let temporaryPointerPath: string | undefined;
  try {
    const stagingPackages = path.join(staging, "packages");
    await fileSystem.mkdir(stagingPackages, { recursive: true });
    for (const artifact of stored.artifacts.packages) {
      assertMaterializationNotCancelled(signal);
      await copyFile(
        path.join(packageDirectory, artifact.fileName),
        path.join(stagingPackages, artifact.fileName)
      );
    }
    await fileSystem.writeFile(
      path.join(staging, "manifest.json"),
      `${JSON.stringify(stored, null, 2)}\n`,
      "utf8"
    );
    await verifyStoredPackageBytesFromDirectory(staging, stored.artifacts);
    assertMaterializationNotCancelled(signal);
    await fileSystem.writeFile(
      path.join(staging, "complete.json"),
      `${JSON.stringify({ schemaVersion: 1, artifactKey: stored.artifactKey })}\n`,
      "utf8"
    );
    await assertOwnership();
    assertMaterializationNotCancelled(signal);
    const finalDirectory = path.join(artifactRoot, stored.artifactKey);
    try {
      await fileSystem.rename(staging, finalDirectory);
    } catch (error) {
      try {
        await stat(finalDirectory);
      } catch {
        throw error;
      }
      await verifyCompletedMaterialization(root, stored);
    }
    await assertOwnership();
    assertMaterializationNotCancelled(signal);
    const pointerPath = path.join(acquisitionRoot, `${stored.acquisitionKey}.json`);
    const pointerStagingPath = `${pointerPath}.${process.pid}.${randomUUID()}.tmp`;
    temporaryPointerPath = pointerStagingPath;
    await fileSystem.writeFile(
      temporaryPointerPath,
      `${JSON.stringify({ artifactKey: stored.artifactKey })}\n`,
      "utf8"
    );
    await commitMaterializationStage(stageDeadline, "ARTIFACT_PERSIST", async () => {
      await assertOwnership();
      assertMaterializationNotCancelled(signal);
      await fileSystem.rename(pointerStagingPath, pointerPath);
    });
    temporaryPointerPath = undefined;
  } catch (error) {
    operationFailure = error;
  }
  const cleanupResults = await Promise.allSettled([
    fileSystem.rm(staging, { force: true, recursive: true }),
    ...(temporaryPointerPath === undefined
      ? []
      : [fileSystem.rm(temporaryPointerPath, { force: true })])
  ]);
  const cleanupCauses = cleanupResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (cleanupCauses.length > 0) {
    const cleanupFailures = cleanupCauses.map((result) => ({
      stage: "CLEANUP" as const,
      reason: isPermissionError(result.reason)
        ? ("PERMISSION_DENIED" as const)
        : ("CLEANUP_FAILED" as const)
    }));
    const cleanupFailure = cleanupFailures[0];
    if (!cleanupFailure) throw new Error("清理失败集合不能为空");
    if (operationFailure === undefined) {
      throw new CoreMindArtifactMaterializationError(
        "CLEANUP",
        cleanupCauses[0]?.reason,
        cleanupFailure.reason,
        undefined,
        cleanupFailure,
        cleanupFailures
      );
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
      primary.cleanupFailure ?? cleanupFailure,
      [...primary.cleanupFailures, ...cleanupFailures]
    );
  }
  if (operationFailure !== undefined) throw operationFailure;
}

function assertMaterializationNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CoreMindArtifactMaterializationError(
      "ARTIFACT_PERSIST",
      undefined,
      signal.reason === "deadline-timeout" ? "DEADLINE_TIMEOUT" : "CANCELLED"
    );
  }
}

async function verifyCompletedMaterialization(
  root: string,
  expected: StoredMaterialization
): Promise<void> {
  const artifactDirectory = path.join(root, "artifacts", expected.artifactKey);
  const completion = JSON.parse(
    await readFile(path.join(artifactDirectory, "complete.json"), "utf8")
  ) as { schemaVersion?: unknown; artifactKey?: unknown };
  const manifest = JSON.parse(
    await readFile(path.join(artifactDirectory, "manifest.json"), "utf8")
  ) as StoredMaterialization;
  if (
    completion.schemaVersion !== 1 ||
    completion.artifactKey !== expected.artifactKey ||
    JSON.stringify(manifest) !== JSON.stringify(expected)
  ) {
    throw new CoreMindArtifactMaterializationError("TARBALL_VALIDATE");
  }
  await verifyStoredPackageBytes(root, expected);
}

async function verifyStoredPackageBytesFromDirectory(
  directory: string,
  artifacts: MaterializedCoreMindCandidate
): Promise<void> {
  for (const artifact of artifacts.packages) {
    const bytes = await readFile(path.join(directory, "packages", artifact.fileName));
    if (sha256(bytes) !== artifact.sha256) {
      throw new CoreMindArtifactMaterializationError("TARBALL_VALIDATE");
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha512Integrity(value: Buffer): string {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

async function atMaterializationStage<T>(
  stageDeadline: MaterializationStageDeadline | undefined,
  stage: CoreMindMaterializationStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await (stageDeadline ? stageDeadline.run(stage, operation) : operation());
  } catch (error) {
    if (error instanceof CoreMindArtifactMaterializationError) throw error;
    throw new CoreMindArtifactMaterializationError(
      stage,
      error,
      safeMaterializationFailureReason(error) ??
        (isPermissionError(error) ? "PERMISSION_DENIED" : undefined)
    );
  }
}

async function commitMaterializationStage<T>(
  stageDeadline: MaterializationStageDeadline | undefined,
  stage: CoreMindMaterializationStage,
  operation: () => Promise<T>
): Promise<T> {
  return stageDeadline ? stageDeadline.commit(stage, operation) : operation();
}

function safeMaterializationFailureReason(
  error: unknown
): CoreMindMaterializationFailureReason | undefined {
  if (!(error instanceof Error) || !("reason" in error)) return undefined;
  const reason = error.reason;
  return reason === "TIMEOUT" ||
    reason === "DEADLINE_TIMEOUT" ||
    reason === "IDLE_TIMEOUT" ||
    reason === "PERMISSION_DENIED" ||
    reason === "CLEANUP_FAILED" ||
    reason === "LOCK_LOST" ||
    reason === "LOCK_TIMEOUT" ||
    reason === "CANCELLED" ||
    reason === "COMMAND_FAILED" ||
    reason === "LAUNCH_FAILED"
    ? reason
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}
