import { once } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  finalizeSuccessfulDecisionTaskResultV1,
  type ExecuteDecisionTaskCommandV1
} from "@choicemind/contracts/decision/v1";

import { createDecisionTaskExecutor } from "../src/decision-tasks/executor.js";
import { createCoreMindAgentRuntimeAdapter } from "../src/runtime/coremind-agent-runtime-adapter.js";
import type { AgentRuntimeRunOutputV1 } from "../src/runtime/port.js";

const providerBaseUrl = requireEnvironmentValue("CHOICEMIND_COREMIND_PROVIDER_BASE_URL");
const model = requireEnvironmentValue("CHOICEMIND_COREMIND_MODEL");
const executionRequestId = "coremind-qwen-local-smoke";
const decisionTaskId = "task-coremind-qwen-local-smoke";
const requirementRevisionId = "req-coremind-qwen-local-smoke-r1";
const summaryPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.artifacts/coremind-qwen-smoke.json"
);
const configDir = await mkdtemp(path.join(os.tmpdir(), "choicemind-qwen-smoke-"));
let proxy: RecordingProxy | undefined;

try {
  const requirementRevision = buildSyntheticRequirement();
  const draft: Omit<AgentRuntimeRunOutputV1, "runEvents"> = {
    candidates: [
      {
        contractType: "candidate",
        contractVersion: "1.0",
        candidateId: "candidate-coremind-qwen-synthetic",
        decisionTaskId,
        displayName: "合成笔记本候选",
        synthetic: true,
        identity: {
          model: "CM-QWEN-SYNTHETIC",
          sku: "CM-QWEN-SYNTHETIC-BASE",
          market: "CN",
          configuration: "仅用于本地 Tool 集成冒烟"
        },
        observedPrice: {
          amountMinor: 0,
          currency: "CNY",
          observedAt: "2026-08-20T09:00:00.000Z"
        }
      }
    ],
    claims: [
      {
        contractType: "claim",
        contractVersion: "1.0",
        claimId: "claim-coremind-qwen-model",
        decisionTaskId,
        subject: {
          subjectType: "CANDIDATE",
          subjectId: "candidate-coremind-qwen-synthetic"
        },
        predicate: "identity.model",
        value: { kind: "TEXT", value: "CM-QWEN-SYNTHETIC" },
        claimKind: "FACT_ASSERTION"
      }
    ],
    evidence: [
      {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-coremind-qwen-model",
        decisionTaskId,
        synthetic: true,
        source: {
          sourceKind: "SYNTHETIC",
          sourceId: "source-coremind-qwen-smoke",
          title: "本地 Qwen Tool 集成冒烟合成来源"
        },
        capturedAt: "2026-08-20T09:00:00.000Z",
        locator: { section: "synthetic", field: "identity.model" },
        excerpt: "合成候选型号为 CM-QWEN-SYNTHETIC",
        validUntil: "2026-08-27T09:00:00.000Z"
      }
    ],
    claimEvidenceLinks: [
      {
        contractType: "claim-evidence-link",
        contractVersion: "1.0",
        linkId: "link-coremind-qwen-model",
        decisionTaskId,
        claimId: "claim-coremind-qwen-model",
        evidenceId: "evidence-coremind-qwen-model",
        direction: "SUPPORTS"
      }
    ],
    decision: {
      contractType: "decision-revision",
      contractVersion: "1.0",
      decisionRevisionId: `decision-${decisionTaskId}-r1`,
      decisionTaskId,
      requirementRevisionId,
      revision: 1,
      status: "NEED_MORE_INFO",
      summary: "预算上限尚未确认，当前不能安全形成购买结论。",
      conditions: [],
      candidateDispositions: [],
      risks: [],
      evidenceIds: ["evidence-coremind-qwen-model"],
      criticalGaps: [
        {
          gapId: "gap-coremind-qwen-budget",
          key: "budget.maxAmountMinor",
          question: "你的最高预算是多少？",
          resolution: {
            resolutionType: "PROVIDE_REQUIREMENT",
            requirementKey: "budget.maxAmountMinor"
          }
        }
      ],
      assumptions: [],
      validFrom: "2026-08-20T09:00:00.000Z",
      validUntil: "2026-08-27T09:00:00.000Z",
      nextSteps: [
        {
          actionType: "PROVIDE_REQUIREMENT",
          requirementKey: "budget.maxAmountMinor",
          instruction: "请补充最高预算后重新执行决策"
        }
      ],
      synthetic: true
    }
  };
  const command: ExecuteDecisionTaskCommandV1 = {
    contractType: "execute-decision-task-command",
    contractVersion: "1.0",
    executionRequestId,
    requirementRevision: {
      ...requirementRevision,
      submittedText: [
        requirementRevision.submittedText,
        "这是本地模型 Tool 集成冒烟，不评估模型的消费研究能力。",
        "请只调用一次 submit_decision_draft，并把下面的合成草稿原样作为参数提交：",
        JSON.stringify(draft)
      ].join("\n")
    }
  };
  await assertSyntheticDraftAccepted(command, draft);
  const recordingProxy = await startRecordingProxy(providerBaseUrl, draft);
  proxy = recordingProxy;
  const executor = createDecisionTaskExecutor({
    runtime: createCoreMindAgentRuntimeAdapter({
      providerBaseUrl: recordingProxy.baseUrl,
      model,
      apiKey: "local-smoke",
      configDir,
      runTimeoutMs: 120_000
    })
  });

  const result = await executor.execute(command);
  await recordingProxy.close();
  proxy = undefined;
  const summary = result.ok
    ? {
        ok: true,
        provider: describeProvider(providerBaseUrl, model),
        taskState: result.taskStatus.state,
        decisionStatus: result.bundle.decision.status,
        selectedCandidateId: result.bundle.decision.selectedCandidateId,
        eventStates: result.runEvents.map((event) => event.taskState),
        providerObservations: recordingProxy.observations
      }
    : {
        ok: false,
        provider: describeProvider(providerBaseUrl, model),
        taskState: "taskStatus" in result ? result.taskStatus.state : undefined,
        errorCode: result.error.code,
        eventStates:
          "runEvents" in result ? result.runEvents.map((event) => event.taskState) : [],
        providerObservations: recordingProxy.observations
      };

  await saveSummary(summaryPath, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
} finally {
  await proxy?.close();
  // CoreMind 0.3.0 可能在 run 返回后继续收尾 RunState 写入。
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(configDir, { recursive: true, force: true });
}

async function assertSyntheticDraftAccepted(
  command: ExecuteDecisionTaskCommandV1,
  draft: Omit<AgentRuntimeRunOutputV1, "runEvents">
): Promise<void> {
  const agentRunId = `agent-run-${command.executionRequestId}`;
  const completedAt = "2026-08-20T09:00:01.000Z";
  const finalized = finalizeSuccessfulDecisionTaskResultV1({
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: true,
    taskStatus: {
      contractType: "decision-task-status",
      contractVersion: "1.0",
      decisionTaskId,
      agentRunId,
      state: "COMPLETED",
      terminal: true,
      latestEventSequence: 2,
      decisionRevisionId: draft.decision.decisionRevisionId,
      updatedAt: completedAt
    },
    runEvents: [
      {
        contractType: "run-event",
        contractVersion: "1.0",
        eventId: "event-coremind-qwen-preflight-1",
        decisionTaskId,
        agentRunId,
        sequence: 1,
        occurredAt: "2026-08-20T09:00:00.000Z",
        eventType: "TASK_STATE_CHANGED",
        taskState: "CREATED",
        summary: "已创建本地 Qwen 合同预检任务",
        synthetic: true
      },
      {
        contractType: "run-event",
        contractVersion: "1.0",
        eventId: "event-coremind-qwen-preflight-2",
        decisionTaskId,
        agentRunId,
        sequence: 2,
        occurredAt: completedAt,
        eventType: "RUNTIME_SUCCEEDED",
        taskState: "COMPLETED",
        summary: "本地 Qwen 合同预检任务已完成",
        synthetic: true
      }
    ],
    bundle: {
      requirementRevision: command.requirementRevision,
      ...draft
    }
  });

  if (!finalized.ok) {
    throw new Error(
      `本地 Qwen 冒烟草稿未通过 ChoiceMind 合同预检：${JSON.stringify(finalized.issues)}`
    );
  }
}

type ProviderObservations = {
  requestCount: number;
  responseStatuses: number[];
  finishReasons: string[];
  toolNames: string[];
  toolArgumentsJsonValid: boolean[];
  toolArgumentsMatchExpected: boolean[];
};

type RecordingProxy = Readonly<{
  baseUrl: string;
  observations: ProviderObservations;
  close: () => Promise<void>;
}>;

async function startRecordingProxy(
  targetBaseUrl: string,
  expectedToolArguments: unknown
): Promise<RecordingProxy> {
  const target = new URL(targetBaseUrl);
  const expectedCanonicalArguments = canonicalize(expectedToolArguments);
  const mutableObservations = {
    requestCount: 0,
    responseStatuses: [] as number[],
    finishReasons: [] as string[],
    toolNames: [] as string[],
    toolArgumentsJsonValid: [] as boolean[],
    toolArgumentsMatchExpected: [] as boolean[]
  };
  const activeControllers = new Set<AbortController>();
  const activeRequests = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const activeRequest = forwardProviderRequest({
      request,
      response,
      target,
      expectedCanonicalArguments,
      observations: mutableObservations,
      activeControllers
    }).finally(() => activeRequests.delete(activeRequest));
    activeRequests.add(activeRequest);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("本地记录代理未取得监听地址");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}${target.pathname.replace(/\/$/, "")}`,
    observations: mutableObservations,
    close: async () => {
      for (const controller of activeControllers) {
        controller.abort();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.allSettled([...activeRequests]);
    }
  };
}

async function forwardProviderRequest(options: {
  request: IncomingMessage;
  response: import("node:http").ServerResponse;
  target: URL;
  expectedCanonicalArguments: string;
  observations: ProviderObservations;
  activeControllers: Set<AbortController>;
}): Promise<void> {
  const { request, response } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.activeControllers.add(controller);
  request.once("aborted", abort);
  response.once("close", abort);
  options.observations.requestCount += 1;

  try {
    const requestBody = await readRequestBody(request);
    const upstream = await fetch(new URL(request.url ?? "/", options.target.origin), {
      method: request.method ?? "POST",
      headers: {
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        "content-type": request.headers["content-type"] ?? "application/json"
      },
      body: new Uint8Array(requestBody),
      signal: controller.signal
    });
    options.observations.responseStatuses.push(upstream.status);
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream"
    });

    const observer = createSseMetadataObserver(
      options.expectedCanonicalArguments,
      options.observations
    );
    const reader = upstream.body?.getReader();
    if (reader !== undefined) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          observer.push(chunk.value);
          if (!response.write(Buffer.from(chunk.value))) {
            await once(response, "drain", { signal: controller.signal });
          }
        }
      } finally {
        observer.finish();
        reader.releaseLock();
      }
    }
    response.end();
  } catch {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(502, { "content-type": "text/plain" });
    }
    if (!response.writableEnded && !response.destroyed) {
      response.end("本地记录代理转发失败");
    }
  } finally {
    request.off("aborted", abort);
    response.off("close", abort);
    options.activeControllers.delete(controller);
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createSseMetadataObserver(
  expectedCanonicalArguments: string,
  observations: {
    finishReasons: string[];
    toolNames: string[];
    toolArgumentsJsonValid: boolean[];
    toolArgumentsMatchExpected: boolean[];
  }
): Readonly<{ push: (chunk: Uint8Array) => void; finish: () => void }> {
  const argumentsByIndex = new Map<number, string>();
  const decoder = new TextDecoder();
  let pending = "";

  const observeLine = (line: string): void => {
    if (!line.startsWith("data: ") || line === "data: [DONE]") {
      return;
    }
    try {
      const chunk = JSON.parse(line.slice(6)) as unknown;
      if (!isRecord(chunk) || !Array.isArray(chunk.choices)) {
        return;
      }
      for (const choice of chunk.choices) {
        if (!isRecord(choice)) {
          continue;
        }
        if (typeof choice.finish_reason === "string") {
          observations.finishReasons.push(choice.finish_reason);
        }
        if (!isRecord(choice.delta) || !Array.isArray(choice.delta.tool_calls)) {
          continue;
        }
        for (const toolCall of choice.delta.tool_calls) {
          if (
            isRecord(toolCall) &&
            isRecord(toolCall.function) &&
            typeof toolCall.function.name === "string"
          ) {
            observations.toolNames.push(toolCall.function.name);
          }
          if (
            isRecord(toolCall) &&
            typeof toolCall.index === "number" &&
            isRecord(toolCall.function) &&
            typeof toolCall.function.arguments === "string"
          ) {
            argumentsByIndex.set(
              toolCall.index,
              `${argumentsByIndex.get(toolCall.index) ?? ""}${toolCall.function.arguments}`
            );
          }
        }
      }
    } catch {
      // 非 JSON SSE 行不属于本冒烟需要记录的元数据。
    }
  };

  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        observeLine(line);
      }
    },
    finish() {
      pending += decoder.decode();
      if (pending !== "") {
        observeLine(pending);
      }
      for (const argumentsText of argumentsByIndex.values()) {
        try {
          const parsed = JSON.parse(argumentsText) as unknown;
          observations.toolArgumentsJsonValid.push(true);
          observations.toolArgumentsMatchExpected.push(
            canonicalize(parsed) === expectedCanonicalArguments
          );
        } catch {
          observations.toolArgumentsJsonValid.push(false);
          observations.toolArgumentsMatchExpected.push(false);
        }
      }
    }
  };
}

function describeProvider(baseUrl: string, modelName: string): Readonly<{
  endpoint: string;
  model: string;
}> {
  const endpoint = new URL(baseUrl);
  return {
    endpoint: `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`,
    model: modelName
  };
}

async function saveSummary(filePath: string, summary: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildSyntheticRequirement(): ExecuteDecisionTaskCommandV1["requirementRevision"] {
  return {
    contractType: "requirement-revision",
    contractVersion: "1.0",
    requirementRevisionId,
    decisionTaskId,
    revision: 1,
    submittedText: "需要一台软件开发用笔记本，但最高预算尚未确认。",
    market: { country: "CN", currency: "CNY", locale: "zh-CN" },
    intendedUses: ["软件开发"],
    mustHaves: [],
    niceToHaves: [],
    mustNotHaves: [],
    unknowns: ["budget.maxAmountMinor"]
  };
}

function requireEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`缺少必需环境变量：${name}`);
  }
  return value;
}
