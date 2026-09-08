import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

import type { EgressGuard } from "@choicemind/security";
import {
  decodeLocalServiceResultV1,
  type DocumentParserRequestV1,
  type EmbeddingProviderRequestV1,
  type LocalServiceResultV1,
  type RerankerRequestV1
} from "@choicemind/contracts/local-services/v1";
import type { PublicWebEvidenceV1 } from "@choicemind/contracts/decision/v1";

export type DataSourceArtifactRef = Readonly<{
  algorithm: "sha256";
  digest: string;
  objectKey: string;
}>;

export type DataSourceCollectionResult =
  | Readonly<{
      ok: true;
      sourceFacts: Readonly<{
        capturedAt: string;
        collectorVersion?: string;
        mediaType: string;
        sourceId: string;
        title: string;
        url: string;
      }>;
      rawArtifact: DataSourceArtifactRef;
      metrics: Readonly<{ bytesFetched: number; durationMs: number }>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code:
          | "SOURCE_FETCH_FAILED"
          | "SOURCE_MIME_REJECTED"
          | "SOURCE_SIZE_EXCEEDED"
          | "SOURCE_REDIRECT_REJECTED";
        retryable: boolean;
      }>;
      metrics: Readonly<{ bytesFetched: number; durationMs: number }>;
    }>;

export interface DataSourceConnector {
  collect(input: Readonly<{
    policy: Readonly<{
      allowedMediaTypes: readonly string[];
      maxBytes: number;
    }>;
    sourceId: string;
    title: string;
    url: string;
  }>): Promise<DataSourceCollectionResult>;
}

export interface RawEvidenceObjectStore {
  put(
    bytes: Uint8Array,
    retention?: Readonly<{ expiresAt: string }>
  ): Promise<DataSourceArtifactRef>;
}

export interface ReadableRawEvidenceObjectStore extends RawEvidenceObjectStore {
  read(reference: DataSourceArtifactRef, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ManagedRawEvidenceObjectStore extends ReadableRawEvidenceObjectStore {
  purgeExpired(now: Date): Promise<Readonly<{ deleted: number }>>;
}

export function createFileRawEvidenceObjectStore(options: Readonly<{
  rootDirectory: string;
}>): ManagedRawEvidenceObjectStore {
  // ponytail: 单实例串行修改；多个进程共享目录前改用持久化租约。
  let pending: Promise<void> = Promise.resolve();
  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    put: (bytes, retention) => mutate(async () => {
      const digest = createHash("sha256").update(bytes).digest("hex");
      const reference = toRawArtifactReference(digest);
      const filePath = rawArtifactPath(options.rootDirectory, digest);
      const directory = rawArtifactDirectory(options.rootDirectory);
      await mkdir(directory, {
        recursive: true
      });
      if (retention !== undefined) {
        await registerRawArtifactRetention(directory, digest, retention.expiresAt);
      }
      try {
        await writeFile(filePath, bytes, { flag: "wx" });
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
        await readVerifiedRawArtifact(filePath, digest);
      }
      return reference;
    }),
    async read(reference, signal) {
      if (
        reference.algorithm !== "sha256" ||
        !/^[0-9a-f]{64}$/.test(reference.digest) ||
        reference.objectKey !== `evidence-raw/sha256/${reference.digest}`
      ) {
        throw new Error("原始 Evidence 对象引用无效");
      }
      return readVerifiedRawArtifact(
        rawArtifactPath(options.rootDirectory, reference.digest),
        reference.digest,
        signal
      );
    },
    purgeExpired: (now) => mutate(async () => {
      if (!Number.isFinite(now.getTime())) throw new Error("原始 Evidence 清理时间无效");
      const directory = rawArtifactDirectory(options.rootDirectory);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return { deleted: 0 };
        throw error;
      }
      let deleted = 0;
      const retainedDigests = new Set<string>();
      const retentionErrors: unknown[] = [];
      for (const name of names.filter((candidate) => candidate.endsWith(".retention.json"))) {
        const digest = name.slice(0, -".retention.json".length);
        if (!/^[0-9a-f]{64}$/.test(digest)) continue;
        retainedDigests.add(digest);
        const retentionPath = join(directory, name);
        let retention: Readonly<{ expiresAt: string }>;
        try {
          retention = parseRawArtifactRetention(await readFile(retentionPath, "utf8"));
        } catch (error) {
          retentionErrors.push(error);
          continue;
        }
        if (Date.parse(retention.expiresAt) > now.getTime()) continue;
        try {
          await unlink(rawArtifactPath(options.rootDirectory, digest));
          deleted += 1;
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) throw error;
        }
        await unlink(retentionPath);
      }
      const orphanCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1_000;
      for (const digest of names.filter((candidate) => /^[0-9a-f]{64}$/.test(candidate))) {
        if (retainedDigests.has(digest)) continue;
        const filePath = rawArtifactPath(options.rootDirectory, digest);
        const metadata = await stat(filePath);
        if (metadata.mtimeMs > orphanCutoff) continue;
        await unlink(filePath);
        deleted += 1;
      }
      if (retentionErrors.length > 0) throw retentionErrors[0];
      return { deleted };
    })
  };
}

