import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity & Access SUPERADMIN Recovery",
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

		it("本机恢复码在没有其他可用 SUPERADMIN 时重置密码、会话和恢复码", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-recovery",
				isLocalRequest: true,
				password: "abc123!",
				username: "AdminUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const secondLogin = await identity.execute({
				type: "LOGIN",
				correlationId: "login-before-recovery",
				password: "abc123!",
				username: "AdminUser",
			});
			if (!secondLogin.ok) throw new Error("登录应成功");

			const recovered = await identity.execute({
				type: "RECOVER_SUPERADMIN",
				correlationId: "recover-superadmin",
				isLocalRequest: true,
				newPassword: "recovered123!",
				recoveryCode: bootstrap.recoveryCode,
			});
			expect(recovered).toMatchObject({
				ok: true,
				access: "FULL",
				account: { accountId: bootstrap.account.accountId, role: "SUPERADMIN" },
			});
			if (!recovered.ok || !("recoveryCode" in recovered))
				throw new Error("恢复应成功");
			expect(recovered.recoveryCode).not.toBe(bootstrap.recoveryCode);
			for (const sessionToken of [
				bootstrap.sessionToken,
				secondLogin.sessionToken,
			]) {
				await expect(
					identity.read({ type: "GET_CURRENT_SESSION", sessionToken }),
				).resolves.toEqual({ authenticated: false });
			}
			await expect(
				identity.execute({
					type: "RECOVER_SUPERADMIN",
					correlationId: "reuse-old-recovery-code",
					isLocalRequest: true,
					newPassword: "another123!",
					recoveryCode: bootstrap.recoveryCode,
				}),
			).resolves.toEqual({ ok: false, code: "RECOVERY_INVALID" });
			await expect(
				identity.execute({
					type: "LOGIN",
					correlationId: "login-after-recovery",
					password: "recovered123!",
					username: "AdminUser",
				}),
			).resolves.toMatchObject({ ok: true, access: "FULL" });
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
