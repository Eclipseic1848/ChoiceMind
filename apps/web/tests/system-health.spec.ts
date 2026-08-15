import { createServer, type Server } from "node:http";

import { expect, test } from "@playwright/test";

let apiServer: Server;
let decisionResponseStatus = 200;

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  decisionResponseStatus = 200;
});

test.beforeAll(async () => {
  apiServer = createServer((request, response) => {
    if (request.url === "/api/v1/system/health") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          checkedAt: "2026-08-12T20:40:00.000Z",
          components: [
            { service: "web", status: "healthy", latencyMs: 3 },
            { service: "api", status: "healthy", latencyMs: 0 },
            { service: "orchestrator", status: "healthy", latencyMs: 6 },
            { service: "data-worker", status: "healthy", latencyMs: 9 }
          ],
          status: "healthy"
        })
      );
      return;
    }

    if (request.url === "/api/v1/decision-tasks:execute" && request.method === "POST") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.statusCode = decisionResponseStatus;
      response.end(JSON.stringify(buildSyntheticDecisionResult()));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(3199, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await closeApiServer();
});

test("shows the four process states returned by the API", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "系统健康" })).toBeVisible();
  await expect(page.getByText("全部正常")).toBeVisible();
  await expect(page.getByText("Web", { exact: true })).toBeVisible();
  await expect(page.getByText("API", { exact: true })).toBeVisible();
  await expect(page.getByText("Orchestrator", { exact: true })).toBeVisible();
  await expect(page.getByText("Data Worker", { exact: true })).toBeVisible();
});

test("shows a reviewable decision with conditions, risk and synthetic evidence", async ({
  page
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect(page.getByText("合成测试数据，不代表真实商品、价格或购买建议")).toBeVisible();
  await expect(page.getByText("有条件购买")).toBeVisible();
  await expect(page.getByText("CM-SYNTH-LAPTOP-A-32")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "实际到手价不高于 7800 元" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "必须提供官方保修" })).toBeVisible();
  await expect(page.getByText(/超过 8000 元硬预算/)).toBeVisible();
  await expect(
    page
      .getByRole("listitem")
      .filter({
        hasText:
          "memory.upgradeable：否；合成规格标记内存不可升级；购买前由用户核验准确 SKU 的官方规格"
      })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Claim 评估" })).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({
      hasText: "price.observed：7699 元；类型：FACT_ASSERTION；证据状态：SUPPORTED"
    })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "下一步" })).toBeVisible();
  await expect(page.getByText("核验实际到手价", { exact: true })).toBeVisible();
  await expect(page.getByText("合成观测价为 7699 元", { exact: true })).toBeVisible();
  await expect(page.getByText("2026-08-19T12:00:00.000Z").first()).toBeVisible();
});

