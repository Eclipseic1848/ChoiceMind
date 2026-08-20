import { describe, expect, it } from "vitest";

import { createAgentRuntimeAdapter } from "./agent-runtime-factory.js";
import { createDecisionTaskExecutor } from "../decision-tasks/executor.js";

describe("Agent Runtime factory", () => {
  it("keeps Fake as the default runtime", async () => {
    const result = await createDecisionTaskExecutor({
      runtime: createAgentRuntimeAdapter({ env: {} })
    }).execute(buildFactoryCommand("factory-default-fake"));

    expect(result).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: { decision: { status: "BUY_IF_PRICE" } }
    });
  });

  it("requires a complete explicit CoreMind provider configuration", () => {
    expect(() =>
      createAgentRuntimeAdapter({
        env: { CHOICEMIND_RUNTIME: "coremind" }
      })
    ).toThrow("CHOICEMIND_COREMIND_PROVIDER_BASE_URL");

    expect(() =>
      createAgentRuntimeAdapter({
        env: {
          CHOICEMIND_RUNTIME: "coremind",
          CHOICEMIND_COREMIND_PROVIDER_BASE_URL: "http://127.0.0.1:1234/v1"
        }
      })
    ).toThrow("CHOICEMIND_COREMIND_MODEL");
  });

  it("fails closed for an unknown runtime instead of silently selecting Fake", () => {
    expect(() =>
      createAgentRuntimeAdapter({ env: { CHOICEMIND_RUNTIME: "unknown" } })
    ).toThrow("未知 CHOICEMIND_RUNTIME");
  });
});

function buildFactoryCommand(executionRequestId: string) {
  return {
    contractType: "execute-decision-task-command" as const,
    contractVersion: "1.0" as const,
    executionRequestId,
    requirementRevision: {
      contractType: "requirement-revision" as const,
      contractVersion: "1.0" as const,
      requirementRevisionId: `req-${executionRequestId}-r1`,
      decisionTaskId: `task-${executionRequestId}`,
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
}
