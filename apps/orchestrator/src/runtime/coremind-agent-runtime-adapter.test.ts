import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CoreMindRuntime } from "coremind-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApiApp } from "../../../api/src/app.js";
import { createHttpDecisionOrchestratorAdapter } from "../../../api/src/decision-tasks/http-orchestrator-adapter.js";
import { buildOrchestratorApp } from "../app.js";
import { createDecisionTaskExecutor } from "../decision-tasks/executor.js";
import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import { buildSyntheticLaptopRunOutput } from "./synthetic-laptop-fixture.js";
import { createCoreMindAgentRuntimeAdapter } from "./coremind-agent-runtime-adapter.js";

type OfflineProvider = Readonly<{
  baseUrl: string;
  requests: readonly Record<string, unknown>[];
  close: () => Promise<void>;
}>;

type OfflineProviderScenario =
  | "success"
  | "duplicate-tool"
  | "no-tool"
  | "free-text"
  | "malformed-tool-arguments"
  | "forbidden-claim-assessments"
  | "forbidden-run-events"
  | "forbidden-success-marker"
  | "provider-error"
  | "provider-timeout"
  | "contradictory-domain-draft"
  | "invalid-decision-draft";

const openProviders: Array<OfflineProvider> = [];
const openApps: Array<ReturnType<typeof buildOrchestratorApp>> = [];
const temporaryDirectories: string[] = [];
const originalChoiceMindApiUrl = process.env.CHOICEMIND_API_URL;
const webDecisionRouteModule = new URL(
  "../../../web/src/app/api/decision-tasks/execute/route.ts",
  import.meta.url
).href;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openProviders.splice(0).map((provider) => provider.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
  if (originalChoiceMindApiUrl === undefined) {
    delete process.env.CHOICEMIND_API_URL;
  } else {
    process.env.CHOICEMIND_API_URL = originalChoiceMindApiUrl;
  }
});

