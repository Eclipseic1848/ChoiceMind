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
  test("显式 registry 规范化后交给兼容系统", async () => {
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
    let observedRegistry: string | undefined;

    await runCoreMindCompatCli(
      ["--candidate", candidatePath, "--registry", "https://registry.npmmirror.com"],
      {
        createCompatibilitySystem: (runDirectory, _materializationDirectory, registry) => {
          observedRegistry = registry;
          return createCompatibilitySystem(undefined, runDirectory);
        },
        outputRoot: path.join(root, "output")
      }
    );

    expect(observedRegistry).toBe("https://registry.npmmirror.com/");
  });

  test("显式本地 Qwen 门只把冻结的 Gate G 配置交给兼容系统", async () => {
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
    let observedGateG:
      | Readonly<{ providerBaseUrl: string; model: string }>
      | undefined;

    const result = await runCoreMindCompatCli(
      ["--candidate", candidatePath, "--gate-g-local-qwen"],
      {
        createCompatibilitySystem: (
          runDirectory,
          _materializationDirectory,
          _registry,
          gateG
        ) => {
          observedGateG = gateG;
          const system = createCompatibilitySystem(undefined, runDirectory);
          system.verifyCandidateCompatibility = async (candidate) => ({
            resolvedRuntimePackages: candidate.packages
              .filter((artifact) => !["coremind-worker", "coremind-cli"].includes(artifact.name))
              .map((artifact) => ({ name: artifact.name, version: artifact.version })),
            testCounts: { D: 1, E: 2 },
            localModelSmoke: {
              endpoint: "http://192.168.121.32:6013/v1",
              model: "Qwen3.8-27B",
              executedAt: "2026-08-23T20:00:00.000Z",
              evidenceNonce: "test-evidence-nonce",
              synthetic: true,
              scope: "INTEGRATION_SMOKE_ONLY",
              requestCount: 2,
              toolName: "submit_decision_draft",
              decisionStatus: "NEED_MORE_INFO"
            }
          });
          return system;
        },
        outputRoot: path.join(root, "output")
      }
    );
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      gates: Record<string, string>;
      verification: { localModelSmoke: Record<string, unknown> };
    };

    expect(observedGateG).toEqual({
      providerBaseUrl: "http://192.168.121.32:6013/v1",
      model: "Qwen3.8-27B"
    });
    expect(report.gates.G).toBe("PASSED");
    expect(report.verification.localModelSmoke).toEqual({
      endpoint: "http://192.168.121.32:6013/v1",
      model: "Qwen3.8-27B",
      executedAt: "2026-08-23T20:00:00.000Z",
      evidenceNonce: "test-evidence-nonce",
      synthetic: true,
      scope: "INTEGRATION_SMOKE_ONLY",
      requestCount: 2,
      toolName: "submit_decision_draft",
      decisionStatus: "NEED_MORE_INFO"
    });
    expect(result.highestPassedGate).toBe("G");
  });

  test.each([
    ["未批准主机", "https://registry.example.com/"],
    ["路径型秘密", "https://registry.npmmirror.com/private-token/"],
    ["非根路径", "https://registry.npmjs.org/npm/"]
  ])("registry URL 含%s时在创建兼容系统前拒绝", async (_case, registry) => {
    const root = await createTemporaryDirectory();
    let systemCreated = false;

    await expect(
      runCoreMindCompatCli(["--candidate", "candidate.json", "--registry", registry], {
        createCompatibilitySystem: () => {
          systemCreated = true;
          return createCompatibilitySystem();
        },
        outputRoot: path.join(root, "output")
      })
    ).rejects.toThrow("registry URL 不在允许列表中");

    expect(systemCreated).toBe(false);
  });

  test("registry URL 含凭据时在创建兼容系统前拒绝", async () => {
    const root = await createTemporaryDirectory();
    let systemCreated = false;

    await expect(
      runCoreMindCompatCli(
        [
          "--candidate",
          "candidate.json",
          "--registry",
          "https://build-user:private-token@registry.example.com/"
        ],
        {
          createCompatibilitySystem: () => {
            systemCreated = true;
            return createCompatibilitySystem();
          },
          outputRoot: path.join(root, "output")
        }
      )
    ).rejects.toThrow("registry URL 不得包含凭据");

    expect(systemCreated).toBe(false);
  });

  test("registry URL 使用非 HTTPS 协议时拒绝", async () => {
    const root = await createTemporaryDirectory();
    await expect(
      runCoreMindCompatCli(
        ["--candidate", "candidate.json", "--registry", "http://registry.example.com/"],
        {
          createCompatibilitySystem: () => createCompatibilitySystem(),
          outputRoot: path.join(root, "output")
        }
      )
    ).rejects.toThrow("registry URL 必须使用 HTTPS");
  });

  test("registry URL 含查询参数时拒绝", async () => {
    const root = await createTemporaryDirectory();
    await expect(
      runCoreMindCompatCli(
        [
          "--candidate",
          "candidate.json",
          "--registry",
          "https://registry.example.com/?token=private"
        ],
        {
          createCompatibilitySystem: () => createCompatibilitySystem(),
          outputRoot: path.join(root, "output")
        }
      )
    ).rejects.toThrow("registry URL 不得包含查询参数");
  });

  test("registry URL 含片段时拒绝", async () => {
    const root = await createTemporaryDirectory();
    await expect(
      runCoreMindCompatCli(
        [
          "--candidate",
          "candidate.json",
          "--registry",
          "https://registry.example.com/#private-token"
        ],
        {
          createCompatibilitySystem: () => createCompatibilitySystem(),
          outputRoot: path.join(root, "output")
        }
      )
    ).rejects.toThrow("registry URL 不得包含片段");
  });

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
    expect(result.highestPassedGate).toBe("F");
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

  test("Gate G 失败时保留 A-F 通过事实并脱敏", async () => {
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
        "G",
        "LOCAL_MODEL_SMOKE",
        new Error("不得进入报告的模型原始响应"),
        "COMMAND_FAILED"
      );
    };

    let failure: CoreMindCompatCliFailure | undefined;
    try {
      await runCoreMindCompatCli(["--candidate", candidatePath, "--gate-g-local-qwen"], {
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
      C: "PASSED",
      D: "PASSED",
      E: "PASSED",
      F: "PASSED",
      G: "FAILED",
      H: "NOT_RUN"
    });
    expect(report.failure).toEqual({
      code: "COMPATIBILITY_VERIFICATION_FAILED",
      stage: "LOCAL_MODEL_SMOKE",
      reason: "COMMAND_FAILED"
    });
    expect(reportText).not.toContain("模型原始响应");
  });

  test("Gate C 失败报告仍记录规范化的依赖 registry", async () => {
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
    const source = Object.assign(createCompatibilitySystem(), {
      compatibilityPolicy: {
        dependencyRegistry: "https://registry.npmmirror.com/",
        dependencyFetch: {
          fetchRetries: 5,
          installConcurrency: 1,
          networkConcurrency: 1
        },
        materializationConcurrency: 4,
        stageTimeouts: {
          CANDIDATE_INSTALL: { hardDeadlineMs: 12_345, idleTimeoutMs: 2_345 }
        }
      }
    });
    source.verifyCandidateCompatibility = async () => {
      throw new CoreMindCandidateVerificationError(
        "C",
        "CANDIDATE_INSTALL",
        new Error("不得进入报告的原始 registry 错误"),
        "COMMAND_FAILED"
      );
    };

    let failure: CoreMindCompatCliFailure | undefined;
    try {
      await runCoreMindCompatCli(
        ["--candidate", candidatePath, "--registry", "https://registry.npmmirror.com"],
        {
          createCompatibilitySystem: () => source,
          outputRoot: path.join(root, "output")
        }
      );
    } catch (error) {
      if (error instanceof CoreMindCompatCliFailure) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    if (!failure) return;
    const reportText = await readFile(failure.reportPath, "utf8");
    const report = JSON.parse(reportText) as {
      compatibilityPolicy?: {
        dependencyRegistry?: string;
        dependencyFetch?: {
          fetchRetries?: number;
          installConcurrency?: number;
          networkConcurrency?: number;
        };
        materializationConcurrency?: number;
        stageTimeouts?: Record<string, { hardDeadlineMs: number; idleTimeoutMs: number }>;
      };
    };
    expect(report.compatibilityPolicy).toEqual({
      dependencyRegistry: "https://registry.npmmirror.com/",
      dependencyFetch: {
        fetchRetries: 5,
        installConcurrency: 1,
        networkConcurrency: 1
      },
      materializationConcurrency: 4,
      stageTimeouts: {
        CANDIDATE_INSTALL: { hardDeadlineMs: 12_345, idleTimeoutMs: 2_345 }
      }
    });
    expect(reportText).not.toContain("原始 registry 错误");
  });

  test("候选读取失败仍记录系统的完整兼容策略", async () => {
    const root = await createTemporaryDirectory();
    const source = Object.assign(createCompatibilitySystem(), {
      compatibilityPolicy: {
        dependencyRegistry: "https://registry.npmjs.org/",
        dependencyFetch: {
          fetchRetries: 5,
          installConcurrency: 1,
          networkConcurrency: 1
        },
        materializationConcurrency: 3,
        stageTimeouts: {
          GIT_FETCH: { hardDeadlineMs: 9_000, idleTimeoutMs: 3_000 }
        }
      }
    });
    let failure: CoreMindCompatCliFailure | undefined;

    try {
      await runCoreMindCompatCli(["--candidate", path.join(root, "missing.json")], {
        createCompatibilitySystem: () => source,
        outputRoot: path.join(root, "output")
      });
    } catch (error) {
      if (error instanceof CoreMindCompatCliFailure) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    if (!failure) return;
    const report = JSON.parse(await readFile(failure.reportPath, "utf8")) as {
      compatibilityPolicy?: unknown;
    };
    expect(report.compatibilityPolicy).toEqual(source.compatibilityPolicy);
  });

  test("staging 清理失败不掩盖主失败且仍生成安全报告", async () => {
    const root = await createTemporaryDirectory();
    const candidatePath = path.join(root, "candidate.json");
    await writeFile(candidatePath, "null\n", "utf8");
    let failure: CoreMindCompatCliFailure | undefined;

    try {
      await runCoreMindCompatCli(["--candidate", candidatePath], {
        createCompatibilitySystem: () => createCompatibilitySystem(),
        outputRoot: path.join(root, "output"),
        removeDirectory: async () => {
          throw Object.assign(new Error("不得进入报告的原始清理错误"), { code: "EPERM" });
        }
      });
    } catch (error) {
      if (error instanceof CoreMindCompatCliFailure) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    if (!failure) return;
    const reportText = await readFile(failure.reportPath, "utf8");
    const report = JSON.parse(reportText) as {
      failure?: { code?: string; cleanupFailure?: unknown };
    };
    expect(report.failure).toMatchObject({
      code: "CANDIDATE_INVALID",
      cleanupFailure: { stage: "CLEANUP", reason: "PERMISSION_DENIED" }
    });
    expect(reportText).not.toContain("原始清理错误");
  });

  test("主流程与 staging 的清理失败会分别记录", async () => {
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
        "C",
        "CANDIDATE_INSTALL",
        new Error("主流程失败"),
        "COMMAND_FAILED",
        undefined,
        { stage: "CLEANUP", reason: "CLEANUP_FAILED" }
      );
    };
    let failure: CoreMindCompatCliFailure | undefined;

    try {
      await runCoreMindCompatCli(["--candidate", candidatePath], {
        createCompatibilitySystem: () => source,
        outputRoot: path.join(root, "output"),
        removeDirectory: async () => {
          throw Object.assign(new Error("staging 清理失败"), { code: "EPERM" });
        }
      });
    } catch (error) {
      if (error instanceof CoreMindCompatCliFailure) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    if (!failure) return;
    const report = JSON.parse(await readFile(failure.reportPath, "utf8")) as {
      failure?: { cleanupFailures?: unknown };
    };
    expect(report.failure?.cleanupFailures).toEqual([
      { stage: "CLEANUP", reason: "CLEANUP_FAILED" },
      { stage: "CLEANUP", reason: "PERMISSION_DENIED" }
    ]);
  });

  test.each([
    ["C", "DEPENDENCY_RESOLUTION", { A: "PASSED", B: "PASSED", C: "FAILED", D: "NOT_RUN", E: "NOT_RUN", F: "NOT_RUN" }, "CONTENT_MISMATCH", { packageName: "coremind-ai" }],
    ["C", "CANDIDATE_INSTALL", { A: "PASSED", B: "PASSED", C: "FAILED", D: "NOT_RUN", E: "NOT_RUN", F: "NOT_RUN" }, "NETWORK_FAILED", { diagnosticCodes: ["ERR_PNPM_META_FETCH_FAIL"] }],
    ["D", "CONTRACT_TEST", { A: "PASSED", B: "PASSED", C: "PASSED", D: "FAILED", E: "NOT_RUN", F: "NOT_RUN" }, "COMMAND_FAILED", { verificationStep: "COREMIND_ADAPTER_CONTRACT" }],
    ["E", "VERTICAL_TEST", { A: "PASSED", B: "PASSED", C: "PASSED", D: "PASSED", E: "FAILED", F: "NOT_RUN" }, "COMMAND_FAILED", { verificationStep: "VERTICAL_HTTP" }],
    ["F", "ROOT_VERIFY", { A: "PASSED", B: "PASSED", C: "PASSED", D: "PASSED", E: "PASSED", F: "FAILED" }, "COMMAND_FAILED", { verificationStep: "ROOT_VERIFY" }]
  ] as const)("Gate %s 失败只保留此前通过事实", async (gate, stage, expectedGates, reason, subject) => {
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
        reason,
        undefined,
        undefined,
        undefined,
        subject
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
      reason,
      ...(subject === undefined ? {} : { subject })
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

  test("Gate G 已通过后报告写入失败仍保留 A-G 通过事实", async () => {
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
      await runCoreMindCompatCli(["--candidate", candidatePath, "--gate-g-local-qwen"], {
        createCompatibilitySystem: (runDirectory) => {
          const source = createCompatibilitySystem(undefined, runDirectory);
          source.verifyCandidateCompatibility = async (candidate) => {
            await mkdir(path.join(runDirectory, "report.json.tmp"));
            return {
              resolvedRuntimePackages: candidate.packages
                .filter((artifact) => !["coremind-worker", "coremind-cli"].includes(artifact.name))
                .map((artifact) => ({ name: artifact.name, version: artifact.version })),
              testCounts: { D: 1, E: 2 },
              localModelSmoke: {
                endpoint: "http://192.168.121.32:6013/v1",
                model: "Qwen3.8-27B",
                executedAt: "2026-08-23T20:00:00.000Z",
                evidenceNonce: "test-evidence-nonce",
                synthetic: true,
                scope: "INTEGRATION_SMOKE_ONLY",
                requestCount: 2,
                toolName: "submit_decision_draft",
                decisionStatus: "NEED_MORE_INFO"
              }
            };
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
    expect(report.gates).toEqual({
      A: "PASSED",
      B: "PASSED",
      C: "PASSED",
      D: "PASSED",
      E: "PASSED",
      F: "PASSED",
      G: "PASSED",
      H: "NOT_RUN"
    });
    expect(report.failure).toEqual({ code: "REPORT_WRITE_FAILED", stage: "REPORT_WRITE" });
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
        "TIMEOUT",
        {
          elapsedMs: 600_000,
          observedProgressEvents: 42,
          cacheBytes: 1024,
          cacheFileCount: 8,
          lastProgressAgeMs: 500
        }
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
      reason: "TIMEOUT",
      progress: {
        elapsedMs: 600_000,
        observedProgressEvents: 42,
        cacheBytes: 1024,
        cacheFileCount: 8,
        lastProgressAgeMs: 500
      }
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
