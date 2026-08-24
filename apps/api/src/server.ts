import {
  openPersistentDecisionTaskModule,
  openRunEventNotificationSubscriber
} from "@choicemind/task-persistence";

import { buildApiApp } from "./app.js";

const databaseUrl = process.env.CHOICEMIND_DATABASE_URL;

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
  decisionTaskPersistence,
  healthUrls: {
    "data-worker": process.env.DATA_WORKER_HEALTH_URL ?? "http://127.0.0.1:3300/health/live",
    orchestrator: process.env.ORCHESTRATOR_HEALTH_URL ?? "http://127.0.0.1:3200/health/live",
    web: process.env.WEB_HEALTH_URL ?? "http://127.0.0.1:3000/health/live"
  }
});

app.addHook("onClose", async () => {
  await Promise.all([decisionTaskPersistence.close(), decisionTaskEventNotifications?.close()]);
});

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ host, port });
