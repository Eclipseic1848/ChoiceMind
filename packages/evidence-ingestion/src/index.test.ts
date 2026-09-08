import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEgressGuard } from "@choicemind/security";
import type { PublicWebEvidenceV1 } from "@choicemind/contracts/decision/v1";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createEvidenceModule,
  createEvidenceIngestionService,
  createFileRawEvidenceObjectStore,
  createHttpDataSourceConnector,
  createLocalEvidenceRetrievalService,
  createPublicWebEvidenceGenerator,
  type DataSourceConnector,
  type ResearchEvidenceMaterial,
  type DataSourceResponseMetadata
} from "./index.js";

describe("Evidence ingestion", () => {
  it("loads an owned Source Research Batch through its stable Interface", async () => {
    const readEvidenceCandidates = vi.fn(async () => ({
      batchId: "batch-a",
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      results: [{ resultKey: "jd:owned", material: researchMaterial() }]
    }));
    const nextEvidenceId = vi.fn(() => "unstable-evidence-id");
    const nextLinkId = vi.fn(() => "unstable-link-id");
    const module = createEvidenceModule({
      nextEvidenceId,
      nextGapId: () => "gap-unused",
      nextLinkId,
      sourceResearch: { readEvidenceCandidates }
    });

    const command = {
      batchId: "batch-a",
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"]
    } as const;
    const first = await module.normalizeResearchBatchById(command);
    const second = await module.normalizeResearchBatchById(command);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      evidence: [
        {
          evidenceId: expect.stringMatching(/^evidence-[0-9a-f]{32}$/),
          ownerUserId: "user-a"
        }
      ],
      claimEvidenceLinks: [
        {
          linkId: expect.stringMatching(/^claim-evidence-link-[0-9a-f]{32}$/),
          claimId: "claim-price"
        }
      ],
      gaps: []
    });
    expect(first.claimEvidenceLinks[0]?.evidenceId).toBe(first.evidence[0]?.evidenceId);
    expect(nextEvidenceId).not.toHaveBeenCalled();
    expect(nextLinkId).not.toHaveBeenCalled();
    expect(readEvidenceCandidates).toHaveBeenCalledWith({
      batchId: "batch-a",
      ownerUserId: "user-a"
    });
  });

  it("indexes normalized Live Platform Evidence through the existing retrieval seam", async () => {
    const index = vi.fn(async () => ({
      status: "INDEXED" as const,
      evidenceId: "evidence-live"
    }));
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-live",
      nextGapId: () => "gap-unused",
      nextLinkId: () => "link-live",
      retrieval: {
        index,
        search: async () => ({ status: "RETRIEVED" as const, results: [] })
      }
    });
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [{ resultKey: "jd:index", material: researchMaterial() }]
      }
    });

    await expect(
      module.indexEvidence({ ownerUserId: "user-a", evidence: normalized.evidence })
    ).resolves.toEqual({ indexed: 1, skipped: 0, gaps: [] });
    expect(index).toHaveBeenCalledWith({
      ownerUserId: "user-a",
      evidence: expect.objectContaining({
        contractType: "evidence",
        contractVersion: "1.0",
        evidenceId: "evidence-live",
        decisionTaskId: "task-a",
        synthetic: false,
        source: {
          sourceKind: "PUBLIC_WEB",
          sourceId: "jd",
          title: "京东商品详情",
          url: "https://item.jd.com/1001.html"
        }
      })
    });
  });

  it("retrieves ranked Evidence as a bounded CoreMind projection", async () => {
    const search = vi.fn(async () => ({
      status: "RETRIEVED" as const,
      results: [
        { evidenceId: "evidence-2", score: 0.98 },
        { evidenceId: "evidence-from-another-task", score: 0.97 }
      ]
    }));
    let evidenceSequence = 0;
    let linkSequence = 0;
    const module = createEvidenceModule({
      nextEvidenceId: () => `evidence-${++evidenceSequence}`,
      nextGapId: () => "gap-unused",
      nextLinkId: () => `link-${++linkSequence}`,
      projectionLimits: { maxEvidence: 2, maxExcerptCharacters: 10 },
      retrieval: {
        index: async ({ evidence }) => ({
          status: "INDEXED" as const,
          evidenceId: evidence.evidenceId
        }),
        search
      }
    });
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [
          { resultKey: "jd:first", material: researchMaterial({ excerpt: "第一条证据" }) },
          { resultKey: "jd:second", material: researchMaterial({ excerpt: "第二条证据" }) }
        ]
      }
    });

    await expect(
      module.retrieveForCoreMind({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        decisionValidFrom: "2026-08-28T12:00:00.000Z",
        query: "当前价格",
        topK: 2,
        evidence: normalized.evidence,
        claimEvidenceLinks: normalized.claimEvidenceLinks
      })
    ).resolves.toMatchObject({
      status: "RETRIEVED",
      projection: {
        items: [{ evidenceId: "evidence-2", excerpt: "第二条证据" }],
        hasMore: false
      }
    });
    expect(search).toHaveBeenCalledWith({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      query: "当前价格",
      topK: 2
    });
  });

  it("normalizes a Source Research result into locatable Evidence and Claim links", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-a",
      nextGapId: () => "gap-unused",
      nextLinkId: () => "link-a"
    });

    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [
            {
              resultKey: "jd:item-1001:offer",
              material: {
                capturedAt: "2026-08-28T10:00:00.000Z",
                validUntil: "2026-08-29T10:00:00.000Z",
                excerpt: "京东自营当前价格为 2999 元",
                locator: { section: "商品价格", field: "当前售价" },
                parserVersion: "fixture-adapter@1",
                rawArtifact: {
                  algorithm: "sha256",
                  digest: "a".repeat(64),
                  objectKey: `source-artifacts/sha256/${"a".repeat(64)}`,
                  lifecycle: "TRANSIENT_PLATFORM",
                  expiresAt: "2026-09-04T10:00:00.000Z"
                },
                source: {
                  sourceType: "LIVE_PLATFORM",
                  sourceId: "jd",
                  platform: "JD",
                  title: "京东商品详情",
                  url: "https://item.jd.com/1001.html",
                  contentId: "1001"
                },
                sourceRole: "OFFER",
                subject: {
                  subjectType: "OFFER",
                  candidateId: "candidate-monitor-a",
                  offerId: "offer-jd-1001",
                  channel: "JD",
                  sku: "1001"
                },
                claimLinks: [{ claimId: "claim-price", direction: "SUPPORTS" }]
              }
            }
          ]
        }
      })
    ).toEqual({
      evidence: [
        {
          evidenceId: "evidence-a",
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          capturedAt: "2026-08-28T10:00:00.000Z",
          validUntil: "2026-08-29T10:00:00.000Z",
          excerpt: "京东自营当前价格为 2999 元",
          excerptHash: {
            algorithm: "sha256",
            digest: createHash("sha256")
              .update("京东自营当前价格为 2999 元", "utf8")
              .digest("hex")
          },
          locator: { section: "商品价格", field: "当前售价" },
          parserVersion: "fixture-adapter@1",
          rawArtifact: {
            algorithm: "sha256",
            digest: "a".repeat(64),
            objectKey: `source-artifacts/sha256/${"a".repeat(64)}`,
            lifecycle: "TRANSIENT_PLATFORM",
            expiresAt: "2026-09-04T10:00:00.000Z"
          },
          source: {
            sourceType: "LIVE_PLATFORM",
            sourceId: "jd",
            platform: "JD",
            title: "京东商品详情",
            url: "https://item.jd.com/1001.html",
            contentId: "1001"
          },
          sourceRole: "OFFER",
          subject: {
            subjectType: "OFFER",
            candidateId: "candidate-monitor-a",
            offerId: "offer-jd-1001",
            channel: "JD",
            sku: "1001"
          }
        }
      ],
      claimEvidenceLinks: [
        {
          linkId: "link-a",
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          claimId: "claim-price",
          evidenceId: "evidence-a",
          direction: "SUPPORTS"
        }
      ],
      gaps: []
    });
  });

  it("rejects a Source Research batch from another User before generating Evidence", () => {
    const nextEvidenceId = vi.fn(() => "evidence-never");
    const nextGapId = vi.fn(() => "gap-never");
    const nextLinkId = vi.fn(() => "link-never");
    const module = createEvidenceModule({ nextEvidenceId, nextGapId, nextLinkId });

    expect(() =>
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-a"],
        batch: {
          ownerUserId: "user-b",
          decisionTaskId: "task-a",
          results: []
        }
      })
    ).toThrow("EVIDENCE_BATCH_SCOPE_MISMATCH");
    expect(nextEvidenceId).not.toHaveBeenCalled();
    expect(nextGapId).not.toHaveBeenCalled();
    expect(nextLinkId).not.toHaveBeenCalled();
  });

  it("turns Source Research material without a Locator into an Evidence Gap", () => {
    const nextEvidenceId = vi.fn(() => "evidence-never");
    const nextLinkId = vi.fn(() => "link-never");
    const module = createEvidenceModule({
      nextEvidenceId,
      nextGapId: () => "gap-invalid-material",
      nextLinkId
    });

    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [
            {
              resultKey: "jd:item-1001:offer",
              material: {
                capturedAt: "2026-08-28T10:00:00.000Z",
                validUntil: "2026-08-29T10:00:00.000Z",
                excerpt: "京东自营当前价格为 2999 元",
                parserVersion: "fixture-adapter@1",
                rawArtifact: {
                  algorithm: "sha256",
                  digest: "a".repeat(64),
                  objectKey: `source-artifacts/sha256/${"a".repeat(64)}`,
                  lifecycle: "TRANSIENT_PLATFORM",
                  expiresAt: "2026-09-04T10:00:00.000Z"
                },
                source: {
                  sourceType: "LIVE_PLATFORM",
                  sourceId: "jd",
                  platform: "JD",
                  title: "京东商品详情",
                  url: "https://item.jd.com/1001.html"
                },
                sourceRole: "OFFER",
                subject: {
                  subjectType: "OFFER",
                  candidateId: "candidate-monitor-a",
                  offerId: "offer-jd-1001",
                  channel: "JD",
                  sku: "1001"
                },
                claimLinks: [{ claimId: "claim-price", direction: "SUPPORTS" }]
              } as never
            }
          ]
        }
      })
    ).toEqual({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [
        {
          gapId: "gap-invalid-material",
          code: "EVIDENCE_MATERIAL_INVALID",
          decisionTaskId: "task-a",
          resultKey: "jd:item-1001:offer",
          critical: true
        }
      ]
    });
    expect(nextEvidenceId).not.toHaveBeenCalled();
    expect(nextLinkId).not.toHaveBeenCalled();
  });

  it("turns an untrusted non-object Adapter result into an Evidence Gap", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-never",
      nextGapId: () => "gap-untrusted-material",
      nextLinkId: () => "link-never"
    });

    expect(() =>
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [{ resultKey: "adapter:invalid", material: null as never }]
        }
      })
    ).not.toThrow();
    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [{ resultKey: "adapter:invalid", material: null as never }]
        }
      })
    ).toEqual({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [
        {
          gapId: "gap-untrusted-material",
          code: "EVIDENCE_MATERIAL_INVALID",
          decisionTaskId: "task-a",
          resultKey: "adapter:invalid",
          critical: true
        }
      ]
    });
  });

  it("rejects Source Research material linked to an unknown Claim", () => {
    const nextEvidenceId = vi.fn(() => "evidence-never");
    const nextLinkId = vi.fn(() => "link-never");
    const module = createEvidenceModule({
      nextEvidenceId,
      nextGapId: () => "gap-claim-link",
      nextLinkId
    });

    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [
            {
              resultKey: "jd:item-1001:offer",
              material: researchMaterial({
                claimLinks: [{ claimId: "claim-from-another-task", direction: "SUPPORTS" }]
              })
            }
          ]
        }
      })
    ).toEqual({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [
        {
          gapId: "gap-claim-link",
          code: "CLAIM_LINK_INVALID",
          decisionTaskId: "task-a",
          resultKey: "jd:item-1001:offer",
          critical: true
        }
      ]
    });
    expect(nextEvidenceId).not.toHaveBeenCalled();
    expect(nextLinkId).not.toHaveBeenCalled();
  });

  it("projects only bounded Evidence excerpts to CoreMind without raw artifacts", () => {
    let evidenceSequence = 0;
    let linkSequence = 0;
    const module = createEvidenceModule({
      nextEvidenceId: () => `evidence-${++evidenceSequence}`,
      nextGapId: () => "gap-unused",
      nextLinkId: () => `link-${++linkSequence}`,
      projectionLimits: { maxEvidence: 1, maxExcerptCharacters: 8 }
    });
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [
          {
            resultKey: "jd:first",
            material: researchMaterial({ excerpt: "1234567890ABCDEF" })
          },
          {
            resultKey: "jd:second",
            material: researchMaterial({ excerpt: "第二条不应进入本次投影" })
          }
        ]
      }
    });

    const projection = module.projectForCoreMind({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      decisionValidFrom: "2026-08-28T12:00:00.000Z",
      evidence: normalized.evidence,
      claimEvidenceLinks: normalized.claimEvidenceLinks
    });

    expect(projection).toEqual({
      items: [
        {
          evidenceId: "evidence-1",
          capturedAt: "2026-08-28T10:00:00.000Z",
          validUntil: "2026-08-29T10:00:00.000Z",
          excerpt: "12345678",
          excerptTruncated: true,
          locator: { section: "商品价格", field: "当前售价" },
          source: {
            sourceType: "LIVE_PLATFORM",
            sourceId: "jd",
            platform: "JD",
            title: "京东商品详情",
            url: "https://item.jd.com/1001.html",
            contentId: "1001"
          },
          sourceRole: "OFFER",
          subject: {
            subjectType: "OFFER",
            candidateId: "candidate-monitor-a",
            offerId: "offer-jd-1001",
            channel: "JD",
            sku: "1001"
          },
          claimLinks: [{ claimId: "claim-price", direction: "SUPPORTS" }]
        }
      ],
      hasMore: true
    });
    expect(JSON.stringify(projection)).not.toContain("source-artifacts/");
    expect(JSON.stringify(projection)).not.toContain("rawArtifact");
  });

  it("strips untrusted nested fields before creating a CoreMind projection", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-sanitized",
      nextGapId: () => "gap-unused",
      nextLinkId: () => "link-sanitized"
    });
    const material = researchMaterial();
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [
          {
            resultKey: "jd:untrusted-extra-fields",
            material: {
              ...material,
              locator: { ...material.locator, fullPage: "不得进入模型" },
              source: { ...material.source, cookie: "session-secret" },
              subject: { ...material.subject, rawComments: "不得进入模型" }
            }
          }
        ]
      }
    });

    const projection = module.projectForCoreMind({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      decisionValidFrom: "2026-08-28T12:00:00.000Z",
      evidence: normalized.evidence,
      claimEvidenceLinks: normalized.claimEvidenceLinks
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("fullPage");
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("rawComments");
  });

  it.each([
    "https://user:synthetic-secret@brand.example/product",
    "https://user@brand.example/product",
    "https://:synthetic-secret@brand.example/product"
  ])("rejects credential-bearing Evidence source URLs: %s", (url) => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-never",
      nextGapId: () => "gap-invalid-source",
      nextLinkId: () => "link-never"
    });
    const material = researchMaterial();
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [{
          resultKey: "source:credentials",
          material: { ...material, source: { ...material.source, url } }
        }]
      }
    });
    expect(normalized).toMatchObject({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [{ code: "EVIDENCE_MATERIAL_INVALID" }]
    });
    expect(JSON.stringify(normalized)).not.toContain("synthetic-secret");
  });

  it("enforces hard CoreMind limits even when configured limits are larger", () => {
    let evidenceSequence = 0;
    let linkSequence = 0;
    const module = createEvidenceModule({
      nextEvidenceId: () => `evidence-hard-limit-${++evidenceSequence}`,
      nextGapId: () => "gap-unused",
      nextLinkId: () => `link-hard-limit-${++linkSequence}`,
      projectionLimits: { maxEvidence: 100, maxExcerptCharacters: 5_000 }
    });
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: Array.from({ length: 21 }, (_, index) => ({
          resultKey: `jd:hard-limit:${index}`,
          material: researchMaterial({ excerpt: "x".repeat(2_001) })
        }))
      }
    });

    const projection = module.projectForCoreMind({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      decisionValidFrom: "2026-08-28T12:00:00.000Z",
      evidence: normalized.evidence,
      claimEvidenceLinks: normalized.claimEvidenceLinks
    });
    expect(projection.items).toHaveLength(20);
    expect(projection.items.every((item) => item.excerpt.length === 2_000)).toBe(true);
    expect(projection.hasMore).toBe(true);
  });

  it("rejects oversized excerpts instead of treating full payloads as Evidence", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-never",
      nextGapId: () => "gap-oversized-excerpt",
      nextLinkId: () => "link-never"
    });

    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [
            {
              resultKey: "jd:full-page",
              material: researchMaterial({ excerpt: "x".repeat(8_001) })
            }
          ]
        }
      })
    ).toEqual({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [
        {
          gapId: "gap-oversized-excerpt",
          code: "EVIDENCE_MATERIAL_INVALID",
          decisionTaskId: "task-a",
          resultKey: "jd:full-page",
          critical: true
        }
      ]
    });
  });

  it("rejects projection inputs that would expose orphan Evidence", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-linked",
      nextGapId: () => "gap-unused",
      nextLinkId: () => "link-linked"
    });
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [{ resultKey: "jd:linked", material: researchMaterial() }]
      }
    });

    expect(() =>
      module.projectForCoreMind({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        decisionValidFrom: "2026-08-28T12:00:00.000Z",
        evidence: normalized.evidence,
        claimEvidenceLinks: []
      })
    ).toThrowError("EVIDENCE_PROJECTION_LINK_INVALID");
  });

  it("expands one owned Evidence excerpt without exposing its raw artifact", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-expand",
      nextGapId: () => "gap-unused",
      nextLinkId: () => "link-expand",
      projectionLimits: { maxEvidence: 1, maxExcerptCharacters: 8 }
    });
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [
          {
            resultKey: "jd:expand",
            material: researchMaterial({ excerpt: "这是完整但仍然有界的证据短摘录" })
          }
        ]
      }
    });

    const expanded = module.expandEvidence({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      evidenceId: "evidence-expand",
      evidence: normalized.evidence
    });
    expect(expanded).toMatchObject({
      evidenceId: "evidence-expand",
      excerpt: "这是完整但仍然有界的证据短摘录",
      locator: { section: "商品价格", field: "当前售价" }
    });
    expect(JSON.stringify(expanded)).not.toContain("rawArtifact");
    expect(
      module.expandEvidence({
        ownerUserId: "user-b",
        decisionTaskId: "task-a",
        evidenceId: "evidence-expand",
        evidence: normalized.evidence
      })
    ).toBeUndefined();
  });

  it("turns an inverted Evidence validity interval into a Critical Gap", () => {
    const nextEvidenceId = vi.fn(() => "evidence-never");
    const module = createEvidenceModule({
      nextEvidenceId,
      nextGapId: () => "gap-invalid-time",
      nextLinkId: () => "link-never"
    });

    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [
            {
              resultKey: "jd:invalid-time",
              material: researchMaterial({
                capturedAt: "2026-08-29T10:00:00.000Z",
                validUntil: "2026-08-28T10:00:00.000Z"
              })
            }
          ]
        }
      })
    ).toEqual({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [
        {
          gapId: "gap-invalid-time",
          code: "EVIDENCE_TIME_INVALID",
          decisionTaskId: "task-a",
          resultKey: "jd:invalid-time",
          critical: true
        }
      ]
    });
    expect(nextEvidenceId).not.toHaveBeenCalled();
  });

  it("rejects a Live Platform artifact whose retention exceeds seven days", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-never",
      nextGapId: () => "gap-artifact-lifecycle",
      nextLinkId: () => "link-never"
    });

    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [
            {
              resultKey: "jd:retention-too-long",
              material: researchMaterial({
                rawArtifact: {
                  algorithm: "sha256",
                  digest: "a".repeat(64),
                  objectKey: `source-artifacts/sha256/${"a".repeat(64)}`,
                  lifecycle: "TRANSIENT_PLATFORM",
                  expiresAt: "2026-09-05T10:00:00.000Z"
                }
              })
            }
          ]
        }
      })
    ).toEqual({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [
        {
          gapId: "gap-artifact-lifecycle",
          code: "EVIDENCE_ARTIFACT_LIFECYCLE_INVALID",
          decisionTaskId: "task-a",
          resultKey: "jd:retention-too-long",
          critical: true
        }
      ]
    });
  });

  it("keeps historical eligibility while excluding Evidence from decisions after retirement", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-retired",
      nextGapId: () => "gap-unused",
      nextLinkId: () => "link-retired"
    });
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [
          {
            resultKey: "jd:retired",
            material: researchMaterial({ validUntil: "2026-09-30T10:00:00.000Z" })
          }
        ]
      }
    });
    const retiredEvidence = normalized.evidence.map((item) => ({
      ...item,
      retiredAt: "2026-08-29T10:00:00.000Z"
    }));

    expect(
      module.projectForCoreMind({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        decisionValidFrom: "2026-08-28T12:00:00.000Z",
        evidence: retiredEvidence,
        claimEvidenceLinks: normalized.claimEvidenceLinks
      }).items
    ).toHaveLength(1);
    expect(
      module.projectForCoreMind({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        decisionValidFrom: "2026-08-30T12:00:00.000Z",
        evidence: retiredEvidence,
        claimEvidenceLinks: normalized.claimEvidenceLinks
      })
    ).toEqual({ items: [], hasMore: false });
  });

  it("does not create orphan Evidence when Source Research supplies no Claim relation", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-never",
      nextGapId: () => "gap-orphan",
      nextLinkId: () => "link-never"
    });

    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [
            {
              resultKey: "jd:orphan",
              material: researchMaterial({ claimLinks: [] })
            }
          ]
        }
      })
    ).toEqual({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [
        {
          gapId: "gap-orphan",
          code: "CLAIM_LINK_INVALID",
          decisionTaskId: "task-a",
          resultKey: "jd:orphan",
          critical: true
        }
      ]
    });
  });

  it("rejects opposite directions for the same Claim and Evidence material", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-never",
      nextGapId: () => "gap-opposite-link",
      nextLinkId: () => "link-never"
    });

    expect(
      module.normalizeResearchBatch({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        claimIds: ["claim-price"],
        batch: {
          ownerUserId: "user-a",
          decisionTaskId: "task-a",
          results: [
            {
              resultKey: "jd:ambiguous",
              material: researchMaterial({
                claimLinks: [
                  { claimId: "claim-price", direction: "SUPPORTS" },
                  { claimId: "claim-price", direction: "REFUTES" }
                ]
              })
            }
          ]
        }
      })
    ).toEqual({
      evidence: [],
      claimEvidenceLinks: [],
      gaps: [
        {
          gapId: "gap-opposite-link",
          code: "CLAIM_LINK_INVALID",
          decisionTaskId: "task-a",
          resultKey: "jd:ambiguous",
          critical: true
        }
      ]
    });
  });

  it("preserves conflicting links from separate Evidence for Decision Basis", () => {
    const evidenceIds = ["evidence-support", "evidence-refute"];
    const linkIds = ["link-support", "link-refute"];
    const module = createEvidenceModule({
      nextEvidenceId: () => evidenceIds.shift() ?? "evidence-unexpected",
      nextGapId: () => "gap-unexpected",
      nextLinkId: () => linkIds.shift() ?? "link-unexpected"
    });

    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [
          {
            resultKey: "jd:price",
            material: researchMaterial({
              excerpt: "京东自营当前价格为 2999 元",
              claimLinks: [{ claimId: "claim-price", direction: "SUPPORTS" }]
            })
          },
          {
            resultKey: "smzdm:price-history",
            material: researchMaterial({
              excerpt: "历史价格显示 2999 元并非近期低价",
              claimLinks: [{ claimId: "claim-price", direction: "REFUTES" }]
            })
          }
        ]
      }
    });

    expect(normalized.gaps).toEqual([]);
    expect(normalized.evidence).toHaveLength(2);
    expect(normalized.claimEvidenceLinks).toEqual([
      expect.objectContaining({
        evidenceId: "evidence-support",
        claimId: "claim-price",
        direction: "SUPPORTS"
      }),
      expect.objectContaining({
        evidenceId: "evidence-refute",
        claimId: "claim-price",
        direction: "REFUTES"
      })
    ]);
  });

  it("normalizes Private File derived material through the same Evidence chain", () => {
    const module = createEvidenceModule({
      nextEvidenceId: () => "evidence-private-file",
      nextGapId: () => "gap-unused",
      nextLinkId: () => "link-private-file"
    });

    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-usb-c"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [
          {
            resultKey: "private-file:manual:page-8",
            material: privateFileMaterial()
          }
        ]
      }
    });

    expect(normalized.gaps).toEqual([]);
    expect(normalized.evidence).toMatchObject([
      {
        evidenceId: "evidence-private-file",
        sourceRole: "OFFICIAL",
        source: {
          sourceType: "PRIVATE_FILE",
          sourceId: "private-file-manual",
          fileId: "file-manual",
          title: "显示器说明书.pdf",
          mediaType: "application/pdf"
        },
        rawArtifact: {
          lifecycle: "PRIVATE_FILE"
        }
      }
    ]);
  });

  it("purges only expired transient artifacts while retaining reviewable Evidence", async () => {
    const deletedArtifacts: string[] = [];
    let evidenceSequence = 0;
    let linkSequence = 0;
    const module = createEvidenceModule({
      deleteRawArtifact: async (artifact) => {
        deletedArtifacts.push(artifact.objectKey);
      },
      nextEvidenceId: () => `evidence-${++evidenceSequence}`,
      nextGapId: () => "gap-unused",
      nextLinkId: () => `link-${++linkSequence}`
    });
    const normalized = module.normalizeResearchBatch({
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      claimIds: ["claim-price", "claim-usb-c"],
      batch: {
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        results: [
          { resultKey: "jd:expired", material: researchMaterial() },
          { resultKey: "file:retained", material: privateFileMaterial() }
        ]
      }
    });

    await expect(
      module.purgeExpiredRawArtifacts({
        now: "2026-09-05T10:00:00.000Z",
        ownerUserId: "user-a",
        evidence: normalized.evidence
      })
    ).resolves.toEqual({ deleted: 1 });
    expect(deletedArtifacts).toEqual([
      `source-artifacts/sha256/${"a".repeat(64)}`
    ]);
    expect(
      module.projectForCoreMind({
        ownerUserId: "user-a",
        decisionTaskId: "task-a",
        decisionValidFrom: "2026-08-28T12:00:00.000Z",
        evidence: normalized.evidence,
        claimEvidenceLinks: normalized.claimEvidenceLinks
      }).items
    ).toHaveLength(2);
  });

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

  it("returns a redirect target before inspecting MIME or reading the body", async () => {
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
      resolvedAddress: "93.184.216.34",
      sourceId: "source-redirect-rejected",
      title: "Redirect rejected fixture",
      url: "https://example.com/choicemind/p0-fixture"
    });

    expect(result).toEqual({
      ok: false,
      redirect: { location: "https://unapproved.example/private" },
      metrics: { bytesFetched: 0, durationMs: 5 }
    });
    expect(bodyReadCount).toBe(0);
  });

  it("follows an approved HTTPS redirect and records every hop before collection", async () => {
    const body = new TextEncoder().encode("<main>ChoiceMind redirected fixture</main>");
    const responses = [
      {
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers({ location: "https://example.com/final" }),
        ok: false,
        status: 302,
        url: "https://example.com/start"
      },
      {
        arrayBuffer: async () => body.buffer,
        headers: new Headers({ "content-type": "text/html" }),
        ok: true,
        status: 200,
        url: "https://example.com/final"
      }
    ];
    const egressOperations: string[] = [];
    const pinnedAddresses: string[] = [];
    const controller = new AbortController();
    const connector = createHttpDataSourceConnector({
      fetch: async (request) => {
        pinnedAddresses.push(request.resolvedAddress);
        expect(request.signal.aborted).toBe(false);
        const response = responses.shift();
        if (response === undefined) throw new Error("发生了未计划的额外请求");
        return response;
      },
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          return {
            algorithm: "sha256",
            digest: "d".repeat(64),
            objectKey: `evidence-raw/sha256/${"d".repeat(64)}`
          };
        }
      },
      readDurationMs: () => 12
    });
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/start"]),
      approvedSourceOrigins: new Set(["https://example.com"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector,
      egressGuard: createEgressGuard({
        appendRecord: async (record) => {
          egressOperations.push(record.operationId);
        },
        nextId: () => `egress-${egressOperations.length + 1}`,
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-redirect",
      resolveHost: async () => ["93.184.216.34"]
    });
    type FollowResult = Awaited<ReturnType<typeof service.ingest>>;
    expectTypeOf<Extract<FollowResult, { status: "REDIRECT" }>>().toEqualTypeOf<never>();

    const result = await service.ingest({
      correlationId: "correlation-redirect",
      decisionTaskId: "task-redirect",
      operationId: "collect-redirect",
      source: {
        sourceId: "source-redirect",
        title: "Redirect fixture",
        url: "https://example.com/start"
      },
      signal: controller.signal,
      userId: "user-redirect"
    });

    expect(result).toMatchObject({
      status: "COLLECTED",
      collection: { sourceFacts: { url: "https://example.com/final" } }
    });
    expect(egressOperations).toEqual([
      "collect-redirect:hop-0",
      "collect-redirect:hop-1"
    ]);
    expect(pinnedAddresses).toEqual(["93.184.216.34", "93.184.216.34"]);
  });

  it("returns an approved redirect for a browser to request through the service again", async () => {
    const collect = vi.fn(async () => ({
      ok: false as const,
      redirect: { location: "/final" },
      metrics: { bytesFetched: 0, durationMs: 3 }
    }));
    const resolveHost = vi.fn(async () => ["93.184.216.34"]);
    const egressOperations: string[] = [];
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/start"]),
      approvedSourceOrigins: new Set(["https://example.com"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector: { collect },
      egressGuard: createEgressGuard({
        appendRecord: async (record) => {
          egressOperations.push(record.operationId);
        },
        nextId: () => "egress-manual-redirect",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-manual-redirect",
      redirectMode: "manual",
      resolveHost
    });
    type ManualResult = Awaited<ReturnType<typeof service.ingest>>;
    type HasManualRedirect = Extract<ManualResult, { status: "REDIRECT" }> extends never
      ? false
      : true;
    expectTypeOf<HasManualRedirect>().toEqualTypeOf<true>();

    await expect(
      service.ingest({
        correlationId: "correlation-manual-redirect",
        decisionTaskId: "task-manual-redirect",
        operationId: "collect-manual-redirect",
        source: {
          sourceId: "source-manual-redirect",
          title: "Manual redirect fixture",
          url: "https://example.com/start"
        },
        userId: "user-manual-redirect"
      })
    ).resolves.toEqual({
      status: "REDIRECT",
      location: "https://example.com/final",
      metrics: { bytesFetched: 0, durationMs: 3 }
    });
    expect(collect).toHaveBeenCalledOnce();
    expect(resolveHost).toHaveBeenCalledOnce();
    expect(egressOperations).toEqual(["collect-manual-redirect:hop-0"]);
  });

  it.each([
    ["an unapproved origin", "https://unapproved.example/private"],
    ["HTTP", "http://example.com/private"],
    ["credentials", "https://user@example.com/private"]
  ])("rejects a manual redirect containing %s", async (_name, location) => {
    const collect = vi.fn(async () => ({
      ok: false as const,
      redirect: { location },
      metrics: { bytesFetched: 0, durationMs: 3 }
    }));
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/start"]),
      approvedSourceOrigins: new Set(["https://example.com"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector: { collect },
      egressGuard: createEgressGuard({
        appendRecord: async () => {},
        nextId: () => "egress-manual-unsafe-redirect",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-manual-unsafe-redirect",
      redirectMode: "manual",
      resolveHost: async () => ["93.184.216.34"]
    });

    await expect(
      service.ingest({
        correlationId: "correlation-manual-unsafe-redirect",
        decisionTaskId: "task-manual-unsafe-redirect",
        operationId: "collect-manual-unsafe-redirect",
        source: {
          sourceId: "source-manual-unsafe-redirect",
          title: "Unsafe redirect fixture",
          url: "https://example.com/start"
        },
        userId: "user-manual-unsafe-redirect"
      })
    ).resolves.toMatchObject({
      status: "EVIDENCE_GAP",
      gap: { code: "SOURCE_REDIRECT_REJECTED", retryable: false }
    });
    expect(collect).toHaveBeenCalledOnce();
  });

  it("rejects an unapproved redirect before the second DNS, egress, or fetch", async () => {
    let fetchCount = 0;
    let resolveCount = 0;
    const egressOperations: string[] = [];
    const connector = createHttpDataSourceConnector({
      fetch: async () => {
        fetchCount += 1;
        return {
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: new Headers({ location: "https://unapproved.example/private" }),
          ok: false,
          status: 302,
          url: "https://example.com/start"
        };
      },
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          throw new Error("重定向响应不得写对象存储");
        }
      },
      readDurationMs: () => 4
    });
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/start"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector,
      egressGuard: createEgressGuard({
        appendRecord: async (record) => {
          egressOperations.push(record.operationId);
        },
        nextId: () => "egress-unapproved-redirect",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-unapproved-redirect",
      resolveHost: async () => {
        resolveCount += 1;
        return ["93.184.216.34"];
      }
    });

    await expect(
      service.ingest({
        correlationId: "correlation-unapproved-redirect",
        decisionTaskId: "task-unapproved-redirect",
        operationId: "collect-unapproved-redirect",
        source: {
          sourceId: "source-unapproved-redirect",
          title: "Unapproved redirect fixture",
          url: "https://example.com/start"
        },
        userId: "user-unapproved-redirect"
      })
    ).resolves.toMatchObject({
      status: "EVIDENCE_GAP",
      gap: { code: "SOURCE_REDIRECT_REJECTED", retryable: false }
    });
    expect(fetchCount).toBe(1);
    expect(resolveCount).toBe(1);
    expect(egressOperations).toEqual(["collect-unapproved-redirect:hop-0"]);
  });

  it("rejects same-origin redirects containing credentials before the second fetch", async () => {
    let fetchCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => {
        fetchCount += 1;
        return {
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: new Headers({ location: "https://user@example.com/private" }),
          ok: false,
          status: 302,
          url: "https://example.com/start"
        };
      },
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: { put: async () => { throw new Error("不得写对象存储"); } },
      readDurationMs: () => 4
    });
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/start"]),
      approvedSourceOrigins: new Set(["https://example.com"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector,
      egressGuard: createEgressGuard({
        appendRecord: async () => {},
        nextId: () => "egress-credential-redirect",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-credential-redirect",
      resolveHost: async () => ["93.184.216.34"]
    });

    await expect(
      service.ingest({
        correlationId: "correlation-credential-redirect",
        decisionTaskId: "task-credential-redirect",
        operationId: "collect-credential-redirect",
        source: {
          sourceId: "source-credential-redirect",
          title: "Credential redirect fixture",
          url: "https://example.com/start"
        },
        userId: "user-credential-redirect"
      })
    ).resolves.toMatchObject({
      status: "EVIDENCE_GAP",
      gap: { code: "SOURCE_REDIRECT_REJECTED", retryable: false }
    });
    expect(fetchCount).toBe(1);
  });

  it("rejects a fourth redirect after auditing the first four requests", async () => {
    let fetchCount = 0;
    const egressOperations: string[] = [];
    const connector = createHttpDataSourceConnector({
      fetch: async (input) => {
        fetchCount += 1;
        return {
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: new Headers({ location: `/hop-${fetchCount}` }),
          ok: false,
          status: 302,
          url: input.url
        };
      },
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: { put: async () => { throw new Error("重定向不得写对象存储"); } },
      readDurationMs: () => 2
    });
    const service = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://example.com/start"]),
      approvedSourceOrigins: new Set(["https://example.com"]),
      collectionPolicy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
      connector,
      egressGuard: createEgressGuard({
        appendRecord: async (record) => {
          egressOperations.push(record.operationId);
        },
        nextId: () => `egress-max-redirect-${egressOperations.length + 1}`,
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-max-redirect",
      resolveHost: async () => ["93.184.216.34"]
    });

    await expect(
      service.ingest({
        correlationId: "correlation-max-redirect",
        decisionTaskId: "task-max-redirect",
        operationId: "collect-max-redirect",
        source: {
          sourceId: "source-max-redirect",
          title: "Max redirect fixture",
          url: "https://example.com/start"
        },
        userId: "user-max-redirect"
      })
    ).resolves.toMatchObject({
      status: "EVIDENCE_GAP",
      gap: { code: "SOURCE_REDIRECT_REJECTED", retryable: false }
    });
    expect(fetchCount).toBe(4);
    expect(egressOperations).toEqual([
      "collect-max-redirect:hop-0",
      "collect-max-redirect:hop-1",
      "collect-max-redirect:hop-2",
      "collect-max-redirect:hop-3"
    ]);
  });

  it("turns a fetch timeout into a retryable structured error", async () => {
    let observedSignal: AbortSignal | undefined;
    const connector = createHttpDataSourceConnector({
      fetch: async (input) => {
        observedSignal = input.signal;
        return await new Promise((_, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), {
            once: true
          });
        });
      },
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          throw new Error("超时请求不得写对象存储");
        }
      },
      readDurationMs: () => 15,
      timeoutMs: 5
    });

    await expect(
      connector.collect({
        policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
        resolvedAddress: "93.184.216.34",
        sourceId: "source-timeout",
        title: "Timeout fixture",
        url: "https://example.com/timeout"
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: "SOURCE_FETCH_FAILED", retryable: true },
      metrics: { bytesFetched: 0, durationMs: 15 }
    });
    expect(observedSignal?.aborted).toBe(true);
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
      resolvedAddress: "93.184.216.34",
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

  it("treats HTTP 429 as retryable without reading the body", async () => {
    let bodyReadCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => {
          bodyReadCount += 1;
          return new ArrayBuffer(0);
        },
        headers: new Headers(),
        ok: false,
        status: 429,
        url: "https://example.com/rate-limited"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          throw new Error("限流响应不得写对象存储");
        }
      },
      readDurationMs: () => 6
    });

    await expect(
      connector.collect({
        policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
        resolvedAddress: "93.184.216.34",
        sourceId: "source-rate-limited",
        title: "Rate limited fixture",
        url: "https://example.com/rate-limited"
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: "SOURCE_FETCH_FAILED", retryable: true },
      metrics: { bytesFetched: 0, durationMs: 6 }
    });
    expect(bodyReadCount).toBe(0);
  });

  it("reports an HTTP access challenge as a final structured failure", async () => {
    let cancelCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
        body: new ReadableStream({
          cancel() {
            cancelCount += 1;
          }
        }),
        headers: new Headers(),
        ok: false,
        status: 403,
        url: "https://example.com/protected"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          throw new Error("访问挑战响应不得写对象存储");
        }
      },
      readDurationMs: () => 6
    });

    await expect(
      connector.collect({
        policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
        resolvedAddress: "93.184.216.34",
        sourceId: "source-protected",
        title: "Protected fixture",
        url: "https://example.com/protected"
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: "SOURCE_ACCESS_CHALLENGE", retryable: false },
      metrics: { bytesFetched: 0, durationMs: 6 }
    });
    expect(cancelCount).toBe(1);
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
      resolvedAddress: "93.184.216.34",
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

  it("rejects non-identity content encoding before reading or storing the body", async () => {
    let bodyReadCount = 0;
    let objectWriteCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => {
          bodyReadCount += 1;
          return new Uint8Array([0x1f, 0x8b]).buffer;
        },
        headers: new Headers({
          "content-encoding": "gzip",
          "content-type": "text/html"
        }),
        ok: true,
        status: 200,
        url: "https://example.com/compressed"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          objectWriteCount += 1;
          throw new Error("压缩正文不得写对象存储");
        }
      },
      readDurationMs: () => 7
    });

    await expect(
      connector.collect({
        policy: { allowedMediaTypes: ["text/html"], maxBytes: 1_048_576 },
        resolvedAddress: "93.184.216.34",
        sourceId: "source-compressed",
        title: "Compressed fixture",
        url: "https://example.com/compressed"
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: "SOURCE_FETCH_FAILED", retryable: false },
      metrics: { bytesFetched: 0, durationMs: 7 }
    });
    expect(bodyReadCount).toBe(0);
    expect(objectWriteCount).toBe(0);
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
      resolvedAddress: "93.184.216.34",
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
      resolvedAddress: "93.184.216.34",
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
        async put(bytes, retention) {
          expect(retention).toEqual({ expiresAt: "2026-09-02T00:00:01.000Z" });
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
      resolvedAddress: "93.184.216.34",
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

  it("includes only browser-safe response metadata when explicitly requested", async () => {
    const body = new TextEncoder().encode("console.log('ChoiceMind')");
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => body.buffer,
        headers: new Headers({
          "access-control-allow-origin": "https://brand.example",
          "content-security-policy": "default-src 'self'",
          "content-type": "text/javascript; charset=utf-8",
          "cross-origin-resource-policy": "same-origin",
          "referrer-policy": "no-referrer",
          "set-cookie": "session=secret",
          "x-content-type-options": "nosniff",
          "x-internal-secret": "hidden"
        }),
        ok: true,
        status: 200,
        url: "https://brand.example/app.js"
      }),
      collectorVersion: "http-connector@1",
      includeResponseMetadata: true,
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          return {
            algorithm: "sha256",
            digest: "e".repeat(64),
            objectKey: `evidence-raw/sha256/${"e".repeat(64)}`
          };
        }
      },
      readDurationMs: () => 4
    });
    const metadataService = createEvidenceIngestionService({
      approvedSourceUrls: new Set(["https://brand.example/app.js"]),
      approvedSourceOrigins: new Set(["https://brand.example"]),
      collectionPolicy: { allowedMediaTypes: ["text/javascript"], maxBytes: 1_048_576 },
      connector,
      egressGuard: createEgressGuard({
        appendRecord: async () => {},
        nextId: () => "egress-metadata-type",
        now: () => new Date("2026-08-26T00:00:00.000Z")
      }),
      nextGapId: () => "gap-metadata-type",
      redirectMode: "manual",
      resolveHost: async () => ["93.184.216.34"]
    });
    type MetadataServiceResult = Awaited<ReturnType<typeof metadataService.ingest>>;
    type MetadataCollection = Extract<
      MetadataServiceResult,
      { status: "COLLECTED" }
    >["collection"];
    expectTypeOf<MetadataCollection["response"]>().toEqualTypeOf<DataSourceResponseMetadata>();

    const result = await connector.collect({
      policy: { allowedMediaTypes: ["text/javascript"], maxBytes: 1_048_576 },
      resolvedAddress: "93.184.216.34",
      sourceId: "source-browser-script",
      title: "Browser script fixture",
      url: "https://brand.example/app.js"
    });

    expect(result).toMatchObject({
      ok: true,
      sourceFacts: { collectorVersion: "http-connector@1" },
      response: {
        status: 200,
        headers: {
          "access-control-allow-origin": "https://brand.example",
          "content-security-policy": "default-src 'self'",
          "content-type": "text/javascript; charset=utf-8",
          "cross-origin-resource-policy": "same-origin",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain("set-cookie");
    expect(JSON.stringify(result)).not.toContain("x-internal-secret");
    if (result.ok) expect(result.response.status).toBe(200);
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
      resolvedAddress: "93.184.216.34",
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

  it("stops a streamed body as soon as it crosses the byte limit", async () => {
    let objectWriteCount = 0;
    let arrayBufferReadCount = 0;
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({
        arrayBuffer: async () => {
          arrayBufferReadCount += 1;
          throw new Error("真实 Response 流存在时不得回退到整包读取");
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          }
        }),
        headers: new Headers({ "content-type": "text/html" }),
        ok: true,
        status: 200,
        url: "https://example.com/streamed"
      }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: {
        async put() {
          objectWriteCount += 1;
          throw new Error("流式正文超限时不得写对象存储");
        }
      },
      readDurationMs: () => 9
    });

    await expect(
      connector.collect({
        policy: { allowedMediaTypes: ["text/html"], maxBytes: 4 },
        resolvedAddress: "93.184.216.34",
        sourceId: "source-streamed",
        title: "Streamed fixture",
        url: "https://example.com/streamed"
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
      metrics: { bytesFetched: 6, durationMs: 9 }
    });
    expect(arrayBufferReadCount).toBe(0);
    expect(objectWriteCount).toBe(0);
  });

  it("取消停滞的正文读取会释放流且不落盘", async () => {
    const abort = new AbortController();
    let enteredRead!: () => void;
    const reading = new Promise<void>((resolve) => { enteredRead = resolve; });
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      pull() { enteredRead(); },
      cancel
    }, { highWaterMark: 0 });
    const put = vi.fn();
    const connector = createHttpDataSourceConnector({
      fetch: async () => ({ body, arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers({ "content-type": "text/html" }), ok: true, status: 200,
        url: "https://example.com/stalled" }),
      now: () => new Date("2026-08-26T00:00:01.000Z"),
      objectStore: { put }, readDurationMs: () => 1
    });
    const result = connector.collect({ signal: abort.signal,
      policy: { allowedMediaTypes: ["text/html"], maxBytes: 100 },
      resolvedAddress: "93.184.216.34", sourceId: "stalled", title: "合成停滞响应",
      url: "https://example.com/stalled" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await reading;
      abort.abort();
      const deadline = new Promise<"STALLED">((resolve) => {
        timer = setTimeout(() => resolve("STALLED"), 200);
      });
      await expect(Promise.race([result, deadline])).resolves.toMatchObject({
        ok: false, error: { code: "SOURCE_FETCH_FAILED", retryable: true }
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(put).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    } finally {
      clearTimeout(timer);
      if (cancel.mock.calls.length === 0) streamController.close();
      await result.catch(() => undefined);
    }
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

function researchMaterial(
  overrides: Partial<ResearchEvidenceMaterial> = {}
): ResearchEvidenceMaterial {
  return {
    capturedAt: "2026-08-28T10:00:00.000Z",
    validUntil: "2026-08-29T10:00:00.000Z",
    excerpt: "京东自营当前价格为 2999 元",
    locator: { section: "商品价格", field: "当前售价" },
    parserVersion: "fixture-adapter@1",
    rawArtifact: {
      algorithm: "sha256",
      digest: "a".repeat(64),
      objectKey: `source-artifacts/sha256/${"a".repeat(64)}`,
      lifecycle: "TRANSIENT_PLATFORM",
      expiresAt: "2026-09-04T10:00:00.000Z"
    },
    source: {
      sourceType: "LIVE_PLATFORM",
      sourceId: "jd",
      platform: "JD",
      title: "京东商品详情",
      url: "https://item.jd.com/1001.html",
      contentId: "1001"
    },
    sourceRole: "OFFER",
    subject: {
      subjectType: "OFFER",
      candidateId: "candidate-monitor-a",
      offerId: "offer-jd-1001",
      channel: "JD",
      sku: "1001"
    },
    claimLinks: [{ claimId: "claim-price", direction: "SUPPORTS" }],
    ...overrides
  };
}

function privateFileMaterial(): ResearchEvidenceMaterial {
  return {
    capturedAt: "2026-08-28T10:00:00.000Z",
    validUntil: "2027-08-28T10:00:00.000Z",
    excerpt: "USB-C 接口支持最高 90W 供电",
    locator: { section: "第 8 页", field: "USB-C 端口" },
    parserVersion: "mineru@fixture",
    rawArtifact: {
      algorithm: "sha256",
      digest: "b".repeat(64),
      objectKey: `private-files/sha256/${"b".repeat(64)}`,
      lifecycle: "PRIVATE_FILE"
    },
    source: {
      sourceType: "PRIVATE_FILE",
      sourceId: "private-file-manual",
      fileId: "file-manual",
      title: "显示器说明书.pdf",
      mediaType: "application/pdf"
    },
    sourceRole: "OFFICIAL",
    subject: {
      subjectType: "CANDIDATE",
      candidateId: "candidate-monitor-a"
    },
    claimLinks: [{ claimId: "claim-usb-c", direction: "SUPPORTS" }]
  };
}