describe("CoreMind AgentRuntimeRunPort", () => {
  it("runs through the public CoreMind HTTP/SSE and Tool path before finalizing a Decision", async () => {
    const provider = await startOfflineProvider();
    const configDir = await createTemporaryDirectory();
    const command = buildCoreMindCommand("coremind-offline-buy-if-price");
    const executor = createDecisionTaskExecutor({
      runtime: createCoreMindAgentRuntimeAdapter({
        providerBaseUrl: provider.baseUrl,
        model: "offline-model",
        configDir,
        now: createDeterministicClock([
          "2026-08-20T12:00:00.000Z",
          "2026-08-20T12:00:02.000Z"
        ])
      })
    });

    const result = await executor.execute(command);

    expect(result).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: true,
      taskStatus: {
        state: "COMPLETED",
        decisionRevisionId: "decision-task-coremind-offline-buy-if-price-r1"
      },
      bundle: {
        decision: {
          status: "BUY_IF_PRICE",
          selectedCandidateId: "candidate-synth-a"
        }
      },
      runEvents: [
        {
          sequence: 1,
          taskState: "CREATED",
          occurredAt: "2026-08-20T12:00:00.000Z"
        },
        {
          sequence: 2,
          taskState: "COMPLETED",
          eventType: "RUNTIME_SUCCEEDED",
          occurredAt: "2026-08-20T12:00:02.000Z"
        }
      ]
    });

    expect(provider.requests).toHaveLength(2);
    const firstRequest = provider.requests[0];
    if (firstRequest === undefined) {
      throw new Error("离线 Provider 未收到首个请求");
    }
    const tools = firstRequest.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "submit_decision_draft" })
      })
    ]);

    const toolParameters = JSON.stringify((tools as unknown[])[0]);
    expect(toolParameters).not.toContain("claimAssessments");
    expect(toolParameters).not.toContain("runEvents");
    expect(toolParameters).not.toContain("ok");
  });

  it("keeps a deterministic CoreMind Decision field-identical across independent executions", async () => {
    const provider = await startOfflineProvider();
    const firstConfigDir = await createTemporaryDirectory();
    const secondConfigDir = await createTemporaryDirectory();
    const command = buildCoreMindCommand("coremind-offline-repeatable");
    const firstExecutor = createDecisionTaskExecutor({
      runtime: createCoreMindAgentRuntimeAdapter({
        providerBaseUrl: provider.baseUrl,
        model: "offline-model",
        configDir: firstConfigDir,
        now: createDeterministicClock([
          "2026-08-20T12:00:00.000Z",
          "2026-08-20T12:00:02.000Z"
        ])
      })
    });
    const secondExecutor = createDecisionTaskExecutor({
      runtime: createCoreMindAgentRuntimeAdapter({
        providerBaseUrl: provider.baseUrl,
        model: "offline-model",
        configDir: secondConfigDir,
        now: createDeterministicClock([
          "2026-08-20T12:00:00.000Z",
          "2026-08-20T12:00:02.000Z"
        ])
      })
    });

    const [first, second] = await Promise.all([
      firstExecutor.execute(command),
      secondExecutor.execute(command)
    ]);

    expect(first).toEqual(second);
    expect(provider.requests).toHaveLength(4);
  });

  it("fails closed when the Provider submits the Decision draft Tool more than once", async () => {
    const provider = await startOfflineProvider("duplicate-tool");
    const configDir = await createTemporaryDirectory();
    const executor = createDecisionTaskExecutor({
      runtime: createCoreMindAgentRuntimeAdapter({
        providerBaseUrl: provider.baseUrl,
        model: "offline-model",
        configDir
      })
    });

    const result = await executor.execute(buildCoreMindCommand("coremind-duplicate-tool"));

    expectRuntimeFailure(result);
  });

  it.each([
    ["no-tool", "缺失 Tool"],
    ["free-text", "仅自由文本"],
    ["malformed-tool-arguments", "畸形 Tool 参数"],
    ["forbidden-claim-assessments", "越权 Claim Assessment"],
    ["forbidden-run-events", "越权 RunEvent"],
    ["forbidden-success-marker", "越权任务成功标记"],
    ["provider-error", "Provider 非成功响应"],
    ["provider-timeout", "Provider 超时"],
    ["contradictory-domain-draft", "相互矛盾的领域草稿"],
    ["invalid-decision-draft", "违反 ChoiceMind 合同的 Decision 草稿"]
  ] as const)("fails closed for %s（%s）", async (scenario, _description) => {
    const provider = await startOfflineProvider(scenario);
    const configDir = await createTemporaryDirectory();
    const executor = createDecisionTaskExecutor({
      runtime: createCoreMindAgentRuntimeAdapter({
        providerBaseUrl: provider.baseUrl,
        model: "offline-model",
        configDir,
        runTimeoutMs: scenario === "provider-timeout" ? 20 : 10_000
      })
    });

    const result = await executor.execute(buildCoreMindCommand(`coremind-${scenario}`));

    // CoreMind 0.3.0 的超时结果会早于后台 RunState 写入返回，保留临时目录直到写入收尾。
    if (scenario === "provider-timeout") {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expectRuntimeFailure(result);
    expect(JSON.stringify(result)).not.toContain("provider-private-sentinel");
  });

  it("passes only the dedicated ChoiceMind Provider credential into CoreMind", async () => {
    let createOptions: Parameters<typeof CoreMindRuntime.create>[0] | undefined;
    vi.spyOn(CoreMindRuntime, "create").mockImplementation(async (options) => {
      createOptions = options;
      return {
        run: async () => ({
          outcome: { status: "failed", reason: "coremind-private-sentinel" }
        })
      } as unknown as Awaited<ReturnType<typeof CoreMindRuntime.create>>;
    });
    const executor = createDecisionTaskExecutor({
      runtime: createCoreMindAgentRuntimeAdapter({
        providerBaseUrl: "http://127.0.0.1:6013/v1",
        model: "offline-model",
        apiKey: "choice-key"
      })
    });

    const result = await executor.execute(buildCoreMindCommand("coremind-provider-env"));

    expectRuntimeFailure(result);
    expect(JSON.stringify(result)).not.toContain("coremind-private-sentinel");
    expect(Object.keys(createOptions?.env ?? {})).toHaveLength(1);
    expect(createOptions?.env?.CHOICEMIND_COREMIND_PROVIDER_API_KEY).toBe("choice-key");
  });

  it("serves BUY_IF_PRICE and NEED_MORE_INFO through the Web, API and Orchestrator HTTP seams", async () => {
    const provider = await startOfflineProvider();
    const configDir = await createTemporaryDirectory();
    const orchestratorApp = buildOrchestratorApp({
      decisionTaskExecutor: createDecisionTaskExecutor({
        runtime: createCoreMindAgentRuntimeAdapter({
          providerBaseUrl: provider.baseUrl,
          model: "offline-model",
          configDir,
          now: createDeterministicClock([
            "2026-08-20T12:00:00.000Z",
            "2026-08-20T12:00:02.000Z",
            "2026-08-20T12:01:00.000Z",
            "2026-08-20T12:01:02.000Z"
          ])
        })
      })
    });
    openApps.push(orchestratorApp);
    const orchestratorUrl = await orchestratorApp.listen({ host: "127.0.0.1", port: 0 });
    const apiApp = buildApiApp({
      decisionOrchestrator: createHttpDecisionOrchestratorAdapter({
        baseUrl: orchestratorUrl
      })
    });
    openApps.push(apiApp);
    process.env.CHOICEMIND_API_URL = await apiApp.listen({ host: "127.0.0.1", port: 0 });
    const { POST: executeDecisionTaskViaWeb } = (await import(webDecisionRouteModule)) as {
      POST: (request: Request) => Promise<Response>;
    };

    const buyResponse = await executeDecisionTaskViaWeb(
      createWebDecisionRequest(buildCoreMindCommand("coremind-http-buy-if-price"))
    );
    const gapResponse = await executeDecisionTaskViaWeb(
      createWebDecisionRequest(buildCoreMindCommand("coremind-http-needs-budget", false))
    );

    expect(buyResponse.status).toBe(200);
    expect(await buyResponse.json()).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: { decision: { status: "BUY_IF_PRICE" } }
    });
    expect(gapResponse.status).toBe(200);
    expect(await gapResponse.json()).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: {
        decision: {
          status: "NEED_MORE_INFO",
          criticalGaps: [expect.objectContaining({ key: "budget.maxAmountMinor" })]
        }
      }
    });
  });

  it("returns a framework-neutral Runtime failure through the Orchestrator HTTP seam", async () => {
    const provider = await startOfflineProvider("provider-error");
    const configDir = await createTemporaryDirectory();
    const app = buildOrchestratorApp({
      decisionTaskExecutor: createDecisionTaskExecutor({
        runtime: createCoreMindAgentRuntimeAdapter({
          providerBaseUrl: provider.baseUrl,
          model: "offline-model",
          configDir
        })
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      payload: buildCoreMindCommand("coremind-http-runtime-failure")
    });
    const body = response.json();

    expect(response.statusCode).toBe(502);
    expectRuntimeFailure(body);
    expect(response.body).not.toContain("provider-private-sentinel");
  });
});

