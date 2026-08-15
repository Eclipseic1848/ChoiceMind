import { describe, expect, it } from "vitest";

import { decodeExecuteDecisionTaskCommandV1 } from "./index.js";

describe("decodeExecuteDecisionTaskCommandV1", () => {
  it("accepts a complete version 1 decision command", () => {
    const result = decodeExecuteDecisionTaskCommandV1({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-laptop-001",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-laptop-001-r1",
        decisionTaskId: "task-synth-laptop-001",
        revision: 1,
        submittedText: "预算不超过 8000 元，至少 32 GiB 内存和 1 TiB 存储。",
        market: {
          country: "CN",
          currency: "CNY",
          locale: "zh-CN"
        },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 800000
        },
        mustHaves: [
          {
            key: "memory.capacity",
            operator: "AT_LEAST",
            value: { amount: 32, unit: "GiB" }
          },
          {
            key: "storage.capacity",
            operator: "AT_LEAST",
            value: { amount: 1, unit: "TiB" }
          }
        ],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        executionRequestId: "exec-synth-laptop-001",
        requirementRevision: {
          budget: { maxAmountMinor: 800000 },
          requirementRevisionId: "req-synth-laptop-001-r1"
        }
      }
    });
  });

  it("rejects duplicate must-have keys", () => {
    const result = decodeExecuteDecisionTaskCommandV1({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-duplicate-must-have",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-duplicate-must-have-r1",
        decisionTaskId: "task-duplicate-must-have",
        revision: 1,
        submittedText: "至少 32 GiB 内存。",
        market: {
          country: "CN",
          currency: "CNY",
          locale: "zh-CN"
        },
        intendedUses: ["软件开发"],
        mustHaves: [
          {
            key: "memory.capacity",
            operator: "AT_LEAST",
            value: { amount: 32, unit: "GiB" }
          },
          {
            key: "memory.capacity",
            operator: "AT_LEAST",
            value: { amount: 64, unit: "GiB" }
          }
        ],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          path: "requirementRevision.mustHaves.1.key",
          message: "must-have key 在 Requirement Revision 中必须唯一"
        }
      ]),
      ok: false
    });
  });

  it("rejects an unsupported nested requirement contract version explicitly", () => {
    const result = decodeExecuteDecisionTaskCommandV1({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-version-test",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "2.0"
      }
    });

    expect(result).toMatchObject({
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [
        {
          path: "requirementRevision.contractVersion"
        }
      ],
      ok: false
    });
  });

  it("reports an invalid budget amount with a stable field path", () => {
    const result = decodeExecuteDecisionTaskCommandV1({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-invalid-budget",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: "800000"
        }
      }
    });

    expect(result).toMatchObject({
      code: "CONTRACT_INVALID",
      issues: expect.arrayContaining([
        {
          message: "金额必须是非负整数人民币分",
          path: "requirementRevision.budget.maxAmountMinor"
        }
      ]),
      ok: false
    });
  });
});