test("does not mark Evidence expired when validUntil equals Decision validFrom with different ISO precision", async ({
  page
}) => {
  const result = buildSyntheticDecisionResult();
  result.bundle.decision.validFrom = "2026-08-12T12:00:00Z";
  result.bundle.evidence[0].validUntil = "2026-08-12T12:00:00.000Z";

  await page.route("**/api/decision-tasks/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(result)
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect(page.getByRole("heading", { name: "有条件购买" })).toBeVisible();
  await expect(page.getByText("形成 Decision 时已过期，仅供追溯")).not.toBeVisible();
});

test("shows the preference question when multiple Candidates remain feasible", async ({ page }) => {
  await page.route("**/api/decision-tasks/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(buildPreferenceDecisionResult())
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect(page.getByRole("heading", { name: "需要补充信息" })).toBeVisible();
  await expect(
    page.getByText("两个候选都满足硬约束，你更看重更低价格还是其他使用偏好？")
  ).toBeVisible();
  await expect(page.getByText(/候选：合成笔记本 A/)).not.toBeVisible();
});

test("does not render a successful decision when the API status contradicts its body", async ({
  page
}) => {
  decisionResponseStatus = 500;
  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect(page.getByRole("heading", { name: "决策任务失败" })).toBeVisible();
  await expect(page.getByText("有条件购买")).not.toBeVisible();
});

test("does not trust a successful body received with a failed Web response", async ({ page }) => {
  await page.route("**/api/decision-tasks/execute", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(buildSyntheticDecisionResult())
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect(page.getByRole("heading", { name: "决策任务失败" })).toBeVisible();
  await expect(page.getByText("有条件购买")).not.toBeVisible();
});

test("does not render a Decision with an unsupported contract version", async ({ page }) => {
  await page.route("**/api/decision-tasks/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        ...buildSyntheticDecisionResult(),
        contractVersion: "2.0"
      })
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect(page.getByRole("heading", { name: "决策任务失败" })).toBeVisible();
  await expect(page.getByText("有条件购买")).not.toBeVisible();
});

test("does not render a Decision with a forged Claim Assessment", async ({ page }) => {
  const forged = buildSyntheticDecisionResult();
  forged.bundle.claimAssessments[0].evidenceState = "CONFLICTED";

  await page.route("**/api/decision-tasks/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(forged)
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect(page.getByRole("heading", { name: "决策任务失败" })).toBeVisible();
  await expect(page.getByText("有条件购买")).not.toBeVisible();
});

test("shows an explicit failure when the Web decision response is not JSON", async ({ page }) => {
  await page.route("**/api/decision-tasks/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: "{"
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect(page.getByRole("heading", { name: "决策任务失败" })).toBeVisible();
  await expect(page.getByText("本次执行状态暂时无法确认")).toBeVisible();
  await expect(page.getByText("有条件购买")).not.toBeVisible();
});

test("keeps the P0 synthetic requirement fixed and read-only", async ({ page }) => {
  await page.goto("/");

  const requirement = page.getByRole("textbox", { name: "合成消费需求" });
  await expect(requirement).toHaveValue("预算不超过 8000 元，至少 32 GiB 内存和 1 TiB 存储。");
  await expect(requirement).toHaveAttribute("readonly", "");
  await expect(page.getByText("P0 固定合成示例，不解析任意自然语言需求。")).toBeVisible();
});

test("returns a versioned contract error for malformed decision JSON", async ({ page }) => {
  await page.goto("/");
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/decision-tasks/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });

    return { body: await result.text(), status: result.status };
  });

  expect(response.status).toBe(400);
  expect(JSON.parse(response.body)).toMatchObject({
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    error: {
      code: "CONTRACT_INVALID",
      category: "VALIDATION",
      retryMode: "NONE"
    }
  });
});

test("shows an explicit failure when the API cannot be reached", async ({ page }) => {
  await closeApiServer();

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "系统健康" })).toBeVisible();
  await expect(page.getByText("健康状态不可用")).toBeVisible();
});

