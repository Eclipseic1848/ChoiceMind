import { createServer, request as requestHttp, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { decodeDecisionTaskResultV1 } from "@choicemind/contracts/decision/v1";
import { buildApiApp } from "../../api/src/app.js";
import { createDecisionTaskExecutor } from "../../orchestrator/src/decision-tasks/executor.js";
import { buildSyntheticLaptopRunOutput } from "../../orchestrator/src/runtime/synthetic-laptop-fixture.js";
import {
  openOutboxPublisher,
  openPersistentDecisionTaskModule,
  openPersistentDecisionTaskWorker,
  openRuntimeRecoveryStore
} from "../../../packages/task-persistence/src/index.js";
import { resetPersistentDecisionTaskTestData } from "../../../packages/task-persistence/tests/integration/support.js";

let apiServer: Server;
let decisionResponseStatus = 200;
const sseRecoveryRunId = "agent-run-web-sse-recovery";
const sseRecoveryTaskId = "task-web-sse-recovery";
let sseRecoveryCursors: Array<string | null> = [];
let decisionAuthorizationHeaders: Array<string | undefined> = [];
let runtimeControlRequests: Array<{
  authorization: string | undefined;
  body: Record<string, unknown>;
  url: string;
}> = [];
let verticalApiUrl: string | undefined;

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  decisionResponseStatus = 200;
  sseRecoveryCursors = [];
  decisionAuthorizationHeaders = [];
  runtimeControlRequests = [];
});

test.beforeAll(async () => {
  apiServer = createServer(async (request, response) => {
    if (
      verticalApiUrl !== undefined &&
      request.url?.startsWith("/api/v1/decision-tasks")
    ) {
      const upstream = requestHttp(
        new URL(request.url, verticalApiUrl),
        { headers: request.headers, method: request.method },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        }
      );
      upstream.on("error", () => response.writeHead(502).end());
      request.pipe(upstream);
      return;
    }

    if (request.url?.startsWith("/api/v1/decision-tasks")) {
      decisionAuthorizationHeaders.push(request.headers.authorization);
    }

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

    const runtimeControlMatch = request.url?.match(
      /^\/api\/v1\/decision-tasks\/task-web-proxy-control\/(resume|cancel)$/
    );
    if (request.method === "POST" && runtimeControlMatch !== undefined && runtimeControlMatch !== null) {
      const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
      const action = runtimeControlMatch[1] === "resume" ? "RESUME" : "CANCEL";
      runtimeControlRequests.push({
        authorization: request.headers.authorization,
        body,
        url: request.url ?? ""
      });
      response.statusCode = action === "RESUME" ? 202 : 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          contractType: "runtime-control-status",
          contractVersion: "1.0",
          controlRequestId: body.controlRequestId,
          decisionTaskId: "task-web-proxy-control",
          agentRunId: "agent-run-web-proxy-control",
          action,
          state: action === "RESUME" ? "ACCEPTED" : "COMPLETED",
          updatedAt: "2026-08-24T03:10:00.000Z"
        })
      );
      return;
    }

    if (request.url === `/api/v1/decision-tasks/${sseRecoveryTaskId}/events`) {
      sseRecoveryCursors.push(request.headers["last-event-id"] ?? null);

      if (sseRecoveryCursors.length === 2) {
        response.writeHead(503).end();
        return;
      }

      const event = buildPersistedEvent({
        cursor: sseRecoveryCursors.length === 1 ? "301" : "302",
        eventId:
          sseRecoveryCursors.length === 1
            ? "event-web-sse-initial"
            : "event-web-sse-recovered",
        runId: sseRecoveryRunId,
        sequence: sseRecoveryCursors.length === 1 ? 1 : 2,
        summary: sseRecoveryCursors.length === 1 ? "中断前的事件" : "服务恢复后的事件",
        taskId: sseRecoveryTaskId
      });
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.end(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
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
  await expect(
    page.getByRole("listitem").filter({ hasText: "实际到手价不高于 7800 元" })
  ).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "必须提供官方保修" })).toBeVisible();
  await expect(page.getByText(/超过 8000 元硬预算/)).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({
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

test("forwards the server-owned synthetic authorization to the API", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect.poll(() => decisionAuthorizationHeaders[0]).toBe("Bearer web-test-token");
});

test("stores the accepted task in the URL and restores persisted events after refresh", async ({
  page
}) => {
  let taskId = "";
  const runId = "agent-run-web-refresh";

  await page.route("**/api/decision-tasks/execute", async (route) => {
    const command = route.request().postDataJSON() as {
      executionRequestId: string;
      requirementRevision: { decisionTaskId: string };
    };
    taskId = command.requirementRevision.decisionTaskId;
    await route.fulfill({
      status: 202,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        contractType: "decision-task-snapshot",
        contractVersion: "1.0",
        executionRequestId: command.executionRequestId,
        decisionTaskId: taskId,
        agentRunId: runId,
        state: "ACCEPTED",
        terminal: false,
        updatedAt: "2026-08-24T01:50:00.000Z"
      })
    });
  });
  await page.route(/\/api\/decision-tasks\/task-[^/]+\/events$/, async (route) => {
    const persistedEvent = {
      contractType: "persisted-run-event",
      contractVersion: "1.0",
      cursor: "101",
      event: {
        contractType: "run-event",
        contractVersion: "1.0",
        eventId: "event-web-refresh-1",
        decisionTaskId: taskId,
        agentRunId: runId,
        sequence: 1,
        occurredAt: "2026-08-24T01:50:00.000Z",
        eventType: "TASK_STATE_CHANGED",
        taskState: "CREATED",
        summary: "已从 Postgres 恢复任务事件",
        synthetic: true
      }
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `id: 101\ndata: ${JSON.stringify(persistedEvent)}\n\n`
    });
  });
  await page.route(/\/api\/decision-tasks\/task-[^/]+$/, async (route) => {
    const result = buildSyntheticDecisionResult();
    replaceDecisionTaskIdentity(result, taskId, runId);
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(result)
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "运行合成决策" }).click();

  await expect.poll(() => taskId).toMatch(/^task-/);
  await expect(page).toHaveURL(new RegExp(`decisionTaskId=${taskId}`));
  await expect(page.getByText("已从 Postgres 恢复任务事件")).toBeVisible();

  await page.reload();

  await expect(page).toHaveURL(new RegExp(`decisionTaskId=${taskId}`));
  await expect(page.getByText("权威状态：COMPLETED")).toBeVisible();
  await expect(page.getByText("已从 Postgres 恢复任务事件")).toBeVisible();
});

