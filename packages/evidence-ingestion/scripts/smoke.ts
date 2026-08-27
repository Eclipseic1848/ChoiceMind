import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  executeLocalServiceRequest,
  loadLocalServiceConfiguration,
  type LocalServiceTargetV1
} from "@choicemind/local-services";
import { createEgressGuard } from "@choicemind/security";
import {
  openEvidenceIndexStore,
  openPersistentDecisionTaskModule
} from "@choicemind/task-persistence";

import {
  createEvidenceIngestionService,
  createFileRawEvidenceObjectStore,
  createHttpDataSourceConnector,
  createLocalEvidenceRetrievalService,
  createPublicWebEvidenceGenerator
} from "../src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = requireEnvironment("CHOICEMIND_DATABASE_URL");
const sourceUrl = new URL(requireEnvironment("CHOICEMIND_EVIDENCE_SOURCE_URL"));
const sourceTitle = process.env.CHOICEMIND_EVIDENCE_SOURCE_TITLE ?? sourceUrl.hostname;
const objectRoot =
  process.env.CHOICEMIND_EVIDENCE_OBJECT_ROOT ??
  path.resolve(packageRoot, "../../.artifacts/evidence-objects");
const configuration = loadLocalServiceConfiguration(process.env);
const htmlParser = requireTarget(configuration.targets, "choicemind-html-parser");
const embedding = requireTarget(configuration.targets, "qwen-embedding");
const reranker = requireTarget(configuration.targets, "qwen-reranker");
const taskStore = await openPersistentDecisionTaskModule({ databaseUrl });
const indexStore = await openEvidenceIndexStore({ databaseUrl });
const objectStore = createFileRawEvidenceObjectStore({ rootDirectory: objectRoot });
const startedAt = performance.now();

try {
  const ingestion = createEvidenceIngestionService({
    approvedSourceUrls: new Set([sourceUrl.href]),
    collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
    connector: createHttpDataSourceConnector({
      fetch: ({ redirect, url }) => fetch(url, { redirect }),
      now: () => new Date(),
      objectStore,
      readDurationMs: () => Math.max(0, Math.round(performance.now() - startedAt))
    }),
    egressGuard: createEgressGuard({
      appendRecord: (record) => taskStore.appendEgressRecord(record),
      nextId: () => `egress-${randomUUID()}`,
      now: () => new Date()
    }),
    nextGapId: () => `gap-${randomUUID()}`,
    resolveHost: async (hostname) =>
      (await lookup(hostname, { all: true })).map((entry) => entry.address)
  });
  const decisionTaskId = `task-evidence-smoke-${randomUUID()}`;
  const collection = await ingestion.ingest({
    correlationId: decisionTaskId,
    decisionTaskId,
    operationId: `collect-${randomUUID()}`,
    source: {
      sourceId: `source-${randomUUID()}`,
      title: sourceTitle,
      url: sourceUrl.href
    },
    userId: "p0-evidence-smoke"
  });
  if (collection.status !== "COLLECTED") {
    writeReport({ status: "EVIDENCE_GAP", gap: collection.gap });
    process.exitCode = 1;
  } else {
    const generator = createPublicWebEvidenceGenerator({
      nextEvidenceId: () => `evidence-${randomUUID()}`,
      nextGapId: () => `gap-${randomUUID()}`,
      nextParserRequestId: () => `parse-${randomUUID()}`,
      objectStore,
      parse: (request) => executeLocalServiceRequest(htmlParser, request)
    });
    const generated = await generator.generate({
      collection: collection.collection,
      decisionTaskId,
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString()
    });
    if (generated.status !== "EVIDENCE_CREATED") {
      writeReport({ status: "EVIDENCE_GAP", gap: generated.gap });
      process.exitCode = 1;
    } else {
      const evidence = generated.evidence;
      const retrieval = createLocalEvidenceRetrievalService({
        embed: (request) => executeLocalServiceRequest(embedding, request),
        indexStore,
        loadExcerpt: async (evidenceId) => {
          if (evidenceId !== evidence.evidenceId) {
            throw new Error("检索结果引用了当前闭环之外的 Evidence");
          }
          return evidence.excerpt;
        },
        nextEmbeddingRequestId: () => `embedding-${randomUUID()}`,
        nextRerankerRequestId: () => `reranker-${randomUUID()}`,
        rerank: (request) => executeLocalServiceRequest(reranker, request)
      });
      const indexed = await retrieval.index(evidence);
      const retrieved =
        indexed.status === "INDEXED"
          ? await retrieval.search({ query: sourceTitle, topK: 1 })
          : indexed;
      writeReport({
        status:
          indexed.status === "INDEXED" && retrieved.status === "RETRIEVED"
            ? "SMOKE_PASSED"
            : "EVIDENCE_GAP",
        decisionTaskId,
        evidenceId: evidence.evidenceId,
        sourceUrl: evidence.source.url,
        rawArtifact: evidence.rawArtifact,
        excerptHash: evidence.excerptHash,
        parserVersion: evidence.parserVersion,
        indexed,
        retrieved
      });
      if (indexed.status !== "INDEXED" || retrieved.status !== "RETRIEVED") {
        process.exitCode = 1;
      }
    }
  }
} finally {
  await Promise.all([indexStore.close(), taskStore.close()]);
}

function requireTarget(
  targets: readonly LocalServiceTargetV1[],
  serviceId: LocalServiceTargetV1["serviceId"]
): LocalServiceTargetV1 {
  const target = targets.find((candidate) => candidate.serviceId === serviceId);
  if (target === undefined) {
    throw new Error(`缺少本地服务目标：${serviceId}`);
  }
  return target;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} 未配置`);
  }
  return value;
}

function writeReport(report: unknown): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
