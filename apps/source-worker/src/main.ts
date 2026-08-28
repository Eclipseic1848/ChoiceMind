import { createCredentialVault } from "@choicemind/security";
import { openPostgresSourceAccess } from "@choicemind/source-access";
import {
  openPostgresSourceResearch,
  openSourceResearchNotificationPublisher
} from "@choicemind/source-research";
import { openPersistentDecisionTaskModule } from "@choicemind/task-persistence";

import { createFixtureSourceAdapter } from "./fixture-adapter.js";
import { createSourceWorker } from "./worker.js";

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
const persistence = await openPersistentDecisionTaskModule({ databaseUrl });
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
const sourceResearch = await openPostgresSourceResearch({ databaseUrl });
let notificationPublisher: Awaited<ReturnType<typeof openSourceResearchNotificationPublisher>> | undefined;
try {
  const redisUrl = process.env.CHOICEMIND_REDIS_URL;
  if (redisUrl !== undefined && redisUrl.length > 0) {
    notificationPublisher = await openSourceResearchNotificationPublisher({ databaseUrl, redisUrl });
  }
} catch {
  console.warn("来源研究 Redis 通知暂不可用；Worker 将继续使用 Postgres 轮询");
}
const worker = createSourceWorker({
  workerId,
  systemActor,
  sourceAccess,
  sourceResearch,
  adapters: new Map([
    [
      "fixture",
      createFixtureSourceAdapter({
        loginUrl:
          process.env.CHOICEMIND_FIXTURE_LOGIN_URL ??
          "http://127.0.0.1:3000/source-login/fixture"
      })
    ]
  ])
});
const pollIntervalMs = Number(process.env.CHOICEMIND_SOURCE_WORKER_POLL_MS ?? 500);
let stopping = false;
const requestStop = () => {
  stopping = true;
};
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

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
  process.off("SIGINT", requestStop);
  process.off("SIGTERM", requestStop);
  masterKey.fill(0);
  await Promise.all([
    sourceAccess.close(),
    sourceResearch.close(),
    notificationPublisher?.close(),
    persistence.close()
  ]);
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} 未配置`);
  return value;
}
