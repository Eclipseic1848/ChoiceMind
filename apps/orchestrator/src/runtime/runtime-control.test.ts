import { CoreMindRuntime, type RunResult } from "coremind-ai";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEgressGuard } from "@choicemind/security";
import type { RuntimeRecoveryStore } from "@choicemind/task-persistence";

import { createCoreMindAgentRuntimeAdapter } from "./coremind-agent-runtime-adapter.js";
import type { AgentRuntimeRunCommandV1, AgentRuntimeSecurityContext } from "./port.js";
import { buildSyntheticLaptopRunOutput } from "./synthetic-laptop-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentRuntimePort 控制与事件 seam", () => {
  it("把 CoreMind 的真实暂停事实映射为公开事件和可校验快照", async () => {
    vi.spyOn(CoreMindRuntime, "create").mockImplementation(async (options) => ({
      run: async () => {
        await seedPausedRunStore(options.runStore);
        options.events?.({
          type: "approval_required",
          approvalId: "approval-1",
          runId: "coremind-run-1",
          agent: "decision",
          tool: "external_lookup",
          args: { secret: "不得进入公开事件" },
          risk: "high",
          effect: {
            operations: ["external"],
            paths: [],
            urls: [],
            reversible: false,
            declared: true
          }
        });
        return buildPausedCoreMindResult();
      }
    }) as unknown as Awaited<ReturnType<typeof CoreMindRuntime.create>>);
    const adapter = createAdapter();
    const observed: unknown[] = [];
    const unsubscribe = adapter.subscribe("run-1", (event) => observed.push(event));

    const result = await adapter.runPersistent?.(buildCommand(), buildSecurityContext());
    unsubscribe();

    expect(result).toMatchObject({
      state: "PAUSED_PERMISSION",
      snapshot: {
        contractType: "runtime-snapshot",
        contractVersion: "1.0",
        agentRunId: "run-1",
        resumable: true,
        runtimeProtocol: { name: "agent-runtime-protocol", version: "1" },
        rawSnapshot: {
          algorithm: "sha256",
          digest: expect.stringMatching(/^[0-9a-f]{64}$/)
        }
      },
      effectReceipts: [
        expect.objectContaining({ effectId: "provider-call-1", state: "started" })
      ]
    });
    expect(observed).toEqual([
      expect.objectContaining({
        agentRunId: "run-1",
        taskState: "PAUSED_PERMISSION",
        summary: "Runtime 等待外部操作授权"
      })
    ]);
    expect(JSON.stringify(observed)).not.toContain("不得进入公开事件");
  });

  it("started 阻断恢复；committed 只复用 ChoiceMind Tool 结果，不承诺第三方恰好一次或零重复计费", async () => {
    const create = vi.spyOn(CoreMindRuntime, "create");
    let creation = 0;
    let resumeRunId: string | undefined;
    create.mockImplementation(async (options) => {
      creation += 1;
      resumeRunId = options.resumeRunId;
      return {
        run: async () => {
          if (options.resumeRunId === undefined) {
            await seedPausedRunStore(options.runStore);
            return creation === 1
              ? buildPausedCoreMindResult("started")
              : buildPausedCoreMindResult("committed", "submit_decision_draft");
          }
          return buildCompletedCoreMindResult();
        }
      } as unknown as Awaited<ReturnType<typeof CoreMindRuntime.create>>;
    });
    const recoveryStore = createMemoryRecoveryStore();
    const firstAdapter = createAdapter(recoveryStore);
    const paused = await firstAdapter.runPersistent?.(buildCommand(), buildSecurityContext());
    if (paused === undefined || !("snapshot" in paused)) {
      throw new Error("测试前置条件必须形成暂停快照");
    }

    const adapter = createAdapter(recoveryStore);
    const blocked = await adapter.resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: paused.snapshot,
        effectReceipts: paused.effectReceipts
      },
      buildSecurityContext()
    );

    expect(blocked).toMatchObject({
      ok: false,
      code: "RUNTIME_RESUME_DENIED",
      recoveryPermission: {
        decision: "MANUAL_VERIFICATION_REQUIRED",
        reason: "EFFECT_STATUS_UNSAFE"
      }
    });
    expect(create).toHaveBeenCalledTimes(1);

    const callerTampering = await adapter.resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: paused.snapshot,
        effectReceipts: paused.effectReceipts.map((receipt) => ({
          ...receipt,
          state: "committed" as const,
          result: {
            algorithm: "sha256" as const,
            digest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            objectKey:
              "effect-results/sha256/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            decisionTaskId: receipt.decisionTaskId,
            agentRunId: receipt.agentRunId,
            checkpointId: receipt.checkpointId,
            effectId: receipt.effectId
          }
        }))
      },
      buildSecurityContext()
    );
    expect(callerTampering).toMatchObject({
      ok: false,
      code: "RUNTIME_RESUME_DENIED",
      recoveryPermission: { decision: "MANUAL_VERIFICATION_REQUIRED" }
    });
    expect(create).toHaveBeenCalledTimes(1);

    const safeRecoveryStore = createMemoryRecoveryStore();
    const safeFirstAdapter = createAdapter(safeRecoveryStore);
    const safePaused = await safeFirstAdapter.runPersistent?.(
      buildCommand(),
      buildSecurityContext()
    );
    if (safePaused === undefined || !("snapshot" in safePaused)) {
      throw new Error("测试前置条件必须形成安全暂停快照");
    }
    const safeReceipt = safePaused.effectReceipts[0];
    if (safeReceipt === undefined) {
      throw new Error("测试前置条件必须形成副作用收据");
    }
    const output = buildSyntheticLaptopRunOutput(buildCommand());
    const result = await safeRecoveryStore.putEffectResult(
      {
        decisionTaskId: safeReceipt.decisionTaskId,
        agentRunId: safeReceipt.agentRunId,
        checkpointId: safeReceipt.checkpointId,
        effectId: safeReceipt.effectId
      },
      {
        effectResultType: "choicemind-decision-draft",
        effectResultVersion: 1,
        tool: "submit_decision_draft",
        draft: {
          candidates: output.candidates,
          claims: output.claims,
          evidence: output.evidence,
          claimEvidenceLinks: output.claimEvidenceLinks,
          decision: output.decision
        }
      }
    );
    const committedReceipt = { ...safeReceipt, state: "committed" as const, result };
    await safeRecoveryStore.saveRecoveryFacts(safePaused.snapshot, [committedReceipt]);

    const missingResult = await createAdapter({
      ...safeRecoveryStore,
      async loadEffectResult() {
        return undefined;
      }
    }).resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: safePaused.snapshot,
        effectReceipts: [committedReceipt]
      },
      buildSecurityContext()
    );
    expect(missingResult).toMatchObject({
      ok: false,
      code: "RUNTIME_RESUME_DENIED",
      recoveryPermission: {
        decision: "MANUAL_VERIFICATION_REQUIRED",
        reason: "EFFECT_RESULT_UNAVAILABLE"
      }
    });

    const corruptStoredResult = await createAdapter({
      ...safeRecoveryStore,
      async loadEffectResult() {
        throw Object.assign(new Error("副作用结果摘要不一致"), {
          code: "EFFECT_RESULT_INVALID"
        });
      }
    }).resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: safePaused.snapshot,
        effectReceipts: [committedReceipt]
      },
      buildSecurityContext()
    );
    expect(corruptStoredResult).toMatchObject({
      ok: false,
      code: "RUNTIME_RESUME_DENIED",
      recoveryPermission: {
        decision: "MANUAL_VERIFICATION_REQUIRED",
        reason: "EFFECT_RESULT_INVALID"
      }
    });

    const tamperedResult = await createAdapter({
      ...safeRecoveryStore,
      async loadEffectResult() {
        return { forged: true };
      }
    }).resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: safePaused.snapshot,
        effectReceipts: [committedReceipt]
      },
      buildSecurityContext()
    );
    expect(tamperedResult).toMatchObject({
      ok: false,
      code: "RUNTIME_RESUME_DENIED",
      recoveryPermission: {
        decision: "MANUAL_VERIFICATION_REQUIRED",
        reason: "EFFECT_RESULT_INVALID"
      }
    });
    expect(create).toHaveBeenCalledTimes(2);

    const unsupportedResultReference = await safeRecoveryStore.putEffectResult(
      {
        decisionTaskId: safeReceipt.decisionTaskId,
        agentRunId: safeReceipt.agentRunId,
        checkpointId: safeReceipt.checkpointId,
        effectId: safeReceipt.effectId
      },
      { effectResultType: "unsupported-result", effectResultVersion: 1 }
    );
    const unsupportedResultReceipt = {
      ...safeReceipt,
      state: "committed" as const,
      result: unsupportedResultReference
    };
    await safeRecoveryStore.saveRecoveryFacts(safePaused.snapshot, [unsupportedResultReceipt]);
    const unsupportedResultType = await createAdapter(safeRecoveryStore).resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: safePaused.snapshot,
        effectReceipts: [unsupportedResultReceipt]
      },
      buildSecurityContext()
    );
    expect(unsupportedResultType).toMatchObject({
      ok: false,
      code: "RUNTIME_RESUME_DENIED",
      recoveryPermission: {
        decision: "MANUAL_VERIFICATION_REQUIRED",
        reason: "EFFECT_RESULT_INVALID"
      }
    });
    expect(create).toHaveBeenCalledTimes(2);
    await safeRecoveryStore.saveRecoveryFacts(safePaused.snapshot, [committedReceipt]);

    const busyAdapter = createAdapter({
      ...safeRecoveryStore,
      async claimRuntimeResume() {
        return { status: "BUSY", state: "RUNNING", runEvents: [] };
      }
    });
    const busy = await busyAdapter.resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: safePaused.snapshot,
        effectReceipts: [committedReceipt]
      },
      buildSecurityContext()
    );
    expect(busy).toMatchObject({ ok: false, code: "RUNTIME_RESUME_IN_PROGRESS" });
    expect(create).toHaveBeenCalledTimes(2);

    const unsupportedAdapter = createAdapter({
      ...safeRecoveryStore,
      async loadRawSnapshot(reference) {
        const stored = await safeRecoveryStore.loadRawSnapshot(reference);
        return typeof stored === "object" && stored !== null
          ? { ...stored, envelopeVersion: 2 }
          : stored;
      }
    });
    const unsupported = await unsupportedAdapter.resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: safePaused.snapshot,
        effectReceipts: [committedReceipt]
      },
      buildSecurityContext()
    );
    expect(unsupported).toMatchObject({
      ok: false,
      code: "RUNTIME_PROTOCOL_UNSUPPORTED"
    });
    expect(create).toHaveBeenCalledTimes(2);

    const adapterForResume = createAdapter(safeRecoveryStore);
    const resumed = await adapterForResume.resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: safePaused.snapshot,
        effectReceipts: [committedReceipt],
        requirementRevision: buildCommand().requirementRevision
      },
      buildSecurityContext()
    );

    expect(resumed).toMatchObject({
      ok: true,
      changed: true,
      state: "COMPLETED",
      outcome: { decision: { decisionTaskId: "task-1" } }
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(resumeRunId).toBe("coremind-run-1");

    const repeated = await createAdapter(safeRecoveryStore).resume(
      {
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        snapshot: safePaused.snapshot,
        effectReceipts: [committedReceipt]
      },
      buildSecurityContext()
    );
    expect(repeated).toMatchObject({ ok: true, changed: false, state: "COMPLETED" });
    expect(create).toHaveBeenCalledTimes(3);
    await expect(
      adapterForResume.cancel({
        contractVersion: "1.0",
        decisionTaskId: "task-1",
        agentRunId: "run-1",
        cancellationId: "cancel-after-complete"
      })
    ).resolves.toMatchObject({ ok: false, code: "RUNTIME_CANCEL_RACE" });
  });

  it("取消活动运行且重复 cancel 幂等，不把中止伪装为完成", async () => {
    let runtimeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });
    vi.spyOn(CoreMindRuntime, "create").mockImplementation(async (options) => ({
      run: async () => {
        runtimeStarted?.();
        if (options.signal === undefined) {
          throw new Error("Adapter 必须向 CoreMind 传递取消信号");
        }
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return buildAbortedCoreMindResult();
      }
    }) as unknown as Awaited<ReturnType<typeof CoreMindRuntime.create>>);
    const recoveryStore = createMemoryRecoveryStore();
    const adapter = createAdapter(recoveryStore);
    const execution = adapter.runPersistent?.(buildCommand(), buildSecurityContext());
    await started;
    const cancelCommand = {
      contractVersion: "1.0" as const,
      decisionTaskId: "task-1",
      agentRunId: "run-1",
      cancellationId: "cancel-1"
    };

    const first = await adapter.cancel(cancelCommand);
    const repeated = await createAdapter(recoveryStore).cancel(cancelCommand);
    await execution;

    expect(first).toMatchObject({ ok: true, changed: true, state: "CANCELLED" });
    expect(repeated).toMatchObject({ ok: true, changed: false, state: "CANCELLED" });
    if (first.ok) {
      expect(first.runEvents.at(-1)).toMatchObject({
        eventType: "TASK_STATE_CHANGED",
        taskState: "CANCELLED",
        summary: "Runtime 已取消"
      });
      expect(first.runEvents.at(-1)).not.toMatchObject({ taskState: "COMPLETED" });
    }
  });

  it("not_started 不复用不存在结果，恢复异常后的新 controller 不伪报旧尝试", async () => {
    let creation = 0;
    vi.spyOn(CoreMindRuntime, "create").mockImplementation(async (options) => {
      creation += 1;
      if (creation === 1) {
        return {
          run: async () => {
            await seedPausedRunStore(options.runStore);
            return buildPausedCoreMindResult("not_started");
          }
        } as unknown as Awaited<ReturnType<typeof CoreMindRuntime.create>>;
      }
      throw new Error("恢复进程异常退出");
    });
    const recoveryStore = createMemoryRecoveryStore();
    const controllerIds: string[] = [];
    const observedStore = {
      ...recoveryStore,
      async claimRuntimeResume(
        ...args: Parameters<RuntimeRecoveryStore["claimRuntimeResume"]>
      ) {
        controllerIds.push(args[2]);
        return recoveryStore.claimRuntimeResume(...args);
      }
    };
    const adapter = createAdapter(observedStore);
    const paused = await adapter.runPersistent?.(buildCommand(), buildSecurityContext());
    if (paused === undefined || !("snapshot" in paused)) {
      throw new Error("测试前置条件必须形成安全暂停快照");
    }
    const command = {
      contractVersion: "1.0" as const,
      decisionTaskId: "task-1",
      agentRunId: "run-1",
      snapshot: paused.snapshot,
      effectReceipts: paused.effectReceipts
    };

    await expect(adapter.resume(command, buildSecurityContext())).rejects.toThrow(
      "恢复进程异常退出"
    );
    await expect(adapter.resume(command, buildSecurityContext())).resolves.toMatchObject({
      ok: false,
      code: "RUNTIME_RESUME_IN_PROGRESS"
    });
    expect(controllerIds).toHaveLength(2);
    expect(controllerIds[1]).not.toBe(controllerIds[0]);
    expect(creation).toBe(2);
  });
});

