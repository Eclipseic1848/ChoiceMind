import { describe, expect, it } from "vitest";

import { createSyntheticIdentityResolver } from "./identity.js";

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
