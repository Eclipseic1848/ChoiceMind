import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { GET, POST } from "../src/app/api/adapter-candidates/[[...path]]/route";

test("同源候选代理只携带当前Cookie，拒绝伪造路径、跨站和超大操作", async () => {
	const received: {
		url?: string;
		cookie?: string;
		authorization?: string;
		body: string;
	}[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		received.push({
			url: request.url,
			cookie: request.headers.cookie,
			authorization: request.headers.authorization,
			body,
		});
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"items":[],"nextCursor":null}');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("TEST_LISTENER_MISSING");
	const previous = process.env.CHOICEMIND_API_URL;
	process.env.CHOICEMIND_API_URL = `http://127.0.0.1:${address.port}`;
	try {
		const context = {
			params: Promise.resolve({
				path: [`adapter-candidate-${"a".repeat(64)}`],
			}),
		};
		const headers = {
			cookie: "choicemind_session=synthetic",
			authorization: "Bearer must-not-forward",
			"content-type": "application/json",
			origin: "http://localhost:1029",
		};
		const list = await GET(
			new Request("http://localhost:1029/api/adapter-candidates?limit=2", {
				headers,
			}),
			{ params: Promise.resolve({}) },
		);
		expect(list.status).toBe(200);
		expect(list.headers.get("cache-control")).toBe("no-store");
		await list.text();
		const changed = await POST(
			new Request("http://localhost:1029/api/adapter-candidates/id", {
				method: "POST",
				headers,
				body: '{"type":"ENABLE"}',
			}),
			context,
		);
		expect(changed.status).toBe(200);
		await changed.text();
		expect(received).toHaveLength(2);
		expect(received[0]).toMatchObject({
			url: "/api/v1/admin/adapter-candidates?limit=2",
			cookie: headers.cookie,
			authorization: undefined,
		});
		expect(received[1]?.body).toBe('{"type":"ENABLE"}');
		for (const [origin, body, expected] of [
			["https://untrusted.invalid", "{}", 403],
			[headers.origin, "x".repeat(4097), 503],
		] as const) {
			const result = await POST(
				new Request("http://localhost:1029/api/adapter-candidates/id", {
					method: "POST",
					headers: { ...headers, origin },
					body,
				}),
				context,
			);
			expect(result.status).toBe(expected);
		}
		expect(
			(
				await GET(
					new Request("http://localhost:1029/api/adapter-candidates/x"),
					{ params: Promise.resolve({ path: ["..", "identity"] }) },
				)
			).status,
		).toBe(404);
		expect(received).toHaveLength(2);
	} finally {
		if (previous === undefined) delete process.env.CHOICEMIND_API_URL;
		else process.env.CHOICEMIND_API_URL = previous;
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
