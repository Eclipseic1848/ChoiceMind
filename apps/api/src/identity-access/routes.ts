import type { IdentityAccess } from "@choicemind/identity-access";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const sessionCookieName = "choicemind_session";
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;

export function registerIdentityAccessRoutes(
	app: FastifyInstance,
	identityAccess: IdentityAccess | undefined,
): void {
	app.get("/api/v1/identity/bootstrap", async (_request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		return reply
			.code(200)
			.send(await identityAccess.read({ type: "GET_BOOTSTRAP_STATUS" }));
	});

	app.post("/api/v1/identity/bootstrap", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const body = decodeUsernamePassword(request.body);
		if (body === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result = await identityAccess.execute({
			type: "BOOTSTRAP_SUPERADMIN",
			correlationId: getCorrelationId(request),
			isLocalRequest: isLocalRequest(request),
			password: body.password,
			username: body.username,
		});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		setSessionCookie(reply, result.sessionToken);
		return reply.code(201).send({
			access: result.access,
			account: result.account,
			recoveryCode: result.recoveryCode,
		});
	});

	app.get("/api/v1/identity/me", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = getSessionToken(request);
		if (sessionToken === undefined)
			return reply.code(401).send({ authenticated: false });
		const result = await identityAccess.read({
			type: "GET_CURRENT_SESSION",
			sessionToken,
		});
		return reply.code(result.authenticated ? 200 : 401).send(result);
	});

	app.post("/api/v1/identity/login", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const body = decodeUsernamePassword(request.body);
		if (body === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result = await identityAccess.execute({
			type: "LOGIN",
			correlationId: getCorrelationId(request),
			password: body.password,
			username: body.username,
		});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		setSessionCookie(reply, result.sessionToken);
		return reply.code(200).send({
			access: result.access,
			account: result.account,
			...(result.access === "DELETION_PENDING"
				? { deletionDueAt: result.deletionDueAt }
				: {}),
		});
	});

	app.post("/api/v1/identity/invitations", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = getSessionToken(request);
		if (sessionToken === undefined)
			return reply.code(401).send({ code: "UNAUTHORIZED" });
		const result = await identityAccess.execute({
			type: "CREATE_INVITATION",
			correlationId: getCorrelationId(request),
			sessionToken,
		});
		return reply
			.code(result.ok ? 201 : getFailureStatus(result.code))
			.send(result);
	});

	app.post("/api/v1/identity/registrations", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const body = decodeRegistration(request.body);
		if (body === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result = await identityAccess.execute({
			type: "REGISTER_WITH_INVITATION",
			correlationId: getCorrelationId(request),
			invitationCode: body.invitationCode,
			password: body.password,
			username: body.username,
		});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		setSessionCookie(reply, result.sessionToken);
		return reply
			.code(201)
			.send({ access: result.access, account: result.account });
	});

	app.post("/api/v1/identity/logout", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = getSessionToken(request);
		if (sessionToken === undefined)
			return reply.code(401).send({ code: "UNAUTHORIZED" });
		const scope = decodeLogoutScope(request.body);
		if (scope === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result =
			scope === "ALL"
				? await identityAccess.execute({
						type: "LOGOUT_ALL",
						correlationId: getCorrelationId(request),
						sessionToken,
					})
				: await identityAccess.execute({
						type: "LOGOUT_CURRENT",
						correlationId: getCorrelationId(request),
						sessionToken,
					});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		clearSessionCookie(reply);
		return reply.code(204).send();
	});

	app.post("/api/v1/identity/password", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = requireSessionToken(request, reply);
		if (sessionToken === undefined) return;
		const body = decodePasswordChange(request.body);
		if (body === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result = await identityAccess.execute({
			type: "CHANGE_PASSWORD",
			correlationId: getCorrelationId(request),
			currentPassword: body.currentPassword,
			newPassword: body.newPassword,
			sessionToken,
		});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		clearSessionCookie(reply);
		return reply.code(204).send();
	});

	app.post("/api/v1/identity/password/temporary", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = requireSessionToken(request, reply);
		if (sessionToken === undefined) return;
		const newPassword = decodeRequiredString(request.body, "newPassword");
		if (newPassword === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result = await identityAccess.execute({
			type: "COMPLETE_TEMPORARY_PASSWORD_CHANGE",
			correlationId: getCorrelationId(request),
			newPassword,
			sessionToken,
		});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		setSessionCookie(reply, result.sessionToken);
		return reply
			.code(200)
			.send({ access: result.access, account: result.account });
	});

	app.get("/api/v1/identity/accounts", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = requireSessionToken(request, reply);
		if (sessionToken === undefined) return;
		const result = await identityAccess.read({
			type: "LIST_ACCOUNTS",
			sessionToken,
		});
		return result.authorized
			? reply.code(200).send(result)
			: reply.code(403).send({ code: "UNAUTHORIZED" });
	});

	app.post("/api/v1/identity/accounts", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = requireSessionToken(request, reply);
		if (sessionToken === undefined) return;
		const body = decodeCreateAccount(request.body);
		if (body === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result = await identityAccess.execute({
			type: "CREATE_ACCOUNT",
			correlationId: getCorrelationId(request),
			role: body.role,
			sessionToken,
			username: body.username,
		});
		return reply
			.code(result.ok ? 201 : getFailureStatus(result.code))
			.send(result);
	});

	app.post(
		"/api/v1/identity/accounts/:accountId/password-reset",
		async (request, reply) => {
			if (identityAccess === undefined)
				return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
			const sessionToken = requireSessionToken(request, reply);
			const accountId = decodePathId(request.params, "accountId");
			if (sessionToken === undefined) return;
			if (accountId === undefined)
				return reply.code(400).send({ code: "CONTRACT_INVALID" });
			const result = await identityAccess.execute({
				type: "RESET_ACCOUNT_PASSWORD",
				accountId,
				correlationId: getCorrelationId(request),
				sessionToken,
			});
			return reply
				.code(result.ok ? 200 : getFailureStatus(result.code))
				.send(result);
		},
	);

	app.patch(
		"/api/v1/identity/accounts/:accountId/role",
		async (request, reply) => {
			if (identityAccess === undefined)
				return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
			const sessionToken = requireSessionToken(request, reply);
			const accountId = decodePathId(request.params, "accountId");
			const body = decodeRoleChange(request.body);
			if (sessionToken === undefined) return;
			if (accountId === undefined || body === undefined) {
				return reply.code(400).send({ code: "CONTRACT_INVALID" });
			}
			const result = await identityAccess.execute({
				type: "SET_ACCOUNT_ROLE",
				accountId,
				correlationId: getCorrelationId(request),
				currentPassword: body.currentPassword,
				role: body.role,
				sessionToken,
			});
			return reply
				.code(result.ok ? 200 : getFailureStatus(result.code))
				.send(result);
		},
	);

	app.patch(
		"/api/v1/identity/accounts/:accountId/status",
		async (request, reply) => {
			if (identityAccess === undefined)
				return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
			const sessionToken = requireSessionToken(request, reply);
			const accountId = decodePathId(request.params, "accountId");
			const body = decodeStatusChange(request.body);
			if (sessionToken === undefined) return;
			if (accountId === undefined || body === undefined) {
				return reply.code(400).send({ code: "CONTRACT_INVALID" });
			}
			const result = await identityAccess.execute({
				type: "SET_ACCOUNT_STATUS",
				accountId,
				correlationId: getCorrelationId(request),
				...(body.currentPassword === undefined
					? {}
					: { currentPassword: body.currentPassword }),
				sessionToken,
				status: body.status,
			});
			return reply
				.code(result.ok ? 200 : getFailureStatus(result.code))
				.send(result);
		},
	);

	app.post(
		"/api/v1/identity/accounts/:accountId/deletion",
		async (request, reply) => {
			if (identityAccess === undefined)
				return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
			const sessionToken = requireSessionToken(request, reply);
			const accountId = decodePathId(request.params, "accountId");
			const currentPassword = decodeRequiredString(
				request.body,
				"currentPassword",
			);
			if (sessionToken === undefined) return;
			if (accountId === undefined || currentPassword === undefined) {
				return reply.code(400).send({ code: "CONTRACT_INVALID" });
			}
			const result = await identityAccess.execute({
				type: "REQUEST_ACCOUNT_DELETION",
				accountId,
				correlationId: getCorrelationId(request),
				currentPassword,
				sessionToken,
			});
			return reply
				.code(result.ok ? 202 : getFailureStatus(result.code))
				.send(result);
		},
	);

	app.post("/api/v1/identity/deletion", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = requireSessionToken(request, reply);
		const currentPassword = decodeRequiredString(
			request.body,
			"currentPassword",
		);
		if (sessionToken === undefined) return;
		if (currentPassword === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result = await identityAccess.execute({
			type: "REQUEST_SELF_DELETION",
			correlationId: getCorrelationId(request),
			currentPassword,
			sessionToken,
		});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		clearSessionCookie(reply);
		return reply.code(202).send(result);
	});

	app.post("/api/v1/identity/deletion/cancel", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = requireSessionToken(request, reply);
		if (sessionToken === undefined) return;
		const result = await identityAccess.execute({
			type: "CANCEL_SELF_DELETION",
			correlationId: getCorrelationId(request),
			sessionToken,
		});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		setSessionCookie(reply, result.sessionToken);
		return reply
			.code(200)
			.send({ access: result.access, account: result.account });
	});

	app.get("/api/v1/identity/invitations", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = requireSessionToken(request, reply);
		if (sessionToken === undefined) return;
		const result = await identityAccess.read({
			type: "LIST_INVITATIONS",
			sessionToken,
		});
		return result.authorized
			? reply.code(200).send(result)
			: reply.code(403).send({ code: "UNAUTHORIZED" });
	});

	app.delete(
		"/api/v1/identity/invitations/:invitationId",
		async (request, reply) => {
			if (identityAccess === undefined)
				return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
			const sessionToken = requireSessionToken(request, reply);
			const invitationId = decodePathId(request.params, "invitationId");
			if (sessionToken === undefined) return;
			if (invitationId === undefined)
				return reply.code(400).send({ code: "CONTRACT_INVALID" });
			const result = await identityAccess.execute({
				type: "REVOKE_INVITATION",
				correlationId: getCorrelationId(request),
				invitationId,
				sessionToken,
			});
			if (!result.ok)
				return reply.code(getFailureStatus(result.code)).send(result);
			return reply.code(204).send();
		},
	);

	app.get("/api/v1/identity/audit-records", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const sessionToken = requireSessionToken(request, reply);
		if (sessionToken === undefined) return;
		const result = await identityAccess.read({
			type: "LIST_AUDIT_RECORDS",
			sessionToken,
		});
		return result.authorized
			? reply.code(200).send(result)
			: reply.code(403).send({ code: "UNAUTHORIZED" });
	});

	app.post("/api/v1/identity/recovery", async (request, reply) => {
		if (identityAccess === undefined)
			return reply.code(503).send({ code: "IDENTITY_UNAVAILABLE" });
		const body = decodeRecovery(request.body);
		if (body === undefined)
			return reply.code(400).send({ code: "CONTRACT_INVALID" });
		const result = await identityAccess.execute({
			type: "RECOVER_SUPERADMIN",
			correlationId: getCorrelationId(request),
			isLocalRequest: isLocalRequest(request),
			newPassword: body.newPassword,
			recoveryCode: body.recoveryCode,
		});
		if (!result.ok)
			return reply.code(getFailureStatus(result.code)).send(result);
		setSessionCookie(reply, result.sessionToken);
		return reply.code(200).send({
			access: result.access,
			account: result.account,
			recoveryCode: result.recoveryCode,
		});
	});
}

