import { openPostgresIdentityAccess } from "@choicemind/identity-access";
import { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { expect, it } from "vitest";
import { buildApiApp } from "../../src/app.js";

it("真实登录 Cookie 授权候选审批，普通用户拒绝，注销后权限立即失效", async () => {
	const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
	if (!databaseUrl) throw new Error("必须配置隔离测试数据库");
	const identityAccess = await openPostgresIdentityAccess({ databaseUrl });
	const candidateStore = await openPostgresCandidateStore(databaseUrl);
	const app = buildApiApp({ identityAccess, candidateStore });
	try {
		const base = await app.listen({ host: "127.0.0.1", port: 0 });
		async function request(
			path: string,
			method = "GET",
			payload?: unknown,
			cookie?: string,
		) {
			return fetch(`${base}/api/v1/${path}`, {
				method,
				headers: {
					...(payload === undefined
						? {}
						: { "content-type": "application/json" }),
					...(cookie === undefined ? {} : { cookie }),
				},
				...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
			});
		}
		const credentials = {
			username: "CandidateAdmin",
			password: "Synthetic123!",
		};
		const bootstrap = await request("identity/bootstrap", "POST", credentials);
		expect(bootstrap.status).toBe(201);
		await bootstrap.json();
		const login = await request("identity/login", "POST", credentials);
		expect(login.status).toBe(200);
		const adminCookie = login.headers.get("set-cookie")?.split(";")[0];
		if (!adminCookie) throw new Error("登录未返回Cookie");
		await login.json();
		const me = await request("identity/me", "GET", undefined, adminCookie);
		const principal = (await me.json()).principal;
		const stored = await candidateStore.record({
			schemaVersion: "adapter-candidate.v1",
			source: {
				kind: "NPM",
				packageName: "candidate-http-test",
				version: "1.0.0",
				artifactSha256: "a".repeat(64),
			},
			review: {
				reportSha256: "b".repeat(64),
				reviewedAt: new Date().toISOString(),
				checks: Object.fromEntries(
					[
						"dependencies",
						"entrypoints",
						"network",
						"secrets",
						"basicCollection",
						"loginExpiry",
						"rateLimit",
						"emptyResult",
						"failureHandling",
					].map((key) => [
						key,
						{ status: "PASSED", checkCount: 1, findingCount: 0 },
					]),
				),
			},
		});
		const path = `admin/adapter-candidates/${stored.candidate.candidateId}`;
		const action = {
			type: "ENABLE",
			requestId: "http-approval",
			reviewBindingSha256: stored.lifecycle.reviewBindingSha256,
		};
		const enabled = await request(path, "POST", action, adminCookie);
		expect(enabled.status).toBe(200);
		expect((await enabled.json()).events[0]).toMatchObject({
			actorId: principal.userId,
			actorRole: "SUPERADMIN",
		});
		const invite = await request(
			"identity/invitations",
			"POST",
			{},
			adminCookie,
		);
		expect(invite.status).toBe(201);
		const registration = await request("identity/registrations", "POST", {
			username: "CandidateUser",
			password: "Synthetic456!",
			invitationCode: (await invite.json()).invitationCode,
		});
		expect(registration.status).toBe(201);
		await registration.json();
		const userCookie = registration.headers.get("set-cookie")?.split(";")[0];
		if (!userCookie) throw new Error("注册未返回Cookie");
		for (const method of ["GET", "POST"]) {
			const denied = await request(
				path,
				method,
				method === "POST" ? action : undefined,
				userCookie,
			);
			expect(denied.status).toBe(403);
			await denied.json();
		}
		const logout = await request(
			"identity/logout",
			"POST",
			{ scope: "ALL" },
			adminCookie,
		);
		expect(logout.status).toBe(204);
		const revoked = await request(path, "POST", action, adminCookie);
		expect(revoked.status).toBe(401);
		await revoked.json();
		expect(
			(await candidateStore.read(stored.candidate.candidateId))?.lifecycle
				.events,
		).toHaveLength(1);
	} finally {
		await app.close();
		await candidateStore.close();
		await identityAccess.close();
	}
}, 30_000);