test("deduplicates and orders replayed events while treating disconnect as reconnecting", async ({
  page
}) => {
  const taskId = "task-web-replay-order";
  const runId = "agent-run-web-replay-order";
  const first = buildPersistedEvent({
    cursor: "201",
    eventId: "event-web-order-1",
    runId,
    sequence: 1,
    summary: "第一阶段",
    taskId
  });
  const second = buildPersistedEvent({
    cursor: "202",
    eventId: "event-web-order-2",
    runId,
    sequence: 2,
    summary: "第二阶段",
    taskId
  });
  const forged = {
    ...buildPersistedEvent({
      cursor: "203",
      eventId: "event-web-order-forged",
      runId,
      sequence: 3,
      summary: "不应显示的事件",
      taskId
    }),
    hiddenThought: "模型隐藏思维链"
  };

  await page.route(/\/api\/decision-tasks\/task-web-replay-order\/events$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: [second, first, second, forged]
        .map((event) => `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("")
    });
  });
  await page.route(/\/api\/decision-tasks\/task-web-replay-order$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        contractType: "decision-task-snapshot",
        contractVersion: "1.0",
        executionRequestId: "exec-web-replay-order",
        decisionTaskId: taskId,
        agentRunId: runId,
        state: "RUNNING",
        terminal: false,
        updatedAt: "2026-08-24T01:55:00.000Z"
      })
    });
  });

  await page.goto(`/?decisionTaskId=${taskId}`);
  const progress = page.getByRole("region", { name: "任务进度" });

  await expect(progress.getByRole("listitem")).toHaveText(["第一阶段", "第二阶段"]);
  await expect(progress.getByText("事件连接中断，正在重连")).toBeVisible();
  await expect(page.getByText("模型隐藏思维链")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "决策任务失败" })).not.toBeVisible();
});

test("reconnects after SSE is temporarily unavailable and replays the recovered event", async ({
  page
}) => {
  await page.route(`**/api/decision-tasks/${sseRecoveryTaskId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        contractType: "decision-task-snapshot",
        contractVersion: "1.0",
        executionRequestId: "exec-web-sse-recovery",
        decisionTaskId: sseRecoveryTaskId,
        agentRunId: sseRecoveryRunId,
        state: "RUNNING",
        terminal: false,
        updatedAt: "2026-08-24T02:10:00.000Z"
      })
    });
  });

  await page.goto(`/?decisionTaskId=${sseRecoveryTaskId}`);

  await expect.poll(() => sseRecoveryCursors.slice(0, 3)).toEqual([null, "301", "301"]);
  await expect(page.getByRole("region", { name: "任务进度" })).toContainText(
    "服务恢复后的事件"
  );
});