function createAdapter(
  recoveryStore?: Pick<
    RuntimeRecoveryStore,
    | "putRawSnapshot"
    | "loadRawSnapshot"
    | "putEffectResult"
    | "loadEffectResult"
    | "saveRecoveryFacts"
    | "loadRecoveryFacts"
    | "recordRuntimeRunning"
    | "claimRuntimeResume"
    | "completeRuntimeControl"
    | "claimRuntimeCancel"
    | "isRuntimeCancelled"
  >
) {
  return createCoreMindAgentRuntimeAdapter({
    providerBaseUrl: "http://127.0.0.1:6013/v1",
    model: "offline-model",
    egressGuard: createEgressGuard({
      appendRecord: async () => undefined,
      nextId: () => "egress-runtime-control",
      now: () => new Date("2026-08-24T12:00:00.000Z")
    }),
    now: () => "2026-08-24T12:00:00.000Z",
    ...(recoveryStore === undefined ? {} : { recoveryStore })
  });
}

function createMemoryRecoveryStore(): Pick<
  RuntimeRecoveryStore,
  | "putRawSnapshot"
  | "loadRawSnapshot"
  | "putEffectResult"
  | "loadEffectResult"
  | "saveRecoveryFacts"
  | "loadRecoveryFacts"
  | "recordRuntimeRunning"
  | "claimRuntimeResume"
  | "completeRuntimeControl"
  | "claimRuntimeCancel"
  | "isRuntimeCancelled"
