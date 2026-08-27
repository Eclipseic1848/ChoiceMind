import { describe, expect, it } from "vitest";

import { p0GoldCommandGates, runP0GoldGate } from "./p0-gold.js";

describe("runP0GoldGate", () => {
  it.runIf(process.platform === "win32")(
    "Windows 通过显式系统命令入口启动固定 pnpm 参数，不拼接命令字符串",
    () => {
      const commandInterpreter = process.env.ComSpec ?? "cmd.exe";
      expect(
        p0GoldCommandGates.every(
          (gate) =>
            gate.command === commandInterpreter &&
            JSON.stringify(gate.args.slice(0, 4)) ===
              JSON.stringify(["/d", "/s", "/c", "pnpm.cmd"])
        )
      ).toBe(true);
    }
  );

  it("统一执行全部 Gold Set 门禁并把任一命令失败传播为整体失败", async () => {
    const executedGateIds: string[] = [];
    const evaluation = await runP0GoldGate(
      {
        baselineCommit: "90b45d3a31ae8392ac2a0aa96c97e41795c35bee",
        localServiceReportPath: "fixture://six-services"
      },
      {
        now: () => new Date("2026-08-26T14:00:00.000Z"),
        listCoreModifiedFiles: async () => [],
        readLocalServiceReport: async () => passingSixServiceReport(),
        runCommand: async (gate) => {
          executedGateIds.push(gate.gateId);
          return { exitCode: gate.gateId === "secret-redaction" ? 1 : 0 };
        }
      }
    );

    expect(executedGateIds).toEqual([
      "workspace-prerequisites",
      "contract-positive-negative",
      "failure-semantics",
      "user-isolation",
      "secret-redaction",
      "event-replay-recovery"
    ]);
    expect(evaluation.report).toMatchObject({
      status: "P0_FAILED",
      blockingFailures: ["secret-redaction"]
    });
    expect(evaluation.report.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateId: "category-runtime", status: "PASSED" }),
        expect.objectContaining({ gateId: "secret-redaction", status: "FAILED" })
      ])
    );
  });
});

function passingSixServiceReport() {
  return {
    contractType: "local-service-smoke-report" as const,
    contractVersion: "1.0" as const,
    status: "SMOKE_PASSED" as const,
    executedAt: "2026-08-26T13:55:00.000Z",
    services: [
      "qwen-model",
      "qwen-embedding",
      "qwen-reranker",
      "paddleocr-vl",
      "mineru",
      "choicemind-html-parser"
    ].map((serviceId) => ({ serviceId, status: "SMOKE_PASSED" as const }))
  };
}
