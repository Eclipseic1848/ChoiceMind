import { afterEach, expect, it, vi } from "vitest";
import { buildApiApp } from "../app.js";
import { createSyntheticIdentityResolver } from "../security/identity.js";
import type { CandidateStore } from "./routes.js";

const apps: ReturnType<typeof buildApiApp>[] = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});
const url = `/api/v1/admin/adapter-candidates/adapter-candidate-${"a".repeat(64)}`;
const payload = {
	type: "ENABLE",
	reviewBindingSha256: "b".repeat(64),
	requestId: "request-1",
};
function setup() {
	const store = {
		list: vi.fn(async () => ({ items: [], nextCursor: null })),
		read: vi.fn(async () => undefined),
		transition: vi.fn(async () => ({ state: "ENABLED" })),
		record: vi.fn(),
		close: vi.fn(),
	};
	const app = buildApiApp({
		candidateStore: store as unknown as CandidateStore,
		now: () => new Date("2026-09-08T12:01:00.000Z"),
		identityResolver: createSyntheticIdentityResolver({
			admin: { principalId: "a", userId: "verified-admin", role: "ADMIN" },
			user: { principalId: "u", userId: "ordinary-user", role: "USER" },
		}),
	});
	apps.push(app);
	return { app, store };
}

it("候选列表只对管理员开放，分页参数有界且不缓存", async () => {
	const { app, store } = setup();
	const listUrl = "/api/v1/admin/adapter-candidates";
	for (const token of [undefined, "user"]) {
		const response = await app.inject({
			url: listUrl,
			...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
		});
		expect(response.statusCode).toBe(token ? 403 : 401);
	}
	expect(store.list).not.toHaveBeenCalled();
	const headers = { authorization: "Bearer admin" };
	for (const query of [
		"limit=51",
		"limit=0",
		"cursor=0",
		"cursor=abc",
		"cursor=9223372036854775808",
		"actorRole=SUPERADMIN",
	]) {
		expect(
			(await app.inject({ url: `${listUrl}?${query}`, headers })).statusCode,
		).toBe(422);
	}
	expect(store.list).not.toHaveBeenCalled();
	const response = await app.inject({
		url: `${listUrl}?limit=2&cursor=123`,
		headers,
	});
	expect(response.statusCode).toBe(200);
	expect(response.headers["cache-control"]).toBe("no-store");
	expect(response.json()).toEqual({ items: [], nextCursor: null });
	expect(store.list).toHaveBeenCalledWith({ limit: 2, cursor: "123" });
	store.list.mockRejectedValueOnce(new Error("synthetic-db-secret"));
	const failed = await app.inject({ url: listUrl, headers });
	expect(failed.statusCode).toBe(503);
	expect(failed.body).not.toContain("synthetic-db-secret");
});
it("未登录和普通用户不能读写候选", async () => {
	const { app, store } = setup();
	for (const method of ["GET", "POST"] as const)
		for (const token of [undefined, "user"]) {
			const result = await app.inject({
				method,
				url,
				...(token === undefined
					? {}
					: { headers: { authorization: `Bearer ${token}` } }),
				...(method === "POST" ? { payload } : {}),
			});
			expect(result.statusCode).toBe(token === undefined ? 401 : 403);
		}
	expect(store.read).not.toHaveBeenCalled();
	expect(store.transition).not.toHaveBeenCalled();
});
it("动作身份和时间只来自服务端，禁止自报角色及审查结果", async () => {
	const { app, store } = setup();
	const headers = { authorization: "Bearer admin" };
	for (const extra of [
		{ actorRole: "SUPERADMIN" },
		{ actorId: "another-user" },
		{ occurredAt: "2000-01-01" },
		{ review: { status: "PASSED" } },
	]) {
		expect(
			(
				await app.inject({
					method: "POST",
					url,
					headers,
					payload: { ...payload, ...extra },
				})
			).statusCode,
		).toBe(422);
	}
	expect(store.transition).not.toHaveBeenCalled();
	expect(
		(await app.inject({ method: "POST", url, headers, payload })).statusCode,
	).toBe(200);
	expect(store.transition).toHaveBeenCalledWith(
		`adapter-candidate-${"a".repeat(64)}`,
		payload.reviewBindingSha256,
		payload.requestId,
		{
			type: "ENABLE",
			actorId: "verified-admin",
			actorRole: "ADMIN",
			occurredAt: "2026-09-08T12:01:00.000Z",
		},
	);
	expect(store.record).not.toHaveBeenCalled();
});
it("报告冲突明确拒绝，内部错误不泄漏", async () => {
	const { app, store } = setup();
	store.transition.mockRejectedValueOnce(
		new Error("ADAPTER_CANDIDATE_REVIEW_STALE"),
	);
	expect(
		(
			await app.inject({
				method: "POST",
				url,
				headers: { authorization: "Bearer admin" },
				payload,
			})
		).statusCode,
	).toBe(409);
	store.transition.mockRejectedValueOnce(new Error("password=secret-internal"));
	const failed = await app.inject({
		method: "POST",
		url,
		headers: { authorization: "Bearer admin" },
		payload,
	});
	expect(failed.statusCode).toBe(503);
	expect(failed.body).not.toContain("secret-internal");
});

it("详情存储异常脱敏且所有详情响应禁止缓存", async () => {
	const { app, store } = setup();
	const headers = { authorization: "Bearer admin" };
	store.read.mockRejectedValueOnce(new Error("synthetic-private-db-path"));
	const failed = await app.inject({ url, headers });
	expect(failed.body).not.toContain("synthetic-private-db-path");
	expect(failed.statusCode).toBe(503);
	expect(failed.headers["cache-control"]).toBe("no-store");
	for (const authorization of [
		"Bearer admin",
		"Bearer user",
		"Bearer unknown",
	]) {
		const response = await app.inject({ url, headers: { authorization } });
		expect(response.headers["cache-control"]).toBe("no-store");
	}
});
