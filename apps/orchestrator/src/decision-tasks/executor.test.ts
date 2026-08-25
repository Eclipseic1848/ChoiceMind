import { describe, expect, it } from "vitest";

import { createDecisionTaskExecutor } from "./executor.js";
import { createFakeAgentRuntimeAdapter } from "../runtime/fake-agent-runtime-adapter.js";

describe("DecisionTaskExecutor.execute", () => {
  it("produces the fixed reviewable decision for the synthetic laptop requirement", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: createFakeAgentRuntimeAdapter()
    });

    const result = await executor.execute({
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
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
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
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: true,
      taskStatus: {
        state: "COMPLETED",
        decisionRevisionId: "decision-task-synth-laptop-001-r1"
      },
      bundle: {
        candidates: [
          { candidateId: "candidate-synth-a" },
          { candidateId: "candidate-synth-b" }
        ],
        claimEvidenceLinks: expect.arrayContaining([
          expect.objectContaining({
            claimId: "claim-synth-a-price",
            evidenceId: "evidence-synth-a-price",
            direction: "SUPPORTS"
          })
        ]),
        claimAssessments: expect.arrayContaining([
          expect.objectContaining({
            claimId: "claim-synth-a-price",
            evidenceState: "SUPPORTED",
            supportingEvidenceIds: ["evidence-synth-a-price"],
            refutingEvidenceIds: []
          })
        ]),
        decision: {
          status: "BUY_IF_PRICE",
          selectedCandidateId: "candidate-synth-a",
          conditions: [
            { conditionType: "MAX_PRICE", amountMinor: 780000 },
            { conditionType: "OFFICIAL_WARRANTY" }
          ],
          candidateDispositions: [
            { dispositionType: "ELIMINATED", candidateId: "candidate-synth-b" }
          ],
          risks: [{ riskId: "risk-synth-memory-upgradeable" }],
          validUntil: "2026-08-19T12:00:00.000Z"
        },
        evidence: expect.arrayContaining([
          expect.objectContaining({
            synthetic: true,
            source: expect.objectContaining({ sourceKind: "SYNTHETIC" })
          })
        ])
      },
      runEvents: expect.arrayContaining([
        expect.objectContaining({ sequence: 1, taskState: "CREATED" }),
        expect.objectContaining({ sequence: 9, taskState: "COMPLETED" })
      ])
    });
  });

  it("accepts a completed run that skips unperformed stages while preserving order", async () => {
    const sourceRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await sourceRuntime.run(command);
          const created = output.runEvents[0];
          const planning = output.runEvents[2];
          const completed = output.runEvents.at(-1);

          if (created === undefined || planning === undefined || completed === undefined) {
            throw new Error("测试 fixture 必须包含首个、规划和完成事件");
          }

          const sparseOutput = {
            ...output,
            runEvents: [created, planning, completed].map((event, index) => ({
              ...event,
              eventId: `${event.eventId}-sparse`,
              sequence: index + 1,
              eventType:
                index === 2
                  ? ("RUNTIME_SUCCEEDED" as const)
                  : ("TASK_STATE_CHANGED" as const)
            }))
          };

          return sparseOutput;
        }
      }
    });

    const baseCommand = buildRuntimeBoundaryCommand("sparse-success");
    const command = {
      ...baseCommand,
      requirementRevision: {
        ...baseCommand.requirementRevision,
        budget: {
          confirmed: true,
          currency: "CNY" as const,
          hard: true,
          maxAmountMinor: 800000
        },
        mustHaves: [
          {
            key: "memory.capacity",
            operator: "AT_LEAST" as const,
            value: { amount: 32, unit: "GiB" }
          },
          {
            key: "storage.capacity",
            operator: "AT_LEAST" as const,
            value: { amount: 1, unit: "TiB" }
          }
        ]
      }
    };

    const result = await executor.execute(command);

    expect(result).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED", latestEventSequence: 3 },
      runEvents: [
        { sequence: 1, taskState: "CREATED" },
        { sequence: 2, taskState: "PLANNING" },
        { sequence: 3, taskState: "COMPLETED", eventType: "RUNTIME_SUCCEEDED" }
      ]
    });
  });

  it("asks for a preference when multiple Candidates satisfy every hard constraint", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: createFakeAgentRuntimeAdapter()
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-laptop-preference",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-laptop-preference-r1",
        decisionTaskId: "task-synth-laptop-preference",
        revision: 1,
        submittedText: "预算不超过 9000 元，至少 32 GiB 内存和 1 TiB 存储。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 900000
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
      taskStatus: { state: "COMPLETED" },
      bundle: {
        decision: {
          status: "NEED_MORE_INFO",
          candidateDispositions: [],
          risks: [],
          criticalGaps: [
            {
              key: "preference.primary",
              question: "两个候选都满足硬约束，你更看重更低价格还是其他使用偏好？"
            }
          ],
          nextSteps: [
            {
              actionType: "PROVIDE_REQUIREMENT",
              requirementKey: "preference.primary"
            }
          ]
        }
      }
    });

    if (result.ok) {
      expect(result.bundle.decision).not.toHaveProperty("selectedCandidateId");
    }
  });

  it("returns NEED_MORE_INFO when the confirmed budget is missing", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: createFakeAgentRuntimeAdapter()
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-missing-budget",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-missing-budget-r1",
        decisionTaskId: "task-synth-missing-budget",
        revision: 1,
        submittedText: "需要开发用笔记本，至少 32 GiB 内存和 1 TiB 存储，预算待确认。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["软件开发"],
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
        unknowns: ["budget.maxAmountMinor"]
      }
    });

    expect(result).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: {
        decision: {
          status: "NEED_MORE_INFO",
          criticalGaps: [
            {
              key: "budget.maxAmountMinor",
              question: "你的最高预算是多少？"
            }
          ],
          nextSteps: [
            {
              actionType: "PROVIDE_REQUIREMENT",
              requirementKey: "budget.maxAmountMinor",
              instruction: "请补充最高预算后重新执行决策"
            }
          ]
        }
      }
    });

    if (result.ok) {
      expect(result.bundle.decision).not.toHaveProperty("selectedCandidateId");
    }
  });

  it("rejects a NEED_MORE_INFO decision that hides the unknown budget gap", async () => {
    const sourceRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await sourceRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              criticalGaps: [],
              nextSteps: []
            }
          };
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-hidden-budget-gap",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-hidden-budget-gap-r1",
        decisionTaskId: "task-synth-hidden-budget-gap",
        revision: 1,
        submittedText: "预算待确认。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["软件开发"],
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: ["budget.maxAmountMinor"]
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: { code: "AGENT_RUNTIME_FAILED" }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("fails closed when Runtime omits the selected Candidate decisive Evidence from Decision Evidence", async () => {
    const sourceRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await sourceRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              evidenceIds: ["evidence-synth-b-price", "evidence-synth-a-memory-upgradeable"]
            }
          };
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-incomplete-evidence-closure",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-incomplete-evidence-closure-r1",
        decisionTaskId: "task-synth-incomplete-evidence-closure",
        revision: 1,
        submittedText: "预算不超过 8000 元，至少 32 GiB 内存和 1 TiB 存储。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
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
      ok: false,
      taskStatus: { state: "FAILED" },
      error: { code: "AGENT_RUNTIME_FAILED" }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("returns NEED_MORE_INFO when the supplied budget is not confirmed", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: createFakeAgentRuntimeAdapter()
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-unconfirmed-budget",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-unconfirmed-budget-r1",
        decisionTaskId: "task-synth-unconfirmed-budget",
        revision: 1,
        submittedText: "预算可能是 8000 元，但还没有确认。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: false,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 800000
        },
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      ok: true,
      bundle: {
        decision: {
          status: "NEED_MORE_INFO",
          criticalGaps: [expect.objectContaining({ key: "budget.maxAmountMinor" })]
        }
      }
    });
  });

  it("rejects a selected Candidate that is not bounded by the confirmed hard budget", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: createFakeAgentRuntimeAdapter()
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-hard-budget-violation",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-hard-budget-violation-r1",
        decisionTaskId: "task-synth-hard-budget-violation",
        revision: 1,
        submittedText: "硬预算不超过 5000 元。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 500000
        },
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: { code: "AGENT_RUNTIME_FAILED" }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("rejects an over-budget selected Candidate even when a lower future price is proposed", async () => {
    const sourceRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await sourceRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              conditions: output.decision.conditions.map((condition) =>
                condition.conditionType === "MAX_PRICE"
                  ? { ...condition, amountMinor: 500000 }
                  : condition
              )
            }
          };
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-hard-budget-future-price",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-hard-budget-future-price-r1",
        decisionTaskId: "task-synth-hard-budget-future-price",
        revision: 1,
        submittedText: "硬预算不超过 5000 元。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 500000
        },
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: { code: "AGENT_RUNTIME_FAILED" }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("rejects the fixed Runtime decision when the selected Candidate misses a must-have", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: createFakeAgentRuntimeAdapter()
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-memory-64",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-memory-64-r1",
        decisionTaskId: "task-synth-memory-64",
        revision: 1,
        submittedText: "预算不超过 8000 元，内存至少 64 GiB。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
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
            value: { amount: 64, unit: "GiB" }
          }
        ],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: { code: "AGENT_RUNTIME_FAILED" }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("returns a failed task without a decision when the runtime fails", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run() {
          throw new Error("synthetic runtime failure");
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-runtime-failure",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-runtime-failure-r1",
        decisionTaskId: "task-synth-runtime-failure",
        revision: 1,
        submittedText: "运行失败测试",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["测试"],
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      taskStatus: {
        state: "FAILED",
        errorId: "error-synth-runtime-failure"
      },
      error: {
        code: "AGENT_RUNTIME_FAILED",
        category: "RUNTIME",
        retryMode: "NEW_EXECUTION_ALLOWED"
      },
      runEvents: [
        expect.objectContaining({ sequence: 1, taskState: "CREATED" }),
        expect.objectContaining({ sequence: 2, taskState: "FAILED" })
      ]
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("coalesces concurrent retries with the same execution request ID", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    let runtimeExecutions = 0;
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          runtimeExecutions += 1;
          await Promise.resolve();
          return fakeRuntime.run(command);
        }
      }
    });
    const command = {
      contractType: "execute-decision-task-command" as const,
      contractVersion: "1.0" as const,
      executionRequestId: "exec-synth-idempotent",
      requirementRevision: {
        contractType: "requirement-revision" as const,
        contractVersion: "1.0" as const,
        requirementRevisionId: "req-synth-idempotent-r1",
        decisionTaskId: "task-synth-idempotent",
        revision: 1,
        submittedText: "预算不超过 8000 元。",
        market: { country: "CN" as const, currency: "CNY" as const, locale: "zh-CN" as const },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: true,
          currency: "CNY" as const,
          hard: true,
          maxAmountMinor: 800000
        },
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    };

    const [first, second] = await Promise.all([
      executor.execute(command),
      executor.execute(command)
    ]);

    expect(second).toEqual(first);
    expect(runtimeExecutions).toBe(1);
  });

  it("assigns different Agent Run and Decision Revision identities to different tasks", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: createFakeAgentRuntimeAdapter()
    });
    const buildCommand = (suffix: string) => ({
      contractType: "execute-decision-task-command" as const,
      contractVersion: "1.0" as const,
      executionRequestId: `exec-${suffix}`,
      requirementRevision: {
        contractType: "requirement-revision" as const,
        contractVersion: "1.0" as const,
        requirementRevisionId: `req-${suffix}-r1`,
        decisionTaskId: `task-${suffix}`,
        revision: 1,
        submittedText: "预算不超过 8000 元。",
        market: { country: "CN" as const, currency: "CNY" as const, locale: "zh-CN" as const },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: true,
          currency: "CNY" as const,
          hard: true,
          maxAmountMinor: 800000
        },
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    const first = await executor.execute(buildCommand("identity-a"));
    const second = await executor.execute(buildCommand("identity-b"));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.taskStatus.agentRunId).not.toBe(first.taskStatus.agentRunId);
      expect(second.bundle.decision.decisionRevisionId).not.toBe(
        first.bundle.decision.decisionRevisionId
      );
    }
  });

  it("rejects a different command that reuses an execution request ID", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    let runtimeExecutions = 0;
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          runtimeExecutions += 1;
          return fakeRuntime.run(command);
        }
      }
    });
    const command = {
      contractType: "execute-decision-task-command" as const,
      contractVersion: "1.0" as const,
      executionRequestId: "exec-synth-conflict",
      requirementRevision: {
        contractType: "requirement-revision" as const,
        contractVersion: "1.0" as const,
        requirementRevisionId: "req-synth-conflict-r1",
        decisionTaskId: "task-synth-conflict",
        revision: 1,
        submittedText: "预算不超过 8000 元。",
        market: { country: "CN" as const, currency: "CNY" as const, locale: "zh-CN" as const },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: true,
          currency: "CNY" as const,
          hard: true,
          maxAmountMinor: 800000
        },
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    };

    await executor.execute(command);
    const conflict = await executor.execute({
      ...command,
      requirementRevision: {
        ...command.requirementRevision,
        submittedText: "预算不超过 7000 元。"
      }
    });

    expect(conflict).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        code: "CONTRACT_INVALID",
        category: "VALIDATION",
        retryMode: "NONE",
        issues: [
          {
            path: "executionRequestId",
            message: "同一执行标识不能绑定不同命令"
          }
        ]
      }
    });
    expect(conflict).not.toHaveProperty("taskStatus");
    expect(runtimeExecutions).toBe(1);
  });

  it("rejects runtime output whose decision references missing evidence", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              evidenceIds: ["evidence-missing"]
            }
          };
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-invalid-runtime-output",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-invalid-runtime-output-r1",
        decisionTaskId: "task-synth-invalid-runtime-output",
        revision: 1,
        submittedText: "校验 Runtime 产物",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["测试"],
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: ["budget.maxAmountMinor"]
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: {
        code: "AGENT_RUNTIME_FAILED",
        category: "RUNTIME"
      }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("fails closed when Decision Risk belongs to a nonselected Candidate", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              risks: output.decision.risks.map((risk) => ({
                ...risk,
                candidateId: "candidate-synth-b"
              }))
            }
          };
        }
      }
    });
    const baseCommand = buildRuntimeBoundaryCommand("risk-on-nonselected");

    const result = await executor.execute({
      ...baseCommand,
      requirementRevision: {
        ...baseCommand.requirementRevision,
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 800000
        }
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: {
        code: "AGENT_RUNTIME_FAILED",
        category: "RUNTIME",
        retryMode: "NEW_EXECUTION_ALLOWED"
      }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("fails closed when a Decision Risk has no verification next step", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              nextSteps: output.decision.nextSteps.filter(
                (nextStep) =>
                  !(
                    nextStep.actionType === "VERIFY_RISK" &&
                    nextStep.riskId === "risk-synth-memory-upgradeable"
                  )
              )
            }
          };
        }
      }
    });
    const baseCommand = buildRuntimeBoundaryCommand("risk-without-verification");

    const result = await executor.execute({
      ...baseCommand,
      requirementRevision: {
        ...baseCommand.requirementRevision,
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 800000
        }
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: {
        code: "AGENT_RUNTIME_FAILED",
        category: "RUNTIME",
        retryMode: "NEW_EXECUTION_ALLOWED"
      }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("fails closed when the Runtime returns the legacy Decision Risk shape", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              risks: [
                {
                  riskId: "risk-synth-legacy",
                  candidateId: "candidate-synth-a",
                  summary: "模型自由编写的风险事实",
                  impact: "模型自由编写的影响",
                  verification: "由用户核验"
                }
              ]
            }
          } as unknown as typeof output;
        }
      }
    });

    const result = await executor.execute(buildRuntimeBoundaryCommand("legacy-risk"));

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: { code: "AGENT_RUNTIME_FAILED", category: "RUNTIME" }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("fails closed when the Runtime returns the legacy NOT_SELECTED disposition", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              candidateDispositions: [
                {
                  dispositionId: "disposition-synth-legacy",
                  dispositionType: "NOT_SELECTED",
                  candidateId: "candidate-synth-b",
                  reason: "缺少结构化偏好依据",
                  evidenceIds: ["evidence-synth-b-price"]
                }
              ]
            }
          } as unknown as typeof output;
        }
      }
    });

    const result = await executor.execute(buildRuntimeBoundaryCommand("legacy-disposition"));

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: { code: "AGENT_RUNTIME_FAILED", category: "RUNTIME" }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("fails closed when the Runtime returns a Decision status locked in P0-03", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);

          return {
            ...output,
            decision: {
              ...output.decision,
              status: "WAIT" as const
            }
          };
        }
      }
    });

    const baseCommand = buildRuntimeBoundaryCommand("locked-status");
    const result = await executor.execute({
      ...baseCommand,
      requirementRevision: {
        ...baseCommand.requirementRevision,
        budget: {
          confirmed: true,
          currency: "CNY" as const,
          hard: true,
          maxAmountMinor: 800000
        }
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: {
        code: "AGENT_RUNTIME_FAILED",
        category: "RUNTIME",
        retryMode: "NEW_EXECUTION_ALLOWED"
      }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("returns a structured failed task when the runtime output is malformed", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run() {
          return {} as never;
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-malformed-runtime-output",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-malformed-runtime-output-r1",
        decisionTaskId: "task-synth-malformed-runtime-output",
        revision: 1,
        submittedText: "校验畸形 Runtime 产物",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["测试"],
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: {
        code: "AGENT_RUNTIME_FAILED",
        category: "RUNTIME",
        retryMode: "NEW_EXECUTION_ALLOWED"
      }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("ignores a Runtime-authored Claim Assessment and derives the canonical projection", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);

          return {
            ...output,
            claimAssessments: [
              {
                contractType: "claim-assessment",
                contractVersion: "1.0",
                claimId: "claim-synth-a-price",
                evidenceState: "CONFLICTED",
                supportingEvidenceIds: [],
                refutingEvidenceIds: []
              }
            ]
          } as never;
        }
      }
    });

    const result = await executor.execute(buildRuntimeBoundaryCommand("runtime-assessment"));

    expect(result).toMatchObject({
      ok: true,
      bundle: {
        claimAssessments: expect.arrayContaining([
          expect.objectContaining({
            claimId: "claim-synth-a-price",
            evidenceState: "SUPPORTED",
            supportingEvidenceIds: ["evidence-synth-a-price"]
          })
        ])
      }
    });
  });

  it("does not depend on an overridable runtime array method", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);
          const runEvents = [...output.runEvents];
          Object.defineProperty(runEvents, "at", { value: null });

          return { ...output, runEvents } as never;
        }
      }
    });

    const result = await executor.execute(buildRuntimeBoundaryCommand("tampered-array"));

    expect(result).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: { decision: { status: "NEED_MORE_INFO" } }
    });
  });

  it("does not depend on an overridable runtime array traversal method", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);
          const runEvents = [...output.runEvents];
          Object.defineProperty(runEvents, "map", { value: null });

          return { ...output, runEvents } as never;
        }
      }
    });

    const result = await executor.execute(buildRuntimeBoundaryCommand("tampered-array-map"));

    expect(result).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: { decision: { status: "NEED_MORE_INFO" } }
    });
  });

  it("returns a structured failed task when reading runtime output throws", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);
          const runtimeOutput = {
            candidates: output.candidates,
            claims: output.claims,
            evidence: output.evidence,
            decision: output.decision
          };
          Object.defineProperty(runtimeOutput, "runEvents", {
            enumerable: true,
            get() {
              throw new Error("Runtime 产物读取失败");
            }
          });

          return runtimeOutput as never;
        }
      }
    });

    const result = await executor.execute(buildRuntimeBoundaryCommand("throwing-getter"));

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: {
        code: "AGENT_RUNTIME_FAILED",
        category: "RUNTIME",
        retryMode: "NEW_EXECUTION_ALLOWED"
      }
    });
    expect(result).not.toHaveProperty("bundle");
  });

  it("returns a structured failed task when the runtime returns no events", async () => {
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run(command) {
          const output = await fakeRuntime.run(command);
          return { ...output, runEvents: [] };
        }
      }
    });

    const result = await executor.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-synth-empty-events",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-synth-empty-events-r1",
        decisionTaskId: "task-synth-empty-events",
        revision: 1,
        submittedText: "校验空 Runtime 事件",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["测试"],
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      }
    });

    expect(result).toMatchObject({
      ok: false,
      taskStatus: { state: "FAILED" },
      error: { code: "AGENT_RUNTIME_FAILED", category: "RUNTIME" }
    });
    expect(result).not.toHaveProperty("bundle");
  });
});

