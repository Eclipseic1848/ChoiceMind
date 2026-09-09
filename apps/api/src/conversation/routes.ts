import type {
	AppendUserTurnCommand,
	Conversation,
	RequirementUpdate,
} from "@choicemind/conversation";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { IdentityResolver } from "../security/identity.js";
import type { DecisionTaskPersistencePort } from "../decision-tasks/persistence-port.js";

export function registerConversationRoutes(
	app: FastifyInstance,
	conversation: Conversation | undefined,
	identityResolver: IdentityResolver | undefined,
	decisionTaskPersistence: DecisionTaskPersistencePort | undefined,
) {
	app.post("/api/v1/conversations", async (request, reply) => {
		const principal = await resolvePrincipal(
			identityResolver,
			request.headers.authorization,
			request.headers.cookie,
			reply,
		);
		if (principal === undefined) return reply;
		if (conversation === undefined) return sendUnavailable(reply);
		const clientRequestId = readNonEmptyString(request.body, "clientRequestId");
		if (clientRequestId === undefined)
			return sendInvalid(reply, "clientRequestId 无效");

		try {
			const session = await conversation.execute({
				type: "CREATE_SESSION",
				clientRequestId,
				ownerUserId: principal.userId,
			});
			return reply.code(201).send(session);
		} catch (error) {
			return sendConversationError(reply, error);
		}
	});

	app.get("/api/v1/conversations", async (request, reply) => {
		const principal = await resolvePrincipal(
			identityResolver,
			request.headers.authorization,
			request.headers.cookie,
			reply,
		);
		if (principal === undefined) return reply;
		if (conversation === undefined) return sendUnavailable(reply);
		try {
			return reply.send(
				await conversation.read({
					type: "LIST_SESSIONS",
					ownerUserId: principal.userId,
				}),
			);
		} catch (error) {
			return sendConversationError(reply, error);
		}
	});

	app.get<{ Params: { sessionId: string } }>(
		"/api/v1/conversations/:sessionId",
		async (request, reply) => {
			const principal = await resolvePrincipal(
				identityResolver,
				request.headers.authorization,
				request.headers.cookie,
				reply,
			);
			if (principal === undefined) return reply;
			if (conversation === undefined) return sendUnavailable(reply);
			try {
				const session = await conversation.read({
					type: "GET_SESSION",
					ownerUserId: principal.userId,
					sessionId: request.params.sessionId,
				});
				return session === undefined
					? sendNotFound(reply)
					: reply.send(session);
			} catch (error) {
				return sendConversationError(reply, error);
			}
		},
	);

	app.get<{ Params: { sessionId: string } }>(
		"/api/v1/conversations/:sessionId/requirements",
		async (request, reply) => {
			const principal = await resolvePrincipal(
				identityResolver,
				request.headers.authorization,
				request.headers.cookie,
				reply,
			);
			if (principal === undefined) return reply;
			if (conversation === undefined) return sendUnavailable(reply);
			try {
				return reply.send(
					await conversation.read({
						type: "LIST_REQUIREMENT_REVISIONS",
						ownerUserId: principal.userId,
						sessionId: request.params.sessionId,
					}),
				);
			} catch (error) {
				return sendConversationError(reply, error);
			}
		},
	);

	app.post<{ Params: { sessionId: string } }>(
		"/api/v1/conversations/:sessionId/turns",
		async (request, reply) => {
			const principal = await resolvePrincipal(
				identityResolver,
				request.headers.authorization,
				request.headers.cookie,
				reply,
			);
			if (principal === undefined) return reply;
			if (conversation === undefined) return sendUnavailable(reply);
			const decoded = decodeAppendTurn(request.body);
			if (decoded === undefined)
				return sendInvalid(reply, "消息或需求更新无效");

			try {
				return reply.send(
					await conversation.execute({
						...decoded,
						type: "APPEND_USER_TURN",
						ownerUserId: principal.userId,
						sessionId: request.params.sessionId,
					}),
				);
			} catch (error) {
				return sendConversationError(reply, error);
			}
		},
	);

	app.post<{ Params: { sessionId: string } }>(
		"/api/v1/conversations/:sessionId/decision-tasks",
		async (request, reply) => {
			const principal = await resolvePrincipal(
				identityResolver,
				request.headers.authorization,
				request.headers.cookie,
				reply,
			);
			if (principal === undefined) return reply;
			if (conversation === undefined || decisionTaskPersistence === undefined) {
				return sendUnavailable(reply);
			}
			const decisionTaskId = readNonEmptyString(request.body, "decisionTaskId");
			if (decisionTaskId === undefined)
				return sendInvalid(reply, "decisionTaskId 无效");
			const requirementRevisionId = readNonEmptyString(
				request.body,
				"requirementRevisionId",
			);
			if (requirementRevisionId === undefined)
				return sendInvalid(reply, "requirementRevisionId 无效");
			try {
				const ownedTask = await decisionTaskPersistence.get(
					decisionTaskId,
					principal.userId,
				);
				if (ownedTask === undefined) return sendNotFound(reply);
				return reply.send(
					await conversation.execute({
						type: "LINK_DECISION_TASK",
						decisionTaskId,
						ownerUserId: principal.userId,
						requirementRevisionId,
						sessionId: request.params.sessionId,
					}),
				);
			} catch (error) {
				return sendConversationError(reply, error);
			}
		},
	);
}

