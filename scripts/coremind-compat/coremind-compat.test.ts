import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  CORE_MIND_PACKAGE_NAMES,
  runCoreMindCandidateAssembly
} from "./index.js";
import type {
  CoreMindArtifactSource,
  MaterializedCoreMindCandidate
} from "./internal-types.js";
import { createArtifactSource, createMaterializedCandidate } from "./test-fixtures.js";

const commit = "57e5765471cf6fe7f7da14d9ed4882e0c53ec322";
const candidateVersion = "0.0.0-rc.1";

describe("CoreMind 候选身份与原子制品装配", () => {
  test("精确 Git commit 的同源八包形成 Gate A/B 通过报告", async () => {
    const report = await runCoreMindCandidateAssembly(
      {
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      },
      createArtifactSource(createMaterializedCandidate())
    );

    expect(report).toMatchObject({
      schemaVersion: 1,
      candidate: {
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit
      },
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
      artifacts: {
        identity: { kind: "git-source-archive", sha256: "a".repeat(64) },
        packages: expect.arrayContaining([
          expect.objectContaining({ name: "coremind-ai", version: candidateVersion })
        ])
      }
    });
    expect(report.artifacts.packages).toHaveLength(8);
  });

  test("浮动 Git 身份在读取外部制品前失败", async () => {
    const source: CoreMindArtifactSource = {
      materializeGitCommit: async () => {
        throw new Error("不应读取外部制品");
      },
      materializeNpmRelease: async () => {
        throw new Error("不应读取外部制品");
      },
      describeEnvironment: async () => ({
        choiceMindCommit: "b".repeat(40),
        nodeVersion: "22.22.1",
        workspacePackageManager: "pnpm@11.21.0",
        artifactPackageManager: "npm@10.9.4"
      })
    };

    await expect(
      runCoreMindCandidateAssembly(
        {
          schemaVersion: 1,
          kind: "git-commit",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          commit: "main"
        },
        source
      )
    ).rejects.toThrow("完整 40 位 commit SHA");
  });

  test("环境身份读取失败在获取候选制品前失败并具有独立错误码", async () => {
    const source = createArtifactSource(createMaterializedCandidate());
    let materialized = false;
    source.materializeGitCommit = async () => {
      materialized = true;
      return createMaterializedCandidate();
    };
    source.describeEnvironment = async () => {
      throw new Error("无法读取 ChoiceMind commit");
    };

    await expect(
      runCoreMindCandidateAssembly(
        {
          schemaVersion: 1,
          kind: "git-commit",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          commit
        },
        source
      )
    ).rejects.toMatchObject({ gate: "A", code: "ENVIRONMENT_IDENTITY_FAILED" });
    expect(materialized).toBe(false);
  });

  test.each([
    ["未知 kind", { schemaVersion: 1, kind: "branch" }],
    [
      "缺失 Git commit",
      {
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git"
      }
    ]
  ])("拒绝%s", async (_caseName, input) => {
    await expect(
      runCoreMindCandidateAssembly(input, createArtifactSource())
    ).rejects.toMatchObject({ gate: "A", code: "CANDIDATE_INVALID" });
  });

  test("拒绝缺少任一包身份的 npm 候选", async () => {
    const materialized = createMaterializedCandidate("0.3.1-rc.1", "npm-package-set");
    const packages = Object.fromEntries(
      materialized.packages
        .filter((artifact) => artifact.name !== "coremind-cli")
        .map((artifact) => [artifact.name, { integrity: artifact.integrity }])
    );

    await expect(
      runCoreMindCandidateAssembly(
        { schemaVersion: 1, kind: "npm-release", version: "0.3.1-rc.1", packages },
        createArtifactSource(materialized)
      )
    ).rejects.toMatchObject({ gate: "A", code: "CANDIDATE_INVALID" });
  });

  test.each([
    ["分支", { commit: "feature/candidate" }, "完整 40 位 commit SHA"],
    ["浮动 Tag", { commit: "v0.3.1-rc.1" }, "完整 40 位 commit SHA"],
    ["本地路径", { repository: "F:/new branch/CoreMind" }, "repository 必须固定"],
    ["额外字段", { dirty: true }, "额外 [dirty]"]
  ])("拒绝%s候选", async (_caseName, override, expectedMessage) => {
    await expect(
      runCoreMindCandidateAssembly(
        {
          schemaVersion: 1,
          kind: "git-commit",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          commit,
          ...override
        },
        createArtifactSource(createMaterializedCandidate())
      )
    ).rejects.toThrow(expectedMessage);
  });

  test("拒绝 next 等非精确 npm 版本", async () => {
    await expect(
      runCoreMindCandidateAssembly(
        { schemaVersion: 1, kind: "npm-release", version: "next", packages: {} },
        createArtifactSource(createMaterializedCandidate())
      )
    ).rejects.toThrow("精确 RC 或正式版本");
  });

  test("精确 npm release 逐包核对八个 registry integrity", async () => {
    const materialized = createMaterializedCandidate("0.3.1-rc.1", "npm-package-set");
    const packages = Object.fromEntries(
      materialized.packages.map((artifact) => [
        artifact.name,
        { integrity: artifact.integrity }
      ])
    );

    const report = await runCoreMindCandidateAssembly(
      {
        schemaVersion: 1,
        kind: "npm-release",
        version: "0.3.1-rc.1",
        packages
      },
      createArtifactSource(materialized)
    );

    expect(report.candidate).toEqual({
      schemaVersion: 1,
      kind: "npm-release",
      version: "0.3.1-rc.1",
      packages
    });
    expect(report.gates).toMatchObject({ A: "PASSED", B: "PASSED" });
  });

  test("npm release 的候选 integrity 与实际制品不一致时失败", async () => {
    const materialized = createMaterializedCandidate("0.3.1-rc.1", "npm-package-set");
    const packages = Object.fromEntries(
      materialized.packages.map((artifact) => [
        artifact.name,
        {
          integrity:
            artifact.name === "coremind-runtime"
              ? `sha512-${createHash("sha512").update("wrong").digest("base64")}`
              : artifact.integrity
        }
      ])
    );

    await expect(
      runCoreMindCandidateAssembly(
        {
          schemaVersion: 1,
          kind: "npm-release",
          version: "0.3.1-rc.1",
          packages
        },
        createArtifactSource(materialized)
      )
    ).rejects.toThrow("coremind-runtime integrity 与候选描述不一致");
  });

  test("拒绝不足 64 字节的 sha512 integrity", async () => {
    const materialized = createMaterializedCandidate("0.3.1-rc.1", "npm-package-set");
    for (const artifact of materialized.packages) artifact.integrity = "sha512-YQ==";
    const packages = Object.fromEntries(
      CORE_MIND_PACKAGE_NAMES.map((name) => [name, { integrity: "sha512-YQ==" }])
    );

    await expect(
      runCoreMindCandidateAssembly(
        {
          schemaVersion: 1,
          kind: "npm-release",
          version: "0.3.1-rc.1",
          packages
        },
        createArtifactSource(materialized)
      )
    ).rejects.toMatchObject({ gate: "A", code: "CANDIDATE_INVALID" });
  });

  test.each([
    ["身份哈希", (candidate: MaterializedCoreMindCandidate) => (candidate.identity.sha256 = "bad")],
    [
      "tarball 哈希",
      (candidate: MaterializedCoreMindCandidate) => {
        const runtime = candidate.packages.find((item) => item.name === "coremind-runtime");
        if (runtime) runtime.sha256 = "bad";
      }
    ]
  ])("拒绝无效%s", async (_caseName, corrupt) => {
    const materialized = createMaterializedCandidate();
    corrupt(materialized);
    await expect(
      runCoreMindCandidateAssembly(
        {
          schemaVersion: 1,
          kind: "git-commit",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          commit
        },
        createArtifactSource(materialized)
      )
    ).rejects.toMatchObject({ gate: "A", code: "ARTIFACT_IDENTITY_INVALID" });
  });

  test("只替换 coremind-ai 时因缺少完整包组失败", async () => {
    const materialized = createMaterializedCandidate();
    materialized.packages = materialized.packages.filter((item) => item.name === "coremind-ai");
    await expect(
      runCoreMindCandidateAssembly(
        {
          schemaVersion: 1,
          kind: "git-commit",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          commit
        },
        createArtifactSource(materialized)
      )
    ).rejects.toMatchObject({ gate: "B", code: "ATOMIC_ASSEMBLY_INVALID" });
  });

  test("optionalDependencies 中的稳定 CoreMind 包回退失败关闭", async () => {
    const materialized = createMaterializedCandidate();
    const entry = materialized.packages.find((artifact) => artifact.name === "coremind-ai");
    if (!entry) throw new Error("测试候选缺少 coremind-ai");
    entry.optionalDependencies = { "coremind-runtime": "0.3.0" };

    await expect(
      runCoreMindCandidateAssembly(
        {
          schemaVersion: 1,
          kind: "git-commit",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          commit
        },
        createArtifactSource(materialized)
      )
    ).rejects.toMatchObject({ gate: "B", code: "ATOMIC_ASSEMBLY_INVALID" });
  });
});
