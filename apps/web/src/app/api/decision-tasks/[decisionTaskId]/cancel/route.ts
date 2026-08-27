import {
  decodeRuntimeCancelRequestV1,
  decodeRuntimeControlStatusV1
} from "@choicemind/contracts/decision/v1";

import { addChoiceMindApiAuthorization } from "../../../../../server-api-authorization";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ decisionTaskId: string }>>;
}>;

export async function POST(request: Request, context: RouteContext) {
  const { decisionTaskId } = await context.params;
  let requestBody: unknown;

  try {
    requestBody = await request.json();
  } catch {
    return Response.json({ error: "取消请求不符合合同" }, { status: 400 });
  }

  const decodedRequest = decodeRuntimeCancelRequestV1(requestBody);
  if (!decodedRequest.ok) {
    return Response.json({ error: "取消请求不符合合同" }, { status: 400 });
  }

  const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";
  const headers = addChoiceMindApiAuthorization(
    new Headers({ "content-type": "application/json" }),
    request
  );

  try {
    const response = await fetch(
      `${apiUrl}/api/v1/decision-tasks/${encodeURIComponent(decisionTaskId)}/cancel`,
      {
        method: "POST",
        cache: "no-store",
        headers,
        body: JSON.stringify(decodedRequest.value),
        signal: AbortSignal.timeout(15_000)
      }
    );
    const responseBody: unknown = await response.json();
    const decodedStatus = decodeRuntimeControlStatusV1(responseBody);

    if (
      response.status === 200 &&
      decodedStatus.ok &&
      decodedStatus.value.decisionTaskId === decisionTaskId &&
      decodedStatus.value.action === "CANCEL" &&
      decodedStatus.value.controlRequestId === decodedRequest.value.controlRequestId
    ) {
      return Response.json(decodedStatus.value, { status: 200 });
    }
  } catch {
    // 统一在下方失败关闭，避免向浏览器泄露上游连接细节。
  }

  return Response.json({ error: "取消请求状态暂时无法确认" }, { status: 503 });
}
