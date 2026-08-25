import {
  openPersistentDecisionTaskModule,
  openRunEventNotificationSubscriber
} from "@choicemind/task-persistence";

import { buildApiApp } from "./app.js";
import {
  createSyntheticIdentityResolverFromJson,
  type IdentityResolver
} from "./security/identity.js";

const databaseUrl = process.env.CHOICEMIND_DATABASE_URL;
const identityResolver = loadIdentityResolver();

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("CHOICEMIND_DATABASE_URL 必须指向 ChoiceMind Postgres");
}

const decisionTaskPersistence = await openPersistentDecisionTaskModule({ databaseUrl });
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
  ...(identityResolver === undefined ? {} : { identityResolver })
});

app.addHook("onClose", async () => {
  await Promise.all([decisionTaskPersistence.close(), decisionTaskEventNotifications?.close()]);
});

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ host, port });

function loadIdentityResolver(): IdentityResolver | undefined {
  const mode = process.env.CHOICEMIND_IDENTITY_MODE;

  if (mode === undefined || mode.length === 0) {
    return undefined;
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
