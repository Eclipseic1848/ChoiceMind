import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createEvidenceIngestionService, createFileRawEvidenceObjectStore,
  createHttpDataSourceConnector, createPublicWebEvidenceGenerator,
  createStaticPublicWebPageCollector, type ResearchEvidenceMaterial
} from "@choicemind/evidence-ingestion";
import { createEgressGuard } from "@choicemind/security";
import { openPostgresSourceResearch } from "@choicemind/source-research";
import { expect, it, vi } from "vitest";
import { createStaticPublicWebSourceAdapter } from "./static-public-web-adapter.js";
import { createSourceWorker } from "./worker.js";

it.skipIf(process.env.CHOICEMIND_TEST_DATABASE_URL === undefined)(
  "公开网页经 Worker 落库且隔离用户，原始材料七天到期",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "choicemind-public-pipeline-"));
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error("临时目录越界");
    const research = await openPostgresSourceResearch({
      databaseUrl: process.env.CHOICEMIND_TEST_DATABASE_URL as string
    });
    const ownerUserId = `synthetic-${randomUUID()}`;
    try {
      const now = () => new Date("2026-09-01T00:00:00.000Z");
      const objectStore = createFileRawEvidenceObjectStore({ rootDirectory: root });
      const text = `${"产品规格说明。".repeat(40)}该型号配备 32 GB 内存`;
      const bytes = new TextEncoder().encode(`<main>${text}</main>`);
      const url = "https://brand.example/product";
      const audited: string[] = [];
      const connector = createHttpDataSourceConnector({
        fetch: async (input) => {
          expect(input.resolvedAddress).toBe("93.184.216.34");
          expect(audited).toEqual([url]);
          return { arrayBuffer: async () => bytes.buffer,
            headers: new Headers({ "content-type": "text/html" }), ok: true, status: 200, url };
        }, now, objectStore, readDurationMs: () => 1
      });
      const ingestion = createEvidenceIngestionService({
        approvedSourceUrls: new Set([url]), approvedSourceOrigins: new Set(["https://brand.example"]),
        collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 10_000 },
        connector, nextGapId: randomUUID, resolveHost: async () => ["93.184.216.34"],
        egressGuard: createEgressGuard({ nextId: randomUUID, now,
          appendRecord: async () => { audited.push(url); } })
      });
      const generator = createPublicWebEvidenceGenerator({
        objectStore, nextEvidenceId: randomUUID, nextGapId: randomUUID, nextParserRequestId: randomUUID,
        parse: async (request) => ({ contractType: "local-service-result", contractVersion: "1.0",
          requestId: request.requestId, port: "DOCUMENT_PARSER", ok: true,
          output: { parser: "synthetic-parser@1", text, pageCount: 1 } })
      });
      const adapter = createStaticPublicWebSourceAdapter({
        definition: { sourceId: "brand", title: "合成品牌官网", entryUrls: [url],
          allowedOrigins: ["https://brand.example"], renderMode: "STATIC", sourceRole: "OFFICIAL" },
        pageCollector: createStaticPublicWebPageCollector({ ingestion, evidenceGenerator: generator })
      });
      const batch = await research.execute({ type: "CREATE_BATCH", batchId: randomUUID(), ownerUserId,
        decisionTaskId: randomUUID(), idempotencyKey: randomUUID(), query: "核验内存规格",
        target: { subject: { kind: "CANDIDATE", value: "candidate" },
          claimTargets: [{ claimId: "memory", statement: "该型号配备 32 GB 内存" }] },
        sources: [{ sourceId: "brand", sourceAccountId: "public", accessMode: "PUBLIC" }] });
      const forbidden = vi.fn(() => { throw new Error("公开来源不得访问凭据"); });
      const worker = createSourceWorker({ workerId: "synthetic-worker",
        systemActor: { userId: "synthetic-system", role: "SYSTEM" }, sourceResearch: research,
        sourceAccess: { read: forbidden, execute: forbidden, withCredential: forbidden },
        adapters: new Map([["brand", adapter]]) });
      await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1 });
      expect(forbidden).not.toHaveBeenCalled();
      await expect(research.read({ type: "GET_BATCH", batchId: batch.batchId, ownerUserId }))
        .resolves.toMatchObject({ state: "COMPLETED", results: [expect.objectContaining({ summary: expect.stringContaining("32 GB") })] });
      await expect(research.readEvidenceCandidates({ batchId: batch.batchId, ownerUserId: "other" })).resolves.toBeUndefined();
      const candidates = await research.readEvidenceCandidates({ batchId: batch.batchId, ownerUserId });
      expect(candidates?.results).toHaveLength(1);
      const material = candidates?.results[0]?.material as ResearchEvidenceMaterial;
      expect(material).toMatchObject({ source: { url }, claimLinks: [{ claimId: "memory", direction: "SUPPORTS" }],
        rawArtifact: { expiresAt: "2026-09-08T00:00:00.000Z" } });
      await expect(objectStore.read(material.rawArtifact)).resolves.toEqual(bytes);
      await expect(objectStore.purgeExpired(new Date("2026-09-07T23:59:59.000Z"))).resolves.toEqual({ deleted: 0 });
      await expect(objectStore.purgeExpired(new Date("2026-09-08T00:00:00.000Z"))).resolves.toEqual({ deleted: 1 });
      await expect(objectStore.read(material.rawArtifact)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      try { await research.purgePrivateDataForOwner(ownerUserId); }
      finally {
        await research.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
);
