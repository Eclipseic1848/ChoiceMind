import type { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { IdentityResolver } from "../security/identity.js";

export type CandidateStore = Awaited<
	ReturnType<typeof openPostgresCandidateStore>
>;
const paramsSchema = z
	.object({ candidateId: z.string().regex(/^adapter-candidate-[a-f0-9]{64}$/) })
	.strict();
const actionSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("ENABLE"),
			reviewBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
			requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		})
		.strict(),
	z
		.object({
			type: z.literal("DISABLE"),
			reviewBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
			requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
			reasonCode: z.enum([
				"ADMIN_REQUEST",
				"SECURITY_REVIEW",
				"SOURCE_DEPRECATED",
			]),
		})
		.strict(),
]);

export function registerAdapterCandidateRoutes(
	app: FastifyInstance,
	store: CandidateStore | undefined,
	resolver: IdentityResolver | undefined,
	now: () => Date = () => new Date(),
) {
	app.get("/api/v1/admin/adapter-candidates", async (request, reply) => {
		reply.header("cache-control", "no-store");
		const principal = await resolver?.resolve(
			request.headers.authorization,
			request.headers.cookie,
		);
		if (!principal)
			return reply
				.code(401)
				.send({ error: { code: "AUTHENTICATION_REQUIRED" } });
		if (principal.role !== "ADMIN" && principal.role !== "SUPERADMIN")
			return reply
				.code(403)
				.send({ error: { code: "ADAPTER_CANDIDATE_PERMISSION_DENIED" } });
		const query = z
			.object({
				limit: z.coerce.number().int().min(1).max(50).default(20),
				cursor: z
					.string()
					.refine(
						(value) =>
							/^[1-9][0-9]{0,18}$/.test(value) &&
							BigInt(value) <= 9223372036854775807n,
					)
					.optional(),
			})
			.strict()
			.safeParse(request.query);
		if (!query.success)
			return reply
				.code(422)
				.send({ error: { code: "ADAPTER_CANDIDATE_REQUEST_INVALID" } });
		if (!store)
			return reply
				.code(503)
				.send({ error: { code: "ADAPTER_CANDIDATE_UNAVAILABLE" } });
		try {
			return await store.list({
				limit: query.data.limit,
				...(query.data.cursor ? { cursor: query.data.cursor } : {}),
			});
		} catch {
			return reply
				.code(503)
				.send({ error: { code: "ADAPTER_CANDIDATE_UNAVAILABLE" } });
		}
	});
	// 没有公开报告写入接口；管理员不能提交自报 PASSED 的报告。
	app.route({
		method: ["GET", "POST"],
		url: "/api/v1/admin/adapter-candidates/:candidateId",
		bodyLimit: 4096,
		handler: async (request, reply) => {
			reply.header("cache-control", "no-store");
			const principal = await resolver?.resolve(
				request.headers.authorization,
				request.headers.cookie,
			);
			if (principal === undefined)
				return reply
					.code(401)
					.send({ error: { code: "AUTHENTICATION_REQUIRED" } });
			if (principal.role !== "ADMIN" && principal.role !== "SUPERADMIN")
				return reply
					.code(403)
					.send({ error: { code: "ADAPTER_CANDIDATE_PERMISSION_DENIED" } });
			const params = paramsSchema.safeParse(request.params);
			if (!params.success)
				return reply
					.code(422)
					.send({ error: { code: "ADAPTER_CANDIDATE_REQUEST_INVALID" } });
			if (store === undefined)
				return reply
					.code(503)
					.send({ error: { code: "ADAPTER_CANDIDATE_UNAVAILABLE" } });
			if (request.method === "GET") {
				try {
					const result = await store.read(params.data.candidateId);
					return result === undefined
						? reply
								.code(404)
								.send({ error: { code: "ADAPTER_CANDIDATE_NOT_FOUND" } })
						: reply.send(result);
				} catch {
					return reply
						.code(503)
						.send({ error: { code: "ADAPTER_CANDIDATE_UNAVAILABLE" } });
				}
			}
			const parsed = actionSchema.safeParse(request.body);
			if (!parsed.success)
				return reply
					.code(422)
					.send({ error: { code: "ADAPTER_CANDIDATE_REQUEST_INVALID" } });
			const action = parsed.data;
			try {
				return await store.transition(
					params.data.candidateId,
					action.reviewBindingSha256,
					action.requestId,
					{
						type: action.type,
						actorId: principal.userId,
						actorRole: principal.role,
						occurredAt: now().toISOString(),
						...(action.type === "DISABLE"
							? { reasonCode: action.reasonCode }
							: {}),
					},
				);
			} catch (error) {
				const code = error instanceof Error ? error.message : "";
				if (
					[
						"ADAPTER_CANDIDATE_REVIEW_STALE",
						"ADAPTER_CANDIDATE_REQUEST_CONFLICT",
						"ADAPTER_CANDIDATE_LIFECYCLE_INVALID",
					].includes(code)
				)
					return reply.code(409).send({ error: { code } });
				return reply
					.code(503)
					.send({ error: { code: "ADAPTER_CANDIDATE_UNAVAILABLE" } });
			}
		},
	});
}
