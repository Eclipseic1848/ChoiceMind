import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity & Access Bootstrap SUPERADMIN",
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

		it("本机首次设置创建唯一 SUPERADMIN，并在重启后永久关闭入口", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});

			const result = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "correlation-bootstrap-1",
				isLocalRequest: true,
				password: "abc123!",
				username: "首位管理员",
			});

			expect(result).toMatchObject({
				ok: true,
				account: {
					role: "SUPERADMIN",
					status: "ACTIVE",
					username: "首位管理员",
				},
				access: "FULL",
			});
			if (!result.ok) throw new Error("Bootstrap 应成功");
			expect(result.recoveryCode).toMatch(/^[A-Z0-9-]{20,}$/);
			expect(result.sessionToken.length).toBeGreaterThanOrEqual(32);
			await identity.close();

			const reopened = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => new Date("2026-08-27T18:01:00.000Z"),
			});
			await expect(
				reopened.read({ type: "GET_BOOTSTRAP_STATUS" }),
			).resolves.toEqual({
				required: false,
			});
			await reopened.close();
		});

		it("拒绝不符合冻结规则的 Username 与 Password，且不占用首次设置机会", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
			});

			await expect(
				identity.execute({
					type: "BOOTSTRAP_SUPERADMIN",
					correlationId: "invalid-username",
					isLocalRequest: true,
					password: "abc123!",
					username: "a",
				}),
			).resolves.toEqual({ ok: false, code: "INVALID_USERNAME" });
			await expect(
				identity.execute({
					type: "BOOTSTRAP_SUPERADMIN",
					correlationId: "invalid-password",
					isLocalRequest: true,
					password: "含中文123",
					username: "合法用户",
				}),
			).resolves.toEqual({ ok: false, code: "INVALID_PASSWORD" });
			await expect(
				identity.read({ type: "GET_BOOTSTRAP_STATUS" }),
			).resolves.toEqual({
				required: true,
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