async function closeApiServer() {
  if (!apiServer.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    apiServer.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function buildSyntheticDecisionResult() {
  const taskId = "task-web-test";
  const runId = "run-web-test";
  const validFrom = "2026-08-12T12:00:00.000Z";
  const validUntil = "2026-08-19T12:00:00.000Z";
  const candidateBPrice = 839900;

  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: true,
    taskStatus: {
      contractType: "decision-task-status",
      contractVersion: "1.0",
      decisionTaskId: taskId,
      agentRunId: runId,
      state: "COMPLETED",
      terminal: true,
      latestEventSequence: 9,
      decisionRevisionId: "decision-web-test-r1",
      updatedAt: "2026-08-12T12:00:08.000Z"
    },
    runEvents: buildCompletedRunEvents(taskId, runId),
    bundle: {
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-web-test-r1",
        decisionTaskId: taskId,
        revision: 1,
        submittedText: "预算不超过 8000 元。",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["软件开发"],
        budget: {
          confirmed: true,
          currency: "CNY",
          hard: true,
          maxAmountMinor: 800000
        },
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: []
      },
      candidates: [
        {
          contractType: "candidate",
          contractVersion: "1.0",
          candidateId: "candidate-synth-a",
          decisionTaskId: taskId,
          displayName: "合成笔记本 A",
          synthetic: true,
          identity: {
            model: "CM-SYNTH-LAPTOP-A",
            sku: "CM-SYNTH-LAPTOP-A-32",
            market: "CN",
            configuration: "32 GiB / 1 TiB"
          },
          observedPrice: { amountMinor: 769900, currency: "CNY", observedAt: validFrom }
        },
        {
          contractType: "candidate",
          contractVersion: "1.0",
          candidateId: "candidate-synth-b",
          decisionTaskId: taskId,
          displayName: "合成笔记本 B",
          synthetic: true,
          identity: {
            model: "CM-SYNTH-LAPTOP-B",
            sku: "CM-SYNTH-LAPTOP-B-32",
            market: "CN",
            configuration: "32 GiB / 1 TiB"
          },
          observedPrice: { amountMinor: candidateBPrice, currency: "CNY", observedAt: validFrom }
        }
      ],
      claims: [
        {
          contractType: "claim",
          contractVersion: "1.0",
          claimId: "claim-synth-a-price",
          decisionTaskId: taskId,
          subject: { subjectType: "CANDIDATE", subjectId: "candidate-synth-a" },
          predicate: "price.observed",
          value: { kind: "MONEY", amountMinor: 769900, currency: "CNY" },
          claimKind: "FACT_ASSERTION"
        },
        {
          contractType: "claim",
          contractVersion: "1.0",
          claimId: "claim-synth-a-memory-upgradeable",
          decisionTaskId: taskId,
          subject: { subjectType: "CANDIDATE", subjectId: "candidate-synth-a" },
          predicate: "memory.upgradeable",
          value: { kind: "BOOLEAN", value: false },
          claimKind: "FACT_ASSERTION"
        },
        {
          contractType: "claim",
          contractVersion: "1.0",
          claimId: "claim-synth-b-price",
          decisionTaskId: taskId,
          subject: { subjectType: "CANDIDATE", subjectId: "candidate-synth-b" },
          predicate: "price.observed",
          value: { kind: "MONEY", amountMinor: candidateBPrice, currency: "CNY" },
          claimKind: "FACT_ASSERTION"
        }
      ],
      evidence: [
        {
          contractType: "evidence",
          contractVersion: "1.0",
          evidenceId: "evidence-synth-a-price",
          decisionTaskId: taskId,
          synthetic: true,
          source: {
            sourceKind: "SYNTHETIC",
            sourceId: "source-synth-laptop-fixture",
            title: "ChoiceMind 合成笔记本测试资料"
          },
          capturedAt: validFrom,
          locator: { section: "synthetic-laptop", field: "price" },
          excerpt: "合成观测价为 7699 元",
          validUntil
        },
        {
          contractType: "evidence",
          contractVersion: "1.0",
          evidenceId: "evidence-synth-a-memory-upgradeable",
          decisionTaskId: taskId,
          synthetic: true,
          source: {
            sourceKind: "SYNTHETIC",
            sourceId: "source-synth-laptop-fixture",
            title: "ChoiceMind 合成笔记本测试资料"
          },
          capturedAt: validFrom,
          locator: { section: "synthetic-laptop", field: "memory.upgradeable" },
          excerpt: "合成规格标记内存不可升级",
          validUntil
        },
        {
          contractType: "evidence",
          contractVersion: "1.0",
          evidenceId: "evidence-synth-b-price",
          decisionTaskId: taskId,
          synthetic: true,
          source: {
            sourceKind: "SYNTHETIC",
            sourceId: "source-synth-laptop-fixture",
            title: "ChoiceMind 合成笔记本测试资料"
          },
          capturedAt: validFrom,
          locator: { section: "synthetic-laptop", field: "price-b" },
          excerpt: `合成观测价为 ${candidateBPrice / 100} 元`,
          validUntil
        }
      ],
      claimEvidenceLinks: [
        {
          contractType: "claim-evidence-link",
          contractVersion: "1.0",
          linkId: "link-web-a-price",
          decisionTaskId: taskId,
          claimId: "claim-synth-a-price",
          evidenceId: "evidence-synth-a-price",
          direction: "SUPPORTS"
        },
        {
          contractType: "claim-evidence-link",
          contractVersion: "1.0",
          linkId: "link-web-a-memory",
          decisionTaskId: taskId,
          claimId: "claim-synth-a-memory-upgradeable",
          evidenceId: "evidence-synth-a-memory-upgradeable",
          direction: "SUPPORTS"
        },
        {
          contractType: "claim-evidence-link",
          contractVersion: "1.0",
          linkId: "link-web-b-price",
          decisionTaskId: taskId,
          claimId: "claim-synth-b-price",
          evidenceId: "evidence-synth-b-price",
          direction: "SUPPORTS"
        }
      ],
      claimAssessments: [
        {
          contractType: "claim-assessment",
          contractVersion: "1.0",
          claimId: "claim-synth-a-memory-upgradeable",
          evidenceState: "SUPPORTED",
          supportingEvidenceIds: ["evidence-synth-a-memory-upgradeable"],
          refutingEvidenceIds: []
        },
        {
          contractType: "claim-assessment",
          contractVersion: "1.0",
          claimId: "claim-synth-a-price",
          evidenceState: "SUPPORTED",
          supportingEvidenceIds: ["evidence-synth-a-price"],
          refutingEvidenceIds: []
        },
        {
          contractType: "claim-assessment",
          contractVersion: "1.0",
          claimId: "claim-synth-b-price",
          evidenceState: "SUPPORTED",
          supportingEvidenceIds: ["evidence-synth-b-price"],
          refutingEvidenceIds: []
        }
      ],
      decision: {
        contractType: "decision-revision",
        contractVersion: "1.0",
        decisionRevisionId: "decision-web-test-r1",
        decisionTaskId: taskId,
        requirementRevisionId: "req-web-test-r1",
        revision: 1,
        status: "BUY_IF_PRICE",
        summary: "候选 A 满足硬约束；仅在核验价不高于 7800 元且提供官方保修时考虑购买。",
        selectedCandidateId: "candidate-synth-a",
        conditions: [
          {
            conditionId: "condition-web-max-price",
            conditionType: "MAX_PRICE",
            candidateId: "candidate-synth-a",
            amountMinor: 780000,
            currency: "CNY",
            verification: "由用户在外部销售渠道核验实际到手价"
          },
          {
            conditionId: "condition-web-official-warranty",
            conditionType: "OFFICIAL_WARRANTY",
            candidateId: "candidate-synth-a",
            verification: "由用户确认销售渠道提供官方保修"
          }
        ],
        candidateDispositions: [
          {
            dispositionId: "disposition-web-budget",
            dispositionType: "ELIMINATED" as const,
            candidateId: "candidate-synth-b",
            requirementKey: "budget.maxAmountMinor",
            reason: "合成观测价 8399 元超过 8000 元硬预算",
            evidenceIds: ["evidence-synth-b-price"]
          }
        ],
        risks: [
          {
            riskId: "risk-synth-memory-upgradeable",
            candidateId: "candidate-synth-a",
            statementClaimId: "claim-synth-a-memory-upgradeable",
            verification: "购买前由用户核验准确 SKU 的官方规格"
          }
        ],
        evidenceIds: [
          "evidence-synth-a-price",
          "evidence-synth-a-memory-upgradeable",
          "evidence-synth-b-price"
        ],
        criticalGaps: [],
        assumptions: [],
        validFrom,
        validUntil,
        nextSteps: [
          {
            actionType: "VERIFY_CONDITION",
            conditionId: "condition-web-max-price",
            instruction: "核验实际到手价"
          },
          {
            actionType: "VERIFY_CONDITION",
            conditionId: "condition-web-official-warranty",
            instruction: "确认官方保修"
          },
          {
            actionType: "VERIFY_RISK",
            riskId: "risk-synth-memory-upgradeable",
            instruction: "核验准确 SKU 的内存规格"
          }
        ],
        synthetic: true
      }
    }
  };
}