function decodeAppendTurn(
	body: unknown,
):
	| Omit<AppendUserTurnCommand, "ownerUserId" | "sessionId" | "type">
	| undefined {
	const clientTurnId = readNonEmptyString(body, "clientTurnId");
	const text = readNonEmptyString(body, "text");
	if (clientTurnId === undefined || text === undefined || !isRecord(body))
		return undefined;
	const update = body.requirementUpdate;
	if (!isRecord(update)) return undefined;

	let consumptionGoal: string | undefined;
	let primaryScenario: string | undefined;
	let hardConstraints: readonly string[] | undefined;
	if ("consumptionGoal" in update) {
		if (typeof update.consumptionGoal !== "string") return undefined;
		consumptionGoal = update.consumptionGoal;
	}
	if ("primaryScenario" in update) {
		if (typeof update.primaryScenario !== "string") return undefined;
		primaryScenario = update.primaryScenario;
	}
	if ("hardConstraints" in update) {
		if (
			!Array.isArray(update.hardConstraints) ||
			update.hardConstraints.some((value) => typeof value !== "string")
		) {
			return undefined;
		}
		hardConstraints = update.hardConstraints;
	}
	const requirementUpdate: RequirementUpdate = {
		...(consumptionGoal === undefined ? {} : { consumptionGoal }),
		...(primaryScenario === undefined ? {} : { primaryScenario }),
		...(hardConstraints === undefined ? {} : { hardConstraints }),
	};
	return { clientTurnId, requirementUpdate, text };
}

async function resolvePrincipal(
	identityResolver: IdentityResolver | undefined,
	authorization: string | undefined,
	cookie: string | undefined,
	reply: FastifyReply,
) {
	const principal = await identityResolver?.resolve(authorization, cookie);
	if (principal === undefined) {
		reply.code(401).send({
			error: {
				code: "AUTHENTICATION_REQUIRED",
				message: "请先登录 ChoiceMind",
			},
		});
	}
	return principal;
}

function sendConversationError(reply: FastifyReply, error: unknown) {
	const code = getErrorCode(error);
	if (code === "CONVERSATION_INVALID") {
		return sendInvalid(
			reply,
			error instanceof Error ? error.message : "Conversation 输入无效",
		);
	}
	if (code === "CONVERSATION_NOT_FOUND") return sendNotFound(reply);
	if (code === "CONVERSATION_IDEMPOTENCY_CONFLICT") {
		return reply.code(409).send({
			error: { code, message: "同一操作不能提交不同内容" },
		});
	}
	return sendUnavailable(reply);
}

function sendInvalid(reply: FastifyReply, message: string) {
	return reply
		.code(400)
		.send({ error: { code: "CONVERSATION_INVALID", message } });
}

function sendNotFound(reply: FastifyReply) {
	return reply.code(404).send({
		error: { code: "CONVERSATION_NOT_FOUND", message: "Session 不存在" },
	});
}

function sendUnavailable(reply: FastifyReply) {
	return reply.code(503).send({
		error: { code: "CONVERSATION_UNAVAILABLE", message: "对话服务暂时不可用" },
	});
}

function readNonEmptyString(value: unknown, key: string): string | undefined {
	if (!isRecord(value) || typeof value[key] !== "string") return undefined;
	const text = value[key].trim();
	return text.length > 0 && text.length <= 2_000 ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string"
		? error.code
		: undefined;
}
