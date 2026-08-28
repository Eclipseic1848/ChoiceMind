import type { SourceAccess } from "@choicemind/source-access";
import type { SourceResearch } from "@choicemind/source-research";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { IdentityResolver } from "../security/identity.js";
import type { DecisionTaskPersistencePort } from "../decision-tasks/persistence-port.js";

export function registerSourceRoutes(
  app: FastifyInstance,
  sourceAccess: SourceAccess | undefined,
  sourceResearch: SourceResearch | undefined,
  identityResolver: IdentityResolver | undefined,
  decisionTaskPersistence: DecisionTaskPersistencePort | undefined
) {
  app.get("/api/v1/sources", async (request, reply) => {
    const principal = await resolvePrincipal(identityResolver, request, reply);
    if (principal === undefined) return reply;
    if (sourceAccess === undefined) return unavailable(reply);
    return reply.send(
      await sourceAccess.read({
        type: "LIST_SOURCE_STATUSES",
        ownerUserId: principal.userId
      })
    );
  });

  app.post<{ Params: { sourceId: string } }>(
    "/api/v1/sources/:sourceId/login",
    async (request, reply) => {
      const principal = await resolvePrincipal(identityResolver, request, reply);
      if (principal === undefined) return reply;
      if (sourceAccess === undefined) return unavailable(reply);
      if (request.params.sourceId !== "fixture") {
        return reply.code(400).send({
          error: { code: "SOURCE_ADAPTER_NOT_CERTIFIED", message: "该来源尚未通过认证" }
        });
      }
      const sourceAccountId = readBoundedString(request.body, "sourceAccountId", 200);
      if (sourceAccountId === undefined) return invalid(reply, "sourceAccountId 无效");
      const login = await sourceAccess.execute({
        type: "BEGIN_LOGIN",
        ownerUserId: principal.userId,
        sourceId: request.params.sourceId,
        sourceAccountId,
        officialLoginUrl: "/source-login/fixture",
        correlationId: request.id
      });
      return reply.code(201).send({
        ...login,
        officialLoginUrl: `/source-login/${login.loginSessionId}`
      });
    }
  );

  app.delete<{ Params: { sourceId: string; sourceAccountId: string } }>(
    "/api/v1/sources/:sourceId/credentials/:sourceAccountId",
    async (request, reply) => {
      const principal = await resolvePrincipal(identityResolver, request, reply);
      if (principal === undefined) return reply;
      if (sourceAccess === undefined) return unavailable(reply);
      if (
        request.params.sourceId !== "fixture" ||
        request.params.sourceAccountId.length === 0 ||
        request.params.sourceAccountId.length > 200
      ) {
        return invalid(reply, "来源账号无效");
      }
      const revoked = await sourceAccess.execute({
        type: "REVOKE_CREDENTIAL",
        ownerUserId: principal.userId,
        sourceId: request.params.sourceId,
        sourceAccountId: request.params.sourceAccountId,
        correlationId: request.id,
        actor: { userId: principal.userId, role: principal.role }
      });
      return revoked === undefined
        ? reply.code(404).send({ error: { code: "SOURCE_CREDENTIAL_NOT_FOUND" } })
        : reply.send(revoked);
    }
  );

  app.post<{ Params: { loginSessionId: string } }>(
    "/api/v1/source-login/:loginSessionId/fixture-complete",
    async (request, reply) => {
      const principal = await resolvePrincipal(identityResolver, request, reply);
      if (principal === undefined) return reply;
      if (sourceAccess === undefined || sourceResearch === undefined) {
        return unavailable(reply);
      }
      if (!isUuid(request.params.loginSessionId)) {
        return reply.code(404).send({ error: { code: "SOURCE_LOGIN_SESSION_NOT_FOUND" } });
      }
      try {
        const status = await sourceAccess.execute({
          type: "COMPLETE_LOGIN",
          ownerUserId: principal.userId,
          loginSessionId: request.params.loginSessionId,
          credentialSecret: `fixture-session:${principal.userId}`,
          correlationId: request.id,
          actor: { userId: principal.userId, role: principal.role }
        });
        const resumed = await sourceResearch.execute({
          type: "RESUME_SOURCE",
          ownerUserId: principal.userId,
          sourceId: status.sourceId,
          sourceAccountId: status.sourceAccountId
        });
        return reply.send({ status, resumed: resumed.resumed });
      } catch (error) {
        if (error instanceof Error && error.message === "SOURCE_LOGIN_SESSION_NOT_FOUND") {
          return reply.code(404).send({ error: { code: error.message } });
        }
        throw error;
      }
    }
  );

  app.post("/api/v1/source-research/batches", async (request, reply) => {
    const principal = await resolvePrincipal(identityResolver, request, reply);
    if (principal === undefined) return reply;
    if (sourceResearch === undefined) return unavailable(reply);
    const batchId = readUuid(request.body, "batchId");
    const decisionTaskId = readBoundedString(request.body, "decisionTaskId", 200);
    const idempotencyKey = readBoundedString(request.body, "idempotencyKey", 200);
    const query = readBoundedString(request.body, "query", 4_000);
    const sources = readSources(request.body);
    if (
      batchId === undefined ||
      decisionTaskId === undefined ||
      idempotencyKey === undefined ||
      query === undefined ||
      sources === undefined
    ) {
      return invalid(reply, "来源研究批次无效");
    }
    if (sources.some((source) => source.sourceId !== "fixture")) {
      return invalid(reply, "本阶段只允许受控 Fixture Adapter");
    }
    if (decisionTaskPersistence === undefined) return unavailable(reply);
    const ownedTask = await decisionTaskPersistence.get(decisionTaskId, principal.userId);
    if (ownedTask === undefined) {
      return reply.code(404).send({ error: { code: "DECISION_TASK_NOT_FOUND" } });
    }
    try {
      const batch = await sourceResearch.execute({
        type: "CREATE_BATCH",
        batchId,
        ownerUserId: principal.userId,
        decisionTaskId,
        idempotencyKey,
        query,
        sources
      });
      return reply.code(201).send(batch);
    } catch (error) {
      if (error instanceof Error && error.message === "SOURCE_RESEARCH_IDEMPOTENCY_CONFLICT") {
        return reply.code(409).send({ error: { code: error.message } });
      }
      throw error;
    }
  });

  app.get("/api/v1/source-research/batches", async (request, reply) => {
    const principal = await resolvePrincipal(identityResolver, request, reply);
    if (principal === undefined) return reply;
    if (sourceResearch === undefined) return unavailable(reply);
    const decisionTaskId = readBoundedString(request.query, "decisionTaskId", 200);
    if (decisionTaskId === undefined) return invalid(reply, "decisionTaskId 无效");
    const batch = await sourceResearch.read({
      type: "GET_BATCH_FOR_TASK",
      decisionTaskId,
      ownerUserId: principal.userId
    });
    return batch === undefined
      ? reply.code(404).send({ error: { code: "SOURCE_RESEARCH_NOT_FOUND" } })
      : reply.send(batch);
  });

  app.get<{ Params: { batchId: string } }>(
    "/api/v1/source-research/batches/:batchId",
    async (request, reply) => {
      const principal = await resolvePrincipal(identityResolver, request, reply);
      if (principal === undefined) return reply;
      if (sourceResearch === undefined) return unavailable(reply);
      if (!isUuid(request.params.batchId)) {
        return reply.code(404).send({ error: { code: "SOURCE_RESEARCH_NOT_FOUND" } });
      }
      const batch = await sourceResearch.read({
        type: "GET_BATCH",
        batchId: request.params.batchId,
        ownerUserId: principal.userId
      });
      return batch === undefined
        ? reply.code(404).send({ error: { code: "SOURCE_RESEARCH_NOT_FOUND" } })
        : reply.send(batch);
    }
  );
}

