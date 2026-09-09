import type {
	ClientRequest,
	IncomingHttpHeaders,
	IncomingMessage,
} from "node:http";
import { request as nodeHttpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

type HttpsRequestBoundary = (
	options: RequestOptions,
	onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

type PinnedHttpsFetchInput = Readonly<{
	redirect: "manual";
	resolvedAddress: string;
	signal: AbortSignal;
	url: string;
}>;

type PinnedHttpsResponse = Readonly<{
	arrayBuffer(): Promise<ArrayBuffer>;
	body: ReadableStream<Uint8Array> | null;
	headers: Headers;
	ok: boolean;
	status: number;
	url: string;
}>;

export function createPinnedHttpsFetch(
	options: Readonly<{ request?: HttpsRequestBoundary }> = {},
): (input: PinnedHttpsFetchInput) => Promise<PinnedHttpsResponse> {
	const request = options.request ?? nodeHttpsRequest;

	return async (input) => {
		const url = new URL(input.url);
		if (url.protocol !== "https:") {
			throw new TypeError("仅支持 HTTPS URL");
		}
		const hostname =
			url.hostname.startsWith("[") && url.hostname.endsWith("]")
				? url.hostname.slice(1, -1)
				: url.hostname;
		const family = isIP(input.resolvedAddress);
		const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
			callback(
				null,
				lookupOptions.all === true
					? [{ address: input.resolvedAddress, family }]
					: input.resolvedAddress,
				family,
			);
		};

		return new Promise((resolve, reject) => {
			const clientRequest = request(
				{
					agent: false,
					family,
					headers: {
						"accept-encoding": "identity",
						host: url.host,
					},
					hostname,
					lookup,
					method: "GET",
					path: `${url.pathname}${url.search}`,
					protocol: "https:",
					servername: isIP(hostname) === 0 ? hostname : "",
					signal: input.signal,
					...(url.port === "" ? {} : { port: url.port }),
				},
				(response) => resolve(mapResponse(response, input.url)),
			);
			clientRequest.once("error", reject);
			clientRequest.end();
		});
	};
}

function mapResponse(
	response: IncomingMessage,
	url: string,
): PinnedHttpsResponse {
	const status = response.statusCode ?? 0;
	const bodyResponse = new Response(
		Readable.toWeb(response) as ReadableStream<Uint8Array>,
	);
	return {
		arrayBuffer: () => bodyResponse.arrayBuffer(),
		body: bodyResponse.body,
		headers: mapHeaders(response.headers),
		ok: status >= 200 && status < 300,
		status,
		url,
	};
}

function mapHeaders(incoming: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.append(name, value);
		}
	}
	return headers;
}
