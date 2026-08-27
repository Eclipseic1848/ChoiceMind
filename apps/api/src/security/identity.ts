import type {
  GetCurrentSessionQuery,
  GetCurrentSessionResult
} from "@choicemind/identity-access";

export type PrincipalRole = "USER" | "ADMIN" | "SUPERADMIN";

export type AuthenticatedPrincipal = Readonly<{
  principalId: string;
  role: PrincipalRole;
  userId: string;
}>;

export interface IdentityResolver {
  resolve(
    authorization: string | undefined,
    cookie?: string
  ): Promise<AuthenticatedPrincipal | undefined>;
}

export interface CurrentSessionReader {
  read(query: GetCurrentSessionQuery): Promise<GetCurrentSessionResult>;
}

export function createPersistentIdentityResolver(
  identityAccess: CurrentSessionReader
): IdentityResolver {
  return {
    async resolve(authorization, cookie) {
      const sessionToken = getSessionToken(authorization, cookie);

      if (sessionToken === undefined) {
        return undefined;
      }

      const result = await identityAccess.read({ type: "GET_CURRENT_SESSION", sessionToken });
      return result.authenticated && result.access === "FULL" ? result.principal : undefined;
    }
  };
}

export function createSyntheticIdentityResolver(
  principalsByToken: Readonly<Record<string, AuthenticatedPrincipal>>
): IdentityResolver {
  const principals = new Map(Object.entries(principalsByToken));

  return {
    async resolve(authorization) {
      if (authorization === undefined || !authorization.startsWith("Bearer ")) {
        return undefined;
      }

      const token = authorization.slice("Bearer ".length);

      if (token.length === 0 || token.trim() !== token) {
        return undefined;
      }

      return principals.get(token);
    }
  };
}

export function createSyntheticIdentityResolverFromJson(input: string): IdentityResolver {
  const decoded: unknown = JSON.parse(input);

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("synthetic identity 配置必须是不透明 token 到 Principal 的对象映射");
  }

  const principals: Record<string, AuthenticatedPrincipal> = {};

  for (const [token, value] of Object.entries(decoded)) {
    if (!isAuthenticatedPrincipal(value) || token.length === 0) {
      throw new Error("synthetic identity 配置包含无效 Principal");
    }

    principals[token] = value;
  }

  return createSyntheticIdentityResolver(principals);
}

function isAuthenticatedPrincipal(value: unknown): value is AuthenticatedPrincipal {
  return (
    typeof value === "object" &&
    value !== null &&
    "principalId" in value &&
    typeof value.principalId === "string" &&
    value.principalId.length > 0 &&
    "userId" in value &&
    typeof value.userId === "string" &&
    value.userId.length > 0 &&
    "role" in value &&
    (value.role === "USER" || value.role === "ADMIN" || value.role === "SUPERADMIN")
  );
}

function getSessionToken(
  authorization: string | undefined,
  cookie: string | undefined
): string | undefined {
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length);

    if (token.length > 0 && token.trim() === token) {
      return token;
    }
  }

  if (cookie === undefined) {
    return undefined;
  }

  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");

    if (separator < 0 || part.slice(0, separator).trim() !== "choicemind_session") {
      continue;
    }

    const value = part.slice(separator + 1).trim();
    return value.length === 0 ? undefined : decodeURIComponent(value);
  }

  return undefined;
}
