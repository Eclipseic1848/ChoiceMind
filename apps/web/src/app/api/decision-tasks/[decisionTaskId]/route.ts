import {
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  decodeDecisionTaskSnapshotV1,
  getDecisionTaskResultHttpStatusV1
} from "@choicemind/contracts/decision/v1";

import { addChoiceMindApiAuthorization } from "../../../../server-api-authorization";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ decisionTaskId: string }>>;
}>;

export async function GET(_request: Request, context: RouteContext) {
  const { decisionTaskId } = await context.params;
  const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";

  try {
    const response = await fetch(
      `${apiUrl}/api/v1/decision-tasks/${encodeURIComponent(decisionTaskId)}`,
      {
        cache: "no-store",
        headers: addChoiceMindApiAuthorization(new Headers()),
        signal: AbortSignal.timeout(15_000)
      }
    );
    const responseBody: unknown = await response.json();
    const snapshot = decodeDecisionTaskSnapshotV1(responseBody);

    if (
      response.status === 200 &&
      snapshot.ok &&
      snapshot.value.decisionTaskId === decisionTaskId
    ) {
      return Response.json(snapshot.value, { status: 200 });
    }

    const result = decodeDecisionTaskResultV1(responseBody);

    if (result.ok) {
      const value = result.value;
      const taskIdentityMatches =
        !("taskStatus" in value) || value.taskStatus.decisionTaskId === decisionTaskId;

      if (taskIdentityMatches && (response.status === 200 || !value.ok)) {
        return Response.json(value, { status: response.status });
      }
    }
  } catch {
    // 统一在下方返回不确定状态，避免泄露上游连接细节。
  }

  const unknown = createUnknownDecisionExecutionResultV1({
    errorId: "error-web-decision-task-read-unknown",
    occurredAt: new Date().toISOString()
  });

  return Response.json(unknown, {
    status: getDecisionTaskResultHttpStatusV1(unknown)
  });
}
