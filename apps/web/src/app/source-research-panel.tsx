"use client";

import { useEffect, useRef, useState } from "react";

type SourceStatus = {
  sourceId: string;
  sourceAccountId: string;
  status: "ACTIVE" | "INVALID" | "REVOKED";
  updatedAt: string;
};

type ResearchBatch = {
  batchId: string;
  state: "QUEUED" | "RUNNING" | "WAITING_SOURCE_LOGIN" | "COMPLETED" | "FAILED";
  costUnits: number;
  results: Array<{ evidenceId: string; summary: string }>;
  jobs: Array<{ state: string; loginSessionId?: string }>;
};

type Requirement = {
  consumptionGoal: string | null;
  primaryScenario: string | null;
  hardConstraints: string[] | null;
  readiness: "NEEDS_CLARIFICATION" | "READY_FOR_RESEARCH";
};

export function SourceResearchPanel({
  decisionTaskId,
  requirement
}: Readonly<{
  decisionTaskId: string | undefined;
  requirement: Requirement | null;
}>) {
  const [sourceStatus, setSourceStatus] = useState<SourceStatus>();
  const [statusAvailable, setStatusAvailable] = useState(true);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [loginUrl, setLoginUrl] = useState<string>();
  const [batch, setBatch] = useState<ResearchBatch>();
  const [recoveredDecisionTaskId, setRecoveredDecisionTaskId] = useState<string>();
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [pending, setPending] = useState<"CONNECT" | "REVOKE" | "START" | null>(null);
  const [error, setError] = useState<string>();
  const batchAttemptRef = useRef<
    | Readonly<{
        batchId: string;
        idempotencyKey: string;
        requestSignature: string;
      }>
    | undefined
  >(undefined);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    void statusAttempt;
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();

    async function loadStatus(signal: AbortSignal) {
      try {
        const response = await fetch("/api/sources", { cache: "no-store", signal });
        if (!response.ok) throw new Error("来源状态暂时无法读取");
        const statuses = (await response.json()) as SourceStatus[];
        setSourceStatus(
          statuses.find(
            (status) =>
              status.sourceId === "fixture" && status.sourceAccountId === "default"
          )
        );
        setStatusAvailable(true);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setStatusAvailable(false);
      }
    }
  }, [statusAttempt]);

  useEffect(() => {
    void recoveryAttempt;
    batchAttemptRef.current = undefined;
    setBatch(undefined);
    setRecoveredDecisionTaskId(undefined);
    setRecoveryFailed(false);
    if (decisionTaskId === undefined) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/source-research/batches?decisionTaskId=${encodeURIComponent(decisionTaskId)}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (response.ok) {
          setBatch((await response.json()) as ResearchBatch);
          setRecoveredDecisionTaskId(decisionTaskId);
          setRecoveryFailed(false);
        } else if (response.status === 404) {
          setRecoveredDecisionTaskId(decisionTaskId);
          setRecoveryFailed(false);
        } else {
          throw new Error("SOURCE_RESEARCH_RECOVERY_UNAVAILABLE");
        }
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setRecoveryFailed(true);
          setError("研究状态暂时无法恢复；后台任务不会因此停止");
        }
      }
    })();
    return () => controller.abort();
  }, [decisionTaskId, recoveryAttempt]);

  useEffect(() => {
    const loginSessionId = batch?.jobs.find(
      (job) => job.state === "WAITING_SOURCE_LOGIN"
    )?.loginSessionId;
    if (loginSessionId !== undefined) setLoginUrl(`/source-login/${loginSessionId}`);
  }, [batch]);

  useEffect(() => {
    if (error !== undefined) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (loginUrl === undefined) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch("/api/sources", {
            cache: "no-store",
            signal: controller.signal
          });
          if (!response.ok) return;
          const statuses = (await response.json()) as SourceStatus[];
          const active = statuses.find(
            (status) =>
              status.sourceId === "fixture" &&
              status.sourceAccountId === "default" &&
              status.status === "ACTIVE"
          );
          if (active !== undefined) {
            setSourceStatus(active);
            setLoginUrl(undefined);
          }
        } catch (cause) {
          if (!(cause instanceof DOMException && cause.name === "AbortError")) {
            setStatusAvailable(false);
          }
        }
      })();
    }, 1_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loginUrl]);

  useEffect(() => {
    if (batch === undefined || batch.state === "COMPLETED" || batch.state === "FAILED") {
      return;
    }
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/source-research/batches/${batch.batchId}`, {
            cache: "no-store",
            signal: controller.signal
          });
          if (response.ok) setBatch((await response.json()) as ResearchBatch);
        } catch (cause) {
          if (!(cause instanceof DOMException && cause.name === "AbortError")) {
            setError("研究状态暂时无法刷新；任务仍会在后台继续");
          }
        }
      })();
    }, 1_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [batch]);

  async function connectFixture() {
    setPending("CONNECT");
    setError(undefined);
    try {
      const response = await fetch("/api/sources/fixture/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceAccountId: "default" })
      });
      if (!response.ok) throw new Error("无法发起来源登录");
      const login = (await response.json()) as { officialLoginUrl: string };
      setLoginUrl(login.officialLoginUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法发起来源登录");
    } finally {
      setPending(null);
    }
  }

  async function revokeFixture() {
    setPending("REVOKE");
    setError(undefined);
    try {
      const response = await fetch("/api/sources/fixture/credentials/default", {
        method: "DELETE"
      });
      if (!response.ok) throw new Error("无法断开来源连接");
      setSourceStatus((await response.json()) as SourceStatus);
      setLoginUrl(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法断开来源连接");
    } finally {
      setPending(null);
    }
  }

  async function startResearch() {
    if (decisionTaskId === undefined || requirement === null) return;
    const query = buildResearchQuery(requirement);
    const requestSignature = `${decisionTaskId}\0${query}`;
    const previousAttempt = batchAttemptRef.current;
    const attempt =
      previousAttempt?.requestSignature === requestSignature
        ? previousAttempt
        : {
            batchId: crypto.randomUUID(),
            idempotencyKey: crypto.randomUUID(),
            requestSignature
          };
    batchAttemptRef.current = attempt;
    setPending("START");
    setError(undefined);
    try {
      const response = await fetch("/api/source-research/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          batchId: attempt.batchId,
          decisionTaskId,
          idempotencyKey: attempt.idempotencyKey,
          query,
          sources: [{ sourceId: "fixture", sourceAccountId: "default" }]
        })
      });
      if (!response.ok) throw new Error("无法启动来源研究");
      setBatch((await response.json()) as ResearchBatch);
      batchAttemptRef.current = undefined;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动来源研究");
    } finally {
      setPending(null);
    }
  }

  const connected = sourceStatus?.status === "ACTIVE";
  const canStart =
    connected &&
    decisionTaskId !== undefined &&
    requirement?.readiness === "READY_FOR_RESEARCH" &&
    recoveredDecisionTaskId === decisionTaskId &&
    batch === undefined;

  return (
    <div className="source-research-panel">
      <div className="source-route" aria-hidden="true">
        <span className={connected ? "source-node source-node-active" : "source-node"} />
        <span className="source-route-line" />
        <span className={batch === undefined ? "source-node" : "source-node source-node-active"} />
      </div>
      <p className="source-status-copy" role="status">
        {!statusAvailable
          ? "来源状态暂不可用"
          : connected
            ? "受控测试来源已连接"
            : sourceStatus?.status === "INVALID"
              ? "来源登录已失效，需要重新连接"
              : "来源尚未连接"}
      </p>
      {!statusAvailable ? (
        <button
          className="inline-action"
          type="button"
          disabled={pending !== null}
          onClick={() => {
            setError(undefined);
            setStatusAttempt((attempt) => attempt + 1);
          }}
        >
          重试来源状态
        </button>
      ) : connected ? (
        <button
          className="inline-action"
          type="button"
          disabled={pending !== null}
          onClick={() => void revokeFixture()}
        >
          {pending === "REVOKE" ? "正在断开" : "断开来源连接"}
        </button>
      ) : (
        <button
          className="inline-action"
          type="button"
          disabled={pending !== null || !statusAvailable}
          onClick={() => void connectFixture()}
        >
          {pending === "CONNECT" ? "正在准备登录" : "连接受控测试来源"}
        </button>
      )}
      {loginUrl === undefined ? null : (
        <p className="source-login-prompt">
          登录需要你亲自完成。系统只保存加密后的会话凭据，不会把 Cookie 放进对话。
          <a href={loginUrl} target="_blank" rel="noreferrer">
            打开独立登录页
          </a>
        </p>
      )}
      <button
        className="primary-action source-start-action"
        type="button"
        disabled={!canStart || pending !== null}
        onClick={() => void startResearch()}
      >
        {pending === "START" ? "正在排队" : "开始来源研究"}
      </button>
      {recoveryFailed ? (
        <button
          className="inline-action"
          type="button"
          disabled={pending !== null}
          onClick={() => {
            setError(undefined);
            setRecoveryAttempt((attempt) => attempt + 1);
          }}
        >
          重试恢复研究状态
        </button>
      ) : null}
      {batch === undefined ? null : (
        <div className="source-batch-state" aria-live="polite">
          <strong>{batchStateLabel(batch.state)}</strong>
          {batch.results.map((result) => (
            <p key={result.evidenceId}>{result.summary}</p>
          ))}
        </div>
      )}
      {error === undefined ? null : (
        <p className="source-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
    </div>
  );
}

function buildResearchQuery(requirement: Requirement): string {
  return [
    requirement.consumptionGoal,
    requirement.primaryScenario === null ? null : `使用场景：${requirement.primaryScenario}`,
    requirement.hardConstraints === null || requirement.hardConstraints.length === 0
      ? null
      : `硬性条件：${requirement.hardConstraints.join("；")}`
  ]
    .filter((value): value is string => value !== null)
    .join("。 ");
}

function batchStateLabel(state: ResearchBatch["state"]): string {
  if (state === "QUEUED") return "研究已排队";
  if (state === "RUNNING") return "正在读取来源";
  if (state === "WAITING_SOURCE_LOGIN") return "等待你完成来源登录";
  if (state === "COMPLETED") return "来源研究已完成";
  return "来源研究未完成";
}