> {
  const objects = new Map<string, unknown>();
  const effectResults = new Map<string, unknown>();
  const facts = new Map<string, Parameters<RuntimeRecoveryStore["saveRecoveryFacts"]>>();
  const controls = new Map<
    string,
    {
      snapshotId?: string;
      state: import("@choicemind/task-persistence").RuntimeControlState;
      runEvents: readonly import("@choicemind/contracts/decision/v1").RunEventV1[];
      controllerId?: string;
      leaseExpiresAt?: number;
    }
  >();

  return {
    async putRawSnapshot(payload) {
      const digest = createHash("sha256")
        .update(canonicalize(payload), "utf8")
        .digest("hex");
      const objectKey = `runtime-snapshots/sha256/${digest}`;
      objects.set(objectKey, payload);
      return { algorithm: "sha256", digest, objectKey };
    },
    async loadRawSnapshot(reference) {
      return objects.get(reference.objectKey);
    },
    async putEffectResult(identity, payload) {
      const digest = createHash("sha256")
        .update(canonicalize(payload), "utf8")
        .digest("hex");
      const objectKey = `effect-results/sha256/${digest}`;
      effectResults.set(objectKey, payload);
      return { algorithm: "sha256", digest, objectKey, ...identity };
    },
    async loadEffectResult(reference) {
      return effectResults.get(reference.objectKey);
    },
    async saveRecoveryFacts(snapshot, effectReceipts) {
      facts.set(snapshot.snapshotId, [snapshot, effectReceipts]);
      const current = controls.get(snapshot.agentRunId);
      if (current?.state === "RUNNING" && current.snapshotId === undefined) {
        current.snapshotId = snapshot.snapshotId;
      } else if (current === undefined || current.state.startsWith("PAUSED_")) {
        controls.set(snapshot.agentRunId, {
          snapshotId: snapshot.snapshotId,
          state: snapshot.taskState as import("@choicemind/task-persistence").RuntimeControlState,
          runEvents: []
        });
      }
    },
    async loadRecoveryFacts(snapshotId) {
      const stored = facts.get(snapshotId);
      return stored === undefined
        ? undefined
        : { snapshot: stored[0], effectReceipts: stored[1] };
    },
    async recordRuntimeRunning(agentRunId, controllerId, leaseDurationMs) {
      const current = controls.get(agentRunId);
      if (
        current === undefined ||
        (current.state === "RUNNING" &&
          current.snapshotId === undefined &&
          (current.controllerId === controllerId ||
            (current.leaseExpiresAt ?? 0) < Date.now()))
      ) {
        controls.set(agentRunId, {
          state: "RUNNING",
          runEvents: [],
          controllerId,
          leaseExpiresAt: Date.now() + leaseDurationMs
        });
      }
    },
    async claimRuntimeResume(agentRunId, snapshotId, controllerId, leaseDurationMs) {
      const current = controls.get(agentRunId);
      if (current === undefined || current.snapshotId !== snapshotId) {
        return { status: "DENIED", state: current?.state ?? "FAILED", runEvents: [] };
      }
      if (current.state === "RUNNING") {
        if (current.controllerId !== controllerId && (current.leaseExpiresAt ?? 0) >= Date.now()) {
          return { status: "BUSY", state: current.state, runEvents: current.runEvents };
        }
        if (current.controllerId === controllerId) {
          return { status: "UNCHANGED", state: current.state, runEvents: current.runEvents };
        }
      }
      if (current.state === "COMPLETED") {
        return { status: "UNCHANGED", state: current.state, runEvents: current.runEvents };
      }
      if (current.state !== "RUNNING" && !current.state.startsWith("PAUSED_")) {
        return { status: "DENIED", state: current.state, runEvents: current.runEvents };
      }
      current.state = "RUNNING";
      current.runEvents = [];
      current.controllerId = controllerId;
      current.leaseExpiresAt = Date.now() + leaseDurationMs;
      return { status: "ACQUIRED", state: "RUNNING", runEvents: [] };
    },
    async completeRuntimeControl(
      agentRunId,
      controllerId,
      expectedSnapshotId,
      nextSnapshotId,
      state,
      runEvents
    ) {
      const current = controls.get(agentRunId);
      if (
        current?.state !== "RUNNING" ||
        current.controllerId !== controllerId ||
        current.snapshotId !== expectedSnapshotId
      ) {
        if (
          current?.state === state &&
          current.snapshotId === nextSnapshotId &&
          canonicalize(current.runEvents) === canonicalize(runEvents)
        ) {
          return;
        }
        throw new Error("测试 Runtime 控制 CAS 失败");
      }
      controls.set(agentRunId, {
        ...(nextSnapshotId === undefined ? {} : { snapshotId: nextSnapshotId }),
        state,
        runEvents
      });
    },
    async claimRuntimeCancel(agentRunId, _cancellationId, runEvents) {
      const current = controls.get(agentRunId);
      if (current === undefined) {
        return { status: "DENIED", state: "FAILED", runEvents: [] };
      }
      if (current.state === "CANCELLED") {
        return { status: "UNCHANGED", state: "CANCELLED", runEvents: current.runEvents };
      }
      if (current.state === "COMPLETED" || current.state === "FAILED") {
        return { status: "DENIED", state: current.state, runEvents: current.runEvents };
      }
      current.state = "CANCELLED";
      current.runEvents = runEvents;
      delete current.controllerId;
      delete current.leaseExpiresAt;
      return { status: "ACQUIRED", state: "CANCELLED", runEvents };
    },
    async isRuntimeCancelled(agentRunId) {
      return controls.get(agentRunId)?.state === "CANCELLED";
    }
  };
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildCommand(): AgentRuntimeRunCommandV1 {
  return {
    contractVersion: "1.0",
    decisionTaskId: "task-1",
    agentRunId: "run-1",
    requirementRevision: {
      contractType: "requirement-revision",
      contractVersion: "1.0",
      requirementRevisionId: "requirement-1",
      decisionTaskId: "task-1",
      revision: 1,
      submittedText: "需要一台开发用笔记本",
      market: { country: "CN", currency: "CNY", locale: "zh-CN" },
      intendedUses: ["软件开发"],
      mustHaves: [],
      niceToHaves: [],
      mustNotHaves: [],
      unknowns: []
    }
  };
}

function buildSecurityContext(): AgentRuntimeSecurityContext {
  return {
    userId: "user-1",
    operationId: "operation-1",
    correlationId: "correlation-1",
    egressConfirmation: { operationId: "operation-1", userId: "user-1" }
  };
}

function buildPausedCoreMindResult(
  receiptState: "not_started" | "started" | "committed" = "started",
  tool = "external_lookup"
): RunResult {
  const operation = {
    schemaVersion: 1 as const,
    operationId: "operation-coremind-1",
    runId: "coremind-run-1",
    correlationId: "correlation-coremind-1",
    state: "paused" as const,
    transitionSequence: 3,
    createdAt: "2026-08-24T11:59:59.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    pauseReason: "approval_required"
  };
  const outcome = { status: "paused" as const, finishReason: "approval_required" };
  const trace = [
    {
      eventId: "coremind-event-1",
      runId: "coremind-run-1",
      sequence: 1,
      timestamp: "2026-08-24T12:00:00.000Z",
      event: {
        type: "effect_receipt" as const,
        idempotencyKey: "provider-call-1",
        tool,
        status: receiptState
      }
    }
  ];
  const snapshot = {
    schemaVersion: 1 as const,
    runId: "coremind-run-1",
    operation,
    outcome,
    metrics: buildMetrics(),
    evaluation: buildEvaluation(),
    releaseReadiness: { ready: false, blockers: ["运行已暂停"], warnings: [] },
    trace,
    checkpoints: [
      {
        version: 1 as const,
        checkpointId: "coremind-checkpoint-1",
        runId: "coremind-run-1",
        timestamp: "2026-08-24T12:00:00.000Z",
        tool,
        reversible: false,
        snapshotFile: ".coremind/checkpoints/coremind-checkpoint-1.json"
      }
    ],
    artifacts: [],
    extensions: [],
    resumable: true
  };

  return {
    runId: "coremind-run-1",
    operation,
    outcome,
    metrics: buildMetrics(),
    evaluation: buildEvaluation(),
    releaseReadiness: { ready: false, blockers: ["运行已暂停"], warnings: [] },
    trace,
    checkpoints: snapshot.checkpoints,
    outputs: new Map(),
    messages: new Map(),
    transcript: "",
    snapshot
  };
}

async function seedPausedRunStore(runStore: import("coremind-ai").RunStore | undefined) {
  if (runStore === undefined) {
    throw new Error("Adapter 必须提供可持久化 RunStore");
  }
  const timestamp = "2026-08-24T12:00:00.000Z";
  await runStore.append({
    version: 1,
    runId: "coremind-run-1",
    sequence: 1,
    timestamp,
    kind: "start",
    payload: { configFingerprint: "test", initialPrompt: "test" }
  });
  await runStore.append({
    version: 1,
    runId: "coremind-run-1",
    sequence: 2,
    timestamp,
    kind: "pause",
    payload: { reason: "approval_required" }
  });
}

function buildCompletedCoreMindResult(): RunResult {
  const paused = buildPausedCoreMindResult();
  const { pauseReason: _pauseReason, ...operationWithoutPause } = paused.operation;
  const operation = {
    ...operationWithoutPause,
    state: "completed" as const,
    transitionSequence: 5,
    updatedAt: "2026-08-24T12:01:00.000Z"
  };
  const outcome = { status: "succeeded" as const, finishReason: "completed" };
  const snapshot = {
    ...paused.snapshot,
    operation,
    outcome,
    resumable: false
  };

  return { ...paused, operation, outcome, snapshot };
}

function buildAbortedCoreMindResult(): RunResult {
  const completed = buildCompletedCoreMindResult();
  const operation = {
    ...completed.operation,
    state: "failed" as const,
    updatedAt: "2026-08-24T12:00:30.000Z",
    failureReason: "aborted"
  };
  const outcome = { status: "aborted" as const, finishReason: "aborted" };

  return {
    ...completed,
    operation,
    outcome,
    snapshot: { ...completed.snapshot, operation, outcome, resumable: false }
  };
}

function buildMetrics() {
  return {
    durationMs: 1,
    turns: 1,
    steps: { total: 1, succeeded: 0, failed: 0 },
    toolCalls: 1,
    toolFailures: 0,
    retries: 0,
    outputChars: 0
  };
}

function buildEvaluation() {
  return {
    profile: "development" as const,
    scenarioResults: [],
    qualityScores: {},
    securityFindings: []
  };
}