test("shows a paused reason and sends owner-controlled resume and cancel commands", async ({
  page
}) => {
  const taskId = "task-web-runtime-control";
  const runId = "agent-run-web-runtime-control";
  const runtimeSnapshotId = "snapshot-web-runtime-control";
  let resumeBody: Record<string, unknown> | undefined;
  let cancelBody: Record<string, unknown> | undefined;
  let releaseOldPausedEvent: (() => void) | undefined;
  const oldPausedEventGate = new Promise<void>((resolve) => {
    releaseOldPausedEvent = resolve;
  });

  await page.route(`**/api/decision-tasks/${taskId}/events`, async (route) => {
    const event = buildPersistedEvent({
      cursor: "401",
      eventId: "event-web-runtime-control",
      runId,
      sequence: 1,
      summary: "副作用状态需要人工核验",
      taskId
    });
    event.event.taskState = "PAUSED_PERMISSION";
    await oldPausedEventGate;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `id: 401\ndata: ${JSON.stringify(event)}\n\n`
    });
  });
  await page.route(`**/api/decision-tasks/${taskId}/resume`, async (route) => {
    resumeBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 202,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        contractType: "runtime-control-status",
        contractVersion: "1.0",
        controlRequestId: resumeBody.controlRequestId,
        decisionTaskId: taskId,
        agentRunId: runId,
        action: "RESUME",
        state: "ACCEPTED",
        updatedAt: "2026-08-24T03:00:00.000Z"
      })
    });
  });
  await page.route(`**/api/decision-tasks/${taskId}/cancel`, async (route) => {
    cancelBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        contractType: "runtime-control-status",
        contractVersion: "1.0",
        controlRequestId: cancelBody.controlRequestId,
        decisionTaskId: taskId,
        agentRunId: runId,
        action: "CANCEL",
        state: "COMPLETED",
        updatedAt: "2026-08-24T03:00:01.000Z"
      })
    });
  });
  await page.route(`**/api/decision-tasks/${taskId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        contractType: "decision-task-snapshot",
        contractVersion: "1.0",
        executionRequestId: "exec-web-runtime-control",
        decisionTaskId: taskId,
        agentRunId: runId,
        state: "PAUSED_PERMISSION",
        terminal: false,
        runtimeSnapshotId,
        updatedAt: "2026-08-24T02:59:00.000Z"
      })
    });
  });

  await page.goto(`/?decisionTaskId=${taskId}`);

  await page.getByRole("button", { name: "安全恢复" }).click();
  await expect(page.getByText("恢复中")).toBeVisible();
  await expect(page.getByRole("button", { name: "正在恢复" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "取消任务" })).toBeDisabled();
  releaseOldPausedEvent?.();
  await expect(page.getByText("副作用状态需要人工核验")).toBeVisible();
  await expect(page.getByText("恢复中")).toBeVisible();
  await expect(page.getByRole("button", { name: "正在恢复" })).toBeDisabled();
  expect(resumeBody).toMatchObject({
    contractType: "runtime-resume-request",
    contractVersion: "1.0",
    runtimeSnapshotId
  });
  expect(Object.keys(resumeBody ?? {}).sort()).toEqual([
    "contractType",
    "contractVersion",
    "controlRequestId",
    "runtimeSnapshotId"
  ]);

  await page.reload();
  await page.getByRole("button", { name: "取消任务" }).click();
  await expect(page.getByText("取消完成")).toBeVisible();
  expect(cancelBody).toMatchObject({
    contractType: "runtime-cancel-request",
    contractVersion: "1.0"
  });
  expect(Object.keys(cancelBody ?? {}).sort()).toEqual([
    "cancellationId",
    "contractType",
    "contractVersion",
    "controlRequestId"
  ]);
});

test("proxies strict runtime controls with server-owned authorization", async ({ page }) => {
  await page.goto("/");
  const responses = await page.evaluate(async () => {
    const resume = await fetch("/api/decision-tasks/task-web-proxy-control/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractType: "runtime-resume-request",
        contractVersion: "1.0",
        controlRequestId: "control-web-proxy-resume",
        runtimeSnapshotId: "snapshot-web-proxy"
      })
    });
    const cancel = await fetch("/api/decision-tasks/task-web-proxy-control/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractType: "runtime-cancel-request",
        contractVersion: "1.0",
        controlRequestId: "control-web-proxy-cancel",
        cancellationId: "cancel-web-proxy"
      })
    });

    return [
      { body: await resume.json(), status: resume.status },
      { body: await cancel.json(), status: cancel.status }
    ];
  });

  expect(responses).toMatchObject([
    { body: { action: "RESUME", state: "ACCEPTED" }, status: 202 },
    { body: { action: "CANCEL", state: "COMPLETED" }, status: 200 }
  ]);
  expect(runtimeControlRequests).toEqual([
    {
      authorization: "Bearer web-test-token",
      body: {
        contractType: "runtime-resume-request",
        contractVersion: "1.0",
        controlRequestId: "control-web-proxy-resume",
        runtimeSnapshotId: "snapshot-web-proxy"
      },
      url: "/api/v1/decision-tasks/task-web-proxy-control/resume"
    },
    {
      authorization: "Bearer web-test-token",
      body: {
        contractType: "runtime-cancel-request",
        contractVersion: "1.0",
        controlRequestId: "control-web-proxy-cancel",
        cancellationId: "cancel-web-proxy"
      },
      url: "/api/v1/decision-tasks/task-web-proxy-control/cancel"
    }
  ]);
});

test("replays one local browser-to-runtime recovery through real Postgres and Redis", async ({
  page
}) => {
  const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
  const redisUrl = process.env.CHOICEMIND_TEST_REDIS_URL;
  test.skip(
    databaseUrl === undefined || redisUrl === undefined,
    "需要显式隔离的 PostgreSQL 和 Redis 资源"
  );
  if (databaseUrl === undefined || redisUrl === undefined) return;

  await resetPersistentDecisionTaskTestData(databaseUrl);
  const suffix = randomUUID();
  const streamName = `choicemind:test:web-runtime-recovery:${suffix}`;
  const consumerGroup = `choicemind-test-web-runtime-recovery-${suffix}`;
  const taskModule = await openPersistentDecisionTaskModule({ databaseUrl });
  const recoveryStore = await openRuntimeRecoveryStore({ databaseUrl });
  const publisher = await openOutboxPublisher({ databaseUrl, redisUrl, streamName });
  let correspondingToolCalls = 0;
  const executor = createDecisionTaskExecutor({
    runtime: {
      async run() {
        throw new Error("纵向恢复测试不应调用普通 Runtime 入口");
      },
      async resume(command) {
         const committed = command.effectReceipts.find(
           (receipt) => receipt.state === "committed"
         );
         if (committed === undefined) {
           correspondingToolCalls += 1;
           throw new Error("纵向恢复测试必须包含 committed 结果");
         }
        const reused = await recoveryStore.loadEffectResult(committed.result);
        if (reused === undefined) {
          throw new Error("纵向恢复测试的权威结果不可用");
        }
        return {
          ok: true,
          changed: true,
          state: "COMPLETED",
          runEvents: [],
          outcome: reused as ReturnType<typeof buildSyntheticLaptopRunOutput>
        };
      }
    }
  });
  const worker = await openPersistentDecisionTaskWorker({
    databaseUrl,
    redisUrl,
    streamName,
    consumerGroup,
    workerId: `web-runtime-recovery-${suffix}`,
    readBlockMs: 10,
    async execute(claim) {
      const command = claim.command;
      const generatedOutput = buildSyntheticLaptopRunOutput({
        contractVersion: "1.0",
        decisionTaskId: command.requirementRevision.decisionTaskId,
        agentRunId: claim.agentRunId,
        requirementRevision: command.requirementRevision
      });
      const recoveryStartedAt = Date.now();
      const output = {
        ...generatedOutput,
        runEvents: generatedOutput.runEvents
          .filter(
            (event) => event.taskState === "CREATED" || event.taskState === "COMPLETED"
          )
          .map((event, index) => ({
            ...event,
            sequence: index + 1,
            occurredAt: new Date(recoveryStartedAt + index).toISOString()
          }))
      };
      const rawSnapshot = await recoveryStore.putRawSnapshot({
        schemaVersion: 1,
        runId: claim.agentRunId,
        operation: { state: "paused", transitionSequence: 1 },
        resumable: true
      });
      const checkpointId = `checkpoint-${suffix}`;
      const snapshot = {
        contractType: "runtime-snapshot" as const,
        contractVersion: "1.0" as const,
        snapshotId: `snapshot-${rawSnapshot.digest}`,
        decisionTaskId: command.requirementRevision.decisionTaskId,
        agentRunId: claim.agentRunId,
        taskState: "PAUSED_PERMISSION" as const,
        resumable: true,
        runtimeProtocol: { name: "agent-runtime-protocol" as const, version: "1" as const },
        rawSnapshot,
        checkpoint: {
          contractType: "checkpoint-ref" as const,
          contractVersion: "1.0" as const,
          checkpointId,
          decisionTaskId: command.requirementRevision.decisionTaskId,
          agentRunId: claim.agentRunId,
          sequence: 1,
          persistedAt: "2026-08-24T12:00:00.000Z"
        },
        capturedAt: "2026-08-24T12:00:00.000Z"
      };
      const result = await recoveryStore.putEffectResult(
        {
          decisionTaskId: snapshot.decisionTaskId,
          agentRunId: snapshot.agentRunId,
          checkpointId,
          effectId: `submit-decision-draft-${suffix}`
        },
        output
      );
      const receipt = {
        contractType: "effect-receipt" as const,
        contractVersion: "1.0" as const,
        effectReceiptId: `receipt-${suffix}`,
        decisionTaskId: snapshot.decisionTaskId,
        agentRunId: snapshot.agentRunId,
        checkpointId,
        effectId: `submit-decision-draft-${suffix}`,
        state: "committed" as const,
        result,
        recordedAt: "2026-08-24T12:00:00.000Z"
      };
      await recoveryStore.saveRecoveryFacts(snapshot, [receipt]);
      return {
        contractType: "runtime-paused-outcome",
        contractVersion: "1.0",
        state: "PAUSED_PERMISSION",
        summary: "等待安全恢复",
        snapshot,
        effectReceipts: [receipt],
        runEvents: [
          {
            contractType: "run-event",
            contractVersion: "1.0",
            eventId: `event-paused-${suffix}`,
            decisionTaskId: snapshot.decisionTaskId,
            agentRunId: snapshot.agentRunId,
            sequence: 1,
            occurredAt: "2026-08-24T12:00:00.000Z",
            eventType: "TASK_STATE_CHANGED",
            taskState: "PAUSED_PERMISSION",
            summary: "等待安全恢复",
            synthetic: true
          }
        ]
      };
    },
    async executeRuntimeControl(claim) {
      const outcome = await executor.resumePersistent(
        claim.command,
        { snapshot: claim.snapshot, effectReceipts: claim.effectReceipts },
        {
          agentRunId: claim.agentRunId,
          userId: claim.ownerUserId,
          operationId: claim.controlRequestId,
          correlationId: claim.correlationId,
          egressConfirmation: claim.egressConfirmation
        }
      );
      if ("runEvents" in outcome) {
        const latest = outcome.runEvents.at(-1);
        if (latest !== undefined) {
          const visibleOutcome = {
            ...outcome,
            runEvents: outcome.runEvents.map((event) =>
              event === latest
                ? { ...event, summary: "Runtime 已复用权威副作用结果并完成" }
              : event
            )
          };
          const decoded = decodeDecisionTaskResultV1(visibleOutcome);
          if (!decoded.ok) {
            throw new Error(`纵向恢复结果不符合合同：${JSON.stringify(decoded.issues)}`);
          }
          return visibleOutcome;
        }
      }
      return outcome;
    }
  });
  const app = buildApiApp({
    auditLog: { append: async (record) => taskModule.appendAuditRecord(record) },
    decisionTaskPersistence: taskModule,
    decisionTaskRuntimeControl: {
      requestResume: async (input) =>
        taskModule.requestRuntimeResume({
          controlRequestId: input.controlRequestId,
          decisionTaskId: input.decisionTaskId,
          ownerUserId: input.actor.userId,
          runtimeSnapshotId: input.runtimeSnapshotId,
          correlationId: input.correlationId,
          egressConfirmation: input.egressConfirmation
        }),
      requestCancel: async (input) =>
        taskModule.requestRuntimeCancel({
          controlRequestId: input.controlRequestId,
          decisionTaskId: input.decisionTaskId,
          ownerUserId: input.actor.userId,
          cancellationId: input.cancellationId,
          correlationId: input.correlationId
        })
    },
    identityResolver: {
      async resolve(authorization) {
        return authorization === "Bearer web-test-token"
          ? { principalId: "principal-web-test", role: "USER", userId: "web-test-user" }
          : undefined;
      }
    }
  });

  try {
    verticalApiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto("/");
    await page.getByRole("button", { name: "运行合成决策" }).click();
    await expect(page).toHaveURL(/decisionTaskId=task-/);
    await publisher.runOnce();
    await worker.runOnce();
    await page.reload();
    await expect(page.getByRole("button", { name: "安全恢复" })).toBeVisible();
    await page.getByRole("button", { name: "安全恢复" }).click();
    await expect(page.getByText("恢复中")).toBeVisible();
    await worker.runOnce();

    await expect(page.getByText("权威状态：COMPLETED")).toBeVisible();
    await expect(page.getByText("恢复中")).not.toBeVisible();
    await expect(
      page.getByRole("region", { name: "任务进度" }).getByText("Runtime 已复用权威副作用结果并完成")
    ).toBeVisible();
    expect(correspondingToolCalls).toBe(0);
  } finally {
    verticalApiUrl = undefined;
    await page.close().catch(() => undefined);
    app.server.closeAllConnections();
    await Promise.allSettled([
      app.close(),
      worker.close(),
      publisher.close(),
      recoveryStore.close(),
      taskModule.close()
    ]);
  }
});

test("does not label a task observation failure as a business task failure", async ({ page }) => {
  const taskId = "task-web-observation-unavailable";

  await page.route(`**/api/decision-tasks/${taskId}/events`, async (route) => {
    await route.fulfill({ status: 503, body: "" });
  });
  await page.route(`**/api/decision-tasks/${taskId}`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(createObservationUnavailableResult())
    });
  });

  await page.goto(`/?decisionTaskId=${taskId}`);

  await expect(page.getByText("任务状态暂时无法读取")).toBeVisible();
  await expect(page.getByRole("heading", { name: "决策任务失败" })).not.toBeVisible();
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

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
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
          observedPrice: {
            amountMinor: 769900,
            currency: "CNY",
            observedAt: validFrom
          }
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
          observedPrice: {
            amountMinor: candidateBPrice,
            currency: "CNY",
            observedAt: validFrom
          }
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
          value: {
            kind: "MONEY",
            amountMinor: candidateBPrice,
            currency: "CNY"
          },
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

function replaceDecisionTaskIdentity(
  result: ReturnType<typeof buildSyntheticDecisionResult>,
  taskId: string,
  runId: string
) {
  result.taskStatus.decisionTaskId = taskId;
  result.taskStatus.agentRunId = runId;
  result.bundle.requirementRevision.decisionTaskId = taskId;
  result.bundle.candidates.forEach((candidate) => {
    candidate.decisionTaskId = taskId;
  });
  result.bundle.claims.forEach((claim) => {
    claim.decisionTaskId = taskId;
  });
  result.bundle.evidence.forEach((evidence) => {
    evidence.decisionTaskId = taskId;
  });
  result.bundle.claimEvidenceLinks.forEach((link) => {
    link.decisionTaskId = taskId;
  });
  result.bundle.decision.decisionTaskId = taskId;
  result.runEvents.forEach((event) => {
    event.decisionTaskId = taskId;
    event.agentRunId = runId;
  });
}

function buildPersistedEvent(input: {
  cursor: string;
  eventId: string;
  runId: string;
  sequence: number;
  summary: string;
  taskId: string;
}) {
  return {
    contractType: "persisted-run-event",
    contractVersion: "1.0",
    cursor: input.cursor,
    event: {
      contractType: "run-event",
      contractVersion: "1.0",
      eventId: input.eventId,
      decisionTaskId: input.taskId,
      agentRunId: input.runId,
      sequence: input.sequence,
      occurredAt: "2026-08-24T01:55:00.000Z",
      eventType: "TASK_STATE_CHANGED",
      taskState: "UNDERSTANDING",
      summary: input.summary,
      synthetic: true
    }
  };
}

function createObservationUnavailableResult() {
  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId: "error-web-observation-unavailable",
      code: "PERSISTENCE_UNAVAILABLE",
      category: "STORAGE",
      message: "持久任务存储暂时不可用",
      retryMode: "SAME_EXECUTION_ONLY",
      issues: [],
      occurredAt: "2026-08-24T02:00:00.000Z"
    }
  };
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
