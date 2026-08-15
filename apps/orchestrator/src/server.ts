import { buildOrchestratorApp } from "./app.js";
import { createDecisionTaskExecutor } from "./decision-tasks/executor.js";
import { createFakeAgentRuntimeAdapter } from "./runtime/fake-agent-runtime-adapter.js";

const app = buildOrchestratorApp({
  decisionTaskExecutor: createDecisionTaskExecutor({
    runtime: createFakeAgentRuntimeAdapter()
  })
});
const port = Number(process.env.PORT ?? 3200);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ host, port });
