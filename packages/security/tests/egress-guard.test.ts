import { describe, expect, it } from "vitest";

import { createEgressGuard, type EgressRecord } from "../src/index.js";

describe("EgressGuard", () => {
  it("records minimal metadata before an allowed external call without body or secret", async () => {
    const records: EgressRecord[] = [];
    let calls = 0;
    const guard = createEgressGuard({
      appendRecord: async (record) => { records.push(record); },
      nextId: () => "egress-1",
      now: () => new Date("2026-08-24T00:20:00.000Z")
    });

    const result = await guard.execute({
      userId: "user-a",
      operationId: "operation-public-1",
      operation: "READ_PUBLIC_SOURCE",
      correlationId: "correlation-egress-1",
      destinationUrl: "https://example.com/private/path?token=private-secret",
      method: "GET",
      perform: async () => {
        calls += 1;
        return "external-response-body";
      }
    });

    expect(result).toEqual({ status: "COMPLETED", value: "external-response-body" });
    expect(calls).toBe(1);
    expect(records).toEqual([
      {
        egressId: "egress-1",
        userId: "user-a",
        operationId: "operation-public-1",
        correlationId: "correlation-egress-1",
        destinationOrigin: "https://example.com",
        method: "GET",
        policyVersion: "p0-v1",
        state: "STARTED",
        occurredAt: "2026-08-24T00:20:00.000Z"
      }
    ]);
    expect(JSON.stringify(records)).not.toContain("private-secret");
    expect(JSON.stringify(records)).not.toContain("external-response-body");
    expect(JSON.stringify(records)).not.toContain("/private/path");
  });

  it("does not call the external executor when policy requires confirmation", async () => {
    let calls = 0;
    const guard = createEgressGuard({
      appendRecord: async () => undefined,
      nextId: () => "egress-unused",
      now: () => new Date("2026-08-24T00:21:00.000Z")
    });

    const result = await guard.execute({
      userId: "user-a",
      operationId: "operation-private-1",
      operation: "READ_PRIVATE_SOURCE",
      correlationId: "correlation-egress-2",
      destinationUrl: "https://private.example.com/source",
      method: "GET",
      perform: async () => { calls += 1; }
    });

    expect(result).toEqual({ status: "REQUIRE_CONFIRMATION" });
    expect(calls).toBe(0);
  });

  it("denies a mutating HTTP method even when it is labelled as a read", async () => {
    let calls = 0;
    const guard = createEgressGuard({
      appendRecord: async () => undefined,
      nextId: () => "egress-unused",
      now: () => new Date("2026-08-24T00:22:00.000Z")
    });

    const result = await guard.execute({
      userId: "user-a",
      operationId: "operation-forged-read",
      operation: "READ_PUBLIC_SOURCE",
      correlationId: "correlation-egress-forged",
      destinationUrl: "https://example.com/change",
      method: "POST",
      perform: async () => { calls += 1; }
    });

    expect(result).toEqual({ status: "DENY" });
    expect(calls).toBe(0);
  });

  it("records an explicitly confirmed Provider POST before execution", async () => {
    const records: EgressRecord[] = [];
    const guard = createEgressGuard({
      appendRecord: async (record) => { records.push(record); },
      nextId: () => "egress-provider-1",
      now: () => new Date("2026-08-24T00:23:00.000Z")
    });

    const result = await guard.execute({
      userId: "user-a",
      operationId: "operation-provider-1",
      operation: "INVOKE_PROVIDER",
      confirmation: { operationId: "operation-provider-1", userId: "user-a" },
      correlationId: "correlation-provider-1",
      destinationUrl: "https://provider.example.com/v1/chat/completions?key=secret",
      method: "POST",
      perform: async () => "provider-result"
    });

    expect(result).toEqual({ status: "COMPLETED", value: "provider-result" });
    expect(records).toEqual([
      expect.objectContaining({
        destinationOrigin: "https://provider.example.com",
        method: "POST"
      })
    ]);
    expect(JSON.stringify(records)).not.toContain("chat/completions");
    expect(JSON.stringify(records)).not.toContain("secret");
  });
});
