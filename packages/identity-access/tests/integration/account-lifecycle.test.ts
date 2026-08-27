import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity & Access Account Lifecycle",
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

		it("管理员停用普通 USER 时撤销全部会话并阻止登录，启用后恢复登录", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-lifecycle",
				isLocalRequest: true,
				password: "abc123!",
				username: "AdminUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const invitation = await identity.execute({
				type: "CREATE_INVITATION",
				correlationId: "invite-lifecycle-user",
				sessionToken: bootstrap.sessionToken,
			});
			if (!invitation.ok || !("invitationCode" in invitation))
				throw new Error("邀请应成功");
			const registration = await identity.execute({
				type: "REGISTER_WITH_INVITATION",
				correlationId: "register-lifecycle-user",
				invitationCode: invitation.invitationCode,
				password: "user123!",
				username: "用户A",
			});
			if (!registration.ok) throw new Error("注册应成功");

			await expect(
				identity.execute({
					type: "SET_ACCOUNT_STATUS",
					accountId: registration.account.accountId,
					correlationId: "disable-user",
					sessionToken: bootstrap.sessionToken,
					status: "DISABLED",
				}),
			).resolves.toEqual({
				ok: true,
				account: {
					accountId: registration.account.accountId,
					status: "DISABLED",
				},
			});
			await expect(
				identity.read({
					type: "GET_CURRENT_SESSION",
					sessionToken: registration.sessionToken,
				}),
			).resolves.toEqual({ authenticated: false });
			await expect(
				identity.execute({
					type: "LOGIN",
					correlationId: "login-disabled-user",
					password: "user123!",
					username: "用户A",
				}),
			).resolves.toEqual({ ok: false, code: "INVALID_CREDENTIALS" });

			await expect(
				identity.execute({
					type: "SET_ACCOUNT_STATUS",
					accountId: registration.account.accountId,
					correlationId: "enable-user",
					sessionToken: bootstrap.sessionToken,
					status: "ACTIVE",
				}),
			).resolves.toEqual({
				ok: true,
				account: {
					accountId: registration.account.accountId,
					status: "ACTIVE",
				},
			});
			await expectNoPendingRestrictionEvent(
				isolated,
				registration.account.accountId,
			);
			await expect(
				identity.execute({
					type: "LOGIN",
					correlationId: "login-reenabled-user",
					password: "user123!",
					username: "用户A",
				}),
			).resolves.toMatchObject({ ok: true, access: "FULL" });
			await identity.close();
		});

		it("USER 重新输入密码进入 7 天待删除，受限登录后可取消并恢复使用", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-self-deletion",
				isLocalRequest: true,
				password: "abc123!",
				username: "AdminUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const invitation = await identity.execute({
				type: "CREATE_INVITATION",
				correlationId: "invite-self-deletion-user",
				sessionToken: bootstrap.sessionToken,
			});
			if (!invitation.ok || !("invitationCode" in invitation))
				throw new Error("邀请应成功");
			const registration = await identity.execute({
				type: "REGISTER_WITH_INVITATION",
				correlationId: "register-self-deletion-user",
				invitationCode: invitation.invitationCode,
				password: "user123!",
				username: "用户A",
			});
			if (!registration.ok) throw new Error("注册应成功");

			await expect(
				identity.execute({
					type: "REQUEST_SELF_DELETION",
					correlationId: "request-self-deletion",
					currentPassword: "user123!",
					sessionToken: registration.sessionToken,
				}),
			).resolves.toEqual({
				ok: true,
				accountId: registration.account.accountId,
				deletionDueAt: "2026-09-03T18:00:00.000Z",
			});
			await expect(
				identity.read({
					type: "GET_CURRENT_SESSION",
					sessionToken: registration.sessionToken,
				}),
			).resolves.toEqual({ authenticated: false });

			const pendingLogin = await identity.execute({
				type: "LOGIN",
				correlationId: "pending-deletion-login",
				password: "user123!",
				username: "用户A",
			});
			expect(pendingLogin).toMatchObject({
				ok: true,
				access: "DELETION_PENDING",
				account: { status: "PENDING_DELETION" },
			});
			if (!pendingLogin.ok || pendingLogin.access !== "DELETION_PENDING") {
				throw new Error("待删除账号应只获得受限会话");
			}
			const cancelled = await identity.execute({
				type: "CANCEL_SELF_DELETION",
				correlationId: "cancel-self-deletion",
				sessionToken: pendingLogin.sessionToken,
			});
			expect(cancelled).toMatchObject({
				ok: true,
				access: "FULL",
				account: { status: "ACTIVE" },
			});
			await expectNoPendingRestrictionEvent(
				isolated,
				registration.account.accountId,
			);
			await identity.close();
		});

		it("SUPERADMIN 重新验证自己的密码后可让普通 USER 进入待删除", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-admin-deletion",
				isLocalRequest: true,
				password: "abc123!",
				username: "AdminUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const invitation = await identity.execute({
				type: "CREATE_INVITATION",
				correlationId: "invite-admin-deletion-user",
				sessionToken: bootstrap.sessionToken,
			});
			if (!invitation.ok || !("invitationCode" in invitation))
				throw new Error("邀请应成功");
			const user = await identity.execute({
				type: "REGISTER_WITH_INVITATION",
				correlationId: "register-admin-deletion-user",
				invitationCode: invitation.invitationCode,
				password: "user123!",
				username: "用户A",
			});
			if (!user.ok) throw new Error("注册应成功");

			await expect(
				identity.execute({
					type: "REQUEST_ACCOUNT_DELETION",
					accountId: user.account.accountId,
					correlationId: "admin-deletion-wrong-password",
					currentPassword: "wrong-password",
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toEqual({ ok: false, code: "REAUTHENTICATION_FAILED" });
			await expect(
				identity.execute({
					type: "REQUEST_ACCOUNT_DELETION",
					accountId: user.account.accountId,
					correlationId: "admin-request-account-deletion",
					currentPassword: "abc123!",
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toEqual({
				ok: true,
				accountId: user.account.accountId,
				deletionDueAt: "2026-09-03T18:00:00.000Z",
			});
			await expect(
				identity.read({
					type: "GET_CURRENT_SESSION",
					sessionToken: user.sessionToken,
				}),
			).resolves.toEqual({ authenticated: false });
			await identity.close();
		});
	},
);

async function expectNoPendingRestrictionEvent(
	databaseUrl: string,
	accountId: string,
): Promise<void> {
	const pool = new Pool({ connectionString: databaseUrl });
	try {
		const result = await pool.query<{ event_count: string }>(
			`SELECT COUNT(*)::text AS event_count
			 FROM identity_account_lifecycle_events
			 WHERE account_id = $1
			   AND event_type = 'RESTRICT_ACCOUNT'
			   AND processed_at IS NULL
			   AND cancelled_at IS NULL`,
			[accountId],
		);
		expect(result.rows[0]?.event_count).toBe("0");
	} finally {
		await pool.end();
	}
}

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
