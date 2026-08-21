import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CORE_MIND_PACKAGE_NAMES } from "./index.js";
import type {
  CoreMindArtifactSource,
  MaterializedCoreMindCandidate
} from "./internal-types.js";

export function createArtifactSource(
  materialized = createMaterializedCandidate(),
  runDirectory?: string
): CoreMindArtifactSource {
  const materialize = async () => {
    if (runDirectory) {
      const packageDirectory = path.join(runDirectory, "packages");
      await mkdir(packageDirectory, { recursive: true });
      await Promise.all(
        materialized.packages.map((artifact) =>
          writeFile(path.join(packageDirectory, artifact.fileName), artifact.name, "utf8")
        )
      );
    }
    return materialized;
  };
  return {
    materializeGitCommit: materialize,
    materializeNpmRelease: materialize,
    describeEnvironment: async () => ({
      choiceMindCommit: "b".repeat(40),
      nodeVersion: "22.22.1",
      workspacePackageManager: "pnpm@11.21.0",
      artifactPackageManager: "npm@10.9.4"
    })
  };
}

export function createMaterializedCandidate(
  version = "0.0.0-rc.1",
  identityKind: MaterializedCoreMindCandidate["identity"]["kind"] = "git-source-archive"
): MaterializedCoreMindCandidate {
  const identity: MaterializedCoreMindCandidate["identity"] =
    identityKind === "git-source-archive"
      ? { kind: "git-source-archive", sha256: "a".repeat(64) }
      : { kind: "npm-package-set", sha256: "a".repeat(64) };
  return {
    version,
    identity,
    packages: CORE_MIND_PACKAGE_NAMES.map((name) => ({
      name,
      version,
      fileName: `${name}-${version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(name).digest("base64")}`,
      sha256: "c".repeat(64),
      dependencies:
        name === "coremind-ai"
          ? {
              "coremind-config": version,
              "coremind-protocol": version,
              "coremind-runtime": version,
              "coremind-tools": version,
              "coremind-templates": version
            }
          : {}
    }))
  };
}
