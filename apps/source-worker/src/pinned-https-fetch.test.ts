import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createPinnedHttpsFetch } from "./pinned-https-fetch.js";

function createIncomingMessage(body: string): IncomingMessage {
	const response = Readable.from([
		Buffer.from(body, "utf8"),
	]) as IncomingMessage;
	response.headers = {
		"content-type": "text/plain; charset=utf-8",
		"x-source": "fixed-address",
	};
	response.statusCode = 200;
	return response;
}

function createClientRequest(): ClientRequest {
	return Object.assign(new EventEmitter(), {
		end: vi.fn(),
	}) as unknown as ClientRequest;
}

describe("createPinnedHttpsFetch", () => {
	it("固定实际拨号地址，同时保留原始 HTTPS 主机语义并映射响应", async () => {
		const request = vi.fn(
			(
				_options: RequestOptions,
				onResponse: (response: IncomingMessage) => void,
			): ClientRequest => {
				onResponse(createIncomingMessage("固定响应"));
				return createClientRequest();
			},
		);
		const fetch = createPinnedHttpsFetch({ request });
		const controller = new AbortController();
		const input = {
			redirect: "manual" as const,
			resolvedAddress: "93.184.216.34",
			signal: controller.signal,
			url: "https://source.example:8443/product?q=1",
		};

		const response = await fetch(input);
		const options = request.mock.calls[0]?.[0];
		expect(options).toBeDefined();
		expect(options?.agent).toBe(false);
		expect(options?.hostname).toBe("source.example");
		expect(options?.servername).toBe("source.example");
		expect(options?.headers).toMatchObject({
			"accept-encoding": "identity",
			host: "source.example:8443",
		});
		expect(options?.signal).toBe(controller.signal);

		const pinnedAddress = await new Promise((resolve, reject) => {
			if (options?.lookup === undefined) {
				reject(new Error("缺少固定地址 lookup"));
				return;
			}
			options.lookup(
				"source.example",
				{ all: false },
				(error, address, family) => {
					if (error !== null) {
						reject(error);
						return;
					}
					resolve({ address, family });
				},
			);
		});
		expect(pinnedAddress).toEqual({ address: "93.184.216.34", family: 4 });
		expect(response).toMatchObject({
			ok: true,
			status: 200,
			url: input.url,
		});
		expect(response.headers).toBeInstanceOf(Headers);
		expect(response.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(response.headers.get("x-source")).toBe("fixed-address");
		expect(response.body).not.toBeNull();
		expect(await new Response(response.body).text()).toBe("固定响应");

		const bufferedResponse = await fetch(input);
		expect(
			Buffer.from(await bufferedResponse.arrayBuffer()).toString("utf8"),
		).toBe("固定响应");
	});

	it("拒绝非 HTTPS URL，且不创建请求", async () => {
		const request = vi.fn(
			(
				_options: RequestOptions,
				_onResponse: (response: IncomingMessage) => void,
			): ClientRequest => createClientRequest(),
		);
		const fetch = createPinnedHttpsFetch({ request });

		await expect(
			fetch({
				redirect: "manual",
				resolvedAddress: "93.184.216.34",
				signal: new AbortController().signal,
				url: "http://source.example/product",
			}),
		).rejects.toThrow("仅支持 HTTPS URL");
		expect(request).not.toHaveBeenCalled();
	});

	it("IPv6 字面量拨号不发送 IP SNI，并保留带方括号的 Host", async () => {
		const request = vi.fn(
			(
				_options: RequestOptions,
				onResponse: (response: IncomingMessage) => void,
			): ClientRequest => {
				onResponse(createIncomingMessage("IPv6 响应"));
				return createClientRequest();
			},
		);
		const fetch = createPinnedHttpsFetch({ request });

		const response = await fetch({
			redirect: "manual",
			resolvedAddress: "2606:4700:4700::1111",
			signal: new AbortController().signal,
			url: "https://[2606:4700:4700::1111]:8443/product",
		});
		const options = request.mock.calls[0]?.[0];
		expect(options?.hostname).toBe("2606:4700:4700::1111");
		expect(options?.servername).toBe("");
		expect(options?.headers).toMatchObject({
			host: "[2606:4700:4700::1111]:8443",
		});
		expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe(
			"IPv6 响应",
		);
	});
});
