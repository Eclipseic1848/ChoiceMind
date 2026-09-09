import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isPublicWebResearchContinuationV1,
  openPostgresSourceResearch,
  type CreateSourceResearchBatchCommand,
  type PublicWebResearchContinuationV1,
  type SourceResearch
} from "../../src/index.js";

const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
const openModules: SourceResearch[] = [];

beforeEach(async () => {
  const module = await openPostgresSourceResearch({ databaseUrl });
  await module.close();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "TRUNCATE source_research_results, source_research_outbox, source_research_jobs, source_research_batches CASCADE"
    );
  } finally {
    await client.end();
  }
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("Public Web Research Continuation", () => {
  it("持久化安全续批并纳入幂等指纹", async () => {
    const module = await openPostgresSourceResearch({ databaseUrl });
    openModules.push(module);
    const continuation = validContinuation();
    const command = {
      type: "CREATE_BATCH" as const,
      batchId: randomUUID(),
      ownerUserId: "user-continuation",
      decisionTaskId: "task-continuation",
      idempotencyKey: randomUUID(),
      query: "继续核验 USB-C 供电能力",
      target: {
        subject: { kind: "CANDIDATE", value: "candidate-a" },
        claimTargets: [{ claimId: "claim-a", statement: "支持 90W USB-C 供电" }]
      },
      sources: [{
        sourceId: "brand-official",
        sourceAccountId: "public",
        accessMode: "PUBLIC" as const,
        continuation
      }]
    } satisfies CreateSourceResearchBatchCommand;
    const source = command.sources[0];
    if (source === undefined) throw new Error("测试来源缺失");

    await expect(module.execute(command)).resolves.toMatchObject({
      batchId: command.batchId,
      jobs: [{ continuation }]
    });
    await expect(module.execute(command)).resolves.toMatchObject({
      batchId: command.batchId,
      jobs: [{ continuation }]
    });
    await expect(module.execute({
      ...command,
      sources: [{
        ...source,
        continuation: {
          contractVersion: continuation.contractVersion,
          deepReadUrls: continuation.deepReadUrls,
          contractType: continuation.contractType,
          searchUrls: continuation.searchUrls
        }
      }]
    })).resolves.toMatchObject({ batchId: command.batchId });
    const conflictingCommand = {
      ...command,
      sources: [{
        ...source,
        continuation: {
          ...continuation,
          searchUrls: ["https://example.com/products?page=3"]
        }
      }]
    } satisfies CreateSourceResearchBatchCommand;
    await expect(module.execute(conflictingCommand)).rejects.toThrow(
      "SOURCE_RESEARCH_IDEMPOTENCY_CONFLICT"
    );
    const claimed = await module.claimNext("worker-continuation", 30_000);
    expect(claimed).toMatchObject({
      status: "CLAIMED",
      checkpoint: { searched: 0, deepRead: 0, hasMore: true, continuation }
    });
    if (claimed.status !== "CLAIMED") throw new Error("续批作业未领取");
    await module.complete(claimed, {
      type: "EVIDENCE_BATCH",
      items: [{
        resultKey: "brand:model-a",
        evidenceId: "evidence-model-a",
        summary: "合成公开证据",
        material: { excerpt: "支持 90W USB-C 供电" }
      }],
      costUnits: 0,
      checkpoint: { searched: 2, deepRead: 1, hasMore: true, continuation }
    });
    await expect(module.read({
      type: "GET_BATCH",
      batchId: command.batchId,
      ownerUserId: command.ownerUserId
    })).resolves.toMatchObject({
      state: "COMPLETED",
      jobs: [{ continuation }]
    });
    const credentialCommand = {
      ...command,
      batchId: randomUUID(),
      idempotencyKey: randomUUID(),
      sources: [{ ...source, accessMode: "CREDENTIAL" as const }]
    } satisfies CreateSourceResearchBatchCommand;
    await expect(module.execute(credentialCommand)).rejects.toThrow(
      "SOURCE_RESEARCH_BATCH_INVALID"
    );
  });

  it.each([
    ["空续批", { ...validContinuation(), searchUrls: [], deepReadUrls: [] }],
    ["HTTP", { ...validContinuation(), searchUrls: ["http://example.com/page"] }],
    ["凭据", { ...validContinuation(), searchUrls: ["https://user:secret@example.com/page"] }],
    ["片段", { ...validContinuation(), searchUrls: ["https://example.com/page#secret"] }],
    ["非规范 URL", { ...validContinuation(), searchUrls: ["https://example.com:443/page"] }],
    ["重复 URL", { ...validContinuation(), deepReadUrls: ["https://example.com/products?page=2"] }],
    ["超过上限", {
      ...validContinuation(),
      searchUrls: Array.from({ length: 21 }, (_, index) => `https://example.com/page/${index}`),
      deepReadUrls: []
    }],
    ["额外字段", { ...validContinuation(), secret: "not-allowed" }]
  ])("拒绝%s", (_label, continuation) => {
    expect(isPublicWebResearchContinuationV1(continuation)).toBe(false);
  });
});

function validContinuation(): PublicWebResearchContinuationV1 {
  return {
    contractType: "public-web-research-continuation",
    contractVersion: "1.0",
    searchUrls: ["https://example.com/products?page=2"],
    deepReadUrls: ["https://example.com/products/model-a"]
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`测试环境缺少 ${name}`);
  }
  return value;
}
