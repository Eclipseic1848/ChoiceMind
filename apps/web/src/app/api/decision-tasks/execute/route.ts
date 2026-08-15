import {
  createContractRejectedDecisionTaskResultV1,
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  decodeExecuteDecisionTaskCommandV1,
  getDecisionTaskResultHttpStatusV1
} from "@choicemind/contracts/decision/v1";

export async function POST(request: Request) {
  let requestBody: unknown;

  try {
    requestBody = await request.json();
  } catch {
    const result = createContractRejectedDecisionTaskResultV1({
      errorId: "error-web-json-invalid",
      code: "CONTRACT_INVALID",
      issues: [{ path: "", message: "请求正文必须是有效 JSON" }],
      occurredAt: new Date().toISOString()
    });

    return Response.json(result, { status: getDecisionTaskResultHttpStatusV1(result) });
  }

  const decodedCommand = decodeExecuteDecisionTaskCommandV1(requestBody);

  if (!decodedCommand.ok) {
    const versionError = decodedCommand.code === "CONTRACT_VERSION_UNSUPPORTED";
    const result = createContractRejectedDecisionTaskResultV1({
      errorId: versionError ? "error-web-contract-version" : "error-web-contract-invalid",
      code: decodedCommand.code,
      issues: decodedCommand.issues,
      occurredAt: new Date().toISOString()
    });

    return Response.json(result, { status: getDecisionTaskResultHttpStatusV1(result) });
  }

  const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";

  try {
    const response = await fetch(`${apiUrl}/api/v1/decision-tasks:execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decodedCommand.value),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    const decodedResult = decodeDecisionTaskResultV1(await response.json());

    if (!decodedResult.ok) {
      const result = createUnknownDecisionExecutionResultV1({
        errorId: "error-web-decision-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return Response.json(result, { status: getDecisionTaskResultHttpStatusV1(result) });
    }

    const result = decodedResult.value;
    const expectedStatus = getDecisionTaskResultHttpStatusV1(result);

    if (response.status !== expectedStatus) {
      const unknownResult = createUnknownDecisionExecutionResultV1({
        errorId: "error-web-decision-execution-status-unknown",
        occurredAt: new Date().toISOString()
      });

      return Response.json(unknownResult, {
        status: getDecisionTaskResultHttpStatusV1(unknownResult)
      });
    }

    return Response.json(result, { status: expectedStatus });
  } catch {
    const result = createUnknownDecisionExecutionResultV1({
      errorId: "error-web-decision-execution-status-unknown",
      occurredAt: new Date().toISOString()
    });

    return Response.json(result, { status: getDecisionTaskResultHttpStatusV1(result) });
  }
}
