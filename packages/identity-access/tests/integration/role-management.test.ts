import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity & Access Role Management",
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

		it("只有重新验证密码的 SUPERADMIN 能变更角色，且最后一名不能被降级", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-role-management",
				isLocalRequest: true,
				password: "abc123!",
				username: "AdminUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const created = await identity.execute({
				type: "CREATE_ACCOUNT",
				correlationId: "create-role-target",
				role: "USER",
				sessionToken: bootstrap.sessionToken,
				username: "用户A",
			});
			if (!created.ok || !("account" in created)) throw new Error("创建应成功");

			await expect(
				identity.execute({
					type: "SET_ACCOUNT_ROLE",
					accountId: created.account.accountId,
					correlationId: "role-change-wrong-password",
					currentPassword: "wrong-password",
					role: "ADMIN",
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toEqual({ ok: false, code: "REAUTHENTICATION_FAILED" });
			await expect(
				identity.execute({
					type: "SET_ACCOUNT_ROLE",
					accountId: created.account.accountId,
					correlationId: "promote-user-to-admin",
					currentPassword: "abc123!",
					role: "ADMIN",
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toEqual({
				ok: true,
				account: { accountId: created.account.accountId, role: "ADMIN" },
			});
			await expect(
				identity.execute({
					type: "SET_ACCOUNT_ROLE",
					accountId: bootstrap.account.accountId,
					correlationId: "demote-last-superadmin",
					currentPassword: "abc123!",
					role: "ADMIN",
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toEqual({ ok: false, code: "LAST_SUPERADMIN" });
			await identity.close();
		});

		it("ADMIN 可管理普通 USER，但不能管理角色、ADMIN 或永久删除", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-admin-rbac",
				isLocalRequest: true,
				password: "abc123!",
				username: "SuperUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const adminAccount = await identity.execute({
				type: "CREATE_ACCOUNT",
				correlationId: "create-admin-account",
				role: "ADMIN",
				sessionToken: bootstrap.sessionToken,
				username: "AdminUser",
			});
			if (!adminAccount.ok || !("temporaryPassword" in adminAccount)) {
				throw new Error("ADMIN 账号创建应成功");
			}
			const adminLogin = await identity.execute({
				type: "LOGIN",
				correlationId: "admin-temporary-login",
				password: adminAccount.temporaryPassword,
				username: "AdminUser",
			});
			if (!adminLogin.ok || adminLogin.access !== "PASSWORD_CHANGE_REQUIRED") {
				throw new Error("ADMIN 临时登录应成功");
			}
			const adminReady = await identity.execute({
				type: "COMPLETE_TEMPORARY_PASSWORD_CHANGE",
				correlationId: "admin-complete-password",
				newPassword: "admin123!",
				sessionToken: adminLogin.sessionToken,
			});
			if (!adminReady.ok) throw new Error("ADMIN 强制改密应成功");

			await expect(
				identity.execute({
					type: "CREATE_ACCOUNT",
					correlationId: "admin-create-user",
					role: "USER",
					sessionToken: adminReady.sessionToken,
					username: "用户A",
				}),
			).resolves.toMatchObject({ ok: true, account: { role: "USER" } });
			await expect(
				identity.execute({
					type: "CREATE_ACCOUNT",
					correlationId: "admin-create-admin",
					role: "ADMIN",
					sessionToken: adminReady.sessionToken,
					username: "AnotherAdmin",
				}),
			).resolves.toEqual({ ok: false, code: "UNAUTHORIZED" });
			await expect(
				identity.execute({
					type: "SET_ACCOUNT_ROLE",
					accountId: adminAccount.account.accountId,
					correlationId: "admin-change-role",
					currentPassword: "admin123!",
					role: "USER",
					sessionToken: adminReady.sessionToken,
				}),
			).resolves.toEqual({ ok: false, code: "UNAUTHORIZED" });
			await expect(
				identity.execute({
					type: "SET_ACCOUNT_STATUS",
					accountId: adminAccount.account.accountId,
					correlationId: "admin-disable-admin",
					sessionToken: adminReady.sessionToken,
					status: "DISABLED",
				}),
			).resolves.toEqual({ ok: false, code: "UNAUTHORIZED" });
			await expect(
				identity.execute({
					type: "RESET_ACCOUNT_PASSWORD",
					accountId: adminAccount.account.accountId,
					correlationId: "admin-reset-admin",
					sessionToken: adminReady.sessionToken,
				}),
			).resolves.toEqual({ ok: false, code: "UNAUTHORIZED" });
			await identity.close();
		});

		it("产生第二名可用 SUPERADMIN 后，新 SUPERADMIN 用自己的密码可停用旧者", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-second-superadmin",
				isLocalRequest: true,
				password: "first123!",
				username: "FirstSuper",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const secondAccount = await identity.execute({
				type: "CREATE_ACCOUNT",
				correlationId: "create-second-superadmin-candidate",
				role: "ADMIN",
				sessionToken: bootstrap.sessionToken,
				username: "SecondSuper",
			});
			if (!secondAccount.ok || !("temporaryPassword" in secondAccount))
				throw new Error("创建应成功");
			const secondTemporaryLogin = await identity.execute({
				type: "LOGIN",
				correlationId: "second-superadmin-temporary-login",
				password: secondAccount.temporaryPassword,
				username: "SecondSuper",
			});
			if (
				!secondTemporaryLogin.ok ||
				secondTemporaryLogin.access !== "PASSWORD_CHANGE_REQUIRED"
			) {
				throw new Error("临时登录应成功");
			}
			const secondReady = await identity.execute({
				type: "COMPLETE_TEMPORARY_PASSWORD_CHANGE",
				correlationId: "second-superadmin-password-change",
				newPassword: "second123!",
				sessionToken: secondTemporaryLogin.sessionToken,
			});
			if (!secondReady.ok) throw new Error("强制改密应成功");
			await expect(
				identity.execute({
					type: "SET_ACCOUNT_ROLE",
					accountId: secondAccount.account.accountId,
					correlationId: "promote-second-superadmin",
					currentPassword: "first123!",
					role: "SUPERADMIN",
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toMatchObject({ ok: true, account: { role: "SUPERADMIN" } });

			await expect(
				identity.execute({
					type: "SET_ACCOUNT_STATUS",
					accountId: bootstrap.account.accountId,
					correlationId: "disable-first-superadmin",
					currentPassword: "second123!",
					sessionToken: secondReady.sessionToken,
					status: "DISABLED",
				}),
			).resolves.toEqual({
				ok: true,
				account: { accountId: bootstrap.account.accountId, status: "DISABLED" },
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
