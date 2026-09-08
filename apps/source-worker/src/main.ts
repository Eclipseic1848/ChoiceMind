import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";

import {
  createEvidenceIngestionService,
  createFileRawEvidenceObjectStore,
  createHttpDataSourceConnector,
  createPublicWebEvidenceGenerator,
  createStaticPublicWebPageCollector
} from "@choicemind/evidence-ingestion";
import {
  executeLocalServiceRequest,
  loadLocalServiceConfiguration
} from "@choicemind/local-services";
import { createCredentialVault, createEgressGuard } from "@choicemind/security";
import { openPostgresSourceAccess } from "@choicemind/source-access";
import { openPostgresCandidateResearchRequests, openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import {
  createPublicWebSourceCatalog,
  openPostgresSourceResearch,
  openSourceResearchNotificationPublisher,
  type PublicWebSourceDefinition
} from "@choicemind/source-research";
import { openPersistentDecisionTaskModule } from "@choicemind/task-persistence";
import { chromium, type Browser } from "playwright";

import { createFixtureSourceAdapter } from "./fixture-adapter.js";
import { createCandidateReviewWorker } from "./candidate-wheel-review.js";
import { createPinnedHttpsFetch } from "./pinned-https-fetch.js";
import { createPlaywrightPublicWebIngestion } from "./playwright-public-web-ingestion.js";
import { createStaticPublicWebSourceAdapter } from "./static-public-web-adapter.js";
import { createSourceWorker, type SourceAdapter } from "./worker.js";

const databaseUrl = requireEnvironment("CHOICEMIND_DATABASE_URL");
const masterKey = Buffer.from(
  requireEnvironment("CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64"),
  "base64"
);
if (masterKey.byteLength !== 32) {
  throw new Error("CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64 解码后必须是 32 字节");
}
const workerId = process.env.CHOICEMIND_SOURCE_WORKER_ID ?? `source-worker-${process.pid}`;
const systemActor = Object.freeze({
  userId: `source-worker:${workerId}`,
  role: "SYSTEM" as const
});
// 每次取得资源立即登记；启动失败和运行退出共用逆序回收，不因一项失败漏关其余资源。
const cleanups: Array<() => Promise<unknown> | undefined> = [() => { masterKey.fill(0); }];
const failures: unknown[] = [];
try {
  const persistence = await openPersistentDecisionTaskModule({ databaseUrl });
  cleanups.push(() => persistence.close());
  const vault = createCredentialVault({
    masterKey,
    systemAccess: {
      actor: systemActor,
      secretType: "SOURCE_CREDENTIAL",
      actions: ["USE", "DELETE"]
    },
    storage: {
      save: async (record) => persistence.saveEncryptedCredential(record),
      load: async (credentialId, ownerUserId) =>
        persistence.loadEncryptedCredential(credentialId, ownerUserId),
      delete: async (credentialId, ownerUserId) =>
        persistence.deleteEncryptedCredential(credentialId, ownerUserId)
    },
    appendAuditRecord: async (record) =>
      persistence.appendAuditRecord({
        actor: {
          principalId: record.actor.userId,
          role: record.actor.role,
          userId: record.actor.userId
        },
        action: record.action,
        object: record.object,
        result: record.result,
        correlationId: record.correlationId
      })
  });
  const sourceAccess = await openPostgresSourceAccess({ databaseUrl, vault, systemActor });
  cleanups.push(() => sourceAccess.close());
  const sourceResearch = await openPostgresSourceResearch({ databaseUrl });
  cleanups.push(() => sourceResearch.close());
  const candidateRequests = await openPostgresCandidateResearchRequests(databaseUrl);
  cleanups.push(() => candidateRequests.close());
  const candidateStore = await openPostgresCandidateStore(databaseUrl);
  cleanups.push(() => candidateStore.close());
  const candidateReview = createCandidateReviewWorker(candidateRequests.review, candidateStore);
  cleanups.push(() => candidateReview.drain());
  const adapters = new Map<string, SourceAdapter>([
    [
      "fixture",
      createFixtureSourceAdapter({
        loginUrl:
          process.env.CHOICEMIND_FIXTURE_LOGIN_URL ??
          "http://127.0.0.1:3000/source-login/fixture"
      })
    ]
  ]);
  const publicWebCatalog = createPublicWebSourceCatalog(readPublicWebDefinitions());
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let publicWebBrowser: Browser | undefined;
  const evidenceObjectRoot = process.env.CHOICEMIND_EVIDENCE_OBJECT_ROOT?.trim();
  const objectStore =
    evidenceObjectRoot === undefined || evidenceObjectRoot === ""
      ? undefined
      : createFileRawEvidenceObjectStore({ rootDirectory: evidenceObjectRoot });
  if (objectStore !== undefined) {
    await objectStore.purgeExpired(new Date());
    retentionTimer = setInterval(() => {
      void objectStore.purgeExpired(new Date()).catch((error) => {
        console.error("公开网页原始材料到期清理失败", error);
      });
    }, 60 * 60 * 1_000);
    retentionTimer.unref();
    cleanups.push(() => { if (retentionTimer !== undefined) clearInterval(retentionTimer); });
  }
  if (publicWebCatalog.size > 0) {
    if (objectStore === undefined) {
      throw new Error("CHOICEMIND_EVIDENCE_OBJECT_ROOT 未配置");
    }
    const localServiceTarget = loadLocalServiceConfiguration(process.env).targets.find(
      (target) => target.serviceId === "choicemind-html-parser"
    );
    if (localServiceTarget === undefined) {
      throw new Error("ChoiceMind HTML Parser 未配置");
    }
    let fetchStartedAt = 0;
    const pinnedFetch = createPinnedHttpsFetch();
    const connector = createHttpDataSourceConnector({
      collectorVersion: "http-connector@1",
      fetch: async (input) => {
        fetchStartedAt = performance.now();
        return pinnedFetch(input);
      },
      includeResponseMetadata: true,
      now: () => new Date(),
      objectStore,
      readDurationMs: () => Math.max(0, Math.round(performance.now() - fetchStartedAt))
    });
    const egressGuard = createEgressGuard({
      appendRecord: async (record) => persistence.appendEgressRecord(record),
      nextId: randomUUID,
      now: () => new Date()
    });
    const evidenceGenerator = createPublicWebEvidenceGenerator({
      nextEvidenceId: randomUUID,
      nextGapId: randomUUID,
      nextParserRequestId: randomUUID,
      objectStore,
      parse: async (request, signal) =>
        executeLocalServiceRequest(
          localServiceTarget,
          request,
          signal === undefined ? {} : { signal }
        )
    });
    if (
      [...publicWebCatalog.values()].some(
        (definition) => definition.renderMode === "AUTO" || definition.renderMode === "DYNAMIC"
      )
    ) {
      publicWebBrowser = await chromium.launch({
        headless: true,
        args: [
          "--disable-background-networking",
          "--disable-features=WebTransport",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--host-resolver-rules=MAP * ~NOTFOUND"
        ]
      });
      const ownedBrowser = publicWebBrowser;
      cleanups.push(() => ownedBrowser.close());
    }
    for (const definition of publicWebCatalog.values()) {
      if (adapters.has(definition.sourceId)) {
        throw new Error(`公开来源 ID 与现有 Adapter 冲突：${definition.sourceId}`);
      }
      const ingestion = createEvidenceIngestionService({
        approvedSourceOrigins: new Set(definition.allowedOrigins),
        approvedSourceUrls: new Set(definition.entryUrls),
        collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_000_000 },
        connector,
        egressGuard,
        nextGapId: randomUUID,
        resolveHost: async (hostname) =>
          (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
      });
      const dynamicIngestion =
        definition.renderMode === "STATIC" || publicWebBrowser === undefined
          ? undefined
          : createPlaywrightPublicWebIngestion({
              approvedSourceOrigins: new Set(definition.allowedOrigins),
              approvedSourceUrls: new Set(definition.entryUrls),
              browser: publicWebBrowser,
              nextGapId: randomUUID,
              now: () => new Date(),
              objectStore,
              safeResourceLoader: {
                async load(input) {
                  const resourceIngestion = createEvidenceIngestionService({
                    approvedSourceOrigins: new Set(definition.allowedOrigins),
                    approvedSourceUrls: new Set([input.url]),
                    collectionPolicy: {
                      allowedMediaTypes: [
                        "application/javascript",
                        "application/json",
                        "text/css",
                        "text/html",
                        "text/javascript",
                        "text/plain"
                      ],
                      maxBytes: Math.min(1_000_000, input.maxBytes)
                    },
                    connector,
                    egressGuard,
                    nextGapId: randomUUID,
                    redirectMode: "manual",
                    resolveHost: async (hostname) =>
                      (await lookup(hostname, { all: true, verbatim: true })).map(
                        (entry) => entry.address
                      )
                  });
                  const result = await resourceIngestion.ingest({
                    correlationId: input.correlationId,
                    decisionTaskId: input.decisionTaskId,
                    operationId: input.operationId,
                    signal: input.signal,
                    source: {
                      sourceId: input.sourceId,
                      title: definition.title,
                      url: input.url
                    },
                    userId: input.userId
                  });
                  if (result.status === "EVIDENCE_GAP") return result;
                  if (result.status === "REDIRECT") {
                    return {
                      status: "LOADED" as const,
                      response: {
                        body: new Uint8Array(),
                        headers: { location: result.location },
                        status: 302
                      }
                    };
                  }
                  return {
                    status: "LOADED" as const,
                    response: {
                      body: await objectStore.read(
                        result.collection.rawArtifact,
                        input.signal
                      ),
                      headers: result.collection.response.headers,
                      status: result.collection.response.status
                    }
                  };
                }
              }
            });
      adapters.set(
        definition.sourceId,
        createStaticPublicWebSourceAdapter({
          definition,
          pageCollector: createStaticPublicWebPageCollector({
            ingestion,
            evidenceGenerator
          }),
          ...(dynamicIngestion === undefined
            ? {}
            : {
                dynamicPageCollector: createStaticPublicWebPageCollector({
                  ingestion: dynamicIngestion,
                  evidenceGenerator
                })
              })
        })
      );
    }
  }
  let notificationPublisher: Awaited<ReturnType<typeof openSourceResearchNotificationPublisher>> | undefined;
  try {
    const redisUrl = process.env.CHOICEMIND_REDIS_URL;
    if (redisUrl !== undefined && redisUrl.length > 0) {
      notificationPublisher = await openSourceResearchNotificationPublisher({ databaseUrl, redisUrl });
      const ownedPublisher = notificationPublisher;
      cleanups.push(() => ownedPublisher.close());
    }
  } catch {
    console.warn("来源研究 Redis 通知暂不可用；Worker 将继续使用 Postgres 轮询");
  }
  const worker = createSourceWorker({
    workerId,
    systemActor,
    sourceAccess,
    sourceResearch,
    requestCandidateResearch: async (_sourceId, claim) => { await candidateRequests.request(claim); },
    adapters
  });
  const pollIntervalMs = Number(process.env.CHOICEMIND_SOURCE_WORKER_POLL_MS ?? 500);
  let stopping = false;
  const candidateStop = new AbortController();
  const requestStop = () => {
    stopping = true;
    candidateStop.abort();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  // 审查与普通采集分开轮询；未实现的制品类型保留待审，不抢领后伪装成失败完成。
  const candidateReviews = (async () => {
    while (!stopping) {
      try { await candidateReview.runOnce(candidateStop.signal); }
      catch { console.warn("CANDIDATE_REVIEW_POLL_FAILED"); }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 500));
    }
  })();

  try {
    while (!stopping) {
      try {
        await notificationPublisher?.runOnce();
      } catch {
        console.warn("来源研究 Redis 通知发送失败；Worker 将继续使用 Postgres 轮询");
      }
      const result = await worker.runOnce();
      if (!stopping && result.claimed === 0) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  } finally {
    requestStop();
    try {
      await candidateReviews;
    } finally {
      process.off("SIGINT", requestStop);
      process.off("SIGTERM", requestStop);
    }
  }
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "SOURCE_WORKER_CLEANUP_FAILED");

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} 未配置`);
  return value;
}

function readPublicWebDefinitions(): readonly PublicWebSourceDefinition[] {
  const configured = process.env.CHOICEMIND_PUBLIC_WEB_SOURCES_JSON;
  if (configured === undefined || configured.trim() === "") return [];
  try {
    return JSON.parse(configured) as readonly PublicWebSourceDefinition[];
  } catch {
    throw new Error("CHOICEMIND_PUBLIC_WEB_SOURCES_JSON 必须是有效 JSON");
  }
}
