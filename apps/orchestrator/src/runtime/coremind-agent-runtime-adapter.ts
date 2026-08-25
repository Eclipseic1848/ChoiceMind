import { createHash, randomUUID } from "node:crypto";

import {
  CoreMindRuntime,
  defineTool,
  parseAndValidate,
  parseRunSnapshot,
  type CoreMindConfig,
  type CoreMindEvent,
  type ApprovalDecision,
  type RunStateRecord,
  type RunStore,
  type RunResult,
  type CoreMindToolDefinition
} from "coremind-ai";
import type { EgressGuard } from "@choicemind/security";
import type { RuntimeRecoveryStore } from "@choicemind/task-persistence";
import {
  canonicalizeJsonV1,
  evaluateRuntimeRecoveryPermissionV1,
  type CandidateV1,
  type ClaimEvidenceLinkV1,
  type ClaimV1,
  type DecisionRevisionV1,
  type EvidenceV1,
  type EffectReceiptV1,
  type RuntimeSnapshotV1,
  type RunEventV1
} from "@choicemind/contracts/decision/v1";

import type {
  AgentRuntimeControlResultV1,
  AgentRuntimeRunCommandV1,
  AgentRuntimeRunOutputV1,
  AgentRuntimePausedOutcomeV1,
  AgentRuntimePort
} from "./port.js";

