import { randomUUID } from "node:crypto";
import { openPostgresIdentityAccess } from "@choicemind/identity-access";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApiApp } from "../../src/app.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)("Identity HTTP Routes", () => {
	afterEach(async () => {
		if (databaseUrl === undefined) return;
		const pool = new Pool({ connectionString: databaseUrl });
		try {
			for (const schema of schemasToDelete.splice(0)) {
				await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
			}
		} finally {
			await pool.end();
		}
	});

	it("本机首次设置通过 HTTP 写入 Postgres，并用 HttpOnly Cookie 解析当前 Principal", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const identityAccess = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => new Date("2026-08-27T18:00:00.000Z"),
		});
		const app = buildApiApp({ identityAccess });

		const status = await app.inject({
			method: "GET",
			url: "/api/v1/identity/bootstrap",
		});
		expect(status.statusCode).toBe(200);
		expect(status.json()).toEqual({ required: true });
		const bootstrap = await app.inject({
			method: "POST",
			url: "/api/v1/identity/bootstrap",
			payload: { password: "abc123!", username: "AdminUser" },
		});
		expect(bootstrap.statusCode).toBe(201);
		expect(bootstrap.json()).toMatchObject({
			access: "FULL",
			account: { role: "SUPERADMIN", username: "AdminUser" },
			recoveryCode: expect.stringMatching(/^[A-Z0-9-]{20,}$/),
		});
		expect(bootstrap.body).not.toContain("sessionToken");
		const setCookie = bootstrap.headers["set-cookie"];
		expect(setCookie).toContain("choicemind_session=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		const cookie = String(setCookie).split(";")[0];

		const me = await app.inject({
			method: "GET",
			url: "/api/v1/identity/me",
			headers: { cookie },
		});
		expect(me.statusCode).toBe(200);
		expect(me.json()).toMatchObject({
			authenticated: true,
			account: { username: "AdminUser" },
			principal: { role: "SUPERADMIN" },
		});

		await app.close();
		await identityAccess.close();
	});

	it("仅信任由本机 Web 代理标记的容器网络初始化请求", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const identityAccess = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => new Date("2026-08-27T18:00:00.000Z"),
		});
		const app = buildApiApp({ identityAccess });
		const previousTrust = process.env.CHOICEMIND_TRUST_LOCAL_WEB_PROXY;
		process.env.CHOICEMIND_TRUST_LOCAL_WEB_PROXY = "true";
		try {
			const unmarked = await app.inject({
				method: "POST",
				url: "/api/v1/identity/bootstrap",
				remoteAddress: "172.18.0.4",
				payload: { password: "abc123!", username: "AdminUser" },
			});
			expect(unmarked.statusCode).toBe(403);

			const marked = await app.inject({
				method: "POST",
				url: "/api/v1/identity/bootstrap",
				remoteAddress: "172.18.0.4",
				headers: { "x-choicemind-local-browser": "1" },
				payload: { password: "abc123!", username: "AdminUser" },
			});
			expect(marked.statusCode).toBe(201);
		} finally {
			if (previousTrust === undefined) {
				delete process.env.CHOICEMIND_TRUST_LOCAL_WEB_PROXY;
			} else {
				process.env.CHOICEMIND_TRUST_LOCAL_WEB_PROXY = previousTrust;
			}
			await app.close();
			await identityAccess.close();
		}
	});

	it("管理员签发 Invitation 后，用户可注册、退出并重新登录", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const identityAccess = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => new Date("2026-08-27T18:00:00.000Z"),
		});
		const app = buildApiApp({ identityAccess });
		const bootstrap = await app.inject({
			method: "POST",
			url: "/api/v1/identity/bootstrap",
			payload: { password: "abc123!", username: "AdminUser" },
		});
		const adminCookie = String(bootstrap.headers["set-cookie"]).split(";")[0];
		const invitation = await app.inject({
			method: "POST",
			url: "/api/v1/identity/invitations",
			headers: { cookie: adminCookie },
		});
		expect(invitation.statusCode).toBe(201);
		expect(invitation.json()).toMatchObject({
			expiresAt: "2026-09-03T18:00:00.000Z",
			invitationCode: expect.stringMatching(/^[A-Z0-9-]{20,}$/),
		});

		const registration = await app.inject({
			method: "POST",
			url: "/api/v1/identity/registrations",
			payload: {
				invitationCode: invitation.json().invitationCode,
				password: "user123!",
				username: "用户A",
			},
		});
		expect(registration.statusCode).toBe(201);
		expect(registration.body).not.toContain("sessionToken");
		const userCookie = String(registration.headers["set-cookie"]).split(";")[0];
		const logout = await app.inject({
			method: "POST",
			url: "/api/v1/identity/logout",
			headers: { cookie: userCookie },
			payload: { scope: "CURRENT" },
		});
		expect(logout.statusCode).toBe(204);
		expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
		await expect(
			app.inject({
				method: "GET",
				url: "/api/v1/identity/me",
				headers: { cookie: userCookie },
			}),
		).resolves.toMatchObject({ statusCode: 401 });

		const login = await app.inject({
			method: "POST",
			url: "/api/v1/identity/login",
			payload: { password: "user123!", username: "用户A" },
		});
		expect(login.statusCode).toBe(200);
		expect(login.json()).toMatchObject({
			access: "FULL",
			account: { role: "USER" },
		});
		expect(login.body).not.toContain("sessionToken");
		expect(login.headers["set-cookie"]).toContain("HttpOnly");

		await app.close();
		await identityAccess.close();
	});

	it("账号安全与管理行为全部通过 HTTP Interface 并保持角色隔离", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const identityAccess = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => new Date("2026-08-27T18:00:00.000Z"),
		});
		const app = buildApiApp({ identityAccess });
		const bootstrap = await app.inject({
			method: "POST",
			url: "/api/v1/identity/bootstrap",
			payload: { password: "super123!", username: "RootAdmin" },
		});
		const superCookie = String(bootstrap.headers["set-cookie"]).split(";")[0];

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/identity/accounts",
			headers: {
				cookie: superCookie,
				"x-correlation-id": "secret-should-not-be-audited",
			},
			payload: { role: "USER", username: "普通用户" },
		});
		expect(created.statusCode).toBe(201);
		const createdBody = created.json();
		expect(createdBody).toMatchObject({
			account: { role: "USER", username: "普通用户" },
			temporaryPassword: expect.any(String),
		});
		const userAccountId = createdBody.account.accountId as string;

		const temporaryLogin = await app.inject({
			method: "POST",
			url: "/api/v1/identity/login",
			payload: {
				password: createdBody.temporaryPassword,
				username: "普通用户",
			},
		});
		expect(temporaryLogin.statusCode).toBe(200);
		expect(temporaryLogin.json()).toMatchObject({
			access: "PASSWORD_CHANGE_REQUIRED",
		});
		const temporaryCookie = String(temporaryLogin.headers["set-cookie"]).split(
			";",
		)[0];
		const temporarySession = await app.inject({
			method: "GET",
			url: "/api/v1/identity/me",
			headers: { cookie: temporaryCookie },
		});
		expect(temporarySession.statusCode).toBe(200);
		expect(temporarySession.json()).toMatchObject({
			access: "PASSWORD_CHANGE_REQUIRED",
			authenticated: true,
			account: { username: "普通用户" },
		});

		const completed = await app.inject({
			method: "POST",
			url: "/api/v1/identity/password/temporary",
			headers: { cookie: temporaryCookie },
			payload: { newPassword: "user123!" },
		});
		expect(completed.statusCode).toBe(200);
		expect(completed.body).not.toContain("sessionToken");
		const userCookie = String(completed.headers["set-cookie"]).split(";")[0];
		await expect(
			app.inject({
				method: "GET",
				url: "/api/v1/identity/me",
				headers: { cookie: userCookie },
			}),
		).resolves.toMatchObject({ statusCode: 200 });

		const passwordChanged = await app.inject({
			method: "POST",
			url: "/api/v1/identity/password",
			headers: { cookie: userCookie },
			payload: { currentPassword: "user123!", newPassword: "user456!" },
		});
		expect(passwordChanged.statusCode).toBe(204);
		expect(passwordChanged.headers["set-cookie"]).toContain("Max-Age=0");

		const invitation = await app.inject({
			method: "POST",
			url: "/api/v1/identity/invitations",
			headers: { cookie: superCookie },
		});
		const invitations = await app.inject({
			method: "GET",
			url: "/api/v1/identity/invitations",
			headers: { cookie: superCookie },
		});
		expect(invitations.statusCode).toBe(200);
		expect(invitations.body).not.toContain(invitation.json().invitationCode);
		expect(invitations.json().invitations).toContainEqual(
			expect.objectContaining({
				invitationId: invitation.json().invitationId,
				status: "ACTIVE",
			}),
		);
		const revoked = await app.inject({
			method: "DELETE",
			url: `/api/v1/identity/invitations/${invitation.json().invitationId}`,
			headers: { cookie: superCookie },
		});
		expect(revoked.statusCode).toBe(204);
		const revokedAgain = await app.inject({
			method: "DELETE",
			url: `/api/v1/identity/invitations/${invitation.json().invitationId}`,
			headers: { cookie: superCookie },
		});
		expect(revokedAgain.statusCode).toBe(404);

		const accounts = await app.inject({
			method: "GET",
			url: "/api/v1/identity/accounts",
			headers: { cookie: superCookie },
		});
		expect(accounts.statusCode).toBe(200);
		expect(accounts.body).not.toMatch(/password|sessionToken|cookie|secret/i);
		expect(accounts.json().accounts).toContainEqual(
			expect.objectContaining({
				accountId: userAccountId,
				role: "USER",
				status: "ACTIVE",
			}),
		);

		const promoted = await app.inject({
			method: "PATCH",
			url: `/api/v1/identity/accounts/${userAccountId}/role`,
			headers: { cookie: superCookie },
			payload: { currentPassword: "super123!", role: "ADMIN" },
		});
		expect(promoted.statusCode).toBe(200);
		const demoted = await app.inject({
			method: "PATCH",
			url: `/api/v1/identity/accounts/${userAccountId}/role`,
			headers: { cookie: superCookie },
			payload: { currentPassword: "super123!", role: "USER" },
		});
		expect(demoted.statusCode).toBe(200);

		const disabled = await app.inject({
			method: "PATCH",
			url: `/api/v1/identity/accounts/${userAccountId}/status`,
			headers: { cookie: superCookie },
			payload: { status: "DISABLED" },
		});
		expect(disabled.statusCode).toBe(200);
		const blockedLogin = await app.inject({
			method: "POST",
			url: "/api/v1/identity/login",
			payload: { password: "user456!", username: "普通用户" },
		});
		expect(blockedLogin.statusCode).toBe(401);
		await expect(
			app.inject({
				method: "PATCH",
				url: `/api/v1/identity/accounts/${userAccountId}/status`,
				headers: { cookie: superCookie },
				payload: { status: "ACTIVE" },
			}),
		).resolves.toMatchObject({ statusCode: 200 });

		const deletion = await app.inject({
			method: "POST",
			url: `/api/v1/identity/accounts/${userAccountId}/deletion`,
			headers: { cookie: superCookie },
			payload: { currentPassword: "super123!" },
		});
		expect(deletion.statusCode).toBe(202);
		expect(deletion.json()).toMatchObject({
			accountId: userAccountId,
			deletionDueAt: "2026-09-03T18:00:00.000Z",
		});

		const audit = await app.inject({
			method: "GET",
			url: "/api/v1/identity/audit-records",
			headers: { cookie: superCookie },
		});
		expect(audit.statusCode).toBe(200);
		expect(audit.body).not.toMatch(
			/super123|user456|temporaryPassword|sessionToken|cookie/i,
		);
		expect(audit.body).not.toContain("secret-should-not-be-audited");
		const auditedActions = new Set(
			(audit.json().records as Array<{ action: string }>).map(
				(record) => record.action,
			),
		);
		for (const action of [
			"CREATE_ACCOUNT",
			"COMPLETE_TEMPORARY_PASSWORD_CHANGE",
			"CHANGE_PASSWORD",
			"REVOKE_INVITATION",
			"SET_ACCOUNT_ROLE",
			"SET_ACCOUNT_STATUS",
			"REQUEST_ACCOUNT_DELETION",
		]) {
			expect(auditedActions, `缺少审计动作 ${action}`).toContain(action);
		}

		await app.close();
		await identityAccess.close();
	});
});

async function createIsolatedDatabaseUrl(baseUrl: string): Promise<string> {
	const schema = `identity_api_test_${randomUUID().replaceAll("-", "")}`;
	const pool = new Pool({ connectionString: baseUrl });
	try {
		await pool.query(`CREATE SCHEMA "${schema}"`);
	} finally {
		await pool.end();
	}
	schemasToDelete.push(schema);
	const url = new URL(baseUrl);
	url.searchParams.set("options", `-c search_path=${schema}`);
	return url.toString();
}