function toRawArtifactReference(digest: string): DataSourceArtifactRef {
  return {
    algorithm: "sha256",
    digest,
    objectKey: `evidence-raw/sha256/${digest}`
  };
}

function rawArtifactPath(rootDirectory: string, digest: string): string {
  return join(rawArtifactDirectory(rootDirectory), digest);
}

function rawArtifactDirectory(rootDirectory: string): string {
  return join(rootDirectory, "evidence-raw", "sha256");
}

async function registerRawArtifactRetention(
  directory: string,
  digest: string,
  expiresAt: string
): Promise<void> {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) throw new Error("原始 Evidence 到期时间无效");
  const retentionPath = join(directory, `${digest}.retention.json`);
  let latestExpiry = expiry;
  try {
    const current = parseRawArtifactRetention(await readFile(retentionPath, "utf8"));
    latestExpiry = Math.max(latestExpiry, Date.parse(current.expiresAt));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const temporaryPath = join(directory, `.${digest}.${randomUUID()}.retention.tmp`);
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ expiresAt: new Date(latestExpiry).toISOString() })}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await rename(temporaryPath, retentionPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!hasErrorCode(cleanupError, "ENOENT")) {
        throw new AggregateError(
          [error, cleanupError],
          "原始 Evidence 生命周期元数据写入失败"
        );
      }
    }
    throw error;
  }
}

function parseRawArtifactRetention(value: string): Readonly<{ expiresAt: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("原始 Evidence 生命周期元数据无效");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("expiresAt" in parsed) ||
    typeof parsed.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.expiresAt))
  ) {
    throw new Error("原始 Evidence 生命周期元数据无效");
  }
  return { expiresAt: parsed.expiresAt };
}

async function readVerifiedRawArtifact(
  filePath: string,
  expectedDigest: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const bytes = await readFile(filePath, signal === undefined ? undefined : { signal });
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error("原始 Evidence 对象完整性校验失败");
  }
  return Uint8Array.from(bytes);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function createPublicWebEvidenceGenerator(options: Readonly<{
  nextEvidenceId: () => string;
  nextGapId: () => string;
  nextParserRequestId: () => string;
  objectStore: ReadableRawEvidenceObjectStore;
  parse(request: DocumentParserRequestV1, signal?: AbortSignal): Promise<LocalServiceResultV1>;
}>) {
  return {
    async generate(input: Readonly<{
      collection: Extract<DataSourceCollectionResult, Readonly<{ ok: true }>>;
      decisionTaskId: string;
      signal?: AbortSignal;
      validUntil: string;
    }>) {
      if (input.collection.sourceFacts.mediaType !== "text/html") {
        return parserEvidenceGap(options, input.decisionTaskId, false);
      }
      const rawBytes = await options.objectStore.read(
        input.collection.rawArtifact,
        input.signal
      );
      const documentSignals = inspectHtmlDocumentSignals(rawBytes);
      const request: DocumentParserRequestV1 = {
        contractType: "local-service-request",
        contractVersion: "1.0",
        requestId: options.nextParserRequestId(),
        port: "DOCUMENT_PARSER",
        input: {
          document: {
            mediaType: "text/html",
            dataBase64: Buffer.from(rawBytes).toString("base64")
          }
        }
      };
      const parsed = decodeLocalServiceResultV1(await options.parse(request, input.signal));
      if (!parsed.ok || !parsed.value.ok || parsed.value.port !== "DOCUMENT_PARSER") {
        const retryable = parsed.ok && !parsed.value.ok ? parsed.value.error.retryable : false;
        return parserEvidenceGap(options, input.decisionTaskId, retryable);
      }

      const excerpt = parsed.value.output.text;
      const excerptDigest = createHash("sha256").update(excerpt, "utf8").digest("hex");
      return {
        status: "EVIDENCE_CREATED" as const,
        documentSignals,
        evidence: {
          contractType: "evidence" as const,
          contractVersion: "1.0" as const,
          evidenceId: options.nextEvidenceId(),
          decisionTaskId: input.decisionTaskId,
          capturedAt: input.collection.sourceFacts.capturedAt,
          locator: { section: "body", field: "text" },
          excerpt,
          validUntil: input.validUntil,
          synthetic: false as const,
          source: {
            sourceKind: "PUBLIC_WEB" as const,
            sourceId: input.collection.sourceFacts.sourceId,
            title: input.collection.sourceFacts.title,
            url: input.collection.sourceFacts.url
          },
          excerptHash: { algorithm: "sha256" as const, digest: excerptDigest },
          parserVersion:
            input.collection.sourceFacts.collectorVersion === undefined
              ? parsed.value.output.parser
              : `${input.collection.sourceFacts.collectorVersion} + ${parsed.value.output.parser}`,
          rawArtifact: input.collection.rawArtifact
        }
      };
    }
  };
}