function createWebDecisionRequest(command: ExecuteDecisionTaskCommandV1): Request {
  return new Request("http://127.0.0.1/api/decision-tasks/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
}

async function startOfflineProvider(
  scenario: OfflineProviderScenario = "success"
): Promise<OfflineProvider> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }

    if (scenario === "provider-error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider-private-sentinel" } }));
      return;
    }

    if (scenario === "provider-timeout") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!response.destroyed) {
        response.writeHead(504, { "content-type": "text/plain" });
        response.end("provider-private-sentinel");
      }
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasToolResult = messages.some(
      (message) => isRecord(message) && message.role === "tool"
    );

    if (hasToolResult) {
      return sendSse(response, [
        {
          id: "offline-final",
          object: "chat.completion.chunk",
          created: 1,
          model: "offline-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "结构化决策草稿已提交。" },
              finish_reason: "stop"
            }
          ]
        },
        "[DONE]"
      ]);
    }

    if (scenario === "no-tool" || scenario === "free-text") {
      return sendSse(response, [
        {
          id: `offline-${scenario}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "offline-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: scenario === "free-text" ? "我建议选择合成候选 A。" : ""
              },
              finish_reason: "stop"
            }
          ]
        },
        "[DONE]"
      ]);
    }

    const prompt = messages.find(
      (message) => isRecord(message) && message.role === "user"
    );
    const promptContent = getTextContent(prompt);
    if (promptContent === undefined) {
      response.writeHead(400).end();
      return;
    }

    const command = JSON.parse(promptContent) as Parameters<
      typeof buildSyntheticLaptopRunOutput
    >[0];
    const output = buildSyntheticLaptopRunOutput(command);
    const draft: Record<string, unknown> = {
      candidates: output.candidates,
      claims: output.claims,
      evidence: output.evidence,
      claimEvidenceLinks: output.claimEvidenceLinks,
      decision: output.decision
    };

    if (scenario === "forbidden-claim-assessments") {
      draft.claimAssessments = [];
    }
    if (scenario === "forbidden-run-events") {
      draft.runEvents = [];
    }
    if (scenario === "forbidden-success-marker") {
      draft.ok = true;
    }
    if (scenario === "contradictory-domain-draft") {
      const links = [...output.claimEvidenceLinks];
      const firstLink = links[0];
      if (firstLink === undefined) {
        throw new Error("合成领域草稿必须包含 Claim-Evidence Link");
      }
      links.push({
        ...firstLink,
        linkId: `${firstLink.linkId}-refutes`,
        direction: "REFUTES"
      });
      draft.claimEvidenceLinks = links;
    }
    if (scenario === "invalid-decision-draft") {
      draft.decision = {
        ...output.decision,
        selectedCandidateId: "candidate-does-not-exist"
      };
    }

    const toolCalls = [
      {
        index: 0,
        id: "call-submit-decision-draft",
        type: "function",
        function: {
          name: "submit_decision_draft",
          arguments:
            scenario === "malformed-tool-arguments" ? "{not-json" : JSON.stringify(draft)
        }
      }
    ];
    if (scenario === "duplicate-tool") {
      toolCalls.push({
        index: 1,
        id: "call-submit-decision-draft-again",
        type: "function",
        function: {
          name: "submit_decision_draft",
          arguments: JSON.stringify(draft)
        }
      });
    }

    return sendSse(response, [
      {
        id: "offline-tool",
        object: "chat.completion.chunk",
        created: 1,
        model: "offline-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: toolCalls
            },
            finish_reason: "tool_calls"
          }
        ]
      },
      "[DONE]"
    ]);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("离线 Provider 未取得监听地址");
  }

  const provider = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server)
  };
  openProviders.push(provider);
  return provider;
}

function expectRuntimeFailure(result: Awaited<ReturnType<ReturnType<typeof createDecisionTaskExecutor>["execute"]>>): void {
  expect(result).toMatchObject({
    ok: false,
    taskStatus: { state: "FAILED", terminal: true },
    runEvents: [
      { sequence: 1, taskState: "CREATED" },
      { sequence: 2, taskState: "FAILED", eventType: "RUNTIME_FAILED" }
    ],
    error: {
      code: "AGENT_RUNTIME_FAILED",
      category: "RUNTIME",
      message: "决策任务失败",
      retryMode: "NEW_EXECUTION_ALLOWED"
    }
  });
  expect(result).not.toHaveProperty("bundle");
}

async function sendSse(response: ServerResponse, chunks: readonly unknown[]) {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
    connection: "keep-alive"
  });
  for (const chunk of chunks) {
    response.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
  }
  response.end();
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "choicemind-coremind-"));
  temporaryDirectories.push(directory);
  return directory;
}

function buildCoreMindCommand(
  executionRequestId: string,
  budgetConfirmed = true
): ExecuteDecisionTaskCommandV1 {
  return {
    contractType: "execute-decision-task-command",
    contractVersion: "1.0",
    executionRequestId,
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: `req-${executionRequestId}-r1`,
      decisionTaskId: `task-${executionRequestId}`,
      revision: 1,
      submittedText: budgetConfirmed
        ? "预算不超过 8000 元，至少 32 GiB 内存和 1 TiB 存储。"
        : "需要开发用笔记本，预算待确认。",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["软件开发"],
      ...(budgetConfirmed
        ? {
            budget: {
              confirmed: true,
              currency: "CNY" as const,
              hard: true,
              maxAmountMinor: 800000
            }
          }
        : {}),
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
      unknowns: budgetConfirmed ? [] : ["budget.maxAmountMinor"]
    }
  };
}

function createDeterministicClock(timestamps: readonly string[]): () => string {
  let index = 0;
  return () => {
    const timestamp = timestamps[index];
    if (timestamp === undefined) {
      throw new Error("确定性时钟没有更多时间戳");
    }
    index += 1;
    return timestamp;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTextContent(message: Record<string, unknown> | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content.find(
    (part) => isRecord(part) && part.type === "text" && typeof part.text === "string"
  );
  return isRecord(text) && typeof text.text === "string" ? text.text : undefined;
}
