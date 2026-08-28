import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest, context: Readonly<{ params: Promise<{ batchId: string }> }>) {
  const { batchId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) {
    return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }
  const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";
  try {
    const upstream = await fetch(`${apiUrl}/api/v1/source-research/batches/${batchId}`, {
      cache: "no-store",
      headers: request.headers.get("cookie") === null ? {} : { cookie: request.headers.get("cookie") as string }
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }
    });
  } catch {
    return NextResponse.json({ error: { code: "SOURCE_RESEARCH_UNAVAILABLE" } }, { status: 503 });
  }
}