export function getSessionToken(request: FastifyRequest): string | undefined {
	const authorization = request.headers.authorization;
	if (authorization?.startsWith("Bearer ")) {
		const token = authorization.slice("Bearer ".length);
		if (token.length > 0 && token.trim() === token) return token;
	}
	const cookieHeader = request.headers.cookie;
	if (cookieHeader === undefined) return undefined;
	for (const part of cookieHeader.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== sessionCookieName) continue;
		const value = part.slice(separator + 1).trim();
		return value.length === 0 ? undefined : decodeURIComponent(value);
	}
	return undefined;
}

function setSessionCookie(reply: FastifyReply, sessionToken: string): void {
	reply.header(
		"Set-Cookie",
		`${sessionCookieName}=${encodeURIComponent(sessionToken)}; Max-Age=${sessionMaxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax`,
	);
}

function clearSessionCookie(reply: FastifyReply): void {
	reply.header(
		"Set-Cookie",
		`${sessionCookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
	);
}

function decodeUsernamePassword(
	body: unknown,
): { password: string; username: string } | undefined {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return undefined;
	if (!("username" in body) || typeof body.username !== "string")
		return undefined;
	if (!("password" in body) || typeof body.password !== "string")
		return undefined;
	return { password: body.password, username: body.username };
}

function decodeRegistration(
	body: unknown,
): { invitationCode: string; password: string; username: string } | undefined {
	const credentials = decodeUsernamePassword(body);
	if (credentials === undefined || typeof body !== "object" || body === null)
		return undefined;
	if (!("invitationCode" in body) || typeof body.invitationCode !== "string")
		return undefined;
	return { ...credentials, invitationCode: body.invitationCode };
}

function decodeLogoutScope(body: unknown): "ALL" | "CURRENT" | undefined {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return undefined;
	if (!("scope" in body) || (body.scope !== "ALL" && body.scope !== "CURRENT"))
		return undefined;
	return body.scope;
}

function decodePasswordChange(
	body: unknown,
): { currentPassword: string; newPassword: string } | undefined {
	const currentPassword = decodeRequiredString(body, "currentPassword");
	const newPassword = decodeRequiredString(body, "newPassword");
	return currentPassword === undefined || newPassword === undefined
		? undefined
		: { currentPassword, newPassword };
}

function decodeCreateAccount(
	body: unknown,
): { role: "USER" | "ADMIN"; username: string } | undefined {
	const username = decodeRequiredString(body, "username");
	if (
		username === undefined ||
		typeof body !== "object" ||
		body === null ||
		Array.isArray(body)
	) {
		return undefined;
	}
	if (!("role" in body) || (body.role !== "USER" && body.role !== "ADMIN"))
		return undefined;
	return { role: body.role, username };
}

function decodeRoleChange(
	body: unknown,
):
	| { currentPassword: string; role: "USER" | "ADMIN" | "SUPERADMIN" }
	| undefined {
	const currentPassword = decodeRequiredString(body, "currentPassword");
	if (
		currentPassword === undefined ||
		typeof body !== "object" ||
		body === null ||
		Array.isArray(body) ||
		!("role" in body) ||
		(body.role !== "USER" &&
			body.role !== "ADMIN" &&
			body.role !== "SUPERADMIN")
	) {
		return undefined;
	}
	return { currentPassword, role: body.role };
}

function decodeStatusChange(
	body: unknown,
): { currentPassword?: string; status: "ACTIVE" | "DISABLED" } | undefined {
	if (
		typeof body !== "object" ||
		body === null ||
		Array.isArray(body) ||
		!("status" in body) ||
		(body.status !== "ACTIVE" && body.status !== "DISABLED")
	) {
		return undefined;
	}
	const values = body as Record<string, unknown>;
	if ("currentPassword" in values && typeof values.currentPassword !== "string")
		return undefined;
	return {
		...(typeof values.currentPassword === "string"
			? { currentPassword: values.currentPassword }
			: {}),
		status: body.status,
	};
}

function decodeRecovery(
	body: unknown,
): { newPassword: string; recoveryCode: string } | undefined {
	const newPassword = decodeRequiredString(body, "newPassword");
	const recoveryCode = decodeRequiredString(body, "recoveryCode");
	return newPassword === undefined || recoveryCode === undefined
		? undefined
		: { newPassword, recoveryCode };
}

function decodeRequiredString(body: unknown, key: string): string | undefined {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return undefined;
	const value = (body as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function decodePathId(params: unknown, key: string): string | undefined {
	if (typeof params !== "object" || params === null || Array.isArray(params))
		return undefined;
	const value = (params as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireSessionToken(
	request: FastifyRequest,
	reply: FastifyReply,
): string | undefined {
	const sessionToken = getSessionToken(request);
	if (sessionToken === undefined)
		reply.code(401).send({ code: "UNAUTHORIZED" });
	return sessionToken;
}

function getCorrelationId(request: FastifyRequest): string {
	return request.id;
}

function isLocalRequest(request: FastifyRequest): boolean {
	if (
		request.ip === "127.0.0.1" ||
		request.ip === "::1" ||
		request.ip === "::ffff:127.0.0.1"
	) {
		return true;
	}
	return (
		process.env.CHOICEMIND_TRUST_LOCAL_WEB_PROXY === "true" &&
		request.headers["x-choicemind-local-browser"] === "1"
	);
}

function getFailureStatus(code: string): number {
	switch (code) {
		case "BOOTSTRAP_ALREADY_COMPLETE":
			return 409;
		case "BOOTSTRAP_LOCAL_ONLY":
		case "RECOVERY_LOCAL_ONLY":
		case "UNAUTHORIZED":
			return 403;
		case "INVALID_CREDENTIALS":
			return 401;
		case "LOGIN_THROTTLED":
			return 429;
		case "INVITATION_INVALID":
			return 404;
		case "USERNAME_TAKEN":
			return 409;
		case "REAUTHENTICATION_FAILED":
			return 401;
		default:
			return 400;
	}
}
