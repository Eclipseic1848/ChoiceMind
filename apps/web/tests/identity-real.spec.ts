import { randomUUID } from "node:crypto";

import {
	type IdentityAccess,
	openPostgresIdentityAccess,
} from "@choicemind/identity-access";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { buildApiApp } from "../../api/src/app";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;

test.describe("真实 Identity Web 纵向", () => {
	test.skip(databaseUrl === undefined, "需要隔离的真实 Postgres");
	test.describe.configure({ mode: "serial" });

	let api: ReturnType<typeof buildApiApp> | undefined;
	let identity: IdentityAccess | undefined;
	let isolatedDatabaseUrl = "";
	let schema = "";

	test.beforeAll(async () => {
		if (databaseUrl === undefined) return;
		schema = `identity_web_test_${randomUUID().replaceAll("-", "")}`;
		const pool = new Pool({ connectionString: databaseUrl });
		try {
			await pool.query(`CREATE SCHEMA "${schema}"`);
		} finally {
			await pool.end();
		}
		const url = new URL(databaseUrl);
		url.searchParams.set("options", `-c search_path=${schema}`);
		isolatedDatabaseUrl = url.toString();
		await startApi(new Date("2026-08-27T18:00:00.000Z"));
	});

	test.afterAll(async () => {
		await stopApi();
		if (databaseUrl === undefined || schema.length === 0) return;
		const pool = new Pool({ connectionString: databaseUrl });
		try {
			await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
		} finally {
			await pool.end();
		}
	});

	test("初始化、API 重启恢复和七天会话失效均穿过真实 Postgres", async ({
		page,
	}) => {
		await page.goto("/setup");
		await page.getByLabel("用户名").fill("真实管理员");
		await page.getByLabel("密码", { exact: true }).fill("abc123!");
		await page.getByLabel("确认密码", { exact: true }).fill("abc123!");
		await page.getByRole("button", { name: "完成初始化" }).click();
		await expect(
			page.getByRole("heading", { name: "保存恢复码" }),
		).toBeVisible();

		await page.goto("/");
		await expect(page.getByText("你好，真实管理员")).toBeVisible();

		await stopApi();
		await startApi(new Date("2026-08-27T19:00:00.000Z"));
		await page.reload();
		await expect(page.getByText("你好，真实管理员")).toBeVisible();

		await stopApi();
		await startApi(new Date("2026-09-04T18:00:00.000Z"));
		await page.reload();
		await expect(page).toHaveURL(/\/login$/);
		await expect(
			page.getByRole("heading", { name: "登录 ChoiceMind" }),
		).toBeVisible();
	});

	async function startApi(now: Date): Promise<void> {
		identity = await openPostgresIdentityAccess({
			databaseUrl: isolatedDatabaseUrl,
			now: () => now,
		});
		api = buildApiApp({ identityAccess: identity, now: () => now });
		await api.listen({ host: "127.0.0.1", port: 3199 });
	}

	async function stopApi(): Promise<void> {
		await api?.close();
		api = undefined;
		await identity?.close();
		identity = undefined;
	}
});
