import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEgressGuard } from "@choicemind/security";
import type { PublicWebEvidenceV1 } from "@choicemind/contracts/decision/v1";
import { describe, expect, it } from "vitest";

import {
  createEvidenceIngestionService,
  createFileRawEvidenceObjectStore,
  createHttpDataSourceConnector,
  createLocalEvidenceRetrievalService,
  createPublicWebEvidenceGenerator,
  type DataSourceConnector
} from "./index.js";

describe("Evidence ingestion", () => {
  it("purges retained public-web bytes after their registered seven-day expiry", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "choicemind-evidence-retention-"));
    try {
      const store = createFileRawEvidenceObjectStore({ rootDirectory });
      const bytes = new TextEncoder().encode("ChoiceMind transient public fixture");
      const reference = await store.put(bytes, {
        expiresAt: "2026-09-06T12:00:00.000Z"
      });

      await expect(
        store.purgeExpired(new Date("2026-09-06T11:59:59.000Z"))
      ).resolves.toEqual({ deleted: 0 });
      await expect(store.read(reference)).resolves.toEqual(bytes);

      await expect(
        store.purgeExpired(new Date("2026-09-06T12:00:00.000Z"))
      ).resolves.toEqual({ deleted: 1 });
      await expect(store.read(reference)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("keeps deduplicated bytes until the latest registered collection expires", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "choicemind-evidence-retention-"));
    try {
      const store = createFileRawEvidenceObjectStore({ rootDirectory });
      const bytes = new TextEncoder().encode("ChoiceMind shared public fixture");
      const first = await store.put(bytes, {
        expiresAt: "2026-09-06T12:00:00.000Z"
      });
      const second = await store.put(bytes, {
        expiresAt: "2026-09-07T12:00:00.000Z"
      });

      expect(second).toEqual(first);
      await expect(
        store.purgeExpired(new Date("2026-09-06T12:00:00.000Z"))
      ).resolves.toEqual({ deleted: 0 });
      await expect(store.read(first)).resolves.toEqual(bytes);
      await expect(
        store.purgeExpired(new Date("2026-09-07T12:00:00.000Z"))
      ).resolves.toEqual({ deleted: 1 });
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("并发登记同一原始对象不会缩短最新留存期限", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "choicemind-evidence-concurrent-"));
    try {
      const store = createFileRawEvidenceObjectStore({ rootDirectory });
      const bytes = new TextEncoder().encode("并发保存的合成公开网页");
      const latest = Date.parse("2026-09-07T12:00:00.000Z");
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
        store.put(bytes, { expiresAt: new Date(latest - index * 1_000).toISOString() })
      ));
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const first = results[0];
      if (first?.status !== "fulfilled") throw new Error("并发保存失败");
      await expect(store.purgeExpired(new Date(latest - 1))).resolves.toEqual({ deleted: 0 });
      await expect(store.read(first.value)).resolves.toEqual(bytes);
      await expect(store.purgeExpired(new Date(latest))).resolves.toEqual({ deleted: 1 });
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("replaces retention metadata atomically without mutating the previous file", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "choicemind-evidence-retention-"));
    try {
      const store = createFileRawEvidenceObjectStore({ rootDirectory });
      const bytes = new TextEncoder().encode("ChoiceMind atomic retention fixture");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const retentionPath = join(
        rootDirectory,
        "evidence-raw",
        "sha256",
        `${digest}.retention.json`
      );
      const previousFile = join(rootDirectory, "previous-retention.json");

      await store.put(bytes, { expiresAt: "2026-09-06T12:00:00.000Z" });
      await link(retentionPath, previousFile);
      await store.put(bytes, { expiresAt: "2026-09-07T12:00:00.000Z" });

      await expect(readFile(previousFile, "utf8")).resolves.toBe(
        '{"expiresAt":"2026-09-06T12:00:00.000Z"}\n'
      );
      await expect(
        store.purgeExpired(new Date("2026-09-06T12:00:00.000Z"))
      ).resolves.toEqual({ deleted: 0 });
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("purges valid expired objects before reporting damaged retention metadata", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "choicemind-evidence-retention-"));
    try {
      const directory = join(rootDirectory, "evidence-raw", "sha256");
      const damagedDigest = "0".repeat(64);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, damagedDigest), "damaged retention fixture", "utf8");
      await writeFile(join(directory, `${damagedDigest}.retention.json`), "{", "utf8");

      const store = createFileRawEvidenceObjectStore({ rootDirectory });
      const expired = await store.put(
        new TextEncoder().encode("ChoiceMind expired public fixture"),
        { expiresAt: "2026-09-06T12:00:00.000Z" }
      );

      await expect(
        store.purgeExpired(new Date("2026-09-06T12:00:00.000Z"))
      ).rejects.toThrow("原始 Evidence 生命周期元数据无效");
      await expect(store.read(expired)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(directory, damagedDigest), "utf8")).resolves.toBe(
        "damaged retention fixture"
      );
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("purges an orphan raw object after seven days even when no retention file survived", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "choicemind-evidence-orphan-"));
    try {
      const store = createFileRawEvidenceObjectStore({ rootDirectory });
      const bytes = new TextEncoder().encode("ChoiceMind orphan public fixture");
      const reference = await store.put(bytes);

      await expect(store.purgeExpired(new Date("2100-01-01T00:00:00.000Z"))).resolves.toEqual({
        deleted: 1
      });
      await expect(store.read(reference)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("indexes with local Embedding and reranks pgvector candidates with local Reranker", async () => {
    const indexed: Array<{ evidenceId: string; model: string; vector: readonly number[] }> = [];
    const embeddingRequests: unknown[] = [];
    const rerankerRequests: unknown[] = [];
    let embeddingSequence = 0;
    const service = createLocalEvidenceRetrievalService({
      embed: async (request) => {
        embeddingRequests.push(request);
        const vector = request.input.texts[0] === "哪个候选内存更大？"
          ? [0.9, 0.1]
          : [1, 0];
        return {
          contractType: "local-service-result",
          contractVersion: "1.0",
          requestId: request.requestId,
          port: "EMBEDDING_PROVIDER",
          ok: true,
          output: {
            model: "Qwen3-Embedding-4B",
            dimensions: 2,
            vectors: [vector]
          }
        };
      },
      indexStore: {
        async save(evidence, embedding) {
          indexed.push({
            evidenceId: evidence.evidenceId,
            model: embedding.model,
            vector: embedding.vector
          });
        },
        async nearest(input) {
          expect(input).toEqual({
            limit: 4,
            model: "Qwen3-Embedding-4B",
            queryVector: [0.9, 0.1]
          });
          return [
            { distance: 0.01, evidence: { evidenceId: "evidence-memory" } },
            { distance: 0.2, evidence: { evidenceId: "evidence-price" } }
          ];
        }
      },
      loadExcerpt: async (evidenceId) =>
        evidenceId === "evidence-memory"
          ? "候选 A 提供 32 GB 内存"
          : "候选 A 公开标价为 7699 元",
      nextEmbeddingRequestId: () => `embedding-${++embeddingSequence}`,
      nextRerankerRequestId: () => "reranker-1",
      rerank: async (request) => {
        rerankerRequests.push(request);
        return {
          contractType: "local-service-result",
          contractVersion: "1.0",
          requestId: request.requestId,
          port: "RERANKER",
          ok: true,
          output: {
            model: "Qwen3-Reranker-8B",
            rankings: [
              { documentId: "evidence-memory", score: 0.95 },
              { documentId: "evidence-price", score: 0.15 }
            ]
          }
        };
      }
    });

    expect(await service.index(publicEvidence("evidence-memory", "候选 A 提供 32 GB 内存"))).toEqual({
      status: "INDEXED",
      evidenceId: "evidence-memory"
    });
    expect(indexed).toEqual([
      {
        evidenceId: "evidence-memory",
        model: "Qwen3-Embedding-4B",
        vector: [1, 0]
      }
    ]);

    expect(await service.search({ query: "哪个候选内存更大？", topK: 2 })).toEqual({
      status: "RETRIEVED",
      results: [
        { evidenceId: "evidence-memory", score: 0.95 },
        { evidenceId: "evidence-price", score: 0.15 }
      ]
    });
    expect(embeddingRequests).toHaveLength(2);
    expect(rerankerRequests).toEqual([
      {
        contractType: "local-service-request",
        contractVersion: "1.0",
        requestId: "reranker-1",
        port: "RERANKER",
        input: {
          query: "哪个候选内存更大？",
          documents: [
            { documentId: "evidence-memory", text: "候选 A 提供 32 GB 内存" },
            { documentId: "evidence-price", text: "候选 A 公开标价为 7699 元" }
          ],
          topK: 2
        }
      }
    ]);
  });

  it("parses a stored HTML artifact into locatable public-web Evidence", async () => {
    const rawBytes = new TextEncoder().encode(
      '<main>候选 A 提供 32 GB 内存</main><form><input type="password"></form>'
    );
    const rawDigest = createHash("sha256").update(rawBytes).digest("hex");
    const excerpt = "候选 A 提供 32 GB 内存";
    const excerptDigest = createHash("sha256").update(excerpt, "utf8").digest("hex");
    const controller = new AbortController();
    const generator = createPublicWebEvidenceGenerator({
      nextEvidenceId: () => "evidence-public-a-memory",
      nextGapId: () => "gap-unused",
      nextParserRequestId: () => "parse-public-a-memory",
      objectStore: {
        async put() {
          throw new Error("生成 Evidence 时不得重新写原始对象");
        },
        async read(_reference, signal) {
          expect(signal).toBe(controller.signal);
          return rawBytes;
        }
      },
      parse: async (request, signal) => {
        expect(signal).toBe(controller.signal);
        expect(request).toEqual({
          contractType: "local-service-request",
          contractVersion: "1.0",
          requestId: "parse-public-a-memory",
          port: "DOCUMENT_PARSER",
          input: {
            document: {
              mediaType: "text/html",
              dataBase64: Buffer.from(rawBytes).toString("base64")
            }
          }
        });
        return {
          contractType: "local-service-result",
          contractVersion: "1.0",
          requestId: request.requestId,
          port: "DOCUMENT_PARSER",
          ok: true,
          output: {
            parser: "choicemind-html-parser-1.0",
            text: excerpt,
            pageCount: 1
          }
        };
      }
    });

    const result = await generator.generate({
      collection: {
        ok: true,
        sourceFacts: {
          capturedAt: "2026-08-26T00:00:01.000Z",
          collectorVersion: "http-connector@1",
          mediaType: "text/html",
          sourceId: "source-public-a",
          title: "ChoiceMind 固定公开资料",
          url: "https://example.com/choicemind/p0-fixture"
        },
        rawArtifact: {
          algorithm: "sha256",
          digest: rawDigest,
          objectKey: `evidence-raw/sha256/${rawDigest}`
        },
        metrics: { bytesFetched: rawBytes.byteLength, durationMs: 11 }
      },
      decisionTaskId: "task-public-a",
      signal: controller.signal,
      validUntil: "2026-09-26T00:00:01.000Z"
    });

    expect(result).toEqual({
      status: "EVIDENCE_CREATED",
      documentSignals: {
        hasAccessForm: true,
        hasMainContent: true,
        hasTitle: false
      },
      evidence: {
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-public-a-memory",
        decisionTaskId: "task-public-a",
        capturedAt: "2026-08-26T00:00:01.000Z",
        locator: { section: "body", field: "text" },
        excerpt,
        validUntil: "2026-09-26T00:00:01.000Z",
        synthetic: false,
        source: {
          sourceKind: "PUBLIC_WEB",
          sourceId: "source-public-a",
          title: "ChoiceMind 固定公开资料",
          url: "https://example.com/choicemind/p0-fixture"
        },
        excerptHash: { algorithm: "sha256", digest: excerptDigest },
        parserVersion: "http-connector@1 + choicemind-html-parser-1.0",
        rawArtifact: {
          algorithm: "sha256",
          digest: rawDigest,
          objectKey: `evidence-raw/sha256/${rawDigest}`
        }
      }
    });
  });

  it("turns a local parser timeout into an Evidence Gap without fabricated Evidence", async () => {
    const rawBytes = new TextEncoder().encode("<main>未解析正文</main>");
    const rawDigest = createHash("sha256").update(rawBytes).digest("hex");
    const generator = createPublicWebEvidenceGenerator({
      nextEvidenceId: () => {
        throw new Error("解析失败时不得生成 Evidence ID");
      },
      nextGapId: () => "gap-parser-timeout",
      nextParserRequestId: () => "parse-timeout",
      objectStore: {
        async put() {
          throw new Error("解析阶段不得写原始对象");
        },
        async read() {
          return rawBytes;
        }
      },
      parse: async (request) => ({
        contractType: "local-service-result",
        contractVersion: "1.0",
        requestId: request.requestId,
        port: "DOCUMENT_PARSER",
        ok: false,
        error: {
          code: "TIMEOUT",
          category: "TRANSPORT",
          message: "本地解析超时",
          retryable: true
        }
      })
    });

    const result = await generator.generate({
      collection: {
        ok: true,
        sourceFacts: {
          capturedAt: "2026-08-26T00:00:01.000Z",
          mediaType: "text/html",
          sourceId: "source-parser-timeout",
          title: "Parser timeout fixture",
          url: "https://example.com/choicemind/p0-fixture"
        },
        rawArtifact: {
          algorithm: "sha256",
          digest: rawDigest,
          objectKey: `evidence-raw/sha256/${rawDigest}`
        },
        metrics: { bytesFetched: rawBytes.byteLength, durationMs: 11 }
      },
      decisionTaskId: "task-parser-timeout",
      validUntil: "2026-09-26T00:00:01.000Z"
    });

    expect(result).toEqual({
      status: "EVIDENCE_GAP",
      gap: {
        code: "SOURCE_PARSE_FAILED",
        decisionTaskId: "task-parser-timeout",
        gapId: "gap-parser-timeout",
        retryable: true
      }
    });
    expect(JSON.stringify(result)).not.toContain("evidence");
    expect(JSON.stringify(result)).not.toContain("未解析正文");
  });

  it("stores raw bytes by SHA-256 and verifies them through the public read seam", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "choicemind-evidence-"));
    try {
      const store = createFileRawEvidenceObjectStore({ rootDirectory });
      const bytes = new TextEncoder().encode("ChoiceMind fixed public fixture");
      const digest = createHash("sha256").update(bytes).digest("hex");

      const reference = await store.put(bytes);

      expect(reference).toEqual({
        algorithm: "sha256",
        digest,
        objectKey: `evidence-raw/sha256/${digest}`
      });
      expect(await store.read(reference)).toEqual(bytes);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a redirect before inspecting MIME or reading the body", async () => {
    let bodyReadCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => {
          bodyReadCount += 1;
          return new ArrayBuffer(0);
        },
        headers: new Headers({ location: "https://unapproved.example/private" }),
        ok: false,
        status: 302,
        url: "https://example.com/choicemind/p0-fixture"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          throw new Error("重定向拒绝前不得写对象存储");
        }
      },
      readDurationMs: () => 5
    });

    const result = await connector.collect({
      policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      sourceId: "source-redirect-rejected",
      title: "Redirect rejected fixture",
      url: "https://example.com/choicemind/p0-fixture"
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_REDIRECT_REJECTED", retryable: false },
      metrics: { bytesFetched: 0, durationMs: 5 }
    });
    expect(bodyReadCount).toBe(0);
  });

  it("returns a retryable structured error for an HTTP 503 before reading the body", async () => {
    let bodyReadCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => {
          bodyReadCount += 1;
          return new ArrayBuffer(0);
        },
        headers: new Headers(),
        ok: false,
        status: 503,
        url: "https://example.com/choicemind/p0-fixture"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          throw new Error("HTTP 失败时不得写对象存储");
        }
      },
      readDurationMs: () => 6
    });

    const result = await connector.collect({
      policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      sourceId: "source-fetch-failed",
      title: "Fetch failed fixture",
      url: "https://example.com/choicemind/p0-fixture"
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_FETCH_FAILED", retryable: true },
      metrics: { bytesFetched: 0, durationMs: 6 }
    });
    expect(bodyReadCount).toBe(0);
  });

  it("turns a network exception into a retryable structured error", async () => {
    const connector = createHttpDataSourceConnector({
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          throw new Error("网络失败时不得写对象存储");
        }
      },
      readDurationMs: () => 8
    });

    const result = await connector.collect({
      policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      sourceId: "source-network-failed",
      title: "Network failed fixture",
      url: "https://example.com/choicemind/p0-fixture"
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_FETCH_FAILED", retryable: true },
      metrics: { bytesFetched: 0, durationMs: 8 }
    });
  });

  it("rejects response MIME before reading the body or writing object storage", async () => {
    let bodyReadCount = 0;
    let objectWriteCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => {
          bodyReadCount += 1;
          return new ArrayBuffer(0);
        },
        headers: new Headers({ "content-type": "image/png" }),
        ok: true,
        status: 200,
        url: "https://example.com/choicemind/p0-fixture"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          objectWriteCount += 1;
          throw new Error("MIME 拒绝前不得写对象存储");
        }
      },
      readDurationMs: () => 7
    });

    const result = await connector.collect({
      policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      sourceId: "source-mime-rejected",
      title: "MIME rejected fixture",
      url: "https://example.com/choicemind/p0-fixture"
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_MIME_REJECTED", retryable: false },
      metrics: { bytesFetched: 0, durationMs: 7 }
    });
    expect(bodyReadCount).toBe(0);
    expect(objectWriteCount).toBe(0);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    let bodyReadCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => {
          bodyReadCount += 1;
          return new ArrayBuffer(0);
        },
        headers: new Headers({
          "content-length": "1048577",
          "content-type": "text/html"
        }),
        ok: true,
        status: 200,
        url: "https://example.com/choicemind/p0-fixture"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          throw new Error("大小拒绝前不得写对象存储");
        }
      },
      readDurationMs: () => 9
    });

    const result = await connector.collect({
      policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      sourceId: "source-size-rejected",
      title: "Oversized fixture",
      url: "https://example.com/choicemind/p0-fixture"
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
      metrics: { bytesFetched: 0, durationMs: 9 }
    });
    expect(bodyReadCount).toBe(0);
  });

  it("stores an allowed HTML body and returns only source facts and its artifact reference", async () => {
    const body = new TextEncoder().encode("<main>ChoiceMind fixture</main>");
    let storedBytes: Uint8Array | undefined;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => body.buffer,
        headers: new Headers({
          "content-length": String(body.byteLength),
          "content-type": "text/html; charset=utf-8"
        }),
        ok: true,
        status: 200,
        url: "https://example.com/choicemind/p0-fixture"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put(bytes) {
          storedBytes = bytes;
          return {
            algorithm: "sha256",
            digest: "b".repeat(64),
            objectKey: `evidence-raw/sha256/${"b".repeat(64)}`
          };
        }
      },
      readDurationMs: () => 11
    });

    const result = await connector.collect({
      policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      sourceId: "source-collected",
      title: "Collected fixture",
      url: "https://example.com/choicemind/p0-fixture"
    });

    expect(storedBytes).toEqual(body);
    expect(result).toEqual({
      ok: true,
      sourceFacts: {
        capturedAt: "2026-08-26T00:00:01.000Z",
        mediaType: "text/html",
        sourceId: "source-collected",
        title: "Collected fixture",
        url: "https://example.com/choicemind/p0-fixture"
      },
      rawArtifact: {
        algorithm: "sha256",
        digest: "b".repeat(64),
        objectKey: `evidence-raw/sha256/${"b".repeat(64)}`
      },
      metrics: { bytesFetched: body.byteLength, durationMs: 11 }
    });
    expect(JSON.stringify(result)).not.toContain("ChoiceMind fixture");
  });

  it("rejects an oversized body before writing object storage when Content-Length is absent", async () => {
    let objectWriteCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        headers: new Headers({ "content-type": "text/html" }),
        ok: true,
        status: 200,
        url: "https://example.com/choicemind/p0-fixture"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          objectWriteCount += 1;
          throw new Error("正文超限时不得写对象存储");
        }
      },
      readDurationMs: () => 13
    });

    const result = await connector.collect({
      policy: { allowedMediaTypes: ["text/html"], maxBytes: 2 },
      sourceId: "source-body-size-rejected",
      title: "Body size rejected fixture",
      url: "https://example.com/choicemind/p0-fixture"
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
      metrics: { bytesFetched: 3, durationMs: 13 }
    });
    expect(objectWriteCount).toBe(0);
  });

  it("records approved HTTPS egress before returning connector facts and artifact reference", async () => {
    const sequence: string[] = [];
    const connector: DataSourceConnector = {
      async collect() {
        sequence.push("collect");
        return {
          ok: true,
          sourceFacts: {
            capturedAt: "2026-08-26T00:00:01.000Z",
            mediaType: "text/html",
            sourceId: "source-public-fixture",
            title: "ChoiceMind P0 public fixture",
            url: "https://example.com/choicemind/p0-fixture"
          },
          rawArtifact: {
            algorithm: "sha256",
            digest: "b".repeat(64),
            objectKey: `evidence-raw/sha256/${"b".repeat(64)}`
          },
          metrics: { bytesFetched: 512, durationMs: 12 }
        };
      }
    };
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/choicemind/p0-fixture"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector,
      egressGuard: createEgressGuard({
        appendRecord() {
          sequence.push("egress");
          return Promise.resolve();
        },
        nextId: () => "egress-public-fixture",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-unused",
      resolveHost: async () => ["93.184.216.34"]
    });

    const result = await service.ingest({
      correlationId: "correlation-public-fixture",
      decisionTaskId: "task-public-fixture",
      operationId: "collect-public-fixture",
      source: {
        sourceId: "source-public-fixture",
        title: "ChoiceMind P0 public fixture",
        url: "https://example.com/choicemind/p0-fixture"
      },
      userId: "user-public-fixture"
    });

    expect(sequence).toEqual(["egress", "collect"]);
    expect(result).toEqual({
      status: "COLLECTED",
      collection: {
        ok: true,
        sourceFacts: {
          capturedAt: "2026-08-26T00:00:01.000Z",
          mediaType: "text/html",
          sourceId: "source-public-fixture",
          title: "ChoiceMind P0 public fixture",
          url: "https://example.com/choicemind/p0-fixture"
        },
        rawArtifact: {
          algorithm: "sha256",
          digest: "b".repeat(64),
          objectKey: `evidence-raw/sha256/${"b".repeat(64)}`
        },
        metrics: { bytesFetched: 512, durationMs: 12 }
      }
    });
  });

  it("passes immutable MIME and byte limits to the connector before collection", async () => {
    let receivedPolicy: unknown;
    const connector: DataSourceConnector = {
      async collect(input) {
        receivedPolicy = (input as { policy?: unknown }).policy;
        return {
          ok: false,
          error: { code: "SOURCE_MIME_REJECTED", retryable: false },
          metrics: { bytesFetched: 0, durationMs: 1 }
        };
      }
    };
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/choicemind/p0-fixture"]),
      collectionPolicy: {
        allowedMediaTypes: ["text/html"],
        maxBytes: 1_048_576
      },
      connector,
      egressGuard: createEgressGuard({
        appendRecord: () => Promise.resolve(),
        nextId: () => "egress-policy",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-policy",
      resolveHost: async () => ["93.184.216.34"]
    });

    await service.ingest({
      correlationId: "correlation-policy",
      decisionTaskId: "task-policy",
      operationId: "collect-policy",
      source: {
        sourceId: "source-policy",
        title: "Policy fixture",
        url: "https://example.com/choicemind/p0-fixture"
      },
      userId: "user-policy"
    });

    expect(receivedPolicy).toEqual({
      allowedMediaTypes: ["text/html"],
      maxBytes: 1_048_576
    });
  });

  it("turns a rejected MIME into an Evidence Gap instead of collected Evidence", async () => {
    const connector: DataSourceConnector = {
      async collect() {
        return {
          ok: false,
          error: { code: "SOURCE_MIME_REJECTED", retryable: false },
          metrics: { bytesFetched: 0, durationMs: 3 }
        };
      }
    };
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/choicemind/p0-fixture"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector,
      egressGuard: createEgressGuard({
        appendRecord: () => Promise.resolve(),
        nextId: () => "egress-mime",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-mime",
      resolveHost: async () => ["93.184.216.34"]
    });

    const result = await service.ingest({
      correlationId: "correlation-mime",
      decisionTaskId: "task-mime",
      operationId: "collect-mime",
      source: {
        sourceId: "source-mime",
        title: "Rejected MIME fixture",
        url: "https://example.com/choicemind/p0-fixture"
      },
      userId: "user-mime"
    });

    expect(result).toEqual({
      status: "EVIDENCE_GAP",
      gap: {
        code: "SOURCE_MIME_REJECTED",
        decisionTaskId: "task-mime",
        gapId: "gap-mime",
        metrics: { bytesFetched: 0, durationMs: 3 },
        retryable: false,
        sourceId: "source-mime"
      }
    });
  });

  it("rejects an approved loopback URL before egress recording or source collection", async () => {
    let collectionCount = 0;
    const egressRecords: unknown[] = [];
    const connector: DataSourceConnector = {
      async collect() {
        collectionCount += 1;
        throw new Error("SSRF 拒绝前不得调用 Connector");
      }
    };
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://127.0.0.1/private"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector,
      egressGuard: createEgressGuard({
        appendRecord(record) {
          egressRecords.push(record);
          return Promise.resolve();
        },
        nextId: () => "egress-p0-11",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-p0-11",
      resolveHost: async () => {
        throw new Error("字面量回环地址不得进入 DNS 解析");
      }
    });

    const result = await service.ingest({
      correlationId: "correlation-p0-11",
      decisionTaskId: "task-p0-11",
      operationId: "collect-p0-11",
      source: {
        sourceId: "source-loopback",
        title: "Loopback source",
        url: "https://127.0.0.1/private"
      },
      userId: "user-p0-11"
    });

    expect(result).toEqual({
      status: "EVIDENCE_GAP",
      gap: {
        code: "SOURCE_SSRF_BLOCKED",
        decisionTaskId: "task-p0-11",
        gapId: "gap-p0-11",
        retryable: false,
        sourceId: "source-loopback"
      }
    });
    expect(collectionCount).toBe(0);
    expect(egressRecords).toEqual([]);
  });

  it("rejects an approved hostname that resolves to a private address before egress", async () => {
    let collectionCount = 0;
    const egressRecords: unknown[] = [];
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://approved.example/private"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector: {
        async collect() {
          collectionCount += 1;
          throw new Error("DNS SSRF 拒绝前不得调用 Connector");
        }
      },
      egressGuard: createEgressGuard({
        appendRecord(record) {
          egressRecords.push(record);
          return Promise.resolve();
        },
        nextId: () => "egress-dns-ssrf",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-dns-ssrf",
      resolveHost: async () => ["10.0.0.8"]
    });

    const result = await service.ingest({
      correlationId: "correlation-dns-ssrf",
      decisionTaskId: "task-dns-ssrf",
      operationId: "collect-dns-ssrf",
      source: {
        sourceId: "source-dns-ssrf",
        title: "DNS SSRF fixture",
        url: "https://approved.example/private"
      },
      userId: "user-dns-ssrf"
    });

    expect(result).toEqual({
      status: "EVIDENCE_GAP",
      gap: {
        code: "SOURCE_SSRF_BLOCKED",
        decisionTaskId: "task-dns-ssrf",
        gapId: "gap-dns-ssrf",
        retryable: false,
        sourceId: "source-dns-ssrf"
      }
    });
    expect(collectionCount).toBe(0);
    expect(egressRecords).toEqual([]);
  });

  it("returns an Evidence Gap for an unapproved URL without DNS, egress, or collection", async () => {
    let sideEffectCount = 0;
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/approved"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector: {
        async collect() {
          sideEffectCount += 1;
          throw new Error("未批准 URL 不得调用 Connector");
        }
      },
      egressGuard: createEgressGuard({
        appendRecord() {
          sideEffectCount += 1;
          return Promise.resolve();
        },
        nextId: () => "egress-unapproved",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-unapproved",
      resolveHost: async () => {
        sideEffectCount += 1;
        return ["93.184.216.34"];
      }
    });

    const result = await service.ingest({
      correlationId: "correlation-unapproved",
      decisionTaskId: "task-unapproved",
      operationId: "collect-unapproved",
      source: {
        sourceId: "source-unapproved",
        title: "Unapproved fixture",
        url: "https://example.com/not-approved"
      },
      userId: "user-unapproved"
    });

    expect(result).toEqual({
      status: "EVIDENCE_GAP",
      gap: {
        code: "SOURCE_NOT_APPROVED",
        decisionTaskId: "task-unapproved",
        gapId: "gap-unapproved",
        retryable: false,
        sourceId: "source-unapproved"
      }
    });
    expect(sideEffectCount).toBe(0);
  });

  it("rejects an approved non-HTTPS URL before DNS, egress, or collection", async () => {
    let sideEffectCount = 0;
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["http://example.com/approved"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector: {
        async collect() {
          sideEffectCount += 1;
          throw new Error("非 HTTPS URL 不得调用 Connector");
        }
      },
      egressGuard: createEgressGuard({
        appendRecord() {
          sideEffectCount += 1;
          return Promise.resolve();
        },
        nextId: () => "egress-http-rejected",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-http-rejected",
      resolveHost: async () => {
        sideEffectCount += 1;
        return ["93.184.216.34"];
      }
    });

    const result = await service.ingest({
      correlationId: "correlation-http-rejected",
      decisionTaskId: "task-http-rejected",
      operationId: "collect-http-rejected",
      source: {
        sourceId: "source-http-rejected",
        title: "HTTP rejected fixture",
        url: "http://example.com/approved"
      },
      userId: "user-http-rejected"
    });

    expect(result).toEqual({
      status: "EVIDENCE_GAP",
      gap: {
        code: "SOURCE_SCHEME_REJECTED",
        decisionTaskId: "task-http-rejected",
        gapId: "gap-http-rejected",
        retryable: false,
        sourceId: "source-http-rejected"
      }
    });
    expect(sideEffectCount).toBe(0);
  });

  it("turns DNS resolution failure into a retryable Evidence Gap before egress", async () => {
    let sideEffectCount = 0;
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://dns-failure.example/source"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector: {
        async collect() {
          sideEffectCount += 1;
          throw new Error("DNS 失败后不得调用 Connector");
        }
      },
      egressGuard: createEgressGuard({
        appendRecord() {
          sideEffectCount += 1;
          return Promise.resolve();
        },
        nextId: () => "egress-dns-failure",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-dns-failure",
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      }
    });

    const result = await service.ingest({
      correlationId: "correlation-dns-failure",
      decisionTaskId: "task-dns-failure",
      operationId: "collect-dns-failure",
      source: {
        sourceId: "source-dns-failure",
        title: "DNS failure fixture",
        url: "https://dns-failure.example/source"
      },
      userId: "user-dns-failure"
    });

    expect(result).toEqual({
      status: "EVIDENCE_GAP",
      gap: {
        code: "SOURCE_DNS_FAILED",
        decisionTaskId: "task-dns-failure",
        gapId: "gap-dns-failure",
        retryable: true,
        sourceId: "source-dns-failure"
      }
    });
    expect(sideEffectCount).toBe(0);
  });
});

function publicEvidence(evidenceId: string, excerpt: string): PublicWebEvidenceV1 {
  const rawDigest = "c".repeat(64);
  return {
    contractType: "evidence",
    contractVersion: "1.0",
    evidenceId,
    decisionTaskId: "task-local-retrieval",
    capturedAt: "2026-08-26T00:00:01.000Z",
    locator: { section: "body", field: "text" },
    excerpt,
    validUntil: "2026-09-26T00:00:01.000Z",
    synthetic: false,
    source: {
      sourceKind: "PUBLIC_WEB",
      sourceId: "source-local-retrieval",
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
