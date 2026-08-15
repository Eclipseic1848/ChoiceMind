import {
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  getDecisionTaskResultHttpStatusV1,
  type DecisionTaskResultV1,
  type ExecuteDecisionTaskCommandV1
} from "@choicemind/contracts/decision/v1";

import type { DecisionOrchestratorPort } from "./orchestrator-port.js";

type HttpDecisionOrchestratorAdapterOptions = Readonly<{
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  maxAttempts?: number;
}>;

export function createHttpDecisionOrchestratorAdapter(
  options: HttpDecisionOrchestratorAdapterOptions
): DecisionOrchestratorPort {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 2;

  return {
    async execute(command) {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await tryExecute(fetchRequest, options.baseUrl, command);

        if (result !== undefined) {
          return result;
        }
      }

      return createUnknownDecisionExecutionResultV1({
        errorId: "error-decision-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });
    }
  };
}

async function tryExecute(
  fetchRequest: typeof globalThis.fetch,
  baseUrl: string,
  command: ExecuteDecisionTaskCommandV1
): Promise<DecisionTaskResultV1 | undefined> {
  try {
    const response = await fetchRequest(`${baseUrl}/internal/v1/decision-tasks:execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000)
    });
    const decoded = decodeDecisionTaskResultV1(await response.json());

    if (!decoded.ok) {
      return undefined;
    }

    const result = decoded.value;
    const expectedStatus = getDecisionTaskResultHttpStatusV1(result);

    return response.status === expectedStatus ? result : undefined;
  } catch {
    return undefined;
  }
}
