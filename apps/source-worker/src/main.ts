import { createCredentialVault } from "@choicemind/security";
import { openPostgresSourceAccess } from "@choicemind/source-access";
import { openPostgresCandidateResearchRequests, openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import {
  openPostgresSourceResearch,
  openSourceResearchNotificationPublisher
} from "@choicemind/source-research";
import { openPersistentDecisionTaskModule } from "@choicemind/task-persistence";

import { createFixtureSourceAdapter } from "./fixture-adapter.js";
import { createCandidateReviewWorker } from "./candidate-wheel-review.js";
import { createSourceWorker, type SourceAdapter } from "./worker.js";

const databaseUrl = requireEnvironment("CHOICEMIND_DATABASE_URL");
const masterKey = Buffer.from(
  requireEnvironment("CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64"),
  "base64"
);
if (masterKey.byteLength !== 32) {
  throw new Error("CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64 解码后必须是 32 字节");
}
const workerId = process.env.CHOICEMIND_SOURCE_WORKER_ID ?? `source-worker-${process.pid}`;
const systemActor = Object.freeze({
  userId: `source-worker:${workerId}`,
  role: "SYSTEM" as const
});
// 每次取得资源立即登记；启动失败和运行退出共用逆序回收，不因一项失败漏关其余资源。
const cleanups: Array<() => Promise<unknown> | undefined> = [() => { masterKey.fill(0); }];
const failures: unknown[] = [];
try {
  const persistence = await openPersistentDecisionTaskModule({ databaseUrl });
  cleanups.push(() => persistence.close());
  const vault = createCredentialVault({
    masterKey,
    systemAccess: {
      actor: systemActor,
      secretType: "SOURCE_CREDENTIAL",
      actions: ["USE", "DELETE"]
    },
    storage: {
      save: async (record) => persistence.saveEncryptedCredential(record),
      load: async (credentialId, ownerUserId) =>
        persistence.loadEncryptedCredential(credentialId, ownerUserId),
      delete: async (credentialId, ownerUserId) =>
        persistence.deleteEncryptedCredential(credentialId, ownerUserId)
    },
    appendAuditRecord: async (record) =>
      persistence.appendAuditRecord({
        actor: {
          principalId: record.actor.userId,
          role: record.actor.role,
          userId: record.actor.userId
        },
        action: record.action,
        object: record.object,
        result: record.result,
        correlationId: record.correlationId
      })
  });
  const sourceAccess = await openPostgresSourceAccess({ databaseUrl, vault, systemActor });
  cleanups.push(() => sourceAccess.close());
  const sourceResearch = await openPostgresSourceResearch({ databaseUrl });
  cleanups.push(() => sourceResearch.close());
  const candidateRequests = await openPostgresCandidateResearchRequests(databaseUrl);
  cleanups.push(() => candidateRequests.close());
  const candidateStore = await openPostgresCandidateStore(databaseUrl);
  cleanups.push(() => candidateStore.close());
  const candidateReview = createCandidateReviewWorker(candidateRequests.review, candidateStore);
  cleanups.push(() => candidateReview.drain());
  const adapters = new Map<string, SourceAdapter>([
    [
      "fixture",
      createFixtureSourceAdapter({
        loginUrl:
          process.env.CHOICEMIND_FIXTURE_LOGIN_URL ??
          "http://127.0.0.1:3000/source-login/fixture"
      })
    ]
  ]);
  let notificationPublisher: Awaited<ReturnType<typeof openSourceResearchNotificationPublisher>> | undefined;
  try {
    const redisUrl = process.env.CHOICEMIND_REDIS_URL;
    if (redisUrl !== undefined && redisUrl.length > 0) {
      notificationPublisher = await openSourceResearchNotificationPublisher({ databaseUrl, redisUrl });
      const ownedPublisher = notificationPublisher;
      cleanups.push(() => ownedPublisher.close());
    }
  } catch {
    console.warn("来源研究 Redis 通知暂不可用；Worker 将继续使用 Postgres 轮询");
  }
  const worker = createSourceWorker({
    workerId,
    systemActor,
    sourceAccess,
    sourceResearch,
    requestCandidateResearch: async (_sourceId, claim) => { await candidateRequests.request(claim); },
    adapters
  });
  const pollIntervalMs = Number(process.env.CHOICEMIND_SOURCE_WORKER_POLL_MS ?? 500);
  let stopping = false;
  const candidateStop = new AbortController();
  const requestStop = () => {
    stopping = true;
    candidateStop.abort();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  // 审查与普通采集分开轮询；未实现的制品类型保留待审，不抢领后伪装成失败完成。
  const candidateReviews = (async () => {
    while (!stopping) {
      try { await candidateReview.runOnce(candidateStop.signal); }
      catch { console.warn("CANDIDATE_REVIEW_POLL_FAILED"); }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 500));
    }
  })();

  try {
    while (!stopping) {
      try {
        await notificationPublisher?.runOnce();
      } catch {
        console.warn("来源研究 Redis 通知发送失败；Worker 将继续使用 Postgres 轮询");
      }
      const result = await worker.runOnce();
      if (!stopping && result.claimed === 0) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  } finally {
    requestStop();
    try {
      await candidateReviews;
    } finally {
      process.off("SIGINT", requestStop);
      process.off("SIGTERM", requestStop);
    }
  }
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "SOURCE_WORKER_CLEANUP_FAILED");

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} 未配置`);
  return value;
}
