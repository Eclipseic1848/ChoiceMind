type RouteContext = Readonly<{
  params: Promise<Readonly<{ decisionTaskId: string }>>;
}>;

export async function GET(request: Request, context: RouteContext) {
  const { decisionTaskId } = await context.params;
  const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";
  const lastEventId =
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
  const headers = new Headers({ Accept: "text/event-stream" });

  if (lastEventId !== null) {
    headers.set("Last-Event-ID", lastEventId);
  }

  try {
    const response = await fetch(
      `${apiUrl}/api/v1/decision-tasks/${encodeURIComponent(decisionTaskId)}/events`,
      {
        cache: "no-store",
        headers,
        signal: request.signal
      }
    );

    return new Response(response.body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": response.headers.get("content-type") ?? "application/octet-stream"
      },
      status: response.status
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}
