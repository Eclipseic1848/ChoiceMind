import { createHash } from "node:crypto";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CORE_MIND_PACKAGE_NAMES, CORE_MIND_REPOSITORY } from "./index.js";
import { materializeWithReuse } from "./materialization.js";
import type { MaterializedCoreMindCandidate } from "./internal-types.js";

const [root, runId, commit, concurrencySource] = process.argv.slice(2);
if (!root || !runId || !commit || !concurrencySource) {
  throw new Error("跨进程物化夹具参数不完整");
}
const concurrency = Number(concurrencySource);
const runDirectory = path.join(root, `run-${runId}`);
const packageDirectory = path.join(runDirectory, "packages");
const releasePath = path.join(root, `release-${runId}`);
const releaseWaitTimeoutMs = parseReleaseWaitTimeout(
  process.env.CHOICEMIND_FIXTURE_RELEASE_TIMEOUT_MS
);
const reportedWaits = new Set<string>();

const candidate = {
  schemaVersion: 1,
  kind: "git-commit",
  repository: CORE_MIND_REPOSITORY,
  commit
} as const;

await materializeWithReuse(
  {
    artifactDirectory: runDirectory,
    materializationDirectory: path.join(root, "materialized"),
    materializationConcurrency: concurrency,
    materializationLockTimeoutMs: 10_000,
    reportLockWait: async (kind) => {
      if (reportedWaits.has(kind)) return;
      reportedWaits.add(kind);
      await appendFile(path.join(root, "waiting.log"), `${runId}:${kind}\n`, "utf8");
    }
  },
  candidate,
  packageDirectory,
  {
    nodeVersion: process.versions.node,
    workspacePackageManager: "pnpm@11.21.0",
    artifactPackageManager: "npm@10.9.4",
    platform: process.platform,
    architecture: process.arch
  },
  async () => {
    await appendFile(path.join(root, "started.log"), `${runId}\n`, "utf8");
    await waitForFile(releasePath, releaseWaitTimeoutMs);
    await mkdir(packageDirectory, { recursive: true });
    const version = `0.0.0-rc.${BigInt(`0x${commit}`).toString(10)}`;
    const packages = [];
    for (const name of CORE_MIND_PACKAGE_NAMES) {
      const bytes = Buffer.from(name, "utf8");
      const fileName = `${name}-${version}.tgz`;
      await writeFile(path.join(packageDirectory, fileName), bytes);
      packages.push({
        name,
        version,
        fileName,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        dependencies: {},
        optionalDependencies: {},
        peerDependencies: {}
      });
    }
    return {
      version,
      lockfileSha256: "b".repeat(64),
      identity: { kind: "git-source-archive", sha256: "a".repeat(64) },
      packages
    } satisfies MaterializedCoreMindCandidate;
  }
);

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("等待 release 文件超时");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function parseReleaseWaitTimeout(value: string | undefined): number {
  if (value === undefined) return 15_000;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 60_000) {
    throw new Error("跨进程物化夹具 release 等待时限无效");
  }
  return parsed;
}