function inspectHtmlDocumentSignals(bytes: Uint8Array) {
  const html = Buffer.from(bytes).toString("utf8");
  return {
    hasAccessForm:
      /<input\b[^>]*\btype\s*=\s*["']?password\b/iu.test(html) ||
      /<form\b[^>]*(?:login|sign[-_ ]?in|auth)[^>]*>/iu.test(html),
    hasMainContent:
      /<(?:main|article)(?:\s[^>]*)?>/iu.test(html) ||
      /\srole\s*=\s*["']main["']/iu.test(html),
    hasTitle: /<title(?:\s[^>]*)?>\s*[^<\s][\s\S]*?<\/title>/iu.test(html)
  };
}

function parserEvidenceGap(
  options: Readonly<{ nextGapId: () => string }>,
  decisionTaskId: string,
  retryable: boolean
) {
  return {
    status: "EVIDENCE_GAP" as const,
    gap: {
      code: "SOURCE_PARSE_FAILED" as const,
      decisionTaskId,
      gapId: options.nextGapId(),
      retryable
    }
  };
}

export function createLocalEvidenceRetrievalService(options: Readonly<{
  embed(request: EmbeddingProviderRequestV1): Promise<LocalServiceResultV1>;
  indexStore: Readonly<{
    save(
      evidence: PublicWebEvidenceV1,
      embedding: Readonly<{ model: string; vector: readonly number[] }>
    ): Promise<void>;
    nearest(input: Readonly<{
      limit: number;
      model: string;
      queryVector: readonly number[];
    }>): Promise<readonly Readonly<{
      distance: number;
      evidence: Readonly<{ evidenceId: string }>;
    }>[]>;
  }>;
  loadExcerpt(evidenceId: string): Promise<string>;
  nextEmbeddingRequestId: () => string;
  nextRerankerRequestId: () => string;
  rerank(request: RerankerRequestV1): Promise<LocalServiceResultV1>;
}>) {
  async function embedText(text: string) {
    const request: EmbeddingProviderRequestV1 = {
      contractType: "local-service-request",
      contractVersion: "1.0",
      requestId: options.nextEmbeddingRequestId(),
      port: "EMBEDDING_PROVIDER",
      input: { texts: [text] }
    };
    const decoded = decodeLocalServiceResultV1(await options.embed(request));
    if (
      !decoded.ok ||
      !decoded.value.ok ||
      decoded.value.port !== "EMBEDDING_PROVIDER" ||
      decoded.value.output.vectors.length !== 1
    ) {
      return undefined;
    }
    const vector = decoded.value.output.vectors[0];
    if (vector === undefined) {
      return undefined;
    }
    return {
      model: decoded.value.output.model,
      vector
    };
  }

  return {
    async index(evidence: PublicWebEvidenceV1) {
      const embedding = await embedText(evidence.excerpt);
      if (embedding === undefined) {
        return {
          status: "EVIDENCE_GAP" as const,
          gap: { code: "EMBEDDING_FAILED" as const, retryable: true }
        };
      }
      await options.indexStore.save(evidence, embedding);
      return { status: "INDEXED" as const, evidenceId: evidence.evidenceId };
    },
    async search(input: Readonly<{ query: string; topK: number }>) {
      if (input.query.trim() === "" || !Number.isSafeInteger(input.topK) || input.topK <= 0) {
        throw new Error("Evidence 检索请求无效");
      }
      const embedding = await embedText(input.query);
      if (embedding === undefined) {
        return {
          status: "EVIDENCE_GAP" as const,
          gap: { code: "EMBEDDING_FAILED" as const, retryable: true }
        };
      }
      const candidates = await options.indexStore.nearest({
        limit: input.topK * 2,
        model: embedding.model,
        queryVector: embedding.vector
      });
      const documents = await Promise.all(
        candidates.map(async (candidate) => ({
          documentId: candidate.evidence.evidenceId,
          text: await options.loadExcerpt(candidate.evidence.evidenceId)
        }))
      );
      const rerankerRequest: RerankerRequestV1 = {
        contractType: "local-service-request",
        contractVersion: "1.0",
        requestId: options.nextRerankerRequestId(),
        port: "RERANKER",
        input: { query: input.query, documents, topK: input.topK }
      };
      const reranked = decodeLocalServiceResultV1(
        await options.rerank(rerankerRequest)
      );
      if (!reranked.ok || !reranked.value.ok || reranked.value.port !== "RERANKER") {
        return {
          status: "EVIDENCE_GAP" as const,
          gap: { code: "RERANK_FAILED" as const, retryable: true }
        };
      }
      const candidateIds = new Set(documents.map((document) => document.documentId));
      return {
        status: "RETRIEVED" as const,
        results: reranked.value.output.rankings
          .filter((ranking) => candidateIds.has(ranking.documentId))
          .slice(0, input.topK)
          .map((ranking) => ({
            evidenceId: ranking.documentId,
            score: ranking.score
          }))
      };
    }
  };
}

export function createHttpDataSourceConnector(options: Readonly<{
  fetch(input: Readonly<{
    redirect: "manual";
    url: string;
  }>): Promise<
    Readonly<{
      arrayBuffer(): Promise<ArrayBuffer>;
      headers: Readonly<{ get(name: string): string | null }>;
      ok: boolean;
      status: number;
      url: string;
    }>
  >;
  now: () => Date;
  objectStore: RawEvidenceObjectStore;
  readDurationMs: () => number;
}>): DataSourceConnector {
  return {
    async collect(input) {
      let response: Awaited<ReturnType<typeof options.fetch>>;
      try {
        response = await options.fetch({ redirect: "manual", url: input.url });
      } catch {
        return {
          ok: false,
          error: { code: "SOURCE_FETCH_FAILED", retryable: true },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }
      if (response.status >= 300 && response.status < 400) {
        return {
          ok: false,
          error: { code: "SOURCE_REDIRECT_REJECTED", retryable: false },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: "SOURCE_FETCH_FAILED",
            retryable: response.status >= 500
          },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (
        mediaType === undefined ||
        !input.policy.allowedMediaTypes.includes(mediaType)
      ) {
        return {
          ok: false,
          error: { code: "SOURCE_MIME_REJECTED", retryable: false },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }

      const contentLengthHeader = response.headers.get("content-length");
      const contentLength =
        contentLengthHeader === null ? undefined : Number(contentLengthHeader);
      if (
        contentLength !== undefined &&
        Number.isFinite(contentLength) &&
        contentLength > input.policy.maxBytes
      ) {
        return {
          ok: false,
          error: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > input.policy.maxBytes) {
        return {
          ok: false,
          error: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
          metrics: {
            bytesFetched: bytes.byteLength,
            durationMs: options.readDurationMs()
          }
        };
      }
      const rawArtifact = await options.objectStore.put(bytes);
      return {
        ok: true,
        sourceFacts: {
          capturedAt: options.now().toISOString(),
          mediaType,
          sourceId: input.sourceId,
          title: input.title,
          url: response.url
        },
        rawArtifact,
        metrics: {
          bytesFetched: bytes.byteLength,
          durationMs: options.readDurationMs()
        }
      };
    }
  };
}

export function createEvidenceIngestionService(options: Readonly<{
  approvedSourceUrls: ReadonlySet<string>;
  collectionPolicy: Readonly<{
    allowedMediaTypes: readonly string[];
    maxBytes: number;
  }>;
  connector: DataSourceConnector;
  egressGuard: EgressGuard;
  nextGapId: () => string;
  resolveHost(hostname: string): Promise<readonly string[]>;
}>) {
  return {
    async ingest(input: Readonly<{
      correlationId: string;
      decisionTaskId: string;
      operationId: string;
      source: Readonly<{ sourceId: string; title: string; url: string }>;
      userId: string;
    }>) {
      const sourceUrl = new URL(input.source.url);
      const approved = options.approvedSourceUrls.has(sourceUrl.href);
      if (!approved) {
        return {
          status: "EVIDENCE_GAP" as const,
          gap: {
            code: "SOURCE_NOT_APPROVED" as const,
            decisionTaskId: input.decisionTaskId,
            gapId: options.nextGapId(),
            retryable: false,
            sourceId: input.source.sourceId
          }
        };
      }
      if (sourceUrl.protocol !== "https:") {
        return {
          status: "EVIDENCE_GAP" as const,
          gap: {
            code: "SOURCE_SCHEME_REJECTED" as const,
            decisionTaskId: input.decisionTaskId,
            gapId: options.nextGapId(),
            retryable: false,
            sourceId: input.source.sourceId
          }
        };
      }
      if (approved) {
        const hostname = normalizeHostname(sourceUrl.hostname);
        let resolvedAddresses: readonly string[];
        try {
          resolvedAddresses =
            isIP(hostname) === 0 ? await options.resolveHost(hostname) : [hostname];
        } catch {
          return {
            status: "EVIDENCE_GAP" as const,
            gap: {
              code: "SOURCE_DNS_FAILED" as const,
              decisionTaskId: input.decisionTaskId,
              gapId: options.nextGapId(),
              retryable: true,
              sourceId: input.source.sourceId
            }
          };
        }
        if (
          isLocalHostname(hostname) ||
          resolvedAddresses.length === 0 ||
          resolvedAddresses.some(isPrivateAddress)
        ) {
          return ssrfEvidenceGap(options, input);
        }
      }

      if (
        approved &&
        sourceUrl.protocol === "https:"
      ) {
        const guarded = await options.egressGuard.execute({
          userId: input.userId,
          operationId: input.operationId,
          operation: "READ_PUBLIC_SOURCE",
          correlationId: input.correlationId,
          destinationUrl: sourceUrl.href,
          method: "GET",
          perform: () =>
            options.connector.collect({
              ...input.source,
              policy: {
                allowedMediaTypes: [...options.collectionPolicy.allowedMediaTypes],
                maxBytes: options.collectionPolicy.maxBytes
              }
            })
        });
        if (guarded.status === "COMPLETED") {
          if (!guarded.value.ok) {
            return {
              status: "EVIDENCE_GAP" as const,
              gap: {
                code: guarded.value.error.code,
                decisionTaskId: input.decisionTaskId,
                gapId: options.nextGapId(),
                metrics: guarded.value.metrics,
                retryable: guarded.value.error.retryable,
                sourceId: input.source.sourceId
              }
            };
          }
          return { status: "COLLECTED" as const, collection: guarded.value };
        }
      }

      throw new Error("未批准来源的失败语义尚未实现");
    }
  };
}

function ssrfEvidenceGap(
  options: Readonly<{ nextGapId: () => string }>,
  input: Readonly<{
    decisionTaskId: string;
    source: Readonly<{ sourceId: string }>;
  }>
) {
  return {
    status: "EVIDENCE_GAP" as const,
    gap: {
      code: "SOURCE_SSRF_BLOCKED" as const,
      decisionTaskId: input.decisionTaskId,
      gapId: options.nextGapId(),
      retryable: false,
      sourceId: input.source.sourceId
    }
  };
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLocalHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return false;
}

function isPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address).toLowerCase();
  if (isIP(normalized) === 4) {
    const [first = 0, second = 0] = normalized.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (isIP(normalized) !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }
  return false;
}
