import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { CoreMindCompatCliFailure, runCoreMindCompatCli } from "./cli.js";
import {
  CoreMindArtifactMaterializationError,
  CoreMindCandidateVerificationError
} from "./internal-types.js";
import { createCompatibilitySystem, createMaterializedCandidate } from "./test-fixtures.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((temporaryPath) =>
      rm(temporaryPath, { force: true, recursive: true })
    )
  );
});

describe("coremind:compat CLI", () => {
  test("从候选 JSON 原子写入 Gate A-F 离线兼容安全报告", async () => {
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
      createCompatibilitySystem: (runDirectory) => createCompatibilitySystem(undefined, runDirectory),
      outputRoot: path.join(root, "output")
    });
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      gates: Record<string, string>;
      artifacts: { packages: unknown[] };
    };

    expect(report.gates).toEqual({
      A: "PASSED",
      B: "PASSED",
      C: "PASSED",
      D: "PASSED",
      E: "PASSED",
      F: "PASSED",
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

  test("Gate C 失败时保留 A/B 通过事实并停止后续 Gate", async () => {
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
    const source = createCompatibilitySystem();
    source.verifyCandidateCompatibility = async () => {
      throw new Error("不得进入报告的候选安装原始错误");
    };

    let failure: CoreMindCompatCliFailure | undefined;
    try {
      await runCoreMindCompatCli(["--candidate", candidatePath], {
        createCompatibilitySystem: () => source,
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
    expect(report.gates).toEqual({
      A: "PASSED",
      B: "PASSED",
      C: "FAILED",
      D: "NOT_RUN",
      E: "NOT_RUN",
      F: "NOT_RUN",
      G: "NOT_RUN",
      H: "NOT_RUN"
    });
    expect(report.failure).toEqual({ code: "COMPATIBILITY_VERIFICATION_FAILED" });
    expect(reportText).not.toContain("候选安装原始错误");
  });

  test.each([
    ["D", "CONTRACT_TEST", { A: "PASSED", B: "PASSED", C: "PASSED", D: "FAILED", E: "NOT_RUN", F: "NOT_RUN" }],
    ["E", "VERTICAL_TEST", { A: "PASSED", B: "PASSED", C: "PASSED", D: "PASSED", E: "FAILED", F: "NOT_RUN" }],
    ["F", "ROOT_VERIFY", { A: "PASSED", B: "PASSED", C: "PASSED", D: "PASSED", E: "PASSED", F: "FAILED" }]
  ] as const)("Gate %s 失败只保留此前通过事实", async (gate, stage, expectedGates) => {
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
    const source = createCompatibilitySystem();
    source.verifyCandidateCompatibility = async () => {
      throw new CoreMindCandidateVerificationError(
        gate,
        stage,
        new Error("不得进入报告的原始验证错误"),
        "COMMAND_FAILED"
      );
    };

    let failure: CoreMindCompatCliFailure | undefined;
    try {
      await runCoreMindCompatCli(["--candidate", candidatePath], {
        createCompatibilitySystem: () => source,
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
    expect(report.gates).toEqual({ ...expectedGates, G: "NOT_RUN", H: "NOT_RUN" });
    expect(report.failure).toEqual({
      code: "COMPATIBILITY_VERIFICATION_FAILED",
      stage,
      reason: "COMMAND_FAILED"
    });
    expect(reportText).not.toContain("原始验证错误");
  });

  test("成功报告原子写入失败时归属 Gate F 而不是候选无效", async () => {
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

    let failure: CoreMindCompatCliFailure | undefined;
    try {
      await runCoreMindCompatCli(["--candidate", candidatePath], {
        createCompatibilitySystem: (runDirectory) => {
          const source = createCompatibilitySystem(undefined, runDirectory);
          const verify = source.verifyCandidateCompatibility;
          source.verifyCandidateCompatibility = async (candidate, environment) => {
            const result = await verify(candidate, environment);
            await mkdir(path.join(runDirectory, "report.json.tmp"));
            return result;
          };
          return source;
        },
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
    expect(report.gates).toMatchObject({
      A: "PASSED",
      B: "PASSED",
      C: "PASSED",
      D: "PASSED",
      E: "PASSED",
      F: "FAILED"
    });
    expect(report.failure).toEqual({
      code: "REPORT_WRITE_FAILED",
      stage: "REPORT_WRITE"
    });
    expect(await readdir(path.dirname(failure.reportPath))).toEqual(["report.json"]);
  });

  test("成功证据原子提升失败时归属 Gate F", async () => {
    const root = await createTemporaryDirectory();
    const outputRoot = path.join(root, "output");
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

    let failure: CoreMindCompatCliFailure | undefined;
    try {
      await runCoreMindCompatCli(["--candidate", candidatePath], {
        createCompatibilitySystem: (runDirectory) => {
          const source = createCompatibilitySystem(undefined, runDirectory);
          const verify = source.verifyCandidateCompatibility;
          source.verifyCandidateCompatibility = async (candidate, environment) => {
            const result = await verify(candidate, environment);
            const runId = path.basename(runDirectory).slice(".staging-".length);
            const conflictingDirectory = path.join(outputRoot, `candidate-${runId}`);
            await mkdir(conflictingDirectory, { recursive: true });
            await writeFile(path.join(conflictingDirectory, "occupied"), "occupied", "utf8");
            return result;
          };
          return source;
        },
        outputRoot
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
    expect(report.gates).toMatchObject({ E: "PASSED", F: "FAILED" });
    expect(report.failure).toEqual({
      code: "ARTIFACT_PROMOTION_FAILED",
      stage: "ARTIFACT_PROMOTION"
    });
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
        createCompatibilitySystem: (runDirectory) =>
          createCompatibilitySystem(materialized, runDirectory),
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
    const source = createCompatibilitySystem();
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
        createCompatibilitySystem: () => source,
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
