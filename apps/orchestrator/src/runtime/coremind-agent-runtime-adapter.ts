import {
  CoreMindRuntime,
  defineTool,
  parseAndValidate,
  type CoreMindConfig,
  type CoreMindToolDefinition
} from "coremind-ai";
import type {
  CandidateV1,
  ClaimEvidenceLinkV1,
  ClaimV1,
  DecisionRevisionV1,
  EvidenceV1,
  RunEventV1
} from "@choicemind/contracts/decision/v1";

import type {
  AgentRuntimeRunCommandV1,
  AgentRuntimeRunOutputV1,
  AgentRuntimeRunPort
} from "./port.js";

type CoreMindAgentRuntimeAdapterOptions = Readonly<{
  providerBaseUrl: string;
  model: string;
  configDir?: string;
  cwd?: string;
  apiKey?: string;
  runTimeoutMs?: number;
  now?: () => string;
}>;

type CoreMindDecisionDraft = Readonly<{
  candidates: readonly CandidateV1[];
  claims: readonly ClaimV1[];
  evidence: readonly EvidenceV1[];
  claimEvidenceLinks: readonly ClaimEvidenceLinkV1[];
  decision: DecisionRevisionV1;
}>;

type DraftCapture = {
  draft?: CoreMindDecisionDraft;
  calls: number;
};

const CORE_MIND_PROVIDER_API_KEY_ENV = "CHOICEMIND_COREMIND_PROVIDER_API_KEY";

export function createCoreMindAgentRuntimeAdapter(
  options: CoreMindAgentRuntimeAdapterOptions
): AgentRuntimeRunPort {
  validateProviderOptions(options);

  return {
    async run(command) {
      const now = options.now ?? (() => new Date().toISOString());
      const createdAt = now();
      const capture: DraftCapture = { calls: 0 };
      const config = buildCoreMindConfig(options);
      const tool = createDecisionDraftTool(capture);
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: options.configDir ?? options.cwd ?? process.cwd(),
        cwd: options.cwd ?? process.cwd(),
        initialPrompt: JSON.stringify(command),
        toolDefinitions: [tool],
        maxSteps: 2,
        stepTimeoutMs: options.runTimeoutMs ?? 10_000,
        env: {
          [CORE_MIND_PROVIDER_API_KEY_ENV]:
            options.apiKey ?? process.env[CORE_MIND_PROVIDER_API_KEY_ENV] ?? "offline"
        }
      });
      const result = await runtime.run();

      if (result.outcome.status !== "succeeded" || capture.calls !== 1 || capture.draft === undefined) {
        throw new Error("CoreMind 未完成一次有效的 Decision 草稿 Tool 提交");
      }

      return buildRuntimeOutput(command, capture.draft, createdAt, now());
    }
  };
}

function buildCoreMindConfig(options: CoreMindAgentRuntimeAdapterOptions): CoreMindConfig {
  validateProviderOptions(options);

  return parseAndValidate({
    schemaVersion: 2,
    name: "choicemind-coremind-adapter",
    description: "ChoiceMind P0-07A 离线 CoreMind Adapter",
    provider: {
      id: "choicemind-provider",
      name: "ChoiceMind CoreMind Provider",
      baseUrl: options.providerBaseUrl,
      model: options.model,
      api: "openai-completions",
      apiKeyEnv: CORE_MIND_PROVIDER_API_KEY_ENV
    },
    agents: {
      decision: {
        description: "只提交结构化 ChoiceMind Decision 草稿",
        systemPrompt:
          "你是 ChoiceMind 的结构化决策代理。必须只调用一次 submit_decision_draft，参数只能包含 candidates、claims、evidence、claimEvidenceLinks、decision；不得输出或提交 claimAssessments、runEvents、taskStatus、ok 或其他字段。Tool 成功后停止。",
        tools: [],
        options: { thinkingLevel: "off" }
      }
    },
    defaultAgent: "decision",
    runtime: {
      maxTurns: 2,
      maxSteps: 2,
      runTimeoutMs: options.runTimeoutMs ?? 10_000,
      maxToolCalls: 1,
      maxToolFailures: 0,
      maxRetries: 0
    },
    permissions: {
      mode: "full",
      workspaceOnly: true,
      network: "deny"
    },
    quality: { profile: "development" }
  }).config;
}

