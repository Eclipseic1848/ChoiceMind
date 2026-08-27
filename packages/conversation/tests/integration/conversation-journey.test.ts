import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { openPostgresConversation } from "../../src/index.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)("Conversation 用户旅程", () => {
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

	it("创建 Session、形成最小 Requirement Revision，并在重启后按 User 隔离恢复", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const now = new Date("2026-08-27T22:00:00.000Z");
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
			now: () => now,
		});

		const created = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-session-1",
			ownerUserId: "user-a",
		});
		expect(created.title).toBe("新的消费决策");
		expect(created.messages).toMatchObject([
			{
				role: "ASSISTANT",
				text: "先告诉我，你这次想解决什么消费问题？",
			},
		]);

		const withGoal = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-goal",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "我想换一台更适合工作的显示器。",
			requirementUpdate: {
				consumptionGoal: "购买一台工作显示器",
			},
		});
		expect(withGoal.currentRequirement).toMatchObject({
			readiness: "NEEDS_CLARIFICATION",
			missingKeys: ["PRIMARY_SCENARIO", "HARD_CONSTRAINTS"],
			revisionNumber: 1,
		});

		const withScenario = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-scenario",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "每天长时间编程和办公。",
			requirementUpdate: {
				primaryScenario: "每天长时间编程和办公",
			},
		});
		expect(withScenario.currentRequirement?.missingKeys).toEqual([
			"HARD_CONSTRAINTS",
		]);

		const ready = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-constraints",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "至少 4K，并且支持 USB-C 供电。",
			requirementUpdate: {
				hardConstraints: ["至少 4K", "支持 USB-C 供电"],
			},
		});
		expect(ready.currentRequirement).toMatchObject({
			consumptionGoal: "购买一台工作显示器",
			hardConstraints: ["至少 4K", "支持 USB-C 供电"],
			missingKeys: [],
			primaryScenario: "每天长时间编程和办公",
			readiness: "READY_FOR_RESEARCH",
			revisionNumber: 3,
		});
		expect(ready.messages.at(-1)).toMatchObject({
			role: "ASSISTANT",
			text: "关键信息已经足够，可以开始有界研究。你仍可继续补充偏好或预算。",
		});
		await conversation.close();

		const reopened = await openPostgresConversation({ databaseUrl: isolated });
		await expect(
			reopened.read({
				type: "GET_SESSION",
				ownerUserId: "user-a",
				sessionId: created.sessionId,
			}),
		).resolves.toEqual(ready);
		await expect(
			reopened.read({
				type: "GET_SESSION",
				ownerUserId: "user-b",
				sessionId: created.sessionId,
			}),
		).resolves.toBeUndefined();
		await reopened.close();
	});

	it("列出最近 Session、保留 Revision 历史，并拒绝幂等键内容冲突", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		let currentTime = new Date("2026-08-27T22:10:00.000Z");
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
			now: () => currentTime,
		});
		const first = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-first",
			ownerUserId: "user-a",
		});
		currentTime = new Date("2026-08-27T22:11:00.000Z");
		const second = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-second",
			ownerUserId: "user-a",
		});
		await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-other-user",
			ownerUserId: "user-b",
		});

		currentTime = new Date("2026-08-27T22:12:00.000Z");
		const afterTurn = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-idempotent",
			ownerUserId: "user-a",
			sessionId: first.sessionId,
			text: "我要买一台显示器。",
			requirementUpdate: { consumptionGoal: "购买显示器" },
		});
		const retried = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-idempotent",
			ownerUserId: "user-a",
			sessionId: first.sessionId,
			text: "我要买一台显示器。",
			requirementUpdate: { consumptionGoal: "购买显示器" },
		});
		expect(retried).toEqual(afterTurn);
		expect(retried.messages).toHaveLength(3);

		await expect(
			conversation.execute({
				type: "APPEND_USER_TURN",
				clientTurnId: "turn-idempotent",
				ownerUserId: "user-a",
				sessionId: first.sessionId,
				text: "这次内容不同。",
				requirementUpdate: { consumptionGoal: "购买电视" },
			}),
		).rejects.toMatchObject({ code: "CONVERSATION_IDEMPOTENCY_CONFLICT" });

		await expect(
			conversation.read({ type: "LIST_SESSIONS", ownerUserId: "user-a" }),
		).resolves.toMatchObject([
			{
				sessionId: first.sessionId,
				latestMessage: "它主要会用在什么场景？请说最常见、最重要的使用方式。",
				readiness: "NEEDS_CLARIFICATION",
				title: "购买显示器",
			},
			{
				sessionId: second.sessionId,
				latestMessage: "先告诉我，你这次想解决什么消费问题？",
				readiness: null,
				title: "新的消费决策",
			},
		]);
		await expect(
			conversation.read({
				type: "LIST_REQUIREMENT_REVISIONS",
				ownerUserId: "user-a",
				sessionId: first.sessionId,
			}),
		).resolves.toMatchObject([
			{
				consumptionGoal: "购买显示器",
				revisionNumber: 1,
			},
		]);
		await expect(
			conversation.read({
				type: "LIST_REQUIREMENT_REVISIONS",
				ownerUserId: "user-b",
				sessionId: first.sessionId,
			}),
		).resolves.toEqual([]);
		await conversation.close();
	});

	it("保存普通连续消息，但只在需求事实变化时创建 Requirement Revision", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
		});
		const created = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-message-only",
			ownerUserId: "user-a",
		});

		const updated = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-message-only",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "我先想一想，再补充具体要求。",
			requirementUpdate: {},
		});
		expect(updated.currentRequirement).toBeNull();
		expect(updated.messages.map((message) => message.text)).toEqual([
			"先告诉我，你这次想解决什么消费问题？",
			"我先想一想，再补充具体要求。",
			"先告诉我，你这次想解决什么消费问题？",
		]);
		await expect(
			conversation.read({
				type: "LIST_REQUIREMENT_REVISIONS",
				ownerUserId: "user-a",
				sessionId: created.sessionId,
			}),
		).resolves.toEqual([]);
		await conversation.close();
	});

	it("幂等链接 Decision Task，但不允许其他 User 改写 Session", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const linkedAt = new Date("2026-08-27T23:20:00.000Z");
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
			now: () => linkedAt,
		});
		const created = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-task-link",
			ownerUserId: "user-a",
		});

		const linked = await conversation.execute({
			type: "LINK_DECISION_TASK",
			decisionTaskId: "task-conversation-1",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
		});
		expect(linked.decisionTasks).toEqual([
			{
				decisionTaskId: "task-conversation-1",
				linkedAt: "2026-08-27T23:20:00.000Z",
			},
		]);
		await expect(
			conversation.execute({
				type: "LINK_DECISION_TASK",
				decisionTaskId: "task-conversation-1",
				ownerUserId: "user-a",
				sessionId: created.sessionId,
			}),
		).resolves.toEqual(linked);
		await expect(
			conversation.execute({
				type: "LINK_DECISION_TASK",
				decisionTaskId: "task-forged",
				ownerUserId: "user-b",
				sessionId: created.sessionId,
			}),
		).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
		await conversation.close();
	});

	it("账号到期删除只擦除所属 User 的全部 Conversation 私人数据", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
		});
		const owned = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-purge-owned",
			ownerUserId: "user-a",
		});
		await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-purge-owned",
			ownerUserId: "user-a",
			sessionId: owned.sessionId,
			text: "购买显示器",
			requirementUpdate: { consumptionGoal: "购买显示器" },
		});
		await conversation.execute({
			type: "LINK_DECISION_TASK",
			decisionTaskId: "task-purge-owned",
			ownerUserId: "user-a",
			sessionId: owned.sessionId,
		});
		const retained = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-purge-retained",
			ownerUserId: "user-b",
		});

		await expect(
			conversation.purgePrivateDataForOwner("user-a"),
		).resolves.toEqual({
			deletedSessions: 1,
		});
		await expect(
			conversation.read({
				type: "GET_SESSION",
				ownerUserId: "user-a",
				sessionId: owned.sessionId,
			}),
		).resolves.toBeUndefined();
		await expect(
			conversation.read({
				type: "GET_SESSION",
				ownerUserId: "user-b",
				sessionId: retained.sessionId,
			}),
		).resolves.toEqual(retained);
		await conversation.close();
	});
});

async function createIsolatedDatabaseUrl(baseUrl: string): Promise<string> {
	const schema = `conversation_test_${randomUUID().replaceAll("-", "")}`;
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
