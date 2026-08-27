import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity & Access Admin-created Account",
	() => {
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

		it("管理员代创建 USER 后，临时密码只允许进入强制改密并在完成后失效", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-admin-create",
				isLocalRequest: true,
				password: "abc123!",
				username: "AdminUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");

			const created = await identity.execute({
				type: "CREATE_ACCOUNT",
				correlationId: "create-user-a",
				role: "USER",
				sessionToken: bootstrap.sessionToken,
				username: "用户A",
			});
			expect(created).toMatchObject({
				ok: true,
				account: { role: "USER", status: "ACTIVE", username: "用户A" },
			});
			if (!created.ok || !("temporaryPassword" in created)) {
				throw new Error("代创建账号应返回一次性临时密码");
			}
			expect(created.temporaryPassword).toMatch(/^[\x21-\x7E]{6,}$/);

			const temporaryLogin = await identity.execute({
				type: "LOGIN",
				correlationId: "temporary-login",
				password: created.temporaryPassword,
				username: "用户A",
			});
			expect(temporaryLogin).toMatchObject({
				ok: true,
				access: "PASSWORD_CHANGE_REQUIRED",
				account: { role: "USER", username: "用户A" },
			});
			if (
				!temporaryLogin.ok ||
				temporaryLogin.access !== "PASSWORD_CHANGE_REQUIRED"
			) {
				throw new Error("临时密码只能进入强制改密");
			}

			const changed = await identity.execute({
				type: "COMPLETE_TEMPORARY_PASSWORD_CHANGE",
				correlationId: "complete-temporary-password-change",
				newPassword: "user123!",
				sessionToken: temporaryLogin.sessionToken,
			});
			expect(changed).toMatchObject({ ok: true, access: "FULL" });
			await expect(
				identity.execute({
					type: "LOGIN",
					correlationId: "reused-temporary-password",
					password: created.temporaryPassword,
					username: "用户A",
				}),
			).resolves.toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
			await expect(
				identity.execute({
					type: "LOGIN",
					correlationId: "permanent-password-login",
					password: "user123!",
					username: "用户A",
				}),
			).resolves.toMatchObject({ ok: true, access: "FULL" });
			await identity.close();
		});

		it("管理员重置 USER 密码后撤销其全部会话，并只返回新的临时密码", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-password-reset",
				isLocalRequest: true,
				password: "abc123!",
				username: "AdminUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const created = await identity.execute({
				type: "CREATE_ACCOUNT",
				correlationId: "create-user-for-reset",
				role: "USER",
				sessionToken: bootstrap.sessionToken,
				username: "用户A",
			});
			if (!created.ok || !("temporaryPassword" in created))
				throw new Error("创建应成功");
			const temporaryLogin = await identity.execute({
				type: "LOGIN",
				correlationId: "temporary-login-before-reset",
				password: created.temporaryPassword,
				username: "用户A",
			});
			if (
				!temporaryLogin.ok ||
				temporaryLogin.access !== "PASSWORD_CHANGE_REQUIRED"
			) {
				throw new Error("临时登录应成功");
			}
			const changed = await identity.execute({
				type: "COMPLETE_TEMPORARY_PASSWORD_CHANGE",
				correlationId: "complete-before-reset",
				newPassword: "user123!",
				sessionToken: temporaryLogin.sessionToken,
			});
			if (!changed.ok) throw new Error("强制改密应成功");

			const reset = await identity.execute({
				type: "RESET_ACCOUNT_PASSWORD",
				accountId: created.account.accountId,
				correlationId: "reset-user-password",
				sessionToken: bootstrap.sessionToken,
			});
			expect(reset).toMatchObject({
				ok: true,
				accountId: created.account.accountId,
			});
			if (!reset.ok || !("temporaryPassword" in reset))
				throw new Error("重置应返回临时密码");
			await expect(
				identity.read({
					type: "GET_CURRENT_SESSION",
					sessionToken: changed.sessionToken,
				}),
			).resolves.toEqual({ authenticated: false });
			await expect(
				identity.execute({
					type: "LOGIN",
					correlationId: "old-password-after-reset",
					password: "user123!",
					username: "用户A",
				}),
			).resolves.toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
			await expect(
				identity.execute({
					type: "LOGIN",
					correlationId: "temporary-password-after-reset",
					password: reset.temporaryPassword,
					username: "用户A",
				}),
			).resolves.toMatchObject({
				ok: true,
				access: "PASSWORD_CHANGE_REQUIRED",
			});
			await identity.close();
		});
	},
);

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
