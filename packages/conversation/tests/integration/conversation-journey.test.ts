import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
	openPostgresConversation,
	type RequirementUpdate,
} from "../../src/index.js";

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
		const unchanged = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-same-goal",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "消费目标保持不变。",
			requirementUpdate: {
				consumptionGoal: "购买一台工作显示器",
			},
		});
		expect(unchanged.currentRequirement?.revisionNumber).toBe(3);
		expect(unchanged.messages).toHaveLength(ready.messages.length + 2);
		const { turn: completedTurn, ...unchangedSession } = unchanged;
		void completedTurn;
		await conversation.close();

		const reopened = await openPostgresConversation({ databaseUrl: isolated });
		await expect(
			reopened.read({
				type: "GET_SESSION",
				ownerUserId: "user-a",
				sessionId: created.sessionId,
			}),
		).resolves.toEqual(unchangedSession);
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
		expect(retried.turn).toEqual(afterTurn.turn);
		currentTime = new Date("2026-08-27T22:13:00.000Z");
		const laterSameText = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-same-text-later",
			ownerUserId: "user-a",
			sessionId: first.sessionId,
			text: "我要买一台显示器。",
			requirementUpdate: { consumptionGoal: "购买显示器" },
		});
		const restarted = await openPostgresConversation({
			databaseUrl: isolated,
			now: () => currentTime,
		});
		const replayedFirstTurn = await restarted.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-idempotent",
			ownerUserId: "user-a",
			sessionId: first.sessionId,
			text: "我要买一台显示器。",
			requirementUpdate: { consumptionGoal: "购买显示器" },
		});
		expect(replayedFirstTurn.turn).toEqual(afterTurn.turn);
		expect(replayedFirstTurn.turn).not.toEqual(laterSameText.turn);
		await restarted.close();

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

	it("解释失败仍保存 User 原文，重试同一轮次成功后复用结果", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		let currentTime = new Date("2026-08-29T08:00:00.000Z");
		const interpretations: unknown[] = [];
		const requirementInterpreter = {
			async interpret(input: unknown) {
				interpretations.push(input);
				if (interpretations.length === 1) {
					throw new Error("模拟模型暂时不可用");
				}
				return {
					consumptionGoal: "购买人体工学椅",
					hardConstraints: ["预算不超过 3000 元"],
					primaryScenario: "每天在家办公八小时",
				};
			},
		};
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
			now: () => currentTime,
			requirementInterpreter,
		});
		const created = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-natural-language",
			ownerUserId: "user-a",
		});
		const command = {
			type: "APPEND_USER_TURN" as const,
			clientTurnId: "turn-natural-language",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "想买人体工学椅，每天在家办公八小时，预算不超过 3000 元。",
		};

		await expect(conversation.execute(command)).rejects.toThrow(
			"模拟模型暂时不可用",
		);
		const afterFailure = await conversation.read({
			type: "GET_SESSION",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
		});
		expect(afterFailure).toMatchObject({
			currentRequirement: null,
			messages: [{ role: "ASSISTANT" }, { role: "USER", text: command.text }],
		});
		const crashSimulation = new Pool({ connectionString: isolated });
		try {
			await crashSimulation.query(
				`UPDATE conversation_messages
				 SET interpretation_status = 'PROCESSING'
				 WHERE session_id = $1 AND client_turn_id = $2`,
				[created.sessionId, command.clientTurnId],
			);
		} finally {
			await crashSimulation.end();
		}
		currentTime = new Date("2026-08-29T08:03:00.000Z");

		const completed = await conversation.execute(command);
		expect(completed.currentRequirement).toMatchObject({
			consumptionGoal: "购买人体工学椅",
			hardConstraints: ["预算不超过 3000 元"],
			missingKeys: [],
			primaryScenario: "每天在家办公八小时",
			readiness: "READY_FOR_RESEARCH",
		});
		expect(completed.messages).toHaveLength(3);
		expect(interpretations).toHaveLength(2);

		await expect(conversation.execute(command)).resolves.toEqual(completed);
		expect(interpretations).toHaveLength(2);
		await expect(
			conversation.execute({ ...command, text: "同一轮次换成另一段文字" }),
		).rejects.toMatchObject({ code: "CONVERSATION_IDEMPOTENCY_CONFLICT" });
		expect(interpretations).toHaveLength(2);
		await conversation.close();
	});

	it("较早轮次失败后重试仍返回该轮自己的 Assistant 回复", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		let oldTurnAttempts = 0;
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
			requirementInterpreter: {
				async interpret(input) {
					if (input.clientTurnId === "turn-older") {
						oldTurnAttempts += 1;
						if (oldTurnAttempts === 1) throw new Error("模拟旧轮次失败");
						return { primaryScenario: "长时间编程" };
					}
					return { consumptionGoal: "购买编程显示器" };
				},
			},
		});
		const created = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-out-of-order-retry",
			ownerUserId: "user-a",
		});
		const olderCommand = {
			type: "APPEND_USER_TURN" as const,
			clientTurnId: "turn-older",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "主要用于长时间编程。",
		};
		await expect(conversation.execute(olderCommand)).rejects.toThrow(
			"模拟旧轮次失败",
		);
		const afterFailure = await conversation.read({
			type: "GET_SESSION",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
		});
		const olderUserMessage = afterFailure?.messages.find(
			(message) => message.role === "USER",
		);
		if (olderUserMessage === undefined) throw new Error("缺少旧轮次 User 消息");

		await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-newer",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "我想买一台编程显示器。",
		});
		const retried = await conversation.execute(olderCommand);
		expect(retried.turn.userMessageId).toBe(olderUserMessage.messageId);
		expect(
			retried.messages.find(
				(message) => message.messageId === retried.turn.assistantMessageId,
			),
		).toMatchObject({
			role: "ASSISTANT",
			text: "哪些条件一旦不满足，你就不会考虑？如果没有，也可以明确告诉我没有硬性条件。",
		});
		await expect(conversation.execute(olderCommand)).resolves.toEqual(retried);
		expect(oldTurnAttempts).toBe(2);
		await conversation.close();
	});

	it("过期 attempt 的迟到结果不能覆盖新 attempt", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		let currentTime = new Date("2026-08-29T09:00:00.000Z");
		let signalStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		let resolveFirst: ((update: RequirementUpdate) => void) | undefined;
		const firstModelResult = new Promise<RequirementUpdate>((resolve) => {
			resolveFirst = resolve;
		});
		const firstConversation = await openPostgresConversation({
			databaseUrl: isolated,
			now: () => currentTime,
			requirementInterpreter: {
				interpret() {
					signalStarted?.();
					return firstModelResult;
				},
			},
		});
		const created = await firstConversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-stale-attempt",
			ownerUserId: "user-a",
		});
		const command = {
			type: "APPEND_USER_TURN" as const,
			clientTurnId: "turn-stale-attempt",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "我想买显示器",
		};
		const staleAttempt = firstConversation.execute(command);
		await started;

		currentTime = new Date("2026-08-29T09:03:00.000Z");
		const recoveringConversation = await openPostgresConversation({
			databaseUrl: isolated,
			now: () => currentTime,
			requirementInterpreter: {
				async interpret() {
					return { consumptionGoal: "购买新 attempt 的显示器" };
				},
			},
		});
		const recovered = await recoveringConversation.execute(command);
		expect(recovered.currentRequirement?.consumptionGoal).toBe(
			"购买新 attempt 的显示器",
		);

		resolveFirst?.({ consumptionGoal: "旧 attempt 的迟到结果" });
		await expect(staleAttempt).rejects.toMatchObject({
			code: "CONVERSATION_TURN_IN_PROGRESS",
		});
		const finalSession = await recoveringConversation.read({
			type: "GET_SESSION",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
		});
		expect(finalSession?.currentRequirement?.consumptionGoal).toBe(
			"购买新 attempt 的显示器",
		);
		expect(finalSession?.messages).toHaveLength(3);
		await firstConversation.close();
		await recoveringConversation.close();
	});

	it("并发重试同一创建请求只生成一个 Session", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
		});
		const lockPool = new Pool({ connectionString: isolated });
		const lockClient = await lockPool.connect();
		await lockClient.query("BEGIN");
		await lockClient.query("LOCK TABLE conversation_sessions IN SHARE MODE");
		const attempts = Promise.all([
			conversation.execute({
				type: "CREATE_SESSION",
				clientRequestId: "create-concurrently",
				ownerUserId: "user-a",
			}),
			conversation.execute({
				type: "CREATE_SESSION",
				clientRequestId: "create-concurrently",
				ownerUserId: "user-a",
			}),
		]);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await lockClient.query("COMMIT");
		lockClient.release();
		await lockPool.end();
		const [first, second] = await attempts;

		expect(second).toEqual(first);
		await expect(
			conversation.read({ type: "LIST_SESSIONS", ownerUserId: "user-a" }),
		).resolves.toHaveLength(1);
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
		const turn = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-task-link",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "我想买一台显示器。",
			requirementUpdate: { consumptionGoal: "购买显示器" },
		});
		const requirementRevisionId = turn.currentRequirement?.revisionId;
		if (requirementRevisionId === undefined)
			throw new Error("缺少 Requirement Revision");

		const linked = await conversation.execute({
			type: "LINK_DECISION_TASK",
			decisionTaskId: "task-conversation-1",
			requirementRevisionId,
			ownerUserId: "user-a",
			sessionId: created.sessionId,
		});
		expect(linked.decisionTasks).toEqual([
			{
				decisionTaskId: "task-conversation-1",
				requirementRevisionId,
				linkedAt: "2026-08-27T23:20:00.000Z",
			},
		]);
		await expect(
			conversation.execute({
				type: "LINK_DECISION_TASK",
				decisionTaskId: "task-conversation-1",
				ownerUserId: "user-a",
				requirementRevisionId,
				sessionId: created.sessionId,
			}),
		).resolves.toEqual(linked);
		await expect(
			conversation.execute({
				type: "LINK_DECISION_TASK",
				decisionTaskId: "task-forged",
				ownerUserId: "user-b",
				requirementRevisionId,
				sessionId: created.sessionId,
			}),
		).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
		const otherUserSession = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-other-user-task-link",
			ownerUserId: "user-b",
		});
		const otherUserTurn = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-other-user-task-link",
			ownerUserId: "user-b",
			sessionId: otherUserSession.sessionId,
			text: "我想买一台电视。",
			requirementUpdate: { consumptionGoal: "购买电视" },
		});
		const otherUserRequirementRevisionId =
			otherUserTurn.currentRequirement?.revisionId;
		if (otherUserRequirementRevisionId === undefined)
			throw new Error("缺少其他 User 的 Requirement Revision");
		await expect(
			conversation.execute({
				type: "LINK_DECISION_TASK",
				decisionTaskId: "task-conversation-1",
				ownerUserId: "user-b",
				requirementRevisionId: otherUserRequirementRevisionId,
				sessionId: otherUserSession.sessionId,
			}),
		).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
		await conversation.close();
	});

	it("只按所属 User、Decision Task 与 Requirement Revision 解析精确触发消息", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
		});
		const created = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-task-context",
			ownerUserId: "user-a",
		});
		const turn = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-task-context",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "我想买一台用于长时间编程的显示器。",
			requirementUpdate: { consumptionGoal: "购买编程显示器" },
		});
		const requirementRevisionId = turn.currentRequirement?.revisionId;
		if (requirementRevisionId === undefined)
			throw new Error("缺少 Requirement Revision");
		const laterTurn = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-task-context-later",
			ownerUserId: "user-a",
			sessionId: created.sessionId,
			text: "还要支持 USB-C 一线连接。",
			requirementUpdate: { hardConstraints: ["支持 USB-C 一线连接"] },
		});
		const laterRequirementRevisionId = laterTurn.currentRequirement?.revisionId;
		if (laterRequirementRevisionId === undefined)
			throw new Error("缺少后续 Requirement Revision");
		await conversation.execute({
			type: "LINK_DECISION_TASK",
			decisionTaskId: "task-context-1",
			ownerUserId: "user-a",
			requirementRevisionId,
			sessionId: created.sessionId,
		});

		await expect(
			conversation.read({
				type: "GET_DECISION_TASK_CONTEXT",
				ownerUserId: "user-a",
				decisionTaskId: "task-context-1",
				requirementRevisionId,
			}),
		).resolves.toMatchObject({
			sessionId: created.sessionId,
			triggerMessage: {
				messageId: turn.turn.userMessageId,
				text: "我想买一台用于长时间编程的显示器。",
			},
		});
		await expect(
			conversation.read({
				type: "GET_DECISION_TASK_CONTEXT",
				ownerUserId: "user-b",
				decisionTaskId: "task-context-1",
				requirementRevisionId,
			}),
		).resolves.toBeUndefined();
		await expect(
			conversation.read({
				type: "GET_DECISION_TASK_CONTEXT",
				ownerUserId: "user-a",
				decisionTaskId: "task-context-1",
				requirementRevisionId: laterRequirementRevisionId,
			}),
		).resolves.toBeUndefined();
		await expect(
			conversation.execute({
				type: "LINK_DECISION_TASK",
				decisionTaskId: "task-context-1",
				ownerUserId: "user-a",
				requirementRevisionId: laterRequirementRevisionId,
				sessionId: created.sessionId,
			}),
		).rejects.toMatchObject({ code: "CONVERSATION_IDEMPOTENCY_CONFLICT" });
		await conversation.close();
	});

	it("拒绝把 Decision Task 绑定到其他 Session 的 Requirement Revision", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
		});
		const first = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-link-first-session",
			ownerUserId: "user-a",
		});
		const second = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-link-second-session",
			ownerUserId: "user-a",
		});
		const secondTurn = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-link-second-session",
			ownerUserId: "user-a",
			sessionId: second.sessionId,
			text: "我想买一把人体工学椅。",
			requirementUpdate: { consumptionGoal: "购买人体工学椅" },
		});
		const secondRequirementRevisionId =
			secondTurn.currentRequirement?.revisionId;
		if (secondRequirementRevisionId === undefined)
			throw new Error("缺少第二个 Session 的 Requirement Revision");

		await expect(
			conversation.execute({
				type: "LINK_DECISION_TASK",
				decisionTaskId: "task-cross-session-revision",
				ownerUserId: "user-a",
				requirementRevisionId: secondRequirementRevisionId,
				sessionId: first.sessionId,
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
		const ownedTurn = await conversation.execute({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-purge-owned",
			ownerUserId: "user-a",
			sessionId: owned.sessionId,
			text: "购买显示器",
			requirementUpdate: { consumptionGoal: "购买显示器" },
		});
		const ownedRequirementRevisionId = ownedTurn.currentRequirement?.revisionId;
		if (ownedRequirementRevisionId === undefined)
			throw new Error("缺少待删除 Session 的 Requirement Revision");
		await conversation.execute({
			type: "LINK_DECISION_TASK",
			decisionTaskId: "task-purge-owned",
			ownerUserId: "user-a",
			requirementRevisionId: ownedRequirementRevisionId,
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

	it("会话删除状态跨重启保留，清理完成前拒绝读取与继续写入", async () => {
		if (databaseUrl === undefined) throw new Error("测试数据库未配置");
		const isolated = await createIsolatedDatabaseUrl(databaseUrl);
		const conversation = await openPostgresConversation({
			databaseUrl: isolated,
		});
		const owned = await conversation.execute({
			type: "CREATE_SESSION",
			clientRequestId: "create-session-delete",
			ownerUserId: "user-a",
		});

		await expect(
			conversation.beginPrivateDataDeletionForSession(
				"user-b",
				owned.sessionId,
			),
		).resolves.toBe(false);
		await expect(
			conversation.beginPrivateDataDeletionForSession(
				"user-a",
				owned.sessionId,
			),
		).resolves.toBe(true);
		await expect(
			conversation.read({
				type: "GET_SESSION",
				ownerUserId: "user-a",
				sessionId: owned.sessionId,
			}),
		).resolves.toBeUndefined();
		await expect(
			conversation.execute({
				type: "APPEND_USER_TURN",
				clientTurnId: "turn-after-delete",
				ownerUserId: "user-a",
				sessionId: owned.sessionId,
				text: "不能继续写入",
				requirementUpdate: { consumptionGoal: "不应保存" },
			}),
		).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
		await conversation.close();

		const reopened = await openPostgresConversation({ databaseUrl: isolated });
		await expect(
			reopened.beginPrivateDataDeletionForSession("user-a", owned.sessionId),
		).resolves.toBe(true);
		await expect(
			reopened.completePrivateDataDeletionForSession("user-a", owned.sessionId),
		).resolves.toBe(true);
		await expect(
			reopened.read({
				type: "GET_SESSION",
				ownerUserId: "user-a",
				sessionId: owned.sessionId,
			}),
		).resolves.toBeUndefined();
		await reopened.close();
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
