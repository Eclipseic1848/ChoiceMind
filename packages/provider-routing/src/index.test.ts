import { describe, expect, it } from "vitest";

import {
	normalizeLocalProviderEndpoint,
	ProviderRoutingOperationError,
} from "./index.js";

describe("本地 Provider 地址边界", () => {
	it.each([
		"http://127.0.0.1:6013/v1",
		"http://localhost:6013/v1",
		"http://192.168.50.123:6013/v1",
		"https://10.0.0.8:6013/v1/",
	])("接受受控本地地址 %s", (value) => {
		expect(normalizeLocalProviderEndpoint(value).href).toBe(
			new URL(value).href,
		);
	});

	it.each([
		"https://provider.example/v1",
		"http://127.0.0.1:49152/v1",
		"http://192.168.50.123:8000/v1",
		"http://127.0.0.1:6013/other",
		"http://user:secret@127.0.0.1:6013/v1",
	])("拒绝可能外传或越界的地址 %s", (value) => {
		expect(() => normalizeLocalProviderEndpoint(value)).toThrow(
			ProviderRoutingOperationError,
		);
	});
});
