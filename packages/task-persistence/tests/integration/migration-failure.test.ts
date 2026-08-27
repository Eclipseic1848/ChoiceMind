import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPersistentDecisionTaskModule } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Persistent task migration failure",
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

		it("迁移失败时立即释放连接并返回错误，而不是永久等待关闭连接池", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createBrokenMigrationDatabaseUrl(databaseUrl);

			await expect(
				openPersistentDecisionTaskModule({ databaseUrl: isolated }),
			).rejects.toBeDefined();
		}, 2_000);
	},
);

async function createBrokenMigrationDatabaseUrl(
	baseUrl: string,
): Promise<string> {
	const schema = `task_migration_failure_${randomUUID().replaceAll("-", "")}`;
	const pool = new Pool({ connectionString: baseUrl });
	try {
		await pool.query(`CREATE SCHEMA "${schema}"`);
		await pool.query(
			`CREATE TABLE "${schema}".decision_task_schema_migrations (wrong_column text)`,
		);
	} finally {
		await pool.end();
	}
	schemasToDelete.push(schema);
	const url = new URL(baseUrl);
	url.searchParams.set("options", `-c search_path=${schema},public`);
	return url.toString();
}
