"use client";

import {
  type ClaimValueV1,
  type CompletedDecisionTaskStatusV1,
  createUnknownDecisionExecutionResultV1,
  type DecisionTaskResultV1,
  type DecisionTaskSnapshotV1,
  decodeDecisionTaskResultV1,
  decodeDecisionTaskSnapshotV1,
  decodePersistedRunEventV1,
  decodeRuntimeControlStatusV1,
  type FailedDecisionTaskStatusV1,
  getDecisionTaskResultHttpStatusV1,
  type PersistedRunEventV1,
  type RuntimeControlStatusV1,
  type SuccessfulDecisionTaskResultV1
} from "@choicemind/contracts/decision/v1";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

const defaultRequirement = "预算不超过 8000 元，至少 32 GiB 内存和 1 TiB 存储。";

export function DecisionFlow() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DecisionTaskResultV1 | null>(null);
  const [snapshot, setSnapshot] = useState<DecisionTaskSnapshotV1 | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [persistedEvents, setPersistedEvents] = useState<readonly PersistedRunEventV1[]>([]);
  const [observationError, setObservationError] = useState(false);
  const [controlPending, setControlPending] = useState<"RESUME" | "CANCEL" | null>(null);
  const [controlStatus, setControlStatus] = useState<RuntimeControlStatusV1 | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<"idle" | "connected" | "reconnecting">(
    "idle"
  );
  const activeControl = useRef<
    Readonly<{ controlRequestId: string; acceptedAt?: string }> | undefined
  >(undefined);

  const loadTask = useCallback(async (decisionTaskId: string, settleControl = false) => {
    try {
      const response = await fetch(`/api/decision-tasks/${encodeURIComponent(decisionTaskId)}`, {
        cache: "no-store"
      });
      const responseBody: unknown = await response.json();
      const decodedSnapshot = decodeDecisionTaskSnapshotV1(responseBody);

      if (
        response.status === 200 &&
        decodedSnapshot.ok &&
        decodedSnapshot.value.decisionTaskId === decisionTaskId
      ) {
        setSnapshot(decodedSnapshot.value);
        setResult(null);
        setObservationError(false);
        if (decodedSnapshot.value.state.startsWith("PAUSED_")) {
          if (settleControl) {
            setControlPending(null);
            setControlStatus(null);
            activeControl.current = undefined;
          }
        } else {
          setControlPending(null);
          if (decodedSnapshot.value.state !== "RUNNING") {
            setControlStatus(null);
            activeControl.current = undefined;
          }
        }
        return;
      }

      const decodedResult = decodeDecisionTaskResultV1(responseBody);

      if (
        response.status === 200 &&
        decodedResult.ok &&
        "taskStatus" in decodedResult.value &&
        decodedResult.value.taskStatus.decisionTaskId === decisionTaskId
      ) {
        setSnapshot(null);
        setResult(decodedResult.value);
        setObservationError(false);
        setControlPending(null);
        setControlStatus(null);
        activeControl.current = undefined;
        return;
      }

      throw new Error("任务响应不符合合同");
    } catch {
      setObservationError(true);
    }
  }, []);

  useEffect(() => {
    const decisionTaskId = new URL(window.location.href).searchParams.get("decisionTaskId");

    if (decisionTaskId !== null && decisionTaskId.length > 0) {
      setTaskId(decisionTaskId);
    }
  }, []);

  useEffect(() => {
    if (taskId === null) {
      return;
    }

    const decisionTaskId = taskId;
    let active = true;
    let lastEventCursor: string | undefined;
    let reconnectTimer: number | undefined;
    let source: EventSource | undefined;
    setConnectionState("idle");
    void loadTask(decisionTaskId);

    function connect() {
      const after = lastEventCursor === undefined ? "" : `?after=${encodeURIComponent(lastEventCursor)}`;
      const nextSource = new EventSource(
        `/api/decision-tasks/${encodeURIComponent(decisionTaskId)}/events${after}`
      );
      source = nextSource;
      nextSource.onopen = () => {
        if (active) {
          setConnectionState("connected");
        }
      };
      nextSource.onmessage = (message) => {
        if (!active) {
          return;
        }

        let responseBody: unknown;

        try {
          responseBody = JSON.parse(message.data) as unknown;
        } catch {
          return;
        }

        const decoded = decodePersistedRunEventV1(responseBody);

        if (!decoded.ok || decoded.value.event.decisionTaskId !== decisionTaskId) {
          return;
        }

        if (
          lastEventCursor === undefined ||
          BigInt(decoded.value.cursor) > BigInt(lastEventCursor)
        ) {
          lastEventCursor = decoded.value.cursor;
        }

        setPersistedEvents((current) => mergePersistedEvent(current, decoded.value));
        setConnectionState("connected");
        const acceptedAt = activeControl.current?.acceptedAt;
        const eventAt = Date.parse(decoded.value.event.occurredAt);
        const settleControl =
          acceptedAt !== undefined &&
          Number.isFinite(eventAt) &&
          eventAt >= Date.parse(acceptedAt);
        void loadTask(decisionTaskId, settleControl);
      };
      nextSource.onerror = () => {
        if (!active) {
          return;
        }

        setConnectionState("reconnecting");
        nextSource.close();
        reconnectTimer = window.setTimeout(connect, 1_000);
      };
    }

    connect();

    return () => {
      active = false;
      source?.close();

      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
    };
  }, [loadTask, taskId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    setSnapshot(null);
    setPersistedEvents([]);
    setObservationError(false);
    const id = crypto.randomUUID();

    try {
      const response = await fetch("/api/decision-tasks/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractType: "execute-decision-task-command",
          contractVersion: "1.0",
          executionRequestId: `exec-${id}`,
          requirementRevision: {
            contractType: "requirement-revision",
            contractVersion: "1.0",
            requirementRevisionId: `req-${id}-r1`,
            decisionTaskId: `task-${id}`,
            revision: 1,
            submittedText: defaultRequirement,
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
        })
      });
      const responseBody: unknown = await response.json();
      const decodedSnapshot = decodeDecisionTaskSnapshotV1(responseBody);

      if (
        response.status === 202 &&
        decodedSnapshot.ok &&
        decodedSnapshot.value.decisionTaskId === `task-${id}`
      ) {
        const acceptedTaskId = decodedSnapshot.value.decisionTaskId;
        const url = new URL(window.location.href);
        url.searchParams.set("decisionTaskId", acceptedTaskId);
        window.history.replaceState(null, "", url);
        setSnapshot(decodedSnapshot.value);
        setTaskId(acceptedTaskId);
        return;
      }

      const decodedResult = decodeDecisionTaskResultV1(responseBody);
      const taskResult = decodedResult.ok ? decodedResult.value : undefined;

      setResult(
        taskResult !== undefined &&
          response.status === getDecisionTaskResultHttpStatusV1(taskResult)
          ? taskResult
          : createUnknownWebResult("error-web-response-status-mismatch")
      );
    } catch {
      setResult(createUnknownWebResult("error-web-decision-execution-status-unknown"));
    } finally {
      setPending(false);
    }
  }

  async function requestRuntimeControl(action: "RESUME" | "CANCEL") {
    if (taskId === null || snapshot === null || !("runtimeSnapshotId" in snapshot)) {
      return;
    }

    const controlRequestId = `control-${action.toLowerCase()}-${crypto.randomUUID()}`;
    const requestBody =
      action === "RESUME"
        ? {
            contractType: "runtime-resume-request",
            contractVersion: "1.0",
            controlRequestId,
            runtimeSnapshotId: snapshot.runtimeSnapshotId
          }
        : {
            contractType: "runtime-cancel-request",
            contractVersion: "1.0",
            controlRequestId,
            cancellationId: `cancel-${crypto.randomUUID()}`
          };

    setControlPending(action);
    setControlStatus(null);
    setControlError(null);
    activeControl.current = { controlRequestId };
    let keepPending = false;

    try {
      const response = await fetch(
        `/api/decision-tasks/${encodeURIComponent(taskId)}/${action.toLowerCase()}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody)
        }
      );
      const responseBody: unknown = await response.json();
      const decoded = decodeRuntimeControlStatusV1(responseBody);
      const expectedStatus = action === "RESUME" ? 202 : 200;

      if (
        response.status !== expectedStatus ||
        !decoded.ok ||
        decoded.value.controlRequestId !== controlRequestId ||
        decoded.value.decisionTaskId !== taskId ||
        decoded.value.action !== action
      ) {
        throw new Error("控制响应不符合合同");
      }

      setControlStatus(decoded.value);
      keepPending = decoded.value.state === "ACCEPTED" || decoded.value.state === "RUNNING";
      activeControl.current = keepPending
        ? { controlRequestId, acceptedAt: decoded.value.updatedAt }
        : undefined;
    } catch {
      setControlError(action === "RESUME" ? "恢复请求状态暂时无法确认" : "取消请求状态暂时无法确认");
    } finally {
      if (!keepPending) {
        setControlPending(null);
        activeControl.current = undefined;
      }
    }
  }

  return (
    <section aria-labelledby="decision-heading">
      <h1 id="decision-heading">智能消费决策</h1>
      <p>使用固定合成候选验证 ChoiceMind 的决策合同，不访问真实商品或价格。</p>
      <form onSubmit={submit}>
        <label htmlFor="requirement">合成消费需求</label>
        <textarea
          id="requirement"
          name="requirement"
          rows={4}
          required
          readOnly
          value={defaultRequirement}
        />
        <p>P0 固定合成示例，不解析任意自然语言需求。</p>
        <button type="submit" disabled={pending}>
          {pending ? "正在执行" : "运行合成决策"}
        </button>
      </form>
      <p aria-live="polite">{pending ? "正在理解需求并核验合成证据" : ""}</p>
      {taskId === null ? null : (
        <TaskProgress
          authoritativeState={
            snapshot?.state ??
            (result !== null && "taskStatus" in result ? result.taskStatus.state : null)
          }
          connectionState={connectionState}
          events={persistedEvents}
          observationError={observationError}
          controlError={controlError}
          controlPending={controlPending}
          controlStatus={controlStatus}
          onControl={requestRuntimeControl}
          paused={snapshot?.state.startsWith("PAUSED_") === true}
          taskId={taskId}
        />
      )}
      {result === null ? null : result.ok ? (
        <DecisionResult result={result} />
      ) : (
        <section aria-labelledby="decision-error-heading">
          <h2 id="decision-error-heading">决策任务失败</h2>
          <p>{result.error.message}</p>
          <p>{result.error.code}</p>
        </section>
      )}
    </section>
  );
}

function TaskProgress({
  authoritativeState,
  connectionState,
  events,
  observationError,
  controlError,
  controlPending,
  controlStatus,
  onControl,
  paused,
  taskId
}: Readonly<{
  authoritativeState:
    | DecisionTaskSnapshotV1["state"]
    | CompletedDecisionTaskStatusV1["state"]
    | FailedDecisionTaskStatusV1["state"]
    | null;
  connectionState: "idle" | "connected" | "reconnecting";
  events: readonly PersistedRunEventV1[];
  observationError: boolean;
  controlError: string | null;
  controlPending: "RESUME" | "CANCEL" | null;
  controlStatus: RuntimeControlStatusV1 | null;
  onControl: (action: "RESUME" | "CANCEL") => Promise<void>;
  paused: boolean;
  taskId: string;
}>) {
  return (
    <section aria-labelledby="task-progress-heading">
      <h2 id="task-progress-heading">任务进度</h2>
      <p>任务：{taskId}</p>
      {authoritativeState === null ? null : <p>权威状态：{authoritativeState}</p>}
      {observationError ? <p role="status">任务状态暂时无法读取</p> : null}
      {paused ? (
        <div>
          <p>任务已暂停，请根据最新事件确认原因后选择恢复或取消。</p>
          <button
            type="button"
            disabled={controlPending !== null}
            onClick={() => void onControl("RESUME")}
          >
            {controlPending === "RESUME"
              ? controlStatus?.state === "ACCEPTED" || controlStatus?.state === "RUNNING"
                ? "正在恢复"
                : "正在请求恢复"
              : "安全恢复"}
          </button>
          <button
            type="button"
            disabled={controlPending !== null}
            onClick={() => void onControl("CANCEL")}
          >
            {controlPending === "CANCEL" ? "正在取消" : "取消任务"}
          </button>
        </div>
      ) : null}
      {controlStatus === null ? null : (
        <p role="status">{runtimeControlStatusLabel(controlStatus)}</p>
      )}
      {controlError === null ? null : <p role="alert">{controlError}</p>}
      <p aria-live="polite">
        {connectionState === "reconnecting"
          ? "事件连接中断，正在重连"
          : connectionState === "connected"
            ? "事件连接正常"
            : "正在恢复任务事件"}
      </p>
      <ol>
        {events.map((persistedEvent) => (
          <li key={persistedEvent.cursor}>{persistedEvent.event.summary}</li>
        ))}
      </ol>
    </section>
  );
}

function runtimeControlStatusLabel(status: RuntimeControlStatusV1): string {
  if (status.state === "ACCEPTED" || status.state === "RUNNING") {
    return status.action === "RESUME" ? "恢复中" : "取消中";
  }
  if (status.state === "COMPLETED") {
    return status.action === "RESUME" ? "恢复完成" : "取消完成";
  }
  return status.action === "RESUME" ? "恢复失败" : "取消失败";
}

function mergePersistedEvent(
  current: readonly PersistedRunEventV1[],
  incoming: PersistedRunEventV1
): readonly PersistedRunEventV1[] {
  const byCursor = new Map(current.map((event) => [event.cursor, event] as const));
  byCursor.set(incoming.cursor, incoming);
  return [...byCursor.values()].sort((left, right) =>
    BigInt(left.cursor) < BigInt(right.cursor)
      ? -1
      : BigInt(left.cursor) > BigInt(right.cursor)
        ? 1
        : 0
  );
}

function createUnknownWebResult(errorId: string): DecisionTaskResultV1 {
  return createUnknownDecisionExecutionResultV1({
    errorId,
    occurredAt: new Date().toISOString()
  });
}

function DecisionResult({ result }: Readonly<{ result: SuccessfulDecisionTaskResultV1 }>) {
  const { candidates, claimAssessments, claims, decision, evidence } = result.bundle;
  const selected = candidates.find(
    (candidate) => candidate.candidateId === decision.selectedCandidateId
  );
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim] as const));
  const assessmentsByClaimId = new Map(
    claimAssessments.map((assessment) => [assessment.claimId, assessment] as const)
  );
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item] as const));
  const decisionHeading =
    decision.status === "BUY_IF_PRICE"
      ? "有条件购买"
      : decision.status === "NEED_MORE_INFO"
        ? "需要补充信息"
        : decision.status;

  return (
    <section aria-labelledby="decision-result-heading">
      <p role="note">合成测试数据，不代表真实商品、价格或购买建议</p>
      <h2 id="decision-result-heading">{decisionHeading}</h2>
      <p>{decision.summary}</p>
      {selected === undefined ? null : (
        <p>
          候选：{selected.displayName}（{selected.identity.sku}）
        </p>
      )}

      <h3>成立条件</h3>
      <ul>
        {decision.conditions.map((condition) => (
          <li key={condition.conditionId}>
            {condition.conditionType === "MAX_PRICE"
              ? `实际到手价不高于 ${condition.amountMinor / 100} 元；${condition.verification}`
              : `必须提供官方保修；${condition.verification}`}
          </li>
        ))}
      </ul>

      <h3>候选去向</h3>
      <ul>
        {decision.candidateDispositions.map((disposition) => (
          <li key={disposition.dispositionId}>违反硬约束，已淘汰：{disposition.reason}</li>
        ))}
      </ul>

      <h3>风险</h3>
      <ul>
        {decision.risks.map((risk) => {
          const statementClaim = claimsById.get(risk.statementClaimId);
          const assessment = assessmentsByClaimId.get(risk.statementClaimId);
          const supportingEvidence = assessment?.supportingEvidenceIds
            .map((evidenceId) => evidenceById.get(evidenceId))
            .find((item) => item !== undefined);

          return (
            <li key={risk.riskId}>
              {statementClaim === undefined
                ? "风险依据不可用"
                : `${statementClaim.predicate}：${formatClaimValue(statementClaim.value)}；${supportingEvidence?.excerpt ?? "证据摘录不可用"}；${risk.verification}`}
            </li>
          );
        })}
      </ul>

      <h3>Claim 评估</h3>
      <ul>
        {claimAssessments.map((assessment) => {
          const claim = claimsById.get(assessment.claimId);

          if (claim === undefined) {
            return <li key={assessment.claimId}>Claim 依据不可用</li>;
          }

          return (
            <li key={assessment.claimId}>
              {claim.predicate}：{formatClaimValue(claim.value)}；类型：
              {claim.claimKind}
              ；证据状态：{assessment.evidenceState}
              <EvidenceReferences
                evidenceIds={assessment.supportingEvidenceIds}
                evidenceById={evidenceById}
                label="支持证据"
              />
              <EvidenceReferences
                evidenceIds={assessment.refutingEvidenceIds}
                evidenceById={evidenceById}
                label="反驳证据"
              />
            </li>
          );
        })}
      </ul>

      <h3>下一步</h3>
      <ul>
        {decision.nextSteps.map((nextStep) => {
          const target =
            nextStep.actionType === "PROVIDE_REQUIREMENT"
              ? nextStep.requirementKey
              : nextStep.actionType === "VERIFY_CONDITION"
                ? nextStep.conditionId
                : nextStep.riskId;

          return <li key={`${nextStep.actionType}-${target}`}>{nextStep.instruction}</li>;
        })}
      </ul>

      {decision.criticalGaps.length > 0 ? (
        <section aria-labelledby="critical-gaps-heading">
          <h3 id="critical-gaps-heading">需要你补充</h3>
          <ul>
            {decision.criticalGaps.map((gap) => (
              <li key={gap.gapId}>{gap.question}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <h3>证据链</h3>
      {evidence.map((item) => (
        <details key={item.evidenceId} open>
          <summary>{item.source.title}</summary>
          <p>来源类型：{item.source.sourceKind}</p>
          <p>{item.excerpt}</p>
          <p>
            定位：{item.locator.section} / {item.locator.field}
          </p>
          <p>证据有效期：{item.validUntil}</p>
          {Date.parse(item.validUntil) < Date.parse(decision.validFrom) ? (
            <p>形成 Decision 时已过期，仅供追溯</p>
          ) : null}
        </details>
      ))}

      <p>Decision 有效期：{decision.validUntil}</p>
      <h3>执行过程</h3>
      <ol>
        {result.runEvents.map((runEvent) => (
          <li key={runEvent.eventId}>{runEvent.summary}</li>
        ))}
      </ol>
    </section>
  );
}

function EvidenceReferences({
  evidenceIds,
  evidenceById,
  label
}: Readonly<{
  evidenceIds: readonly string[];
  evidenceById: ReadonlyMap<string, SuccessfulDecisionTaskResultV1["bundle"]["evidence"][number]>;
  label: string;
}>) {
  if (evidenceIds.length === 0) {
    return <p>{label}：无</p>;
  }

  return (
    <p>
      {label}：
      {evidenceIds
        .map((evidenceId) => evidenceById.get(evidenceId)?.excerpt ?? "证据摘录不可用")
        .join("；")}
    </p>
  );
}

function formatClaimValue(value: ClaimValueV1): string {
  switch (value.kind) {
    case "MONEY":
      return `${value.amountMinor / 100} 元`;
    case "QUANTITY":
      return `${value.amount} ${value.unit}`;
    case "BOOLEAN":
      return value.value ? "是" : "否";
    case "TEXT":
      return value.value;
  }
}
