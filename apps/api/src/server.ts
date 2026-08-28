import {
  openPersistentDecisionTaskModule,
  openRunEventNotificationSubscriber
} from "@choicemind/task-persistence";
import { openPostgresConversation } from "@choicemind/conversation";
import { openPostgresIdentityAccess } from "@choicemind/identity-access";
import { createCredentialVault } from "@choicemind/security";
import { openPostgresSourceAccess } from "@choicemind/source-access";
import { openPostgresSourceResearch } from "@choicemind/source-research";

import { buildApiApp } from "./app.js";
import {
  createPersistentIdentityResolver,
  createSyntheticIdentityResolverFromJson,
  type IdentityResolver
} from "./security/identity.js";

const databaseUrl = process.env.CHOICEMIND_DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("CHOICEMIND_DATABASE_URL 必须指向 ChoiceMind Postgres");
}

const identityAccess = await openPostgresIdentityAccess({ databaseUrl });
const conversation = await openPostgresConversation({ databaseUrl });
const identityResolver = loadIdentityResolver(identityAccess);
const decisionTaskPersistence = await openPersistentDecisionTaskModule({ databaseUrl });
const credentialMasterKey = Buffer.from(
  requireEnvironment("CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64"),
  "base64"
);
if (credentialMasterKey.byteLength !== 32) {
  throw new Error("CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64 解码后必须是 32 字节");
}
const credentialVault = createCredentialVault({
  masterKey: credentialMasterKey,
  storage: {
    save: async (record) => decisionTaskPersistence.saveEncryptedCredential(record),
    load: async (credentialId, ownerUserId) =>
      decisionTaskPersistence.loadEncryptedCredential(credentialId, ownerUserId),
    delete: async (credentialId, ownerUserId) =>
      decisionTaskPersistence.deleteEncryptedCredential(credentialId, ownerUserId)
  },
  appendAuditRecord: async (record) =>
    decisionTaskPersistence.appendAuditRecord({
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
const sourceAccess = await openPostgresSourceAccess({
  databaseUrl,
  vault: credentialVault
});
const sourceResearch = await openPostgresSourceResearch({ databaseUrl });
const redisUrl = process.env.CHOICEMIND_REDIS_URL;
let decisionTaskEventNotifications:
  | Awaited<ReturnType<typeof openRunEventNotificationSubscriber>>
  | undefined;

if (redisUrl !== undefined && redisUrl.length > 0) {
  try {
    decisionTaskEventNotifications = await openRunEventNotificationSubscriber({
      channelName: process.env.CHOICEMIND_RUN_EVENT_CHANNEL ?? "choicemind:run-events",
      redisUrl
    });
  } catch {
    decisionTaskEventNotifications = undefined;
  }
}

const app = buildApiApp({
  ...(decisionTaskEventNotifications === undefined ? {} : { decisionTaskEventNotifications }),
  auditLog: {
    append: async (record) => decisionTaskPersistence.appendAuditRecord(record)
  },
  conversation,
  decisionTaskPersistence,
  decisionTaskRuntimeControl: {
    requestResume: async (input) =>
      decisionTaskPersistence.requestRuntimeResume({
        controlRequestId: input.controlRequestId,
        decisionTaskId: input.decisionTaskId,
        ownerUserId: input.actor.userId,
        runtimeSnapshotId: input.runtimeSnapshotId,
        correlationId: input.correlationId,
        egressConfirmation: input.egressConfirmation
      }),
    requestCancel: async (input) =>
      decisionTaskPersistence.requestRuntimeCancel({
        controlRequestId: input.controlRequestId,
        decisionTaskId: input.decisionTaskId,
        ownerUserId: input.actor.userId,
        cancellationId: input.cancellationId,
        correlationId: input.correlationId
      })
  },
  healthUrls: {
    "data-worker": process.env.DATA_WORKER_HEALTH_URL ?? "http://127.0.0.1:3300/health/live",
    orchestrator: process.env.ORCHESTRATOR_HEALTH_URL ?? "http://127.0.0.1:3200/health/live",
    web: process.env.WEB_HEALTH_URL ?? "http://127.0.0.1:3000/health/live"
  },
  identityAccess,
  sourceAccess,
  sourceResearch,
  ...(identityResolver === undefined ? {} : { identityResolver })
});

app.addHook("onClose", async () => {
  await Promise.all([
    conversation.close(),
    decisionTaskPersistence.close(),
    decisionTaskEventNotifications?.close(),
    identityAccess.close(),
    sourceAccess.close(),
    sourceResearch.close()
  ]);
  credentialMasterKey.fill(0);
});

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ host, port });

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} 未配置`);
  return value;
}

function loadIdentityResolver(
  persistentIdentity: Parameters<typeof createPersistentIdentityResolver>[0]
): IdentityResolver | undefined {
  const mode = process.env.CHOICEMIND_IDENTITY_MODE;

  if (mode === undefined || mode.length === 0 || mode === "persistent") {
    return createPersistentIdentityResolver(persistentIdentity);
  }

  if (mode !== "synthetic") {
    throw new Error(`不支持的 CHOICEMIND_IDENTITY_MODE: ${mode}`);
  }

  const principalsJson = process.env.CHOICEMIND_SYNTHETIC_IDENTITIES_JSON;

  if (principalsJson === undefined || principalsJson.length === 0) {
    throw new Error("synthetic identity 模式必须配置 CHOICEMIND_SYNTHETIC_IDENTITIES_JSON");
  }

  return createSyntheticIdentityResolverFromJson(principalsJson);
}
