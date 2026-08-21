import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CoreMindCompatibilityError,
  runCoreMindCandidateAssembly,
  type CoreMindCompatibilityReport
} from "./index.js";
import type { CoreMindArtifactSource } from "./internal-types.js";
import { createSystemArtifactSource } from "./system.js";

export interface CoreMindCompatCliDependencies {
  createArtifactSource(runDirectory: string): CoreMindArtifactSource;
  outputRoot: string;
}

export interface CoreMindCompatCliResult {
  reportPath: string;
}

export class CoreMindCompatCliFailure extends Error {
  readonly reportPath: string;

  constructor(reportPath: string) {
    super("CoreMind 候选装配失败");
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
    const artifactSource = dependencies.createArtifactSource(stagingDirectory);
    const report = await runCoreMindCandidateAssembly(candidate, artifactSource);
    await writeReportAtomically(path.join(stagingDirectory, "report.json"), report);
    const candidateDirectory = path.join(dependencies.outputRoot, `candidate-${runId}`);
    await rename(stagingDirectory, candidateDirectory);
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
      gates: {
        A: compatibilityError.gate === "A" ? "FAILED" : "PASSED",
        B: compatibilityError.gate === "B" ? "FAILED" : "NOT_RUN",
        C: "NOT_RUN",
        D: "NOT_RUN",
        E: "NOT_RUN",
        F: "NOT_RUN",
        G: "NOT_RUN",
        H: "NOT_RUN"
      },
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
      createArtifactSource: (runDirectory) =>
        createSystemArtifactSource({
          artifactDirectory: runDirectory,
          choiceMindRoot,
          signal: cancellation.signal
        }),
      outputRoot: path.join(choiceMindRoot, ".artifacts", "coremind-compat")
    });
    console.log(`CoreMind 候选 Gate A/B 通过：${result.reportPath}`);
  } catch (error) {
    if (error instanceof CoreMindCompatCliFailure) {
      console.error(`CoreMind 候选 Gate A/B 失败；安全报告：${error.reportPath}`);
    } else {
      console.error(error instanceof Error ? error.message : "CoreMind 候选命令失败");
    }
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
