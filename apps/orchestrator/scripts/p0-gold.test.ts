import { describe, expect, it } from "vitest";

import {
  buildSyntheticFoldingTableRunOutput,
  createCategoryPackageRegistry,
  syntheticFoldingTableCategory
} from "../../../packages/p0-gold-gate/src/index.js";
import { createDecisionTaskExecutor } from "../src/decision-tasks/executor.js";

describe("P0 合成 Category 运行链路", () => {
  it("通过现有 DecisionTaskExecutor 生成合法的折叠露营桌 Decision", async () => {
    const registry = createCategoryPackageRegistry();
    registry.register(syntheticFoldingTableCategory);
    const categoryPackage = registry.get("synthetic-folding-table");
    if (categoryPackage === undefined) {
      throw new Error("测试 Category Package 未注册");
    }
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          return buildSyntheticFoldingTableRunOutput(categoryPackage, command);
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-folding-table-001",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-folding-table-001-r1",
        decisionTaskId: "task-synth-folding-table-001",
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
    });

    expect(result).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: {
        candidates: expect.arrayContaining([
          expect.objectContaining({ candidateId: "candidate-synth-table-a" })
        ]),
        decision: {
          status: "BUY_IF_PRICE",
          selectedCandidateId: "candidate-synth-table-a"
        },
        evidence: expect.arrayContaining([
          expect.objectContaining({
            synthetic: true,
            source: expect.objectContaining({
              sourceKind: "SYNTHETIC",
              sourceId: "source-synth-folding-table"
            })
          })
        ])
      }
    });
  });

  it("缺少桌宽时通过同一链路返回 NEED_MORE_INFO 而不是购买结论", async () => {
    const registry = createCategoryPackageRegistry();
    registry.register(syntheticFoldingTableCategory);
    const categoryPackage = registry.get("synthetic-folding-table");
    if (categoryPackage === undefined) {
      throw new Error("测试 Category Package 未注册");
    }
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          return buildSyntheticFoldingTableRunOutput(categoryPackage, command);
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-folding-table-missing-width",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-folding-table-missing-width-r1",
        decisionTaskId: "task-synth-folding-table-missing-width",
        revision: 1,
        submittedText: "预算不超过 500 元，额定承重至少 30 kg，桌宽还没确定。",
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
            key: "load.ratedKg",
            operator: "AT_LEAST",
            value: { amount: 30, unit: "kg" }
          }
        ],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: ["dimensions.widthCm"]
      }
    });

    if (!result.ok) {
      throw new Error(`合成折叠露营桌反例未通过合同：${JSON.stringify(result.error)}`);
    }

    expect(result).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: {
        decision: {
          status: "NEED_MORE_INFO",
          criticalGaps: [
            expect.objectContaining({ key: "dimensions.widthCm" })
          ],
          nextSteps: [
            expect.objectContaining({
              actionType: "PROVIDE_REQUIREMENT",
              requirementKey: "dimensions.widthCm"
            })
          ]
        }
      }
    });
    expect(result.bundle.decision.selectedCandidateId).toBeUndefined();
  });
});
