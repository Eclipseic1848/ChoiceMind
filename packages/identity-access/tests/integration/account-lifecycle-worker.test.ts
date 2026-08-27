import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";
import {
	openPostgresIdentityLifecycleWorker,
	type IdentityLifecycleEvent,
} from "../../src/lifecycle-worker.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity account lifecycle worker",
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

		it("停用和等待删除通过持久事件停止任务，七天后才擦除账号", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			let now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "correlation-bootstrap",
				isLocalRequest: true,
				password: "super123!",
				username: "RootAdmin",
			});
			if (!bootstrap.ok) throw new Error("测试初始化失败");
			const created = await identity.execute({
				type: "CREATE_ACCOUNT",
				correlationId: "correlation-create",
				role: "USER",
				sessionToken: bootstrap.sessionToken,
				username: "待删除用户",
			});
			if (!created.ok || !("account" in created))
				throw new Error("测试账号创建失败");
			const accountId = created.account.accountId;
			const events: IdentityLifecycleEvent[] = [];
			const worker = await openPostgresIdentityLifecycleWorker({
				databaseUrl: isolated,
				handle: async (event) => events.push(event),
				now: () => now,
			});

			const disabled = await identity.execute({
				type: "SET_ACCOUNT_STATUS",
				accountId,
				correlationId: "correlation-disable",
				sessionToken: bootstrap.sessionToken,
				status: "DISABLED",
			});
			expect(disabled).toMatchObject({ ok: true });
			await expect(worker.runOnce()).resolves.toMatchObject({
				status: "PROCESSED",
			});
			expect(events).toContainEqual(
				expect.objectContaining({ accountId, eventType: "RESTRICT_ACCOUNT" }),
			);

			await identity.execute({
				type: "SET_ACCOUNT_STATUS",
				accountId,
				correlationId: "correlation-enable",
				sessionToken: bootstrap.sessionToken,
				status: "ACTIVE",
			});
			const deletion = await identity.execute({
				type: "REQUEST_ACCOUNT_DELETION",
				accountId,
				correlationId: "correlation-delete",
				currentPassword: "super123!",
				sessionToken: bootstrap.sessionToken,
			});
			expect(deletion).toMatchObject({ ok: true });
			await expect(worker.runOnce()).resolves.toMatchObject({
				status: "PROCESSED",
			});
			expect(events.at(-1)).toMatchObject({
				accountId,
				eventType: "RESTRICT_ACCOUNT",
			});
			await expect(worker.runOnce()).resolves.toEqual({ status: "IDLE" });

			now = new Date("2026-09-03T18:00:00.001Z");
			await expect(worker.runOnce()).resolves.toMatchObject({
				status: "PROCESSED",
			});
			expect(events.at(-1)).toMatchObject({
				accountId,
				eventType: "DELETE_ACCOUNT",
			});
			const relogin = await identity.execute({
				type: "LOGIN",
				correlationId: "correlation-relogin",
				password: "super123!",
				username: "RootAdmin",
			});
			if (!relogin.ok) throw new Error("测试管理员重新登录失败");
			const accounts = await identity.read({
				type: "LIST_ACCOUNTS",
				sessionToken: relogin.sessionToken,
			});
			expect(accounts).toMatchObject({
				authorized: true,
				accounts: expect.arrayContaining([
					expect.objectContaining({ accountId, status: "DELETED" }),
				]),
			});
			if (!accounts.authorized) throw new Error("测试管理员权限失效");
			const erased = accounts.accounts.find(
				(account) => account.accountId === accountId,
			);
			expect(erased?.username).toMatch(/^deleted_[a-f0-9]{16}$/);
			expect(erased?.username).not.toContain("待删除用户");

			await worker.close();
			await identity.close();
		});

		it("处理失败不会丢失生命周期事件并可在下一轮重试", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "correlation-bootstrap",
				isLocalRequest: true,
				password: "super123!",
				username: "RootAdmin",
			});
			if (!bootstrap.ok) throw new Error("测试初始化失败");
			const created = await identity.execute({
				type: "CREATE_ACCOUNT",
				correlationId: "correlation-create",
				role: "USER",
				sessionToken: bootstrap.sessionToken,
				username: "RetryUser",
			});
			if (!created.ok || !("account" in created))
				throw new Error("测试账号创建失败");
			await identity.execute({
				type: "SET_ACCOUNT_STATUS",
				accountId: created.account.accountId,
				correlationId: "correlation-disable",
				sessionToken: bootstrap.sessionToken,
				status: "DISABLED",
			});
			let attempts = 0;
			const worker = await openPostgresIdentityLifecycleWorker({
				databaseUrl: isolated,
				handle: async () => {
					attempts += 1;
					if (attempts === 1) throw new Error("synthetic handler failure");
				},
				now: () => now,
			});

			await expect(worker.runOnce()).resolves.toEqual({
				status: "RETRY_SCHEDULED",
			});
			await expect(worker.runOnce()).resolves.toMatchObject({
				status: "PROCESSED",
			});
			expect(attempts).toBe(2);

			await worker.close();
			await identity.close();
		});

		it("常驻 worker 会自动清理超过 180 天的审计记录", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const createdAt = new Date("2026-08-27T18:00:00.000Z");
			let now = createdAt;
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "correlation-bootstrap",
				isLocalRequest: true,
				password: "super123!",
				username: "RootAdmin",
			});
			if (!bootstrap.ok) throw new Error("测试初始化失败");
			now = new Date(createdAt.getTime() + 181 * 24 * 60 * 60 * 1_000);
			const worker = await openPostgresIdentityLifecycleWorker({
				databaseUrl: isolated,
				handle: async () => undefined,
				now: () => now,
			});

			await expect(worker.runOnce()).resolves.toEqual({ status: "IDLE" });
			const pool = new Pool({ connectionString: isolated });
			const remaining = await pool.query<{ count: string }>(
				"SELECT COUNT(*)::text AS count FROM identity_audit_records",
			);
			expect(remaining.rows[0]?.count).toBe("0");

			await pool.end();
			await worker.close();
			await identity.close();
		});
	},
);

async function createIsolatedDatabaseUrl(baseUrl: string): Promise<string> {
	const schema = `identity_lifecycle_test_${randomUUID().replaceAll("-", "")}`;
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
