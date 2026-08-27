import { type NextRequest, NextResponse } from "next/server";

type RouteContext = Readonly<{ params: Promise<{ path?: string[] }> }>;

export async function GET(request: NextRequest, context: RouteContext) {
	return proxyConversation(request, context, "GET");
}

export async function POST(request: NextRequest, context: RouteContext) {
	return proxyConversation(request, context, "POST");
}

async function proxyConversation(
	request: NextRequest,
	context: RouteContext,
	method: "GET" | "POST",
) {
	const { path = [] } = await context.params;
	if (!isAllowedPath(method, path)) {
		return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
	}
	const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";
	const suffix =
		path.length === 0 ? "" : `/${path.map(encodeURIComponent).join("/")}`;
	try {
		const upstream = await fetch(`${apiUrl}/api/v1/conversations${suffix}`, {
			method,
			cache: "no-store",
			headers: {
				...(request.headers.get("cookie") === null
					? {}
					: { cookie: request.headers.get("cookie") as string }),
				...(method === "POST" ? { "content-type": "application/json" } : {}),
			},
			...(method === "POST" ? { body: await request.text() } : {}),
		});
		return new NextResponse(await upstream.text(), {
			status: upstream.status,
			headers: {
				"cache-control": "no-store",
				"content-type":
					upstream.headers.get("content-type") ??
					"application/json; charset=utf-8",
			},
		});
	} catch {
		return NextResponse.json(
			{
				error: {
					code: "CONVERSATION_UNAVAILABLE",
					message: "对话服务暂时不可用",
				},
			},
			{ status: 503 },
		);
	}
}

function isAllowedPath(
	method: "GET" | "POST",
	path: readonly string[],
): boolean {
	if (path.length === 0) return method === "GET" || method === "POST";
	if (path.length === 1)
		return method === "GET" && isOpaquePathSegment(path[0]);
	if (path.length === 2 && isOpaquePathSegment(path[0])) {
		return (
			(method === "POST" && path[1] === "turns") ||
			(method === "POST" && path[1] === "decision-tasks") ||
			(method === "GET" && path[1] === "requirements")
		);
	}
	return false;
}

function isOpaquePathSegment(value: string | undefined): value is string {
	return value !== undefined && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}
