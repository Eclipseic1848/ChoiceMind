import { buildOrchestratorApp } from "./app.js";

const app = buildOrchestratorApp();
const port = Number(process.env.PORT ?? 3200);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ host, port });
