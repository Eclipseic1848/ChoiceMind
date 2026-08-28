import type {
	Conversation,
	ConversationSession,
} from "@choicemind/conversation";
import { afterEach, describe, expect, it } from "vitest";

import { buildApiApp } from "../app.js";

const openApps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
	await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("Conversation routes", () => {
	it("只用服务端 Principal 创建、读取和追加 User 自己的 Session", async () => {
		const commands: unknown[] = [];
		const queries: unknown[] = [];
		const session = buildSession();
		const conversation = {
			async execute(command: { type: string; ownerUserId: string }) {
				commands.push(command);
				return session;
			},
			async read(query: { type: string; ownerUserId: string }) {
				queries.push(query);
				if (query.type === "LIST_SESSIONS") {
					return [
						{
							sessionId: session.sessionId,
							title: session.title,
							latestMessage: session.messages.at(-1)?.text ?? "",
							readiness: null,
							updatedAt: session.updatedAt,
						},
					];
				}
				return query.ownerUserId === "user-a" ? session : undefined;
			},
			async close() {},
		} as unknown as Conversation;
		const app = buildApiApp({
			conversation,
			decisionTaskPersistence: {
				async submit() {
					throw new Error("不应提交任务");
				},
				async get(decisionTaskId, ownerUserId) {
					return ownerUserId === "user-a" && decisionTaskId === "task-api-1"
						? {
								contractType: "decision-task-snapshot",
								contractVersion: "1.0",
								executionRequestId: "exec-api-1",
								decisionTaskId,
								agentRunId: "run-api-1",
								state: "ACCEPTED",
								terminal: false,
								updatedAt: "2026-08-27T22:30:00.000Z",
							}
						: undefined;
				},
				async listEvents() {
					return [];
				},
			},
			identityResolver: {
				async resolve(authorization) {
					if (authorization === undefined) return undefined;
					const userId =
						authorization === "Bearer user-b" ? "user-b" : "user-a";
					return {
						principalId: `principal-${userId}`,
						role: "USER",
						userId,
					};
				},
			},
		});
		openApps.push(app);

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/conversations",
			headers: { authorization: "Bearer user-a" },
			payload: {
				clientRequestId: "create-web-1",
				ownerUserId: "forged-user",
			},
		});
		expect(created.statusCode).toBe(201);
		expect(created.json()).toEqual(session);
		expect(commands[0]).toEqual({
			type: "CREATE_SESSION",
			clientRequestId: "create-web-1",
			ownerUserId: "user-a",
		});

		const appended = await app.inject({
			method: "POST",
			url: `/api/v1/conversations/${session.sessionId}/turns`,
			headers: { authorization: "Bearer user-a" },
			payload: {
				clientTurnId: "turn-web-1",
				text: "我想买显示器",
				requirementUpdate: { consumptionGoal: "购买显示器" },
				ownerUserId: "forged-user",
			},
		});
		expect(appended.statusCode).toBe(200);
		expect(commands[1]).toEqual({
			type: "APPEND_USER_TURN",
			clientTurnId: "turn-web-1",
			ownerUserId: "user-a",
			sessionId: session.sessionId,
			text: "我想买显示器",
			requirementUpdate: { consumptionGoal: "购买显示器" },
		});

		const linked = await app.inject({
			method: "POST",
			url: `/api/v1/conversations/${session.sessionId}/decision-tasks`,
			headers: { authorization: "Bearer user-a" },
			payload: { decisionTaskId: "task-api-1" },
		});
		expect(linked.statusCode).toBe(200);
		expect(commands[2]).toEqual({
			type: "LINK_DECISION_TASK",
			decisionTaskId: "task-api-1",
			ownerUserId: "user-a",
			sessionId: session.sessionId,
		});

		const forgedTask = await app.inject({
			method: "POST",
			url: `/api/v1/conversations/${session.sessionId}/decision-tasks`,
			headers: { authorization: "Bearer user-b" },
			payload: { decisionTaskId: "task-api-1" },
		});
		expect(forgedTask.statusCode).toBe(404);
		expect(commands).toHaveLength(3);

		const listed = await app.inject({
			method: "GET",
			url: "/api/v1/conversations",
			headers: { authorization: "Bearer user-a" },
		});
		expect(listed.statusCode).toBe(200);
		expect(listed.json()).toHaveLength(1);
		expect(queries[0]).toEqual({
			type: "LIST_SESSIONS",
			ownerUserId: "user-a",
		});

		const denied = await app.inject({
			method: "GET",
			url: `/api/v1/conversations/${session.sessionId}`,
			headers: { authorization: "Bearer user-b" },
		});
		expect(denied.statusCode).toBe(404);
		expect(denied.json()).toMatchObject({
			error: { code: "CONVERSATION_NOT_FOUND" },
		});
	});

	it("拒绝未登录与无效的 Conversation 动作", async () => {
		const app = buildApiApp({
			conversation: {
				async execute() {
					throw new Error("不应执行");
				},
				async read() {
					throw new Error("不应读取");
				},
				async close() {},
			} as unknown as Conversation,
			identityResolver: {
				async resolve(authorization) {
					return authorization === undefined
						? undefined
						: {
								principalId: "principal-user-a",
								role: "USER",
								userId: "user-a",
							};
				},
			},
		});
		openApps.push(app);

		const unauthenticated = await app.inject({
			method: "POST",
			url: "/api/v1/conversations",
			payload: { clientRequestId: "create-web-1" },
		});
		expect(unauthenticated.statusCode).toBe(401);

		const invalid = await app.inject({
			method: "POST",
			url: "/api/v1/conversations/session-1/turns",
			headers: { authorization: "Bearer user-a" },
			payload: {
				clientTurnId: "turn-web-1",
				text: "",
				requirementUpdate: { hardConstraints: "不是数组" },
			},
		});
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json()).toMatchObject({
			error: { code: "CONVERSATION_INVALID" },
		});
	});
});

function buildSession(): ConversationSession {
	return {
		sessionId: "session-api-1",
		title: "新的消费决策",
		createdAt: "2026-08-27T22:30:00.000Z",
		updatedAt: "2026-08-27T22:30:00.000Z",
		currentRequirement: null,
		decisionTasks: [],
		messages: [
			{
				messageId: "message-api-1",
				ordinal: 1,
				role: "ASSISTANT",
				text: "先告诉我，你这次想解决什么消费问题？",
				createdAt: "2026-08-27T22:30:00.000Z",
			},
		],
	};
}
