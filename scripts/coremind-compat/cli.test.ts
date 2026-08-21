import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { CoreMindCompatCliFailure, runCoreMindCompatCli } from "./cli.js";
import { CoreMindArtifactMaterializationError } from "./internal-types.js";
import { createArtifactSource, createMaterializedCandidate } from "./test-fixtures.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((temporaryPath) =>
      rm(temporaryPath, { force: true, recursive: true })
    )
  );
});

describe("coremind:compat CLI", () => {
  test("从候选 JSON 原子写入只含 Gate A/B 的安全报告", async () => {
    const root = await createTemporaryDirectory();
    const candidatePath = path.join(root, "candidate.json");
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit: "57e5765471cf6fe7f7da14d9ed4882e0c53ec322"
      })}\n`,
      "utf8"
    );

    const result = await runCoreMindCompatCli(["--candidate", candidatePath], {
      createArtifactSource: (runDirectory) => createArtifactSource(undefined, runDirectory),
      outputRoot: path.join(root, "output")
    });
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      gates: Record<string, string>;
      artifacts: { packages: unknown[] };
    };

    expect(report.gates).toEqual({
      A: "PASSED",
      B: "PASSED",
      C: "NOT_RUN",
      D: "NOT_RUN",
      E: "NOT_RUN",
      F: "NOT_RUN",
      G: "NOT_RUN",
      H: "NOT_RUN"
    });
    expect(report.artifacts.packages).toHaveLength(8);
    expect(result.reportPath.endsWith("report.json")).toBe(true);
    expect(path.basename(path.dirname(result.reportPath))).toMatch(/^candidate-/u);
    expect(await readdir(path.join(path.dirname(result.reportPath), "packages"))).toHaveLength(8);
    expect(await readdir(path.join(root, "output"))).toEqual([
      path.basename(path.dirname(result.reportPath))
    ]);
  });

  test("稳定包回退时删除半成品并写入 Gate B 失败报告", async () => {
    const root = await createTemporaryDirectory();
    const candidatePath = path.join(root, "candidate.json");
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit: "57e5765471cf6fe7f7da14d9ed4882e0c53ec322"
      })}\n`,
      "utf8"
    );
    const materialized = createMaterializedCandidate();
    const runtime = materialized.packages.find((item) => item.name === "coremind-runtime");
    if (!runtime) throw new Error("测试夹具缺少 coremind-runtime");
    runtime.version = "0.3.0";

    let failure: CoreMindCompatCliFailure | undefined;
    try {
      await runCoreMindCompatCli(["--candidate", candidatePath], {
        createArtifactSource: (runDirectory) =>
          createArtifactSource(materialized, runDirectory),
        outputRoot: path.join(root, "output")
      });
    } catch (error) {
      if (error instanceof CoreMindCompatCliFailure) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    if (!failure) return;
    const report = JSON.parse(await readFile(failure.reportPath, "utf8")) as {
      gates: Record<string, string>;
      failure: Record<string, string>;
    };
    expect(report.gates).toMatchObject({ A: "PASSED", B: "FAILED", C: "NOT_RUN" });
    expect(report.failure).toEqual({ code: "ATOMIC_ASSEMBLY_INVALID" });
    expect(await readdir(path.dirname(failure.reportPath))).toEqual(["report.json"]);
    expect(path.basename(path.dirname(failure.reportPath))).toMatch(/^failure-/u);
    expect(await readdir(path.join(root, "output"))).toEqual([
      path.basename(path.dirname(failure.reportPath))
    ]);
  });

  test("制品获取失败只报告安全阶段而不保存原始错误", async () => {
    const root = await createTemporaryDirectory();
    const candidatePath = path.join(root, "candidate.json");
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "git-commit",
        repository: "https://github.com/Eclipseic1848/CoreMind.git",
        commit: "57e5765471cf6fe7f7da14d9ed4882e0c53ec322"
      })}\n`,
      "utf8"
    );
    const source = createArtifactSource();
    source.materializeGitCommit = async () => {
      throw new CoreMindArtifactMaterializationError(
        "NPM_CI",
        new Error("不得进入安全报告的原始超时错误"),
        "TIMEOUT"
      );
    };

    let failure: CoreMindCompatCliFailure | undefined;
    try {
      await runCoreMindCompatCli(["--candidate", candidatePath], {
        createArtifactSource: () => source,
        outputRoot: path.join(root, "output")
      });
    } catch (error) {
      if (error instanceof CoreMindCompatCliFailure) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    if (!failure) return;
    const reportText = await readFile(failure.reportPath, "utf8");
    const report = JSON.parse(reportText) as {
      gates: Record<string, string>;
      failure: Record<string, string>;
    };
    expect(report.gates).toMatchObject({ A: "FAILED", B: "NOT_RUN" });
    expect(report.failure).toEqual({
      code: "ARTIFACT_MATERIALIZATION_FAILED",
      stage: "NPM_CI",
      reason: "TIMEOUT"
    });
    expect(reportText).not.toContain("不得进入安全报告的原始超时错误");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "choicemind-coremind-compat-test-"))
  );
  temporaryPaths.push(directory);
  return directory;
}
