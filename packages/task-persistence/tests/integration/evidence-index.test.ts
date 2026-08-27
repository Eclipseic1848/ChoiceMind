import { createHash } from "node:crypto";

import type { PublicWebEvidenceV1 } from "@choicemind/contracts/decision/v1";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEvidenceIndexStore, type EvidenceIndexStore } from "../../src/index.js";

describe("EvidenceIndexStore integration", () => {
  let store: EvidenceIndexStore | undefined;

  beforeEach(async () => {
    store = await openEvidenceIndexStore({
      databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL")
    });
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
  });

  it("persists only Evidence metadata and retrieves nearest Evidence by vector", async () => {
    if (store === undefined) {
      throw new Error("EvidenceIndexStore 未初始化");
    }
    const memoryEvidence = evidence(
      "evidence-public-memory",
      "候选 A 提供 32 GB 内存",
      "a"
    );
    const priceEvidence = evidence(
      "evidence-public-price",
      "候选 A 公开标价为 7699 元",
      "b"
    );
    const foreignModelEvidence = evidence(
      "evidence-foreign-model",
      "不同模型的同维向量不得混排",
      "c"
    );

    await store.save(memoryEvidence, {
      model: "Qwen3-Embedding-4B",
      vector: [1, 0, 0]
    });
    await store.save(priceEvidence, {
      model: "Qwen3-Embedding-4B",
      vector: [0, 1, 0]
    });
    await store.save(foreignModelEvidence, {
      model: "Other-Embedding-4B",
      vector: [1, 0, 0]
    });

    const persisted = await store.get(memoryEvidence.evidenceId);
    expect(persisted).toMatchObject({
      evidenceId: memoryEvidence.evidenceId,
      decisionTaskId: memoryEvidence.decisionTaskId,
      locator: memoryEvidence.locator,
      source: memoryEvidence.source,
      excerptHash: memoryEvidence.excerptHash,
      parserVersion: memoryEvidence.parserVersion,
      rawArtifact: memoryEvidence.rawArtifact,
      embedding: { dimensions: 3, model: "Qwen3-Embedding-4B" }
    });
    expect(JSON.stringify(persisted)).not.toContain(memoryEvidence.excerpt);
    expect(
      (
        await store.nearest({
          limit: 3,
          model: "Qwen3-Embedding-4B",
          queryVector: [0.9, 0.1, 0]
        })
      ).map((item) => item.evidence.evidenceId)
    ).toEqual(["evidence-public-memory", "evidence-public-price"]);

    const client = new Client({
      connectionString: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL")
    });
    await client.connect();
    try {
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'evidence_index'`
      );
      expect(columns.rows.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining(["excerpt", "raw_bytes", "raw_body", "raw_content"])
      );
    } finally {
      await client.end();
    }
  });
});

function evidence(
  evidenceId: string,
  excerpt: string,
  rawDigestPrefix: "a" | "b" | "c"
): PublicWebEvidenceV1 {
  const rawDigest = rawDigestPrefix.repeat(64);
  return {
    contractType: "evidence",
    contractVersion: "1.0",
    evidenceId,
    decisionTaskId: "task-public-index",
    capturedAt: "2026-08-26T00:00:01.000Z",
    locator: { section: "body", field: "text" },
    excerpt,
    validUntil: "2026-09-26T00:00:01.000Z",
    synthetic: false,
    source: {
      sourceKind: "PUBLIC_WEB",
      sourceId: "source-public-index",
      title: "ChoiceMind 固定公开资料",
      url: "https://example.com/choicemind/p0-fixture"
    },
    excerptHash: {
      algorithm: "sha256",
      digest: createHash("sha256").update(excerpt, "utf8").digest("hex")
    },
    parserVersion: "choicemind-html-parser-1.0",
    rawArtifact: {
      algorithm: "sha256",
      digest: rawDigest,
      objectKey: `evidence-raw/sha256/${rawDigest}`
    }
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} 必须指向隔离的真实集成测试资源`);
  }
  return value;
}
