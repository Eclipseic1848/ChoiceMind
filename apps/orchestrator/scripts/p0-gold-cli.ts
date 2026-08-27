import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  type LocalServiceSmokeInputV1,
  saveP0GoldArtifacts
} from "../../../packages/p0-gold-gate/src/index.js";
import { runP0GoldGate, type P0GoldCommandGate } from "./p0-gold.js";

type P0GoldArguments = Readonly<{
  baselineRef: string;
  localServiceReportPath: string;
  outputDirectory: string;
}>;

const execFileAsync = promisify(execFile);
const corePaths = [
  "apps/api/src",
  "apps/orchestrator/src",
  "packages/contracts/src",
  "packages/evidence-ingestion/src",
  "packages/local-services/src",
  "packages/security/src",
  "packages/task-persistence/src"
] as const;

export function parseP0GoldArguments(argv: readonly string[]): P0GoldArguments {
  let baselineRef = "origin/main";
  let localServiceReportPath: string | undefined;
  let outputDirectory = ".artifacts/p0-gold";
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "") {
      throw new Error(`P0_GOLD_ARGUMENT_INVALID: ${option ?? "未知参数"} 缺少值`);
    }
    if (option === "--baseline") {
      baselineRef = value;
    } else if (option === "--local-service-report") {
      localServiceReportPath = value;
    } else if (option === "--output-dir") {
      outputDirectory = value;
    } else {
      throw new Error(`P0_GOLD_ARGUMENT_INVALID: 未知参数 ${option}`);
    }
  }
  if (localServiceReportPath === undefined) {
    throw new Error("P0_GOLD_ARGUMENT_INVALID: 缺少 --local-service-report");
  }
  return { baselineRef, localServiceReportPath, outputDirectory };
}

async function main(): Promise<void> {
  const options = parseP0GoldArguments(process.argv.slice(2));
  const baselineCommit = await resolveGitRef(options.baselineRef);
  const evaluation = await runP0GoldGate(
    {
      baselineCommit,
      localServiceReportPath: options.localServiceReportPath
    },
    {
      now: () => new Date(),
      listCoreModifiedFiles,
      readLocalServiceReport,
      runCommand
    }
  );
  await saveP0GoldArtifacts(options.outputDirectory, evaluation);
  process.stdout.write(`${JSON.stringify(evaluation.report, null, 2)}\n`);
  if (evaluation.report.status !== "P0_PASSED") {
    process.exitCode = 1;
  }
}

async function resolveGitRef(reference: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", reference], {
    encoding: "utf8"
  });
  return stdout.trim();
}

async function listCoreModifiedFiles(
  baselineCommit: string
): Promise<readonly string[]> {
  const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
    execFileAsync(
      "git",
      ["diff", "--name-only", baselineCommit, "--", ...corePaths],
      { encoding: "utf8" }
    ),
    execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", ...corePaths],
      { encoding: "utf8" }
    )
  ]);
  return [...new Set([...splitLines(tracked), ...splitLines(untracked)])].sort();
}

async function readLocalServiceReport(
  reportPath: string
): Promise<LocalServiceSmokeInputV1> {
  const value: unknown = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    !isRecord(value) ||
    value.contractType !== "local-service-smoke-report" ||
    value.contractVersion !== "1.0" ||
    (value.status !== "SMOKE_PASSED" && value.status !== "SMOKE_FAILED") ||
    typeof value.executedAt !== "string" ||
    !Array.isArray(value.services)
  ) {
    throw new Error("P0_GOLD_LOCAL_SERVICE_REPORT_INVALID");
  }
  const services = value.services.map((service) => {
    const serviceId = isRecord(service) ? service.serviceId : undefined;
    if (typeof serviceId !== "string") {
      throw new Error("P0_GOLD_LOCAL_SERVICE_REPORT_INVALID");
    }
    return {
      serviceId,
      status: decodeServiceStatus(isRecord(service) ? service.status : undefined)
    };
  });
  return {
    contractType: "local-service-smoke-report",
    contractVersion: "1.0",
    status: value.status,
    executedAt: value.executedAt,
    services
  };
}

function runCommand(gate: P0GoldCommandGate): Promise<Readonly<{ exitCode: number }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(gate.command, [...gate.args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: false
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
}

function splitLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeServiceStatus(
  value: unknown
): "SMOKE_PASSED" | "SMOKE_FAILED" {
  if (value === "SMOKE_PASSED" || value === "SMOKE_FAILED") {
    return value;
  }
  throw new Error("P0_GOLD_LOCAL_SERVICE_REPORT_INVALID");
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "P0 Gold Gate 执行失败";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
