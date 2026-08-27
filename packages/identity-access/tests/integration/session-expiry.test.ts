import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)("Identity & Access Session", () => {
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

	it("服务重启后仍从 Postgres 解析服务端 Principal，固定 7 天后立即失效", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const createdAt = new Date("2026-08-27T18:00:00.000Z");
		const firstProcess = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => createdAt,
		});
		const bootstrap = await firstProcess.execute({
			type: "BOOTSTRAP_SUPERADMIN",
			correlationId: "bootstrap-for-session",
			isLocalRequest: true,
			password: "abc123!",
			username: "AdminUser",
		});
		if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
		await firstProcess.close();

		let now = new Date("2026-09-03T17:59:59.999Z");
		const restartedProcess = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => now,
		});
		await expect(
			restartedProcess.read({
				type: "GET_CURRENT_SESSION",
				sessionToken: bootstrap.sessionToken,
			}),
		).resolves.toEqual({
			access: "FULL",
			authenticated: true,
			account: {
				accountId: bootstrap.account.accountId,
				role: "SUPERADMIN",
				status: "ACTIVE",
				username: "AdminUser",
			},
			principal: {
				principalId: bootstrap.account.accountId,
				role: "SUPERADMIN",
				userId: bootstrap.account.accountId,
			},
		});

		now = new Date("2026-09-03T18:00:00.000Z");
		await expect(
			restartedProcess.read({
				type: "GET_CURRENT_SESSION",
				sessionToken: bootstrap.sessionToken,
			}),
		).resolves.toEqual({ authenticated: false });
		await restartedProcess.close();
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
