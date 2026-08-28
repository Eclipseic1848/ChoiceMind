import { type NextRequest, NextResponse } from "next/server";

type RouteContext = Readonly<{ params: Promise<{ path?: string[] }> }>;

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, context, "GET");
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, context, "POST");
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, context, "DELETE");
}

async function proxy(request: NextRequest, context: RouteContext, method: "GET" | "POST" | "DELETE") {
  const { path = [] } = await context.params;
  const allowed =
    (method === "GET" && path.length === 0) ||
    (method === "POST" && path.length === 2 && path[0] === "fixture" && path[1] === "login") ||
    (method === "DELETE" && path.join("/") === "fixture/credentials/default");
  if (!allowed) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  return forward(request, `/api/v1/sources${path.length === 0 ? "" : `/${path.join("/")}`}`, method);
}

async function forward(request: NextRequest, path: string, method: "GET" | "POST" | "DELETE") {
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
    return NextResponse.json({ error: { code: "SOURCE_UNAVAILABLE" } }, { status: 503 });
  }
}
