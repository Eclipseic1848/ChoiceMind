import { describe, expect, it } from "vitest";

import {
  createPersistentIdentityResolver,
  createSyntheticIdentityResolver
} from "./identity.js";

describe("createSyntheticIdentityResolver", () => {
  it("derives the principal from a server-owned opaque token map", async () => {
    const resolver = createSyntheticIdentityResolver({
      "opaque-user-a": {
        principalId: "principal-user-a",
        role: "USER",
        userId: "user-a"
      }
    });

    await expect(resolver.resolve("Bearer opaque-user-a")).resolves.toEqual({
      principalId: "principal-user-a",
      role: "USER",
      userId: "user-a"
    });
    await expect(resolver.resolve("Bearer unknown-token")).resolves.toBeUndefined();
    await expect(resolver.resolve("user-a:SUPERADMIN")).resolves.toBeUndefined();
  });
});

describe("createPersistentIdentityResolver", () => {
  it("derives the principal from an HttpOnly session cookie through Identity Access", async () => {
    const resolver = createPersistentIdentityResolver({
      async read(query) {
        return query.sessionToken === "opaque-user-a"
          ? {
              access: "FULL",
              authenticated: true,
              account: {
                accountId: "account-user-a",
                role: "USER",
                status: "ACTIVE",
                username: "用户A"
              },
              principal: {
                principalId: "account-user-a",
                role: "USER",
                userId: "account-user-a"
              }
            }
          : { authenticated: false };
      }
    });

    await expect(
      resolver.resolve(undefined, "theme=dark; choicemind_session=opaque-user-a")
    ).resolves.toEqual({
      principalId: "account-user-a",
      role: "USER",
      userId: "account-user-a"
    });
    await expect(
      resolver.resolve(undefined, "choicemind_session=account-user-a%3ASUPERADMIN")
    ).resolves.toBeUndefined();
  });

  it("does not authorize a restricted temporary-password session as a Principal", async () => {
    const resolver = createPersistentIdentityResolver({
      read: async () => ({
        access: "PASSWORD_CHANGE_REQUIRED" as const,
        account: {
          accountId: "account-user-a",
          role: "USER" as const,
          status: "ACTIVE" as const,
          username: "user-a"
        },
        authenticated: true as const,
        principal: {
          principalId: "account-user-a",
          role: "USER" as const,
          userId: "account-user-a"
        }
      })
    } as Parameters<typeof createPersistentIdentityResolver>[0]);

    await expect(resolver.resolve(undefined, "choicemind_session=temporary-token")).resolves.toBeUndefined();
  });
});
