import { randomUUID } from "node:crypto";

import { openPostgresConversation } from "@choicemind/conversation";
import { openPostgresIdentityAccess } from "@choicemind/identity-access";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApiApp } from "../../src/app.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)("Conversation HTTP Routes", () => {
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

	it("真实 Cookie Principal 的 Session 在模块重启后恢复且保持 User 隔离", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const identityAccess = await openPostgresIdentityAccess({
			databaseUrl: isolated,
			now: () => new Date("2026-08-27T22:00:00.000Z"),
		});
		let conversation = await openPostgresConversation({
			databaseUrl: isolated,
		});
		let app = buildApiApp({ conversation, identityAccess });

		const bootstrap = await app.inject({
			method: "POST",
			url: "/api/v1/identity/bootstrap",
			payload: { password: "admin123!", username: "AdminUser" },
		});
		const adminCookie = cookieFrom(bootstrap.headers["set-cookie"]);
		const invitation = await app.inject({
			method: "POST",
			url: "/api/v1/identity/invitations",
			headers: { cookie: adminCookie },
		});
		const registration = await app.inject({
			method: "POST",
			url: "/api/v1/identity/registrations",
			payload: {
				invitationCode: invitation.json().invitationCode,
				password: "user123!",
				username: "普通用户",
			},
		});
		const userCookie = cookieFrom(registration.headers["set-cookie"]);

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/conversations",
			headers: { cookie: adminCookie },
			payload: { clientRequestId: "create-admin-conversation" },
		});
		expect(created.statusCode).toBe(201);
		const sessionId = created.json().sessionId as string;
		const updated = await app.inject({
			method: "POST",
			url: `/api/v1/conversations/${sessionId}/turns`,
			headers: { cookie: adminCookie },
			payload: {
				clientTurnId: "admin-turn-1",
				text: "购买一台工作显示器",
				requirementUpdate: { consumptionGoal: "购买一台工作显示器" },
			},
		});
		expect(updated.statusCode).toBe(200);
		expect(updated.json()).toMatchObject({
			currentRequirement: {
				consumptionGoal: "购买一台工作显示器",
				revisionNumber: 1,
			},
		});

		await app.close();
		await conversation.close();
		conversation = await openPostgresConversation({ databaseUrl: isolated });
		app = buildApiApp({ conversation, identityAccess });

		const restored = await app.inject({
			method: "GET",
			url: `/api/v1/conversations/${sessionId}`,
			headers: { cookie: adminCookie },
		});
		expect(restored.statusCode).toBe(200);
		expect(restored.json()).toMatchObject({
			sessionId,
			title: "购买一台工作显示器",
			currentRequirement: { revisionNumber: 1 },
		});
		expect(restored.json().messages).toHaveLength(3);

		const isolatedRead = await app.inject({
			method: "GET",
			url: `/api/v1/conversations/${sessionId}`,
			headers: { cookie: userCookie },
		});
		expect(isolatedRead.statusCode).toBe(404);
		expect(isolatedRead.body).not.toContain("购买一台工作显示器");

		await app.close();
		await conversation.close();
		await identityAccess.close();
	});
});

function cookieFrom(value: string | string[] | undefined): string {
	if (value === undefined) throw new Error("响应缺少登录 Cookie");
	return String(value).split(";")[0] ?? "";
}

async function createIsolatedDatabaseUrl(baseUrl: string): Promise<string> {
	const schema = `conversation_api_test_${randomUUID().replaceAll("-", "")}`;
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
