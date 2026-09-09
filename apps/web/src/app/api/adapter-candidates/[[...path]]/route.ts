type Context = { params: Promise<{ path?: string[] }> };

export const GET = (request: Request, context: Context) =>
	proxy(request, context);
export const POST = (request: Request, context: Context) =>
	proxy(request, context);

async function proxy(request: Request, context: Context) {
	const { path = [] } = await context.params;
	const valid =
		path.length === 0
			? request.method === "GET"
			: path.length === 1 &&
				/^adapter-candidate-[a-f0-9]{64}$/.test(path[0] ?? "");
	if (!valid)
		return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
	const origin = new URL(request.url).origin;
	if (
		request.method === "POST" &&
		(request.headers.get("origin") !== origin ||
			!request.headers.get("content-type")?.startsWith("application/json"))
	)
		return Response.json(
			{ error: { code: "CANDIDATE_REQUEST_DENIED" } },
			{ status: 403 },
		);
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
	try {
		const target = new URL(
			`/api/v1/admin/adapter-candidates${path.length ? `/${path[0]}` : ""}`,
			process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100",
		);
		target.search = new URL(request.url).search;
		const headers = new Headers({ "content-type": "application/json" });
		const cookie = request.headers.get("cookie");
		if (cookie) headers.set("cookie", cookie);
		const body =
			request.method === "POST" ? await readAction(request, signal) : undefined;
		const upstream = await fetch(target, {
			method: request.method,
			headers,
			...(body === undefined ? {} : { body }),
			cache: "no-store",
			redirect: "manual",
			signal,
		});
		if (upstream.status >= 300 && upstream.status < 400) {
			await upstream.body?.cancel();
			throw new Error("REDIRECT_DENIED");
		}
		return new Response(upstream.body, {
			status: upstream.status,
			headers: {
				"content-type": "application/json",
				"cache-control": "no-store",
			},
		});
	} catch {
		return Response.json(
			{ error: { code: "ADAPTER_CANDIDATE_UNAVAILABLE" } },
			{ status: 503, headers: { "cache-control": "no-store" } },
		);
	}
}

async function readAction(request: Request, signal: AbortSignal) {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > 4096) throw new Error("BODY_TOO_LARGE");
			chunks.push(chunk.value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel();
		reader.releaseLock();
	}
}
