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
