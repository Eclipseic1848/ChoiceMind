import { describe, expect, it } from "vitest";

import { evaluateRiskPolicy } from "../src/index.js";

describe("RiskPolicy", () => {
  it.each([
    ["READ_PUBLIC_SOURCE", "ALLOW"],
    ["READ_PRIVATE_SOURCE", "REQUIRE_CONFIRMATION"],
    ["INVOKE_PROVIDER", "REQUIRE_CONFIRMATION"],
    ["WRITE_EXTERNAL", "DENY"]
  ] as const)("maps %s to %s", (operation, expected) => {
    expect(
      evaluateRiskPolicy({ operation, operationId: "operation-1", userId: "user-a" })
    ).toEqual({
      decision: expected,
      policyVersion: "p0-v1"
    });
  });

  it("allows a private-source read only after a bound user confirmation", () => {
    expect(
      evaluateRiskPolicy({
        operation: "READ_PRIVATE_SOURCE",
        operationId: "operation-private-1",
        userId: "user-a",
        confirmation: {
          operationId: "operation-private-1",
          userId: "user-a"
        }
      })
    ).toEqual({ decision: "ALLOW", policyVersion: "p0-v1" });
  });

  it("allows a Provider invocation only after a bound user confirmation", () => {
    expect(
      evaluateRiskPolicy({
        operation: "INVOKE_PROVIDER",
        operationId: "operation-provider-1",
        userId: "user-a",
        confirmation: {
          operationId: "operation-provider-1",
          userId: "user-a"
        }
      })
    ).toEqual({ decision: "ALLOW", policyVersion: "p0-v1" });
  });

  it("rejects a confirmation bound to another user or operation", () => {
    expect(
      evaluateRiskPolicy({
        operation: "READ_PRIVATE_SOURCE",
        operationId: "operation-private-1",
        userId: "user-a",
        confirmation: { operationId: "operation-other", userId: "user-a" }
      })
    ).toEqual({ decision: "REQUIRE_CONFIRMATION", policyVersion: "p0-v1" });
  });
});
