import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  return forward(request, "/api/v1/source-research/batches", "POST");
}

export async function GET(request: NextRequest) {
  const decisionTaskId = request.nextUrl.searchParams.get("decisionTaskId");
  if (decisionTaskId === null || decisionTaskId.length === 0 || decisionTaskId.length > 200) {
    return NextResponse.json({ error: { code: "CONTRACT_INVALID" } }, { status: 400 });
  }
  return forward(
    request,
    `/api/v1/source-research/batches?decisionTaskId=${encodeURIComponent(decisionTaskId)}`,
    "GET"
  );
}

async function forward(request: NextRequest, path: string, method: "GET" | "POST") {
  const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";
  try {
    const upstream = await fetch(`${apiUrl}${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...(request.headers.get("cookie") === null ? {} : { cookie: request.headers.get("cookie") as string }),
        ...(method === "POST" ? { "content-type": "application/json" } : {})
      },
      ...(method === "POST" ? { body: await request.text() } : {})
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }
    });
  } catch {
    return NextResponse.json({ error: { code: "SOURCE_RESEARCH_UNAVAILABLE" } }, { status: 503 });
  }
}
