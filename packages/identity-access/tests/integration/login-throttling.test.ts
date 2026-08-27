import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)("Identity & Access Login", () => {
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

	it("Username 按 ASCII 大小写不敏感登录，连续 5 次失败后锁定 30 秒", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		let now = new Date("2026-08-27T18:00:00.000Z");
		const identity = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => now,
		});
		const bootstrap = await identity.execute({
			type: "BOOTSTRAP_SUPERADMIN",
			correlationId: "bootstrap-for-login",
			isLocalRequest: true,
			password: "abc123!",
			username: "AdminUser",
		});
		if (!bootstrap.ok) throw new Error("Bootstrap 应成功");

		await expect(
			identity.execute({
				type: "LOGIN",
				correlationId: "login-case-insensitive",
				password: "abc123!",
				username: "adminuser",
			}),
		).resolves.toMatchObject({
			ok: true,
			access: "FULL",
			account: { role: "SUPERADMIN", username: "AdminUser" },
		});

		for (let attempt = 1; attempt <= 4; attempt += 1) {
			await expect(
				identity.execute({
					type: "LOGIN",
					correlationId: `wrong-password-${attempt}`,
					password: "wrong-password",
					username: "ADMINUSER",
				}),
			).resolves.toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
		}
		await expect(
			identity.execute({
				type: "LOGIN",
				correlationId: "wrong-password-5",
				password: "wrong-password",
				username: "adminuser",
			}),
		).resolves.toEqual({
			ok: false,
			code: "LOGIN_THROTTLED",
			retryAt: "2026-08-27T18:00:30.000Z",
		});
		await expect(
			identity.execute({
				type: "LOGIN",
				correlationId: "correct-but-locked",
				password: "abc123!",
				username: "adminuser",
			}),
		).resolves.toEqual({
			ok: false,
			code: "LOGIN_THROTTLED",
			retryAt: "2026-08-27T18:00:30.000Z",
		});
		const lockedAudit = await identity.read({
			type: "LIST_AUDIT_RECORDS",
			sessionToken: bootstrap.sessionToken,
		});
		if (!lockedAudit.authorized) throw new Error("SUPERADMIN 应有审计读取权限");
		expect(lockedAudit.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "LOGIN",
					correlationId: "correct-but-locked",
					result: "DENIED",
				}),
			]),
		);

		now = new Date("2026-08-27T18:00:30.000Z");
		await expect(
			identity.execute({
				type: "LOGIN",
				correlationId: "login-after-lock",
				password: "abc123!",
				username: "adminuser",
			}),
		).resolves.toMatchObject({ ok: true, access: "FULL" });
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
