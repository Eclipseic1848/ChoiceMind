import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CoreMindCompatibilityError,
  runCoreMindCompatibility,
  type CoreMindCompatibilityReport
} from "./index.js";
import type { CoreMindCompatibilitySystem } from "./internal-types.js";
import { createSystemCompatibilitySystem } from "./system.js";

export interface CoreMindCompatCliDependencies {
  createCompatibilitySystem(runDirectory: string): CoreMindCompatibilitySystem;
  outputRoot: string;
}

export interface CoreMindCompatCliResult {
  reportPath: string;
}

export class CoreMindCompatCliFailure extends Error {
  readonly reportPath: string;

  constructor(reportPath: string) {
    super("CoreMind 候选兼容验证失败");
    this.name = "CoreMindCompatCliFailure";
    this.reportPath = reportPath;
  }
}

export async function runCoreMindCompatCli(
  args: string[],
  dependencies: CoreMindCompatCliDependencies
): Promise<CoreMindCompatCliResult> {
  const candidatePath = parseCandidatePath(args);
  await mkdir(dependencies.outputRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(dependencies.outputRoot, ".staging-"));
  const runId = path.basename(stagingDirectory).slice(".staging-".length);

  try {
    const candidate = await readCandidate(candidatePath);
    const compatibilitySystem = dependencies.createCompatibilitySystem(stagingDirectory);
    const report = await runCoreMindCompatibility(candidate, compatibilitySystem);
    try {
      await writeReportAtomically(path.join(stagingDirectory, "report.json"), report);
    } catch {
      throw new CoreMindCompatibilityError(
        "F",
        "REPORT_WRITE_FAILED",
        "成功报告原子写入失败",
        "REPORT_WRITE"
      );
    }
    const candidateDirectory = path.join(dependencies.outputRoot, `candidate-${runId}`);
    try {
      await rename(stagingDirectory, candidateDirectory);
    } catch {
      throw new CoreMindCompatibilityError(
        "F",
        "ARTIFACT_PROMOTION_FAILED",
        "成功证据原子提升失败",
        "ARTIFACT_PROMOTION"
      );
    }
    return { reportPath: path.join(candidateDirectory, "report.json") };
  } catch (error) {
    await rm(stagingDirectory, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100
    });
    const failureDirectory = path.join(dependencies.outputRoot, `failure-${runId}`);
    await mkdir(failureDirectory, { recursive: true });
    const reportPath = path.join(failureDirectory, "report.json");
    const compatibilityError =
      error instanceof CoreMindCompatibilityError
        ? error
        : new CoreMindCompatibilityError(
            "A",
            "CANDIDATE_INVALID",
            "候选输入读取失败"
          );
    const report = {
      schemaVersion: 1,
      gates: failureGateStates(compatibilityError.gate),
      failure: {
        code: compatibilityError.code,
        ...(compatibilityError.stage === undefined
          ? {}
          : { stage: compatibilityError.stage }),
        ...(compatibilityError.reason === undefined
          ? {}
          : { reason: compatibilityError.reason })
      }
    } satisfies CoreMindCompatibilityReport;
    await writeReportAtomically(reportPath, report);
    throw new CoreMindCompatCliFailure(reportPath);
  }
}

function failureGateStates(
  failedGate: CoreMindCompatibilityError["gate"]
): CoreMindCompatibilityReport["gates"] {
  const orderedGates = ["A", "B", "C", "D", "E", "F"] as const;
  const failedIndex = orderedGates.indexOf(failedGate);
  return {
    A: failedIndex > 0 ? "PASSED" : "FAILED",
    B: failedIndex > 1 ? "PASSED" : failedGate === "B" ? "FAILED" : "NOT_RUN",
    C: failedIndex > 2 ? "PASSED" : failedGate === "C" ? "FAILED" : "NOT_RUN",
    D: failedIndex > 3 ? "PASSED" : failedGate === "D" ? "FAILED" : "NOT_RUN",
    E: failedIndex > 4 ? "PASSED" : failedGate === "E" ? "FAILED" : "NOT_RUN",
    F: failedGate === "F" ? "FAILED" : "NOT_RUN",
    G: "NOT_RUN",
    H: "NOT_RUN"
  };
}

function parseCandidatePath(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--candidate" || !args[1]) {
    throw new Error("用法：pnpm coremind:compat --candidate <versioned-candidate.json>");
  }
  return path.resolve(args[1]);
}

async function readCandidate(candidatePath: string): Promise<unknown> {
  const source = await readFile(candidatePath, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("候选描述不是合法 UTF-8 JSON");
  }
}

async function writeReportAtomically(reportPath: string, report: unknown): Promise<void> {
  const temporaryReportPath = `${reportPath}.tmp`;
  await writeFile(temporaryReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporaryReportPath, reportPath);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const choiceMindRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel);
  try {
    const result = await runCoreMindCompatCli(process.argv.slice(2), {
      createCompatibilitySystem: (runDirectory) =>
        createSystemCompatibilitySystem({
          artifactDirectory: runDirectory,
          choiceMindRoot,
          signal: cancellation.signal
        }),
      outputRoot: path.join(choiceMindRoot, ".artifacts", "coremind-compat")
    });
    console.log(`CoreMind 候选 Gate A-F 离线兼容通过：${result.reportPath}`);
  } catch (error) {
    if (error instanceof CoreMindCompatCliFailure) {
      console.error(`CoreMind 候选兼容验证失败；安全报告：${error.reportPath}`);
    } else {
      console.error(error instanceof Error ? error.message : "CoreMind 候选命令失败");
    }
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
