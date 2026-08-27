import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresIdentityAccess } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity & Access Invitation",
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

		it("管理员签发的单次 Invitation 可注册一个 USER，随后立即失效", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-invitation",
				isLocalRequest: true,
				password: "abc123!",
				username: "首位管理员",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");

			const invitation = await identity.execute({
				type: "CREATE_INVITATION",
				correlationId: "create-invitation-1",
				sessionToken: bootstrap.sessionToken,
			});
			expect(invitation).toMatchObject({ ok: true });
			if (!invitation.ok || !("invitationCode" in invitation)) {
				throw new Error("Invitation 应创建成功");
			}
			expect(invitation.expiresAt).toBe("2026-09-03T18:00:00.000Z");

			const registration = await identity.execute({
				type: "REGISTER_WITH_INVITATION",
				correlationId: "register-user-a",
				invitationCode: invitation.invitationCode,
				password: "user123!",
				username: "用户A",
			});
			expect(registration).toMatchObject({
				ok: true,
				access: "FULL",
				account: { role: "USER", status: "ACTIVE", username: "用户A" },
			});

			await expect(
				identity.execute({
					type: "REGISTER_WITH_INVITATION",
					correlationId: "reuse-invitation",
					invitationCode: invitation.invitationCode,
					password: "other123!",
					username: "用户B",
				}),
			).resolves.toEqual({ ok: false, code: "INVITATION_INVALID" });
			await identity.close();
		});

		it("管理员可在 Invitation 使用前撤销，撤销后不能注册", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			const now = new Date("2026-08-27T18:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const bootstrap = await identity.execute({
				type: "BOOTSTRAP_SUPERADMIN",
				correlationId: "bootstrap-for-revocation",
				isLocalRequest: true,
				password: "abc123!",
				username: "首位管理员",
			});
			if (!bootstrap.ok) throw new Error("Bootstrap 应成功");
			const invitation = await identity.execute({
				type: "CREATE_INVITATION",
				correlationId: "create-revocable-invitation",
				sessionToken: bootstrap.sessionToken,
			});
			if (!invitation.ok || !("invitationId" in invitation))
				throw new Error("签发应成功");

			await expect(
				identity.execute({
					type: "REVOKE_INVITATION",
					correlationId: "revoke-invitation",
					invitationId: invitation.invitationId,
					sessionToken: bootstrap.sessionToken,
				}),
			).resolves.toEqual({ ok: true });
			await expect(
				identity.execute({
					type: "REGISTER_WITH_INVITATION",
					correlationId: "register-with-revoked-invitation",
					invitationCode: invitation.invitationCode,
					password: "user123!",
					username: "用户A",
				}),
			).resolves.toEqual({ ok: false, code: "INVITATION_INVALID" });
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
