import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)("Identity & Access Logout", () => {
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

	it("退出当前会话只撤销当前 token，不影响同账号的其他会话", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const now = new Date("2026-08-27T18:00:00.000Z");
		const identity = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => now,
		});
		const bootstrap = await identity.execute({
			type: "BOOTSTRAP_SUPERADMIN",
			correlationId: "bootstrap-for-logout",
			isLocalRequest: true,
			password: "abc123!",
			username: "AdminUser",
		});
		if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
		const secondLogin = await identity.execute({
			type: "LOGIN",
			correlationId: "second-login",
			password: "abc123!",
			username: "AdminUser",
		});
		if (!secondLogin.ok) throw new Error("第二个会话应登录成功");

		await expect(
			identity.execute({
				type: "LOGOUT_CURRENT",
				correlationId: "logout-current",
				sessionToken: bootstrap.sessionToken,
			}),
		).resolves.toEqual({ ok: true });
		await expect(
			identity.read({
				type: "GET_CURRENT_SESSION",
				sessionToken: bootstrap.sessionToken,
			}),
		).resolves.toEqual({ authenticated: false });
		await expect(
			identity.read({
				type: "GET_CURRENT_SESSION",
				sessionToken: secondLogin.sessionToken,
			}),
		).resolves.toMatchObject({ authenticated: true });
		await identity.close();
	});

	it("退出全部会话撤销同账号的所有 token", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const now = new Date("2026-08-27T18:00:00.000Z");
		const identity = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => now,
		});
		const bootstrap = await identity.execute({
			type: "BOOTSTRAP_SUPERADMIN",
			correlationId: "bootstrap-for-logout-all",
			isLocalRequest: true,
			password: "abc123!",
			username: "AdminUser",
		});
		if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
		const secondLogin = await identity.execute({
			type: "LOGIN",
			correlationId: "second-login-for-logout-all",
			password: "abc123!",
			username: "AdminUser",
		});
		if (!secondLogin.ok) throw new Error("第二个会话应登录成功");

		await expect(
			identity.execute({
				type: "LOGOUT_ALL",
				correlationId: "logout-all",
				sessionToken: secondLogin.sessionToken,
			}),
		).resolves.toEqual({ ok: true });
		for (const sessionToken of [
			bootstrap.sessionToken,
			secondLogin.sessionToken,
		]) {
			await expect(
				identity.read({ type: "GET_CURRENT_SESSION", sessionToken }),
			).resolves.toEqual({ authenticated: false });
		}
		await identity.close();
	});
});

async function createIsolatedDatabaseUrl(baseUrl: string): Promise<string> {
	const schema = `identity_test_${randomUUID().replaceAll("-", "")}`;
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