describe("DecisionTaskExecutor.executePersistent", () => {
  it("把 Runtime 恢复完成结果转换为现有持久任务结果", async () => {
    const command = buildRuntimeBoundaryCommand("persistent-resume");
    const fakeRuntime = createFakeAgentRuntimeAdapter();
    const runtimeOutput = await fakeRuntime.run({
      contractVersion: "1.0",
      decisionTaskId: command.requirementRevision.decisionTaskId,
      agentRunId: "agent-run-persistent-resume",
      requirementRevision: command.requirementRevision
    });
    const executor = createDecisionTaskExecutor({
      runtime: {
        run: fakeRuntime.run,
        async resume() {
          return {
            ok: true,
            changed: true,
            state: "COMPLETED" as const,
            runEvents: runtimeOutput.runEvents,
            outcome: runtimeOutput
          };
        }
      }
    });
    const snapshot = {
      contractType: "runtime-snapshot" as const,
      contractVersion: "1.0" as const,
      snapshotId: "snapshot-persistent-resume",
      decisionTaskId: command.requirementRevision.decisionTaskId,
      agentRunId: "agent-run-persistent-resume",
      taskState: "PAUSED_PERMISSION" as const,
      resumable: true,
      runtimeProtocol: { name: "agent-runtime-protocol" as const, version: "1" as const },
      rawSnapshot: {
        algorithm: "sha256" as const,
        digest: "a".repeat(64),
        objectKey: `runtime-snapshots/sha256/${"a".repeat(64)}`
      },
      checkpoint: {
        contractType: "checkpoint-ref" as const,
        contractVersion: "1.0" as const,
        checkpointId: "checkpoint-persistent-resume",
        decisionTaskId: command.requirementRevision.decisionTaskId,
        agentRunId: "agent-run-persistent-resume",
        sequence: 1,
        persistedAt: "2026-08-24T12:00:00.000Z"
      },
      capturedAt: "2026-08-24T12:00:00.000Z"
    };

    await expect(
      executor.resumePersistent(
        command,
        { snapshot, effectReceipts: [] },
        {
          agentRunId: "agent-run-persistent-resume",
          userId: "owner-1",
          operationId: "control-resume-1",
          correlationId: "correlation-resume-1",
          egressConfirmation: { operationId: "control-resume-1", userId: "owner-1" }
        }
      )
    ).resolves.toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED", terminal: true },
      bundle: { requirementRevision: command.requirementRevision }
    });
  });

  it("保留 Runtime 恢复失败的框架中立错误", async () => {
    const command = buildRuntimeBoundaryCommand("persistent-resume-error");
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run() {
          throw new Error("不应调用 run");
        },
        async resume() {
          return {
            ok: false,
            code: "RUNTIME_SNAPSHOT_INVALID" as const,
            message: "权威 Runtime 快照不合法"
          };
        }
      }
    });

    await expect(
      executor.resumePersistent(
        command,
        {
          snapshot: {
            contractType: "runtime-snapshot",
            contractVersion: "1.0",
            snapshotId: "snapshot-error",
            decisionTaskId: command.requirementRevision.decisionTaskId,
            agentRunId: "agent-run-error",
            taskState: "PAUSED_PERMISSION",
            resumable: true,
            runtimeProtocol: { name: "agent-runtime-protocol", version: "1" },
            rawSnapshot: {
              algorithm: "sha256",
              digest: "b".repeat(64),
              objectKey: `runtime-snapshots/sha256/${"b".repeat(64)}`
            },
            checkpoint: {
              contractType: "checkpoint-ref",
              contractVersion: "1.0",
              checkpointId: "checkpoint-error",
              decisionTaskId: command.requirementRevision.decisionTaskId,
              agentRunId: "agent-run-error",
              sequence: 1,
              persistedAt: "2026-08-24T12:00:00.000Z"
            },
            capturedAt: "2026-08-24T12:00:00.000Z"
          },
          effectReceipts: []
        },
        {
          agentRunId: "agent-run-error",
          userId: "owner-1",
          operationId: "control-error",
          correlationId: "correlation-error",
          egressConfirmation: { operationId: "control-error", userId: "owner-1" }
        }
      )
    ).resolves.toEqual({
      state: "FAILED_FINAL",
      summary: "权威 Runtime 快照不合法",
      runtimeControlError: {
        code: "RUNTIME_SNAPSHOT_INVALID",
        message: "权威 Runtime 快照不合法"
      }
    });
  });

  it("副作用结果需要人工核验时保持暂停并产生结构化公开事件", async () => {
    const command = buildRuntimeBoundaryCommand("persistent-resume-manual");
    const snapshot = {
      contractType: "runtime-snapshot" as const,
      contractVersion: "1.0" as const,
      snapshotId: "snapshot-manual",
      decisionTaskId: command.requirementRevision.decisionTaskId,
      agentRunId: "agent-run-manual",
      taskState: "PAUSED_PERMISSION" as const,
      resumable: true,
      runtimeProtocol: { name: "agent-runtime-protocol" as const, version: "1" as const },
      rawSnapshot: {
        algorithm: "sha256" as const,
        digest: "c".repeat(64),
        objectKey: `runtime-snapshots/sha256/${"c".repeat(64)}`
      },
      checkpoint: {
        contractType: "checkpoint-ref" as const,
        contractVersion: "1.0" as const,
        checkpointId: "checkpoint-manual",
        decisionTaskId: command.requirementRevision.decisionTaskId,
        agentRunId: "agent-run-manual",
        sequence: 1,
        persistedAt: "2026-08-24T12:00:00.000Z"
      },
      capturedAt: "2026-08-24T12:00:00.000Z"
    };
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run() {
          throw new Error("不应调用 run");
        },
        async resume() {
          return {
            ok: false,
            code: "RUNTIME_RESUME_DENIED" as const,
            message: "已提交副作用的权威结果不可用",
            recoveryPermission: {
              contractType: "runtime-recovery-permission" as const,
              contractVersion: "1.0" as const,
              decisionTaskId: snapshot.decisionTaskId,
              agentRunId: snapshot.agentRunId,
              snapshotId: snapshot.snapshotId,
              decision: "MANUAL_VERIFICATION_REQUIRED" as const,
              reason: "EFFECT_RESULT_UNAVAILABLE" as const
            }
          };
        }
      }
    });

    await expect(
      executor.resumePersistent(
        command,
        { snapshot, effectReceipts: [] },
        { agentRunId: snapshot.agentRunId }
      )
    ).resolves.toMatchObject({
      contractType: "runtime-paused-outcome",
      state: "PAUSED_PERMISSION",
      summary: "已提交副作用的权威结果不可用",
      runEvents: [
        {
          eventType: "TASK_STATE_CHANGED",
          taskState: "PAUSED_PERMISSION",
          summary: "已提交副作用的权威结果不可用（EFFECT_RESULT_UNAVAILABLE）"
        }
      ]
    });
  });

  it("把 Runtime 恢复事实持久化故障保留为可重试失败", async () => {
    const executor = createDecisionTaskExecutor({
      runtime: {
        async run() {
          throw new Error("不应调用非持久执行");
        },
        async runPersistent() {
          throw Object.assign(new Error("恢复事实存储不可用"), {
            code: "PERSISTENCE_UNAVAILABLE"
          });
        }
      }
    });

    await expect(
      executor.executePersistent(buildRuntimeBoundaryCommand("recovery-store-down"), {
        agentRunId: "agent-run-recovery-store-down"
      })
    ).resolves.toEqual({
      state: "FAILED_RETRYABLE",
      summary: "Runtime 恢复事实暂时无法持久化"
    });
  });

  it.each([
    ["FAILED_RETRYABLE", "上游暂时不可用，允许重试同一执行"],
    ["FAILED_FINAL", "输入无法形成安全执行"],
    ["PARTIAL", "已形成部分材料，但尚无完整 Decision"]
  ] as const)("preserves an explicit %s Runtime outcome", async (state, summary) => {
    const sourceRuntime = createFakeAgentRuntimeAdapter();
    const executor = createDecisionTaskExecutor({
      runtime: {
        run: (command) => sourceRuntime.run(command),
        async runPersistent() {
          return { state, summary };
        }
      }
    });
    const command = buildRuntimeBoundaryCommand(`persistent-${state.toLowerCase()}`);

    await expect(
      executor.executePersistent(command, {
        agentRunId: `agent-run-persistent-${state.toLowerCase()}`
      })
    ).resolves.toEqual({ state, summary });
  });

  it("重新调用 Runtime 处理同一执行的可重试失败", async () => {
    const sourceRuntime = createFakeAgentRuntimeAdapter();
    let runtimeCalls = 0;
    const executor = createDecisionTaskExecutor({
      runtime: {
        run: (command) => sourceRuntime.run(command),
        async runPersistent() {
          runtimeCalls += 1;

          return runtimeCalls === 1
            ? {
                state: "FAILED_RETRYABLE",
                summary: "上游暂时不可用，允许重试同一执行"
              }
            : {
                state: "FAILED_FINAL",
                summary: "重试后确认无法完成"
              };
        }
      }
    });
    const command = buildRuntimeBoundaryCommand("persistent-retry");
    const context = { agentRunId: "agent-run-persistent-retry" };

    await expect(executor.executePersistent(command, context)).resolves.toMatchObject({
      state: "FAILED_RETRYABLE"
    });
    await expect(executor.executePersistent(command, context)).resolves.toMatchObject({
      state: "FAILED_FINAL"
    });
    expect(runtimeCalls).toBe(2);
  });
});

function buildRuntimeBoundaryCommand(suffix: string) {
  return {
    contractType: "execute-decision-task-command" as const,
    contractVersion: "1.0" as const,
    executionRequestId: `exec-runtime-boundary-${suffix}`,
    requirementRevision: {
      contractType: "requirement-revision" as const,
      contractVersion: "1.0" as const,
      requirementRevisionId: `req-runtime-boundary-${suffix}-r1`,
      decisionTaskId: `task-runtime-boundary-${suffix}`,
      revision: 1,
      submittedText: "校验 Runtime 不可信产物",
      market: { country: "CN" as const, currency: "CNY" as const, locale: "zh-CN" as const },
      intendedUses: ["测试"],
      mustHaves: [],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: []
    }
  };
}
