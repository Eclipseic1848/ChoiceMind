const allowedMethods = ["GET", "POST", "PATCH", "DELETE"] as const;
const localBrowserHeaderName = "x-choicemind-local-browser";

type AllowedMethod = (typeof allowedMethods)[number];

export async function GET(
	request: Request,
	context: RouteContext<"/api/identity/[...path]">,
) {
	return proxyIdentityRequest(request, context, "GET");
}

export async function POST(
	request: Request,
	context: RouteContext<"/api/identity/[...path]">,
) {
	return proxyIdentityRequest(request, context, "POST");
}

export async function PATCH(
	request: Request,
	context: RouteContext<"/api/identity/[...path]">,
) {
	return proxyIdentityRequest(request, context, "PATCH");
}

export async function DELETE(
	request: Request,
	context: RouteContext<"/api/identity/[...path]">,
) {
	return proxyIdentityRequest(request, context, "DELETE");
}

async function proxyIdentityRequest(
	request: Request,
	context: RouteContext<"/api/identity/[...path]">,
	method: AllowedMethod,
): Promise<Response> {
	const { path } = await context.params;
	const isLocalOnlyPath = path[0] === "bootstrap" || path[0] === "recovery";
	if (isLocalOnlyPath && !isLocalBrowserRequest(request)) {
		return Response.json({ code: "LOCAL_ONLY" }, { status: 403 });
	}
	const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";
	const target = new URL(`/api/v1/identity/${path.join("/")}`, apiUrl);
	target.search = new URL(request.url).search;

	const headers = new Headers();
	copyHeader(request.headers, headers, "content-type");
	copyHeader(request.headers, headers, "cookie");
	copyHeader(request.headers, headers, "x-correlation-id");
	if (isLocalOnlyPath) headers.set(localBrowserHeaderName, "1");

	try {
		const init: RequestInit = {
			cache: "no-store",
			headers,
			method,
			redirect: "manual",
		};
		if (method !== "GET") init.body = await request.text();
		const upstream = await fetch(target, init);
		const responseHeaders = new Headers();
		copyHeader(upstream.headers, responseHeaders, "content-type");
		copyHeader(upstream.headers, responseHeaders, "set-cookie");
		copyHeader(upstream.headers, responseHeaders, "retry-after");
		return new Response(upstream.body, {
			headers: responseHeaders,
			status: upstream.status,
		});
	} catch {
		return Response.json({ code: "IDENTITY_UNAVAILABLE" }, { status: 503 });
	}
}

function isLocalBrowserRequest(request: Request): boolean {
	const host = request.headers.get("host");
	const hostname = new URL(
		`http://${host ?? new URL(request.url).host}`,
	).hostname.toLowerCase();
	return (
		hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
	);
}

function copyHeader(source: Headers, target: Headers, name: string): void {
	const value = source.get(name);
	if (value !== null) target.set(name, value);
}
