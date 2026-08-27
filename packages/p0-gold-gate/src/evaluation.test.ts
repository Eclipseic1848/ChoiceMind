import { describe, expect, it } from "vitest";

import { evaluateP0GoldGate } from "./index.js";

describe("evaluateP0GoldGate", () => {
  it("任一阻断门禁失败时整体失败，不能标记 P0 完成", () => {
    const evaluation = evaluateP0GoldGate({
      executedAt: "2026-08-26T13:00:00.000Z",
      baselineCommit: "90b45d3a31ae8392ac2a0aa96c97e41795c35bee",
      coreModifiedFiles: [],
      gateResults: [
        {
          gateId: "category-runtime",
          status: "PASSED",
          evidence: [{ evidenceId: "category-runtime-test", locator: "vitest:category-runtime" }]
        },
        {
          gateId: "secret-redaction",
          status: "FAILED",
          evidence: [{ evidenceId: "secret-redaction-test", locator: "vitest:secret-redaction" }]
        }
      ],
      localServiceReport: passingSixServiceReport()
    });

    expect(evaluation.report).toMatchObject({
      contractType: "p0-evaluation-report",
      contractVersion: "1.0",
      status: "P0_FAILED",
      blockingFailures: ["secret-redaction"]
    });
    expect(evaluation.report.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateId: "secret-redaction", status: "FAILED" })
      ])
    );
  });

  it("全部阻断门禁通过时生成 P0_PASSED 和机器可读证据索引", () => {
    const evaluation = evaluateP0GoldGate({
      executedAt: "2026-08-26T13:00:00.000Z",
      baselineCommit: "90b45d3a31ae8392ac2a0aa96c97e41795c35bee",
      coreModifiedFiles: [],
      gateResults: [
        {
          gateId: "category-runtime",
          status: "PASSED",
          evidence: [{ evidenceId: "category-runtime-test", locator: "vitest:category-runtime" }]
        },
        {
          gateId: "contract-failure-matrix",
          status: "PASSED",
          evidence: [{ evidenceId: "contract-matrix-test", locator: "vitest:contract-matrix" }]
        }
      ],
      localServiceReport: passingSixServiceReport()
    });

    expect(evaluation.report).toMatchObject({
      status: "P0_PASSED",
      blockingFailures: []
    });
    expect(evaluation.evidenceIndex).toMatchObject({
      contractType: "p0-evidence-index",
      contractVersion: "1.0",
      entries: expect.arrayContaining([
        { evidenceId: "category-runtime-test", gateId: "category-runtime", locator: "vitest:category-runtime" },
        {
          evidenceId: "local-service:choicemind-html-parser",
          gateId: "local-service-contracts",
          locator: "local-service-smoke:choicemind-html-parser"
        }
      ])
    });
    expect(new Set(evaluation.evidenceIndex.entries.map((entry) => entry.evidenceId)).size).toBe(
      evaluation.evidenceIndex.entries.length
    );
  });

  it("旧五服务报告不能通过当前六服务门禁，并明确索引缺失项", () => {
    const report = passingSixServiceReport();
    const evaluation = evaluateP0GoldGate({
      executedAt: "2026-08-26T13:00:00.000Z",
      baselineCommit: "90b45d3a31ae8392ac2a0aa96c97e41795c35bee",
      coreModifiedFiles: [],
      gateResults: [],
      localServiceReport: {
        ...report,
        services: report.services.filter(
          (service) => service.serviceId !== "choicemind-html-parser"
        )
      }
    });

    expect(evaluation.report).toMatchObject({
      status: "P0_FAILED",
      blockingFailures: ["local-service-contracts"]
    });
    expect(evaluation.evidenceIndex.entries).toContainEqual({
      evidenceId: "local-service:choicemind-html-parser:missing",
      gateId: "local-service-contracts",
      locator: "local-service-smoke:missing:choicemind-html-parser"
    });
  });

  it("拒绝顶层伪成功但包含重复失败服务的矛盾报告", () => {
    const report = passingSixServiceReport();
    const evaluation = evaluateP0GoldGate({
      executedAt: "2026-08-26T13:00:00.000Z",
      baselineCommit: "90b45d3a31ae8392ac2a0aa96c97e41795c35bee",
      coreModifiedFiles: [],
      gateResults: [],
      localServiceReport: {
        ...report,
        services: [
          ...report.services,
          { serviceId: "qwen-model", status: "SMOKE_FAILED" }
        ]
      }
    });

    expect(evaluation.report).toMatchObject({
      status: "P0_FAILED",
      blockingFailures: ["local-service-contracts"]
    });
  });
});

function passingSixServiceReport() {
  return {
    contractType: "local-service-smoke-report" as const,
    contractVersion: "1.0" as const,
    status: "SMOKE_PASSED" as const,
    executedAt: "2026-08-26T12:55:00.000Z",
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