type CoreMindAgentRuntimeAdapterOptions = Readonly<{
  providerBaseUrl: string;
  model: string;
  configDir?: string;
  cwd?: string;
  apiKey?: string;
  egressGuard: EgressGuard;
  runTimeoutMs?: number;
  now?: () => string;
  permissionsMode?: "full" | "ask";
  approveTool?: () => Promise<ApprovalDecision>;
  recoveryStore?: Pick<
    RuntimeRecoveryStore,
    | "putRawSnapshot"
    | "loadRawSnapshot"
    | "saveRecoveryFacts"
    | "loadRecoveryFacts"
    | "recordRuntimeRunning"
    | "claimRuntimeResume"
    | "completeRuntimeControl"
    | "claimRuntimeCancel"
    | "isRuntimeCancelled"
  >;
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

type AgentRuntimeControlStateV1 = Extract<
  AgentRuntimeControlResultV1,
  Readonly<{ ok: true }>
>["state"];
type InternalRunState = AgentRuntimeControlStateV1 | "FAILED";

type CoreMindRecoveryEnvelopeV1 = Readonly<{
  envelopeType: "coremind-runtime-recovery";
  envelopeVersion: 1;
  nativeSnapshot: ReturnType<typeof parseRunSnapshot>;
  runStateRecords: readonly RunStateRecord[];
}>;

const CORE_MIND_PROVIDER_API_KEY_ENV = "CHOICEMIND_COREMIND_PROVIDER_API_KEY";

export function createCoreMindAgentRuntimeAdapter(
  options: CoreMindAgentRuntimeAdapterOptions
): AgentRuntimePort {
  validateProviderOptions(options);

  const listeners = new Map<string, Set<(event: RunEventV1) => void>>();
  const eventSequences = new Map<string, number>();
  const rawSnapshots = new Map<string, unknown>();
  const recoveryFacts = new Map<
    string,
    Readonly<{ snapshot: RuntimeSnapshotV1; effectReceipts: readonly EffectReceiptV1[] }>
  >();
  const activeControllers = new Map<string, AbortController>();
  const runStates = new Map<string, InternalRunState>();
  const eventHistory = new Map<string, RunEventV1[]>();
  const resumedSnapshotIds = new Map<string, string>();
  const controlLeaseDurationMs = (options.runTimeoutMs ?? 10_000) + 5_000;

  return {
    async run(command, securityContext) {
      const controllerId = randomUUID();
      const result = await executeCoreMind(command, securityContext, controllerId);

      if (result.result.outcome.status !== "succeeded") {
        throw new Error("CoreMind 未完成一次有效的 Decision 草稿 Tool 提交");
      }

      const output = buildSuccessfulOutput(command, result);
      await options.recoveryStore?.completeRuntimeControl(
        command.agentRunId,
        controllerId,
        undefined,
        undefined,
        "COMPLETED",
        output.runEvents
      );
      return output;
    },
    async runPersistent(command, securityContext) {
      const controllerId = randomUUID();
      const result = await executeCoreMind(command, securityContext, controllerId);

      if (result.result.outcome.status === "paused") {
        const paused = await buildPausedOutcome(command, result);
        await options.recoveryStore?.completeRuntimeControl(
          command.agentRunId,
          controllerId,
          paused.snapshot.snapshotId,
          paused.snapshot.snapshotId,
          paused.state,
          paused.runEvents
        );
        return paused;
      }

      if (result.result.outcome.status !== "succeeded") {
        if (runStates.get(command.agentRunId) === "CANCELLED") {
          return {
            state: "FAILED_FINAL",
            summary: "Agent Runtime 已取消"
          };
        }
        const failure = {
          state:
            result.result.outcome.status === "timeout" ? "FAILED_RETRYABLE" : "FAILED_FINAL",
          summary: "Agent Runtime 未完成执行"
        } as const;
        await options.recoveryStore?.completeRuntimeControl(
          command.agentRunId,
          controllerId,
          undefined,
          undefined,
          "FAILED",
          []
        );
        return failure;
      }

      const output = buildSuccessfulOutput(command, result);
      await options.recoveryStore?.completeRuntimeControl(
        command.agentRunId,
        controllerId,
        undefined,
        undefined,
        "COMPLETED",
        output.runEvents
      );
      return output;
    },
    async resume(command, securityContext) {
      const controllerId = randomUUID();
      const resumedSnapshotId = resumedSnapshotIds.get(command.agentRunId);
      const currentState = runStates.get(command.agentRunId);
      if (
        options.recoveryStore === undefined &&
        resumedSnapshotId === command.snapshot.snapshotId &&
        (currentState === "RUNNING" || currentState === "COMPLETED")
      ) {
        return {
          ok: true,
          changed: false,
          state: currentState,
          runEvents: eventHistory.get(command.agentRunId) ?? []
        };
      }
      if (
        options.recoveryStore === undefined &&
        resumedSnapshotId !== undefined &&
        resumedSnapshotId !== command.snapshot.snapshotId
      ) {
        return {
          ok: false,
          code: "RUNTIME_RESUME_DENIED",
          message: "该 Agent Run 已绑定另一权威恢复快照"
        };
      }

      const authoritativeFacts = options.recoveryStore
        ? await options.recoveryStore.loadRecoveryFacts(command.snapshot.snapshotId)
        : recoveryFacts.get(command.snapshot.snapshotId);
      if (
        authoritativeFacts === undefined ||
        canonicalizeJsonV1(authoritativeFacts.snapshot) !== canonicalizeJsonV1(command.snapshot) ||
        authoritativeFacts.snapshot.decisionTaskId !== command.decisionTaskId ||
        authoritativeFacts.snapshot.agentRunId !== command.agentRunId
      ) {
        return {
          ok: false,
          code: "RUNTIME_SNAPSHOT_INVALID",
          message: "调用参数与权威 Runtime 恢复事实不一致"
        };
      }

      const recoveryPermission = evaluateRuntimeRecoveryPermissionV1({
        snapshot: authoritativeFacts.snapshot,
        effectReceipts: authoritativeFacts.effectReceipts
      });

      if (recoveryPermission.decision !== "RESUME_ALLOWED") {
        return {
          ok: false,
          code: "RUNTIME_RESUME_DENIED",
          message:
            recoveryPermission.decision === "MANUAL_VERIFICATION_REQUIRED"
              ? "副作用状态需要人工核验"
              : "Runtime 快照不允许原位恢复",
          recoveryPermission
        };
      }

      const rawEnvelope = options.recoveryStore
        ? await options.recoveryStore.loadRawSnapshot(authoritativeFacts.snapshot.rawSnapshot)
        : rawSnapshots.get(authoritativeFacts.snapshot.rawSnapshot.objectKey);
      if (rawEnvelope === undefined) {
        return {
          ok: false,
          code: "RUNTIME_SNAPSHOT_INVALID",
          message: "Runtime 原始快照不可用"
        };
      }

      let envelope: CoreMindRecoveryEnvelopeV1;
      try {
        envelope = parseCoreMindRecoveryEnvelopeV1(rawEnvelope);
      } catch {
        if (
          isRecord(rawEnvelope) &&
          (rawEnvelope.envelopeVersion !== 1 ||
            (isRecord(rawEnvelope.nativeSnapshot) && rawEnvelope.nativeSnapshot.schemaVersion !== 1))
        ) {
          return {
            ok: false,
            code: "RUNTIME_PROTOCOL_UNSUPPORTED",
            message: "Runtime Snapshot Protocol 版本不受支持"
          };
        }
        return {
          ok: false,
          code: "RUNTIME_SNAPSHOT_INVALID",
          message: "Runtime 原始快照未通过 Protocol v1 校验"
        };
      }

      const digest = createHash("sha256")
        .update(canonicalizeJsonV1(envelope), "utf8")
        .digest("hex");
      if (digest !== authoritativeFacts.snapshot.rawSnapshot.digest) {
        return {
          ok: false,
          code: "RUNTIME_SNAPSHOT_INVALID",
          message: "Runtime 原始快照 SHA-256 不一致"
        };
      }

      if (options.recoveryStore) {
        const claim = await options.recoveryStore.claimRuntimeResume(
          command.agentRunId,
          authoritativeFacts.snapshot.snapshotId,
          controllerId,
          controlLeaseDurationMs
        );
        if (claim.status === "BUSY") {
          return {
            ok: false,
            code: "RUNTIME_RESUME_IN_PROGRESS",
            message: "Agent Run 正由另一恢复进程处理"
          };
        }
        if (claim.status === "UNCHANGED") {
          if (claim.state === "RUNNING" || claim.state === "COMPLETED") {
            return {
              ok: true,
              changed: false,
              state: claim.state,
              runEvents: claim.runEvents
            };
          }
        }
        if (claim.status !== "ACQUIRED") {
          return {
            ok: false,
            code: "RUNTIME_RESUME_DENIED",
            message: "Agent Run 当前状态不允许恢复"
          };
        }
      }

      resumedSnapshotIds.set(command.agentRunId, command.snapshot.snapshotId);
      const execution = await executeCoreMind(
        command,
        securityContext,
        controllerId,
        envelope
      );
      if (execution.result.outcome.status === "succeeded") {
        const event = createPublicRunEvent(
          command,
          "COMPLETED",
          "RUNTIME_SUCCEEDED",
          "Runtime 已从权威快照恢复并完成",
          execution.completedAt
        );
        await options.recoveryStore?.completeRuntimeControl(
          command.agentRunId,
          controllerId,
          authoritativeFacts.snapshot.snapshotId,
          authoritativeFacts.snapshot.snapshotId,
          "COMPLETED",
          [event]
        );
        return {
          ok: true,
          changed: true,
          state: "COMPLETED",
          runEvents: [event],
          ...(command.requirementRevision === undefined
            ? {}
            : { outcome: buildSuccessfulOutput({ ...command, requirementRevision: command.requirementRevision }, execution) })
        };
      }
      if (execution.result.outcome.status === "paused") {
        const paused = await buildPausedOutcome(command, execution);
        await options.recoveryStore?.completeRuntimeControl(
          command.agentRunId,
          controllerId,
          authoritativeFacts.snapshot.snapshotId,
          paused.snapshot.snapshotId,
          paused.state,
          paused.runEvents
        );
        return {
          ok: true,
          changed: true,
          state: paused.state,
          runEvents: paused.runEvents,
          outcome: paused
        };
      }
      if (runStates.get(command.agentRunId) === "CANCELLED") {
        return {
          ok: false,
          code: "RUNTIME_CANCEL_RACE",
          message: "Runtime 恢复执行已被取消"
        };
      }

      await options.recoveryStore?.completeRuntimeControl(
        command.agentRunId,
        controllerId,
        authoritativeFacts.snapshot.snapshotId,
        authoritativeFacts.snapshot.snapshotId,
        "FAILED",
        []
      );
      return {
        ok: false,
        code: "RUNTIME_FAILED",
        message: "Runtime 恢复执行失败"
      };
    },
    async cancel(command) {
      if (runStates.get(command.agentRunId) === "CANCELLED") {
        return {
          ok: true,
          changed: false,
          state: "CANCELLED",
          runEvents: eventHistory.get(command.agentRunId) ?? []
        };
      }

      const controller = activeControllers.get(command.agentRunId);
      const event = createPublicRunEvent(
          {
            decisionTaskId: command.decisionTaskId,
            agentRunId: command.agentRunId
          },
          "CANCELLED",
          "TASK_STATE_CHANGED",
          "Runtime 已取消",
          (options.now ?? (() => new Date().toISOString()))(),
          false
        );
      if (options.recoveryStore) {
        const claim = await options.recoveryStore.claimRuntimeCancel(
          command.agentRunId,
          command.cancellationId,
          [event]
        );
        if (claim.status === "UNCHANGED") {
          return {
            ok: true,
            changed: false,
            state: "CANCELLED",
            runEvents: claim.runEvents
          };
        }
        if (claim.status === "DENIED") {
          return {
            ok: false,
            code: "RUNTIME_CANCEL_RACE",
            message: "Runtime 已进入不可取消的终态"
          };
        }
      } else if (controller === undefined) {
        return {
          ok: false,
          code: "RUNTIME_CANCEL_RACE",
          message: "Runtime 当前没有可取消的运行"
        };
      }

      recordPublicRunEvent(event);
      if (controller !== undefined) {
        controller.abort();
      }
      runStates.set(command.agentRunId, "CANCELLED");
        return {
          ok: true,
          changed: true,
          state: "CANCELLED",
          runEvents: eventHistory.get(command.agentRunId) ?? [event]
        };
    },
    subscribe(agentRunId, listener) {
      const runListeners = listeners.get(agentRunId) ?? new Set();
      runListeners.add(listener);
      listeners.set(agentRunId, runListeners);

      return () => {
        runListeners.delete(listener);
        if (runListeners.size === 0) {
          listeners.delete(agentRunId);
        }
      };
    }
  };

  async function executeCoreMind(
    command: Pick<AgentRuntimeRunCommandV1, "decisionTaskId" | "agentRunId"> &
      Partial<Pick<AgentRuntimeRunCommandV1, "contractVersion" | "requirementRevision">>,
    securityContext: Parameters<AgentRuntimePort["run"]>[1],
    controllerId: string,
    recoveryEnvelope?: CoreMindRecoveryEnvelopeV1
  ): Promise<
    Readonly<{
      result: RunResult;
      capture: DraftCapture;
      createdAt: string;
      completedAt: string;
      runStateRecords: readonly RunStateRecord[];
    }>
  > {
      if (securityContext === undefined) {
        throw new Error("CoreMind Provider 外传缺少服务端安全上下文");
      }
      const now = options.now ?? (() => new Date().toISOString());
      const createdAt = now();
      const capture: DraftCapture = { calls: 0 };
      const config = buildCoreMindConfig(options);
      const tool = createDecisionDraftTool(capture);
      const runStore = createMemoryRunStore(recoveryEnvelope?.runStateRecords ?? []);
      const controller = new AbortController();
      await options.recoveryStore?.recordRuntimeRunning(
        command.agentRunId,
        controllerId,
        controlLeaseDurationMs
      );
      activeControllers.set(command.agentRunId, controller);
      runStates.set(command.agentRunId, "RUNNING");
      let checkingCancellation = false;
      const cancellationPoll = options.recoveryStore
        ? setInterval(() => {
            if (checkingCancellation) return;
            checkingCancellation = true;
            void options.recoveryStore
              ?.isRuntimeCancelled(command.agentRunId)
              .then((cancelled) => {
                if (cancelled) controller.abort();
              })
              .catch(() => controller.abort())
              .finally(() => {
                checkingCancellation = false;
              });
          }, 50)
        : undefined;
      cancellationPoll?.unref();
      const egress = await (async () => {
        try {
          return await options.egressGuard.execute({
            userId: securityContext.userId,
            operationId: securityContext.operationId,
            operation: "INVOKE_PROVIDER",
            confirmation: securityContext.egressConfirmation,
            correlationId: securityContext.correlationId,
            destinationUrl: options.providerBaseUrl,
            method: "POST",
            perform: async () => {
              const runtime = await CoreMindRuntime.create({
                config,
                configDir: options.configDir ?? options.cwd ?? process.cwd(),
                cwd: options.cwd ?? process.cwd(),
                ...(recoveryEnvelope === undefined
                  ? { initialPrompt: JSON.stringify(command) }
                  : { resumeRunId: recoveryEnvelope.nativeSnapshot.runId }),
                runStore,
                events: (event) => publishCoreMindEvent(command, event),
                ...(options.approveTool === undefined
                  ? {}
                  : { approveTool: options.approveTool }),
                signal: controller.signal,
                toolDefinitions: [tool],
                maxSteps: options.permissionsMode === "ask" ? 3 : 2,
                stepTimeoutMs: options.runTimeoutMs ?? 10_000,
                env: {
                  [CORE_MIND_PROVIDER_API_KEY_ENV]:
                    options.apiKey ??
                    process.env[CORE_MIND_PROVIDER_API_KEY_ENV] ??
                    "offline"
                }
              });
              return runtime.run();
            }
          });
        } finally {
          if (cancellationPoll !== undefined) clearInterval(cancellationPoll);
          activeControllers.delete(command.agentRunId);
        }
      })();
      if (egress.status !== "COMPLETED") {
        throw new Error(`CoreMind Provider 外传策略未允许：${egress.status}`);
      }
      const result = egress.value;
      if (runStates.get(command.agentRunId) !== "CANCELLED") {
        runStates.set(command.agentRunId, mapRunControlState(result));
      }

      return {
        result,
        capture,
        createdAt,
        completedAt: now(),
        runStateRecords: await runStore.read(result.runId)
      };
  }

  function buildSuccessfulOutput(
    command: AgentRuntimeRunCommandV1,
    execution: Readonly<{
      result: RunResult;
      capture: DraftCapture;
      createdAt: string;
      completedAt: string;
    }>
  ): AgentRuntimeRunOutputV1 {
    if (execution.capture.calls !== 1 || execution.capture.draft === undefined) {
      throw new Error("CoreMind 未完成一次有效的 Decision 草稿 Tool 提交");
    }

    return buildRuntimeOutput(
      command,
      execution.capture.draft,
      execution.createdAt,
      execution.completedAt
    );
  }

  async function buildPausedOutcome(
    command: Pick<AgentRuntimeRunCommandV1, "decisionTaskId" | "agentRunId">,
    execution: Readonly<{ result: RunResult; runStateRecords: readonly RunStateRecord[] }>
  ): Promise<AgentRuntimePausedOutcomeV1> {
    const nativeSnapshot = parseRunSnapshot(execution.result.snapshot);
    if (execution.runStateRecords.length === 0) {
      throw new Error("CoreMind 暂停结果缺少可恢复 RunState");
    }
    const rawSnapshot: CoreMindRecoveryEnvelopeV1 = {
      envelopeType: "coremind-runtime-recovery",
      envelopeVersion: 1,
      nativeSnapshot,
      runStateRecords: execution.runStateRecords
    };
    const serializedSnapshot = canonicalizeJsonV1(rawSnapshot);
    const digest = createHash("sha256").update(serializedSnapshot, "utf8").digest("hex");
    const rawSnapshotReference = options.recoveryStore
      ? await options.recoveryStore.putRawSnapshot(rawSnapshot)
      : {
          algorithm: "sha256" as const,
          digest,
          objectKey: `runtime-snapshots/sha256/${digest}`
        };
    if (options.recoveryStore === undefined) {
      rawSnapshots.set(rawSnapshotReference.objectKey, rawSnapshot);
    }
    const nativeCheckpoint = nativeSnapshot.checkpoints.at(-1);
    const journalCheckpoint = execution.runStateRecords.at(-1);
    if (journalCheckpoint === undefined) {
      throw new Error("CoreMind 暂停快照缺少持久 RunState Checkpoint");
    }
    const checkpoint = {
      checkpointId:
        nativeCheckpoint?.checkpointId ??
        `coremind-runstate-${nativeSnapshot.runId}-${journalCheckpoint.sequence}`,
      sequence: nativeCheckpoint
        ? nativeSnapshot.operation.transitionSequence
        : journalCheckpoint.sequence,
      persistedAt: nativeCheckpoint?.timestamp ?? journalCheckpoint.timestamp
    };

    const taskState = mapPausedTaskState(execution.result.outcome.finishReason);
    const snapshot: RuntimeSnapshotV1 = {
      contractType: "runtime-snapshot",
      contractVersion: "1.0",
      snapshotId: `snapshot-${digest}`,
      decisionTaskId: command.decisionTaskId,
      agentRunId: command.agentRunId,
      taskState,
      resumable: nativeSnapshot.resumable,
      runtimeProtocol: { name: "agent-runtime-protocol", version: "1" },
      rawSnapshot: rawSnapshotReference,
      checkpoint: {
        contractType: "checkpoint-ref",
        contractVersion: "1.0",
        checkpointId: checkpoint.checkpointId,
        decisionTaskId: command.decisionTaskId,
        agentRunId: command.agentRunId,
        sequence: checkpoint.sequence,
        persistedAt: checkpoint.persistedAt
      },
      capturedAt: nativeSnapshot.operation.updatedAt
    };
    const effectReceipts = nativeSnapshot.trace.flatMap((entry): EffectReceiptV1[] => {
      if (!isEffectReceiptEvent(entry.event)) {
        return [];
      }

      return [
        {
          contractType: "effect-receipt",
          contractVersion: "1.0",
          effectReceiptId: `receipt-${entry.eventId}`,
          decisionTaskId: command.decisionTaskId,
          agentRunId: command.agentRunId,
          checkpointId: checkpoint.checkpointId,
          effectId: entry.event.idempotencyKey,
          state: entry.event.status,
          recordedAt: entry.timestamp
        }
      ];
    });
    const existingEvents = eventHistory.get(command.agentRunId) ?? [];
    const runEvents =
      existingEvents.at(-1)?.taskState === taskState
        ? existingEvents
        : [
            ...existingEvents,
            createPublicRunEvent(
              command,
              taskState,
              "TASK_STATE_CHANGED",
              pausedSummary(taskState),
              nativeSnapshot.operation.updatedAt
            )
          ];

    const outcome = {
      contractType: "runtime-paused-outcome",
      contractVersion: "1.0",
      state: taskState,
      summary: pausedSummary(taskState),
      snapshot,
      effectReceipts,
      runEvents
    } satisfies AgentRuntimePausedOutcomeV1;
    if (options.recoveryStore) {
      await options.recoveryStore.saveRecoveryFacts(snapshot, effectReceipts);
    } else {
      recoveryFacts.set(snapshot.snapshotId, { snapshot, effectReceipts });
    }
    return outcome;
  }

  function publishCoreMindEvent(
    command: Pick<AgentRuntimeRunCommandV1, "decisionTaskId" | "agentRunId">,
    event: CoreMindEvent
  ): void {
    if (event.type !== "approval_required") {
      return;
    }

    const publicEvent = createPublicRunEvent(
      command,
      "PAUSED_PERMISSION",
      "TASK_STATE_CHANGED",
      "Runtime 等待外部操作授权",
      (options.now ?? (() => new Date().toISOString()))()
    );

    for (const listener of listeners.get(command.agentRunId) ?? []) {
      listener(publicEvent);
    }
  }

  function createPublicRunEvent(
    command: Pick<AgentRuntimeRunCommandV1, "decisionTaskId" | "agentRunId">,
    taskState: RunEventV1["taskState"],
    eventType: RunEventV1["eventType"],
    summary: string,
    occurredAt: string,
    record = true
  ): RunEventV1 {
    const sequence = (eventSequences.get(command.agentRunId) ?? 0) + 1;
    const publicEvent: RunEventV1 = {
      contractType: "run-event",
      contractVersion: "1.0",
      eventId: `event-runtime-${command.agentRunId}-${sequence}`,
      decisionTaskId: command.decisionTaskId,
      agentRunId: command.agentRunId,
      sequence,
      occurredAt,
      eventType,
      taskState,
      summary,
      synthetic: true
    };
    if (record) {
      recordPublicRunEvent(publicEvent);
    }

    return publicEvent;
  }

  function recordPublicRunEvent(publicEvent: RunEventV1): void {
    eventSequences.set(publicEvent.agentRunId, publicEvent.sequence);
    const history = eventHistory.get(publicEvent.agentRunId) ?? [];
    history.push(publicEvent);
    eventHistory.set(publicEvent.agentRunId, history);
  }
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
      maxTurns: options.permissionsMode === "ask" ? 3 : 2,
      maxSteps: options.permissionsMode === "ask" ? 3 : 2,
      runTimeoutMs: options.runTimeoutMs ?? 10_000,
      maxToolCalls: 2,
      maxToolFailures: options.permissionsMode === "ask" ? 1 : 0,
      maxRetries: 0
    },
    permissions: {
      mode: options.permissionsMode ?? "full",
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

function mapPausedTaskState(
  reason: string
): AgentRuntimePausedOutcomeV1["state"] {
  const normalized = reason.toLowerCase();

  if (normalized.includes("approval") || normalized.includes("permission")) {
    return "PAUSED_PERMISSION";
  }
  if (normalized.includes("login") || normalized.includes("source")) {
    return "PAUSED_SOURCE_LOGIN";
  }
  if (normalized.includes("limit") || normalized.includes("budget")) {
    return "PAUSED_LIMIT";
  }

  return "PAUSED_USER";
}

function mapRunControlState(result: RunResult): InternalRunState {
  if (result.outcome.status === "succeeded") {
    return "COMPLETED";
  }
  if (result.outcome.status === "aborted") {
    return "CANCELLED";
  }
  if (result.outcome.status === "paused") {
    return mapPausedTaskState(result.outcome.finishReason);
  }

  return "FAILED";
}

function pausedSummary(state: AgentRuntimePausedOutcomeV1["state"]): string {
  const summaries: Record<AgentRuntimePausedOutcomeV1["state"], string> = {
    PAUSED_USER: "Runtime 等待用户补充信息",
    PAUSED_PERMISSION: "Runtime 等待外部操作授权",
    PAUSED_SOURCE_LOGIN: "Runtime 等待数据源登录",
    PAUSED_LIMIT: "Runtime 因资源限制暂停"
  };

  return summaries[state];
}

function isEffectReceiptEvent(event: unknown): event is Readonly<{
  type: "effect_receipt";
  idempotencyKey: string;
  status: EffectReceiptV1["state"];
}> {
  return (
    isRecord(event) &&
    event.type === "effect_receipt" &&
    typeof event.idempotencyKey === "string" &&
    (event.status === "not_started" ||
      event.status === "started" ||
      event.status === "committed" ||
      event.status === "unknown")
  );
}

function parseCoreMindRecoveryEnvelopeV1(value: unknown): CoreMindRecoveryEnvelopeV1 {
  if (
    !isRecord(value) ||
    value.envelopeType !== "coremind-runtime-recovery" ||
    value.envelopeVersion !== 1 ||
    !Array.isArray(value.runStateRecords)
  ) {
    throw new Error("CoreMind Recovery Envelope 不合法");
  }

  const nativeSnapshot = parseRunSnapshot(value.nativeSnapshot);
  const runStateRecords = value.runStateRecords.map((record, index) => {
    if (
      !isRecord(record) ||
      record.version !== 1 ||
      record.runId !== nativeSnapshot.runId ||
      record.sequence !== index + 1 ||
      typeof record.timestamp !== "string" ||
      !isRunStateKind(record.kind)
    ) {
      throw new Error("CoreMind RunState 不合法");
    }
    return record as unknown as RunStateRecord;
  });
  if (runStateRecords.length === 0) {
    throw new Error("CoreMind RunState 为空");
  }

  return {
    envelopeType: "coremind-runtime-recovery",
    envelopeVersion: 1,
    nativeSnapshot,
    runStateRecords
  };
}

function createMemoryRunStore(initialRecords: readonly RunStateRecord[]): RunStore {
  const records = new Map<string, RunStateRecord[]>();
  for (const record of initialRecords) {
    const items = records.get(record.runId) ?? [];
    items.push(structuredClone(record));
    records.set(record.runId, items);
  }

  return {
    async append(record) {
      const items = records.get(record.runId) ?? [];
      const duplicate = items.find((item) => item.sequence === record.sequence);
      if (duplicate !== undefined) {
        if (canonicalizeJsonV1(duplicate) === canonicalizeJsonV1(record)) {
          return;
        }
        throw new Error("CoreMind RunState sequence 冲突");
      }
      if (record.sequence !== (items.at(-1)?.sequence ?? 0) + 1) {
        throw new Error("CoreMind RunState sequence 不连续");
      }
      items.push(structuredClone(record));
      records.set(record.runId, items);
    },
    async read(runId) {
      return structuredClone(records.get(runId) ?? []);
    }
  };
}

function isRunStateKind(value: unknown): value is RunStateRecord["kind"] {
  return (
    value === "start" ||
    value === "resume" ||
    value === "event" ||
    value === "checkpoint" ||
    value === "loop" ||
    value === "operation" ||
    value === "pause" ||
    value === "finish"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
