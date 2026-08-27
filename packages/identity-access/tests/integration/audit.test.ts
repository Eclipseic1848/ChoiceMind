import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)("Identity & Access Audit", () => {
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

	it("SUPERADMIN 可查看不含秘密值的登录审计，普通 USER 无权查看", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const now = new Date("2026-08-27T18:00:00.000Z");
		const identity = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => now,
		});
		const bootstrap = await identity.execute({
			type: "BOOTSTRAP_SUPERADMIN",
			correlationId: "audit-bootstrap",
			isLocalRequest: true,
			password: "secret-bootstrap-password",
			username: "AdminUser",
		});
		if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
		await identity.execute({
			type: "LOGIN",
			correlationId: "audit-login-failure",
			password: "secret-wrong-password",
			username: "AdminUser",
		});
		const invitation = await identity.execute({
			type: "CREATE_INVITATION",
			correlationId: "audit-invite-user",
			sessionToken: bootstrap.sessionToken,
		});
		if (!invitation.ok || !("invitationCode" in invitation))
			throw new Error("邀请应成功");
		const user = await identity.execute({
			type: "REGISTER_WITH_INVITATION",
			correlationId: "audit-register-user",
			invitationCode: invitation.invitationCode,
			password: "secret-user-password",
			username: "用户A",
		});
		if (!user.ok) throw new Error("注册应成功");

		await expect(
			identity.read({
				type: "LIST_AUDIT_RECORDS",
				sessionToken: user.sessionToken,
			}),
		).resolves.toEqual({ authorized: false });
		const audit = await identity.read({
			type: "LIST_AUDIT_RECORDS",
			sessionToken: bootstrap.sessionToken,
		});
		expect(audit).toMatchObject({ authorized: true });
		if (!audit.authorized) throw new Error("SUPERADMIN 应有审计读取权限");
		expect(audit.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "BOOTSTRAP_SUPERADMIN",
					correlationId: "audit-bootstrap",
					result: "ALLOWED",
				}),
				expect.objectContaining({
					action: "LOGIN",
					correlationId: "audit-login-failure",
					result: "DENIED",
				}),
				expect.objectContaining({
					action: "CREATE_INVITATION",
					correlationId: "audit-invite-user",
					result: "ALLOWED",
				}),
				expect.objectContaining({
					action: "REGISTER_WITH_INVITATION",
					correlationId: "audit-register-user",
					result: "ALLOWED",
				}),
			]),
		);
		const serialized = JSON.stringify(audit);
		expect(serialized).not.toContain("secret-bootstrap-password");
		expect(serialized).not.toContain("secret-wrong-password");
		expect(serialized).not.toContain("secret-user-password");
		expect(serialized).not.toContain(bootstrap.sessionToken);
		expect(serialized).not.toContain(invitation.invitationCode);
		await identity.close();
	});

	it("审计超过 180 天后由系统自动清理，不能通过命令手动删除", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		let now = new Date("2026-01-01T00:00:00.000Z");
		const identity = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => now,
		});
		const bootstrap = await identity.execute({
			type: "BOOTSTRAP_SUPERADMIN",
			correlationId: "old-bootstrap-audit",
			isLocalRequest: true,
			password: "abc123!",
			username: "AdminUser",
		});
		if (!bootstrap.ok) throw new Error("Bootstrap 应成功");

		now = new Date("2026-07-01T00:00:00.000Z");
		const freshLogin = await identity.execute({
			type: "LOGIN",
			correlationId: "fresh-login-audit",
			password: "abc123!",
			username: "AdminUser",
		});
		if (!freshLogin.ok || freshLogin.access !== "FULL")
			throw new Error("新登录应成功");
		const audit = await identity.read({
			type: "LIST_AUDIT_RECORDS",
			sessionToken: freshLogin.sessionToken,
		});
		if (!audit.authorized) throw new Error("SUPERADMIN 应有审计读取权限");
		expect(audit.records.map((record) => record.correlationId)).toEqual([
			"fresh-login-audit",
		]);
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
