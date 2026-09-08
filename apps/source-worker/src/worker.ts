import type { SecretValue } from "@choicemind/security";
import type {
  SourceAccessCommand,
  SourceAccessQuery,
  SourceLoginSession,
  SourceStatus
} from "@choicemind/source-access";
import type {
  SourceResearchClaim,
  SourceResearchOutcome
} from "@choicemind/source-research";

type SourceAdapterOutcome =
  | SourceResearchOutcome
  | Readonly<{ type: "AUTH_REQUIRED"; challenge: "QR_CODE" | "SMS" | "CAPTCHA" }>;

type SourceAdapterInput = Readonly<{
  claim: SourceResearchClaim;
  idempotencyKey: string;
  signal: AbortSignal;
  saveCheckpoint(checkpoint: unknown): Promise<void>;
}>;

export type PublicSourceAdapter = Readonly<{
  accessMode: "PUBLIC";
  run(input: SourceAdapterInput): Promise<SourceResearchOutcome>;
}>;

type CredentialSourceAdapter = Readonly<{
  accessMode: "CREDENTIAL";
  officialLoginUrl: string;
  run(input: SourceAdapterInput & Readonly<{
    revealCredential(): string;
  }>): Promise<SourceAdapterOutcome>;
}>;

export type SourceAdapter = (PublicSourceAdapter | CredentialSourceAdapter) & Readonly<{
  authorize?(): Promise<void>;
}>;

type SourceAccessPort = Readonly<{
  read(
    query: Extract<SourceAccessQuery, { type: "GET_SOURCE_STATUS" }>
  ): Promise<SourceStatus | undefined>;
  execute(
    command: Extract<SourceAccessCommand, { type: "BEGIN_LOGIN" }>
  ): Promise<SourceLoginSession>;
  execute(
    command: Extract<
      SourceAccessCommand,
      { type: "MARK_INVALID" | "REVOKE_CREDENTIAL" }
    >
  ): Promise<SourceStatus | undefined>;
  withCredential(
    input: Readonly<{
      ownerUserId: string;
      sourceId: string;
      sourceAccountId: string;
      correlationId: string;
      actor: Readonly<{ userId: string; role: "SYSTEM" }>;
    }>,
    operation: (secret: SecretValue) => Promise<unknown> | unknown
  ): Promise<void>;
}>;

type SourceResearchPort = Readonly<{
  claimNext(
    workerId: string,
    leaseDurationMs: number
  ): Promise<SourceResearchClaim | Readonly<{ status: "EMPTY" }>>;
  saveCheckpoint(
    claim: SourceResearchClaim,
    checkpoint: unknown
  ): Promise<Readonly<{ status: "SAVED" | "LEASE_LOST" }>>;
  renewLease(
    claim: SourceResearchClaim,
    leaseDurationMs: number
  ): Promise<Readonly<{ status: "RENEWED" | "LEASE_LOST" }>>;
  complete(
    claim: SourceResearchClaim,
    outcome: SourceResearchOutcome
  ): Promise<Readonly<{ status: "COMMITTED" | "ALREADY_COMMITTED" | "LEASE_LOST" }>>;
}>;

