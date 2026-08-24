import { openPersistentDecisionTaskModule } from "@choicemind/task-persistence";

import { buildApiApp } from "./app.js";

const databaseUrl = process.env.CHOICEMIND_DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("CHOICEMIND_DATABASE_URL 必须指向 ChoiceMind Postgres");
}

const decisionTaskPersistence = await openPersistentDecisionTaskModule({ databaseUrl });

const app = buildApiApp({
  decisionTaskPersistence,
  healthUrls: {
    "data-worker": process.env.DATA_WORKER_HEALTH_URL ?? "http://127.0.0.1:3300/health/live",
    orchestrator: process.env.ORCHESTRATOR_HEALTH_URL ?? "http://127.0.0.1:3200/health/live",
    web: process.env.WEB_HEALTH_URL ?? "http://127.0.0.1:3000/health/live"
  }
});

app.addHook("onClose", async () => decisionTaskPersistence.close());

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ host, port });
