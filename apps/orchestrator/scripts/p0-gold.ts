import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";

import {
  buildSyntheticFoldingTableRunOutput,
  createCategoryPackageRegistry,
  evaluateP0GoldGate,
  type LocalServiceSmokeInputV1,
  type P0GateResultV1,
  syntheticFoldingTableCategory
} from "../../../packages/p0-gold-gate/src/index.js";
import { createDecisionTaskExecutor } from "../src/decision-tasks/executor.js";

export type P0GoldCommandGate = Readonly<{
  gateId:
    | "workspace-prerequisites"
    | "contract-positive-negative"
    | "failure-semantics"
    | "user-isolation"
    | "secret-redaction"
    | "event-replay-recovery";
  command: string;
  args: readonly string[];
}>;

type RunP0GoldGateDependencies = Readonly<{
  now(): Date;
  listCoreModifiedFiles(baselineCommit: string): Promise<readonly string[]>;
  readLocalServiceReport(path: string): Promise<LocalServiceSmokeInputV1>;
  runCommand(gate: P0GoldCommandGate): Promise<Readonly<{ exitCode: number }>>;
}>;

const pnpmCommand =
  process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
const pnpmPrefix =
  process.platform === "win32"
    ? (["/d", "/s", "/c", "pnpm.cmd"] as const)
    : ([] as const);

export const p0GoldCommandGates: readonly P0GoldCommandGate[] = [
  {
    gateId: "workspace-prerequisites",
    command: pnpmCommand,
    args: [
      ...pnpmPrefix,
      "--filter",
      "@choicemind/contracts",
      "--filter",
      "@choicemind/security",
      "--filter",
      "@choicemind/task-persistence",
      "build"
    ]
  },
  {
    gateId: "contract-positive-negative",
    command: pnpmCommand,
    args: [...pnpmPrefix, "--filter", "@choicemind/contracts", "test"]
  },
  {
    gateId: "failure-semantics",
    command: pnpmCommand,
    args: [...pnpmPrefix, "--filter", "@choicemind/orchestrator", "test"]
  },
  {
    gateId: "user-isolation",
    command: pnpmCommand,
    args: [...pnpmPrefix, "--filter", "@choicemind/api", "test"]
  },
  {
    gateId: "secret-redaction",
    command: pnpmCommand,
    args: [...pnpmPrefix, "--filter", "@choicemind/security", "test"]
  },
  {
    gateId: "event-replay-recovery",
    command: pnpmCommand,
    args: [
      ...pnpmPrefix,
      "exec",
      "vitest",
      "run",
      "packages/contracts/src/decision/v1/persisted-run-event.test.ts",
      "packages/contracts/src/decision/v1/runtime-recovery.test.ts",
      "apps/orchestrator/src/runtime/runtime-control.test.ts"
    ]
  }
];

export async function runP0GoldGate(
  input: Readonly<{
    baselineCommit: string;
    localServiceReportPath: string;
  }>,
  dependencies: RunP0GoldGateDependencies
) {
  const gateResults: P0GateResultV1[] = [await runCategoryRuntimeGate()];
  for (const gate of p0GoldCommandGates) {
    const result = await dependencies.runCommand(gate);
    gateResults.push({
      gateId: gate.gateId,
      status: result.exitCode === 0 ? "PASSED" : "FAILED",
      evidence: [
        {
          evidenceId: `command:${gate.gateId}`,
          locator: `${gate.command} ${gate.args.join(" ")}`
        }
      ]
    });
  }
  const [coreModifiedFiles, localServiceReport] = await Promise.all([
    dependencies.listCoreModifiedFiles(input.baselineCommit),
    dependencies.readLocalServiceReport(input.localServiceReportPath)
  ]);
  return evaluateP0GoldGate({
    executedAt: dependencies.now().toISOString(),
    baselineCommit: input.baselineCommit,
    coreModifiedFiles,
    gateResults,
    localServiceReport
  });
}

async function runCategoryRuntimeGate(): Promise<P0GateResultV1> {
  try {
    const registry = createCategoryPackageRegistry();
    registry.register(syntheticFoldingTableCategory);
    const categoryPackage = registry.get("synthetic-folding-table");
    if (categoryPackage === undefined) {
      throw new Error("Category Package 注册失败");
    }
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          return buildSyntheticFoldingTableRunOutput(categoryPackage, command);
        }
      }
    });
    const result = await executor.execute(buildSyntheticFoldingTableCommand());
    const passed =
      result.ok &&
      result.taskStatus.state === "COMPLETED" &&
      result.bundle.decision.status === "BUY_IF_PRICE" &&
      result.bundle.decision.selectedCandidateId === "candidate-synth-table-a";
    return {
      gateId: "category-runtime",
      status: passed ? "PASSED" : "FAILED",
      evidence: [
        {
          evidenceId: "category-runtime:synthetic-folding-table",
          locator: "DecisionTaskExecutor.execute:synthetic-folding-table"
        }
      ]
    };
  } catch {
    return {
      gateId: "category-runtime",
      status: "FAILED",
      evidence: [
        {
          evidenceId: "category-runtime:synthetic-folding-table",
          locator: "DecisionTaskExecutor.execute:synthetic-folding-table"
        }
      ]
    };
  }
}

function buildSyntheticFoldingTableCommand(): ExecuteDecisionTaskCommandV1 {
  return {
    contractType: "execute-decision-task-command",
    contractVersion: "1.0",
    executionRequestId: "exec-p0-gold-synth-folding-table",
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: "req-p0-gold-synth-folding-table-r1",
      decisionTaskId: "task-p0-gold-synth-folding-table",
      revision: 1,
      submittedText: "预算不超过 500 元，桌宽不超过 90 cm，额定承重至少 30 kg。",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["露营用餐"],
      budget: {
        confirmed: true,
        currency: "CNY",
        hard: true,
        maxAmountMinor: 50000
      },
      mustHaves: [
        {
          key: "dimensions.widthCm",
          operator: "AT_MOST",
          value: { amount: 90, unit: "cm" }
        },
        {
          key: "load.ratedKg",
          operator: "AT_LEAST",
          value: { amount: 30, unit: "kg" }
        }
      ],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: []
    }
  };
}