export function createSourceWorker(options: Readonly<{
  workerId: string;
  systemActor: Readonly<{ userId: string; role: "SYSTEM" }>;
  sourceAccess: SourceAccessPort;
  sourceResearch: SourceResearchPort;
  adapters: ReadonlyMap<string, SourceAdapter>;
  requestCandidateResearch?(sourceId: string): Promise<void>;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}>) {
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(100, Math.floor(leaseDurationMs / 3));

  return {
    async runOnce(): Promise<Readonly<{ claimed: number; completed: number }>> {
      const claim = await options.sourceResearch.claimNext(
        options.workerId,
        leaseDurationMs
      );
      if (claim.status === "EMPTY") return { claimed: 0, completed: 0 };

      const adapter = options.adapters.get(claim.sourceId);
      if (adapter === undefined) {
        try {
          await options.requestCandidateResearch?.(claim.sourceId);
        } catch {
          await options.sourceResearch.complete(claim, {
            type: "FAILED_RETRYABLE",
            summary: "来源工具研究请求暂时无法记录"
          });
          return { claimed: 1, completed: 1 };
        }
        await options.sourceResearch.complete(claim, {
          type: "FAILED_FINAL",
          summary: `没有可用的来源 Adapter：${claim.sourceId}`
        });
        return { claimed: 1, completed: 1 };
      }
      try {
        await adapter.authorize?.();
      } catch {
        await options.sourceResearch.complete(claim, {
          type: "FAILED_RETRYABLE",
          summary: "候选来源未获当前批准或审批状态暂不可用"
        });
        return { claimed: 1, completed: 1 };
      }
      if (adapter.accessMode !== claim.accessMode) {
        await options.sourceResearch.complete(claim, {
          type: "FAILED_FINAL",
          summary: `来源访问模式与 Adapter 不匹配：${claim.sourceId}`
        });
        return { claimed: 1, completed: 1 };
      }
      if (adapter.accessMode === "PUBLIC" && claim.researchTarget === null) {
        await options.sourceResearch.complete(claim, {
          type: "FAILED_FINAL",
          summary: "公开来源缺少可验证的研究目标"
        });
        return { claimed: 1, completed: 1 };
      }

      if (adapter.accessMode === "CREDENTIAL") {
        const status = await options.sourceAccess.read({
          type: "GET_SOURCE_STATUS",
          ownerUserId: claim.ownerUserId,
          sourceId: claim.sourceId,
          sourceAccountId: claim.sourceAccountId
        });
        if (status?.status !== "ACTIVE") {
          const login = await options.sourceAccess.execute({
            type: "BEGIN_LOGIN",
            ownerUserId: claim.ownerUserId,
            sourceId: claim.sourceId,
            sourceAccountId: claim.sourceAccountId,
            officialLoginUrl: adapter.officialLoginUrl,
            correlationId: claim.jobId
          });
          await options.sourceResearch.complete(claim, {
            type: "WAITING_CHALLENGE",
            challenge: "QR_CODE",
            loginSessionId: login.loginSessionId
          });
          return { claimed: 1, completed: 1 };
        }
      }

      let adapterOutcome: SourceAdapterOutcome | undefined;
      let outcome: SourceResearchOutcome | undefined;
      let leaseLost = false;
      let heartbeatInFlight: Promise<void> | undefined;
      const adapterController = new AbortController();
      const heartbeat = setInterval(() => {
        if (heartbeatInFlight !== undefined) return;
        heartbeatInFlight = options.sourceResearch
          .renewLease(claim, leaseDurationMs)
          .then((renewed) => {
            if (renewed.status === "LEASE_LOST") {
              leaseLost = true;
              adapterController.abort();
            }
          })
          .catch(() => {
            leaseLost = true;
            adapterController.abort();
          })
          .finally(() => {
            heartbeatInFlight = undefined;
          });
      }, heartbeatIntervalMs);
      try {
        const adapterInput: SourceAdapterInput = {
          claim,
          idempotencyKey: claim.jobId,
          signal: adapterController.signal,
          async saveCheckpoint(checkpoint) {
            const saved = await options.sourceResearch.saveCheckpoint(claim, checkpoint);
            if (saved.status !== "SAVED") throw new Error("SOURCE_RESEARCH_LEASE_LOST");
          }
        };
        if (adapter.accessMode === "PUBLIC") {
          adapterOutcome = await adapter.run(adapterInput);
        } else {
          await adapter.authorize?.();
          await options.sourceAccess.withCredential(
            {
              ownerUserId: claim.ownerUserId,
              sourceId: claim.sourceId,
              sourceAccountId: claim.sourceAccountId,
              correlationId: claim.jobId,
              actor: options.systemActor
            },
            async (secret) => {
              adapterOutcome = await adapter.run({
                ...adapterInput,
                revealCredential: () => secret.reveal()
              });
            }
          );
        }
      } catch (error) {
        if (
          adapter.accessMode === "CREDENTIAL" &&
          error instanceof Error &&
          (error.message === "SOURCE_LOGIN_REQUIRED" ||
            error.message === "CREDENTIAL_NOT_FOUND")
        ) {
          await options.sourceAccess.execute({
            type: "MARK_INVALID",
            ownerUserId: claim.ownerUserId,
            sourceId: claim.sourceId,
            sourceAccountId: claim.sourceAccountId,
            correlationId: claim.jobId,
            actor: options.systemActor
          });
          const login = await options.sourceAccess.execute({
            type: "BEGIN_LOGIN",
            ownerUserId: claim.ownerUserId,
            sourceId: claim.sourceId,
            sourceAccountId: claim.sourceAccountId,
            officialLoginUrl: adapter.officialLoginUrl,
            correlationId: claim.jobId
          });
          outcome = {
            type: "WAITING_CHALLENGE",
            challenge: "QR_CODE",
            loginSessionId: login.loginSessionId
          };
        } else {
          outcome = {
            type: "FAILED_RETRYABLE",
            summary: "来源研究暂时失败，可从最近检查点恢复"
          };
        }
      } finally {
        clearInterval(heartbeat);
        await heartbeatInFlight;
      }
      if (leaseLost) return { claimed: 1, completed: 0 };
      if (adapter.accessMode === "CREDENTIAL" && adapterOutcome?.type === "AUTH_REQUIRED") {
        await options.sourceAccess.execute({
          type: "MARK_INVALID",
          ownerUserId: claim.ownerUserId,
          sourceId: claim.sourceId,
          sourceAccountId: claim.sourceAccountId,
          correlationId: claim.jobId,
          actor: options.systemActor
        });
        const login = await options.sourceAccess.execute({
          type: "BEGIN_LOGIN",
          ownerUserId: claim.ownerUserId,
          sourceId: claim.sourceId,
          sourceAccountId: claim.sourceAccountId,
          officialLoginUrl: adapter.officialLoginUrl,
          correlationId: claim.jobId
        });
        outcome = {
          type: "WAITING_CHALLENGE",
          challenge: adapterOutcome.challenge,
          loginSessionId: login.loginSessionId
        };
      } else if (adapterOutcome !== undefined && adapterOutcome.type !== "AUTH_REQUIRED") {
        outcome = adapterOutcome;
      }
      await options.sourceResearch.complete(
        claim,
        outcome ?? { type: "FAILED_RETRYABLE", summary: "来源 Adapter 未返回结果" }
      );
      return { claimed: 1, completed: 1 };
    }
  };
}