async function resolvePrincipal(
  identityResolver: IdentityResolver | undefined,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (identityResolver === undefined) {
    reply.code(503).send({ error: { code: "IDENTITY_UNAVAILABLE" } });
    return undefined;
  }
  const principal = await identityResolver.resolve(
    request.headers.authorization,
    request.headers.cookie
  );
  if (principal === undefined) {
    reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
  }
  return principal;
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: { code: "SOURCE_MODULE_UNAVAILABLE" } });
}

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "CONTRACT_INVALID", message } });
}

function readString(body: unknown, key: string): string | undefined {
  return readBoundedString(body, key, 4_000);
}

function readBoundedString(body: unknown, key: string, maxLength: number): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function readUuid(body: unknown, key: string): string | undefined {
  const value = readString(body, key);
  return value !== undefined && isUuid(value)
    ? value
    : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readSources(
  body: unknown
): readonly Readonly<{ sourceId: string; sourceAccountId: string }>[] | undefined {
  if (typeof body !== "object" || body === null || !("sources" in body)) return undefined;
  const sources = (body as { sources?: unknown }).sources;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 10) return undefined;
  const decoded = sources.map((source) => {
    const sourceId = readBoundedString(source, "sourceId", 100);
    const sourceAccountId = readBoundedString(source, "sourceAccountId", 200);
    return sourceId === undefined || sourceAccountId === undefined
      ? undefined
      : { sourceId, sourceAccountId };
  });
  return decoded.some((source) => source === undefined)
    ? undefined
    : (decoded as readonly Readonly<{ sourceId: string; sourceAccountId: string }>[]);
}