function createDecisionDraftTool(
  capture: DraftCapture
): CoreMindToolDefinition<Record<string, unknown>> {
  return defineTool<Record<string, unknown>>({
    name: "submit_decision_draft",
    label: "提交 Decision 草稿",
    description: "提交一次不可信的 Candidate、Claim、Evidence、Link 和 Decision 草稿。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["candidates", "claims", "evidence", "claimEvidenceLinks", "decision"],
      properties: {
        candidates: { type: "array", items: { type: "object" } },
        claims: { type: "array", items: { type: "object" } },
        evidence: { type: "array", items: { type: "object" } },
        claimEvidenceLinks: { type: "array", items: { type: "object" } },
        decision: { type: "object" }
      }
    },
    effect: { operations: ["read"], reversible: true },
    execute(args) {
      if (capture.calls > 0) {
        throw new Error("submit_decision_draft 只能调用一次");
      }

      capture.draft = assertDecisionDraftEnvelope(args);
      capture.calls += 1;
      return { text: "Decision 草稿已接收", details: { accepted: true } };
    }
  });
}

function buildRuntimeOutput(
  command: AgentRuntimeRunCommandV1,
  draft: CoreMindDecisionDraft,
  createdAt: string,
  completedAt: string
): AgentRuntimeRunOutputV1 {
  const taskId = command.decisionTaskId;
  const agentRunId = command.agentRunId;
  const runEvents: readonly RunEventV1[] = [
    createRunEvent(taskId, agentRunId, 1, createdAt, "CREATED", "已创建 CoreMind 决策任务"),
    {
      contractType: "run-event",
      contractVersion: "1.0",
      eventId: `event-coremind-${taskId}-2`,
      decisionTaskId: taskId,
      agentRunId,
      sequence: 2,
      occurredAt: completedAt,
      eventType: "RUNTIME_SUCCEEDED",
      taskState: "COMPLETED",
      summary: "CoreMind 决策任务已完成",
      synthetic: true
    }
  ];

  return {
    candidates: draft.candidates,
    claims: draft.claims,
    evidence: draft.evidence,
    claimEvidenceLinks: draft.claimEvidenceLinks,
    decision: draft.decision,
    runEvents
  };
}

function createRunEvent(
  decisionTaskId: string,
  agentRunId: string,
  sequence: number,
  occurredAt: string,
  taskState: "CREATED",
  summary: string
): RunEventV1 {
  return {
    contractType: "run-event",
    contractVersion: "1.0",
    eventId: `event-coremind-${decisionTaskId}-${sequence}`,
    decisionTaskId,
    agentRunId,
    sequence,
    occurredAt,
    eventType: "TASK_STATE_CHANGED",
    taskState,
    summary,
    synthetic: true
  };
}

function assertDecisionDraftEnvelope(value: unknown): CoreMindDecisionDraft {
  if (!isRecord(value)) {
    throw new Error("Decision 草稿必须是对象");
  }

  const allowedKeys = new Set([
    "candidates",
    "claims",
    "evidence",
    "claimEvidenceLinks",
    "decision"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Decision 草稿包含不允许的字段");
  }

  if (
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.claims) ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.claimEvidenceLinks) ||
    !isRecord(value.decision)
  ) {
    throw new Error("Decision 草稿缺少结构化领域字段");
  }

  return value as CoreMindDecisionDraft;
}

function validateProviderOptions(options: CoreMindAgentRuntimeAdapterOptions): void {
  if (typeof options.providerBaseUrl !== "string" || options.providerBaseUrl.trim() === "") {
    throw new Error("CoreMind Provider 地址不能为空");
  }

  try {
    new URL(options.providerBaseUrl);
  } catch {
    throw new Error("CoreMind Provider 地址必须是有效 URL");
  }

  if (typeof options.model !== "string" || options.model.trim() === "") {
    throw new Error("CoreMind Provider 模型不能为空");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
