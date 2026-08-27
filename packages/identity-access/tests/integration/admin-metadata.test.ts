import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity & Access Admin Metadata",
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

		it("管理员只读取账号与邀请码管理元数据，普通 USER 无权读取", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-admin-metadata",
				isLocalRequest: true,
				password: "abc123!",
				username: "AdminUser",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const invitation = await identity.execute({
				type: "CREATE_INVITATION",
				correlationId: "create-admin-metadata-invitation",
				sessionToken: bootstrap.sessionToken,
			});
			if (!invitation.ok || !("invitationCode" in invitation))
				throw new Error("邀请应成功");
			const user = await identity.execute({
				type: "REGISTER_WITH_INVITATION",
				correlationId: "register-admin-metadata-user",
				invitationCode: invitation.invitationCode,
				password: "user123!",
				username: "用户A",
			});
			if (!user.ok) throw new Error("注册应成功");

			await expect(
				identity.read({
					type: "LIST_ACCOUNTS",
					sessionToken: user.sessionToken,
				}),
			).resolves.toEqual({ authorized: false });
			await expect(
				identity.read({
					type: "LIST_INVITATIONS",
					sessionToken: user.sessionToken,
				}),
			).resolves.toEqual({ authorized: false });
			await expect(
				identity.read({
					type: "LIST_ACCOUNTS",
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toEqual({
				authorized: true,
				accounts: [
					{
						accountId: bootstrap.account.accountId,
						createdAt: "2026-08-27T18:00:00.000Z",
						deletionDueAt: null,
						role: "SUPERADMIN",
						status: "ACTIVE",
						username: "AdminUser",
					},
					{
						accountId: user.account.accountId,
						createdAt: "2026-08-27T18:00:00.000Z",
						deletionDueAt: null,
						role: "USER",
						status: "ACTIVE",
						username: "用户A",
					},
				],
			});
			await expect(
				identity.read({
					type: "LIST_INVITATIONS",
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toEqual({
				authorized: true,
				invitations: [
					{
						createdAt: "2026-08-27T18:00:00.000Z",
						expiresAt: "2026-09-03T18:00:00.000Z",
						invitationId: invitation.invitationId,
						status: "USED",
					},
				],
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