function buildPreferenceDecisionResult() {
  const result = structuredClone(buildSyntheticDecisionResult());
  const decision: Record<string, unknown> = result.bundle.decision;

  result.bundle.requirementRevision.budget.maxAmountMinor = 900000;
  decision.status = "NEED_MORE_INFO";
  decision.summary = "两个候选都满足已知硬约束，需要补充偏好后才能形成可审查的选择。";
  delete decision.selectedCandidateId;
  decision.conditions = [];
  decision.candidateDispositions = [];
  decision.risks = [];
  decision.criticalGaps = [
    {
      gapId: "gap-web-primary-preference",
      key: "preference.primary",
      question: "两个候选都满足硬约束，你更看重更低价格还是其他使用偏好？",
      resolution: {
        resolutionType: "PROVIDE_REQUIREMENT",
        requirementKey: "preference.primary"
      }
    }
  ];
  decision.nextSteps = [
    {
      actionType: "PROVIDE_REQUIREMENT",
      requirementKey: "preference.primary",
      instruction: "请说明更看重价格、重量、续航或其他使用偏好"
    }
  ];

  return result;
}

function buildCompletedRunEvents(taskId: string, runId: string) {
  const states = [
    "CREATED",
    "UNDERSTANDING",
    "PLANNING",
    "RESEARCHING",
    "VERIFYING",
    "COMPARING",
    "CRITIQUING",
    "GENERATING",
    "COMPLETED"
  ] as const;

  return states.map((taskState, index) => ({
    contractType: "run-event",
    contractVersion: "1.0",
    eventId: `event-web-test-${index + 1}`,
    decisionTaskId: taskId,
    agentRunId: runId,
    sequence: index + 1,
    occurredAt: `2026-08-12T12:00:0${index}.000Z`,
    eventType: index === states.length - 1 ? "RUNTIME_SUCCEEDED" : "TASK_STATE_CHANGED",
    taskState,
    summary: `合成阶段 ${taskState}`,
    synthetic: true
  }));
}
