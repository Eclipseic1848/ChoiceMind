import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest, context: Readonly<{ params: Promise<{ loginSessionId: string }> }>) {
  const { loginSessionId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(loginSessionId)) {
    return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }
  const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";
  try {
    const upstream = await fetch(`${apiUrl}/api/v1/source-login/${loginSessionId}/fixture-complete`, {
      method: "POST",
      cache: "no-store",
      headers: request.headers.get("cookie") === null ? {} : { cookie: request.headers.get("cookie") as string }
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }
    });
  } catch {
    return NextResponse.json({ error: { code: "SOURCE_LOGIN_UNAVAILABLE" } }, { status: 503 });
  }
}
