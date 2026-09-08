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

import { isPublicNetworkAddress } from "./public-network-policy.js";

export type DataSourceArtifactRef = Readonly<{
  algorithm: "sha256";
  digest: string;
  objectKey: string;
}>;

export type DataSourceCollectionSuccess = Readonly<{
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
}>;

type DataSourceCollectionFailure =
  | Readonly<{
      ok: false;
      redirect: Readonly<{ location: string }>;
      metrics: Readonly<{ bytesFetched: number; durationMs: number }>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code:
          | "SOURCE_FETCH_FAILED"
          | "SOURCE_ACCESS_CHALLENGE"
          | "SOURCE_MIME_REJECTED"
          | "SOURCE_SIZE_EXCEEDED"
          | "SOURCE_REDIRECT_REJECTED";
        retryable: boolean;
      }>;
      metrics: Readonly<{ bytesFetched: number; durationMs: number }>;
    }>;

export type DataSourceCollectionResult =
  | DataSourceCollectionSuccess
  | DataSourceCollectionFailure;

export type DataSourceResponseMetadata = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
}>;

export type DataSourceCollectionResultWithResponseMetadata =
  | (DataSourceCollectionSuccess & Readonly<{ response: DataSourceResponseMetadata }>)
  | DataSourceCollectionFailure;

export type EvidenceSourceRole = "OFFICIAL" | "OFFER" | "INDEPENDENT";

export type EvidenceSubject =
  | Readonly<{
      subjectType: "CANDIDATE";
      candidateId: string;
    }>
  | Readonly<{
      subjectType: "OFFER";
      candidateId: string;
      offerId: string;
      channel: string;
      sku: string;
    }>;

export type EvidenceRawArtifact = DataSourceArtifactRef &
  (
    | Readonly<{ lifecycle: "TRANSIENT_PLATFORM"; expiresAt: string }>
    | Readonly<{ lifecycle: "PRIVATE_FILE" }>
  );

export type EvidenceSource =
  | Readonly<{
      sourceType: "LIVE_PLATFORM";
      sourceId: string;
      platform: string;
      title: string;
      url: string;
      contentId?: string;
    }>
  | Readonly<{
      sourceType: "PRIVATE_FILE";
      sourceId: string;
      fileId: string;
      title: string;
      mediaType: string;
    }>;

export type ResearchEvidenceMaterial = Readonly<{
  capturedAt: string;
  validUntil: string;
  excerpt: string;
  locator: Readonly<{ section: string; field: string }>;
  parserVersion: string;
  rawArtifact: EvidenceRawArtifact;
  source: EvidenceSource;
  sourceRole: EvidenceSourceRole;
  subject: EvidenceSubject;
  claimLinks: readonly Readonly<{
    claimId: string;
    direction: "SUPPORTS" | "REFUTES";
  }>[];
}>;

export type NormalizedEvidence = Omit<ResearchEvidenceMaterial, "claimLinks"> &
  Readonly<{
    evidenceId: string;
    ownerUserId: string;
    decisionTaskId: string;
    excerptHash: Readonly<{ algorithm: "sha256"; digest: string }>;
    retiredAt?: string;
  }>;

export type NormalizedClaimEvidenceLink = Readonly<{
  linkId: string;
  ownerUserId: string;
  decisionTaskId: string;
  claimId: string;
  evidenceId: string;
  direction: "SUPPORTS" | "REFUTES";
}>;

const MAX_EVIDENCE_EXCERPT_CHARACTERS = 8_000;
const MAX_EVIDENCE_MATERIAL_BYTES = 64 * 1_024;
const MAX_COREMIND_EVIDENCE = 20;
const MAX_COREMIND_EXCERPT_CHARACTERS = 2_000;

export function createEvidenceModule(options: Readonly<{
  deleteRawArtifact?: (artifact: EvidenceRawArtifact) => Promise<void>;
  nextEvidenceId: () => string;
  nextGapId: () => string;
  nextLinkId: () => string;
  projectionLimits?: Readonly<{
    maxEvidence: number;
    maxExcerptCharacters: number;
  }>;
  sourceResearch?: Readonly<{
    readEvidenceCandidates(input: Readonly<{
      batchId: string;
      ownerUserId: string;
    }>): Promise<Readonly<{
      batchId: string;
      ownerUserId: string;
      decisionTaskId: string;
      results: readonly Readonly<{ resultKey: string; material: unknown }>[];
    }> | undefined>;
  }>;
  retrieval?: Readonly<{
    index(input: Readonly<{
      ownerUserId: string;
      evidence: PublicWebEvidenceV1;
    }>): Promise<
      | Readonly<{ status: "INDEXED"; evidenceId: string }>
      | Readonly<{ status: "EVIDENCE_GAP"; gap: unknown }>
    >;
    search(input: Readonly<{
      ownerUserId: string;
      decisionTaskId: string;
      query: string;
      topK: number;
    }>): Promise<
      | Readonly<{
          status: "RETRIEVED";
          results: readonly Readonly<{ evidenceId: string; score: number }>[];
        }>
      | Readonly<{ status: "EVIDENCE_GAP"; gap: unknown }>
    >;
  }>;
}>) {
  const configuredProjectionLimits = options.projectionLimits ?? {
    maxEvidence: MAX_COREMIND_EVIDENCE,
    maxExcerptCharacters: MAX_COREMIND_EXCERPT_CHARACTERS
  };
  if (
    !Number.isSafeInteger(configuredProjectionLimits.maxEvidence) ||
    configuredProjectionLimits.maxEvidence <= 0 ||
    !Number.isSafeInteger(configuredProjectionLimits.maxExcerptCharacters) ||
    configuredProjectionLimits.maxExcerptCharacters <= 0
  ) {
    throw new Error("EVIDENCE_PROJECTION_LIMIT_INVALID");
  }
  const projectionLimits = {
    maxEvidence: Math.min(
      configuredProjectionLimits.maxEvidence,
      MAX_COREMIND_EVIDENCE
    ),
    maxExcerptCharacters: Math.min(
      configuredProjectionLimits.maxExcerptCharacters,
      MAX_COREMIND_EXCERPT_CHARACTERS
    )
  };
  const normalizeResearchBatch = (input: Readonly<{
      ownerUserId: string;
      decisionTaskId: string;
      claimIds: readonly string[];
      batch: Readonly<{
        batchId?: string;
        ownerUserId: string;
        decisionTaskId: string;
        results: readonly Readonly<{
          resultKey: string;
          material: unknown;
        }>[];
      }>;
    }>) => {
      if (
        input.batch.ownerUserId !== input.ownerUserId ||
        input.batch.decisionTaskId !== input.decisionTaskId
      ) {
        throw new Error("EVIDENCE_BATCH_SCOPE_MISMATCH");
      }
      const evidence: NormalizedEvidence[] = [];
      const claimEvidenceLinks: NormalizedClaimEvidenceLink[] = [];
      const gaps: Array<Readonly<{
        gapId: string;
        code:
          | "EVIDENCE_MATERIAL_INVALID"
          | "CLAIM_LINK_INVALID"
          | "EVIDENCE_TIME_INVALID"
          | "EVIDENCE_ARTIFACT_LIFECYCLE_INVALID";
        decisionTaskId: string;
        resultKey: string;
        critical: true;
      }>> = [];
      const claimIds = new Set(input.claimIds);

      for (const result of input.batch.results) {
        const material = decodeResearchEvidenceMaterial(result.material);
        if (
          material === undefined
        ) {
          gaps.push({
            gapId: options.nextGapId(),
            code: "EVIDENCE_MATERIAL_INVALID",
            decisionTaskId: input.decisionTaskId,
            resultKey: result.resultKey,
            critical: true
          });
          continue;
        }
        const linkedClaimIds = new Set<string>();
        if (
          material.claimLinks.length === 0 ||
          material.claimLinks.some((link) => {
            if (!claimIds.has(link.claimId) || linkedClaimIds.has(link.claimId)) {
              return true;
            }
            linkedClaimIds.add(link.claimId);
            return false;
          })
        ) {
          gaps.push({
            gapId: options.nextGapId(),
            code: "CLAIM_LINK_INVALID",
            decisionTaskId: input.decisionTaskId,
            resultKey: result.resultKey,
            critical: true
          });
          continue;
        }
        const capturedAt = Date.parse(material.capturedAt);
        const validUntil = Date.parse(material.validUntil);
        if (
          !Number.isFinite(capturedAt) ||
          !Number.isFinite(validUntil) ||
          validUntil < capturedAt
        ) {
          gaps.push({
            gapId: options.nextGapId(),
            code: "EVIDENCE_TIME_INVALID",
            decisionTaskId: input.decisionTaskId,
            resultKey: result.resultKey,
            critical: true
          });
          continue;
        }
        const artifactLifecycleValid =
          material.source.sourceType === "LIVE_PLATFORM"
            ? material.rawArtifact.lifecycle === "TRANSIENT_PLATFORM" &&
              Number.isFinite(Date.parse(material.rawArtifact.expiresAt)) &&
              Date.parse(material.rawArtifact.expiresAt) >= capturedAt &&
              Date.parse(material.rawArtifact.expiresAt) <=
                capturedAt + 7 * 24 * 60 * 60 * 1_000
            : material.rawArtifact.lifecycle === "PRIVATE_FILE";
        if (!artifactLifecycleValid) {
          gaps.push({
            gapId: options.nextGapId(),
            code: "EVIDENCE_ARTIFACT_LIFECYCLE_INVALID",
            decisionTaskId: input.decisionTaskId,
            resultKey: result.resultKey,
            critical: true
          });
          continue;
        }
        const evidenceId =
          input.batch.batchId === undefined
            ? options.nextEvidenceId()
            : stableEvidenceIdentity("evidence", [
                input.ownerUserId,
                input.decisionTaskId,
                input.batch.batchId,
                result.resultKey,
                material.source.sourceId
              ]);
        evidence.push({
          evidenceId,
          ownerUserId: input.ownerUserId,
          decisionTaskId: input.decisionTaskId,
          capturedAt: material.capturedAt,
          validUntil: material.validUntil,
          excerpt: material.excerpt,
          excerptHash: {
            algorithm: "sha256",
            digest: createHash("sha256").update(material.excerpt, "utf8").digest("hex")
          },
          locator: material.locator,
          parserVersion: material.parserVersion,
          rawArtifact: material.rawArtifact,
          source: material.source,
          sourceRole: material.sourceRole,
          subject: material.subject
        });
        for (const link of material.claimLinks) {
          claimEvidenceLinks.push({
            linkId:
              input.batch.batchId === undefined
                ? options.nextLinkId()
                : stableEvidenceIdentity("claim-evidence-link", [
                    evidenceId,
                    link.claimId,
                    link.direction
                  ]),
            ownerUserId: input.ownerUserId,
            decisionTaskId: input.decisionTaskId,
            claimId: link.claimId,
            evidenceId,
            direction: link.direction
          });
        }
      }

      return { evidence, claimEvidenceLinks, gaps };
    };

  const projectForCoreMind = (input: Readonly<{
    ownerUserId: string;
    decisionTaskId: string;
    decisionValidFrom: string;
    evidence: readonly NormalizedEvidence[];
    claimEvidenceLinks: readonly NormalizedClaimEvidenceLink[];
  }>) => {
    if (
      input.evidence.some(
        (item) =>
          item.ownerUserId !== input.ownerUserId ||
          item.decisionTaskId !== input.decisionTaskId
      ) ||
      input.claimEvidenceLinks.some(
        (link) =>
          link.ownerUserId !== input.ownerUserId ||
          link.decisionTaskId !== input.decisionTaskId
      )
    ) {
      throw new Error("EVIDENCE_PROJECTION_SCOPE_MISMATCH");
    }
    const evidenceIds = new Set(input.evidence.map((item) => item.evidenceId));
    const linkedEvidenceIds = new Set(
      input.claimEvidenceLinks.map((link) => link.evidenceId)
    );
    if (
      input.evidence.some((item) => !linkedEvidenceIds.has(item.evidenceId)) ||
      input.claimEvidenceLinks.some((link) => !evidenceIds.has(link.evidenceId))
    ) {
      throw new Error("EVIDENCE_PROJECTION_LINK_INVALID");
    }
    const validFrom = Date.parse(input.decisionValidFrom);
    const eligible = input.evidence.filter(
      (item) =>
        Date.parse(item.capturedAt) <= validFrom &&
        Date.parse(item.validUntil) >= validFrom &&
        (item.retiredAt === undefined || Date.parse(item.retiredAt) > validFrom)
    );
    const selected = eligible.slice(0, projectionLimits.maxEvidence);
    return {
      items: selected.map((item) => {
        const excerpt = item.excerpt.slice(0, projectionLimits.maxExcerptCharacters);
        return {
          evidenceId: item.evidenceId,
          capturedAt: item.capturedAt,
          validUntil: item.validUntil,
          excerpt,
          excerptTruncated: excerpt.length < item.excerpt.length,
          locator: item.locator,
          source: item.source,
          sourceRole: item.sourceRole,
          subject: item.subject,
          claimLinks: input.claimEvidenceLinks
            .filter((link) => link.evidenceId === item.evidenceId)
            .map((link) => ({ claimId: link.claimId, direction: link.direction }))
        };
      }),
      hasMore: eligible.length > selected.length
    };
  };

  return {
    normalizeResearchBatch,
    async normalizeResearchBatchById(input: Readonly<{
      batchId: string;
      ownerUserId: string;
      decisionTaskId: string;
      claimIds: readonly string[];
    }>) {
      if (options.sourceResearch === undefined) {
        throw new Error("EVIDENCE_SOURCE_RESEARCH_NOT_CONFIGURED");
      }
      const batch = await options.sourceResearch.readEvidenceCandidates({
        batchId: input.batchId,
        ownerUserId: input.ownerUserId
      });
      if (batch === undefined) {
        throw new Error("EVIDENCE_BATCH_NOT_FOUND");
      }
      return normalizeResearchBatch({
        ownerUserId: input.ownerUserId,
        decisionTaskId: input.decisionTaskId,
        claimIds: input.claimIds,
        batch
      });
    },
    async indexEvidence(input: Readonly<{
      ownerUserId: string;
      evidence: readonly NormalizedEvidence[];
    }>) {
      if (options.retrieval === undefined) {
        throw new Error("EVIDENCE_RETRIEVAL_NOT_CONFIGURED");
      }
      if (input.evidence.some((item) => item.ownerUserId !== input.ownerUserId)) {
        throw new Error("EVIDENCE_INDEX_SCOPE_MISMATCH");
      }
      let indexed = 0;
      let skipped = 0;
      const gaps: unknown[] = [];
      for (const item of input.evidence) {
        if (item.source.sourceType !== "LIVE_PLATFORM") {
          skipped += 1;
          continue;
        }
        const result = await options.retrieval.index({
          ownerUserId: input.ownerUserId,
          evidence: toPublicWebEvidence(item)
        });
        if (result.status === "INDEXED") {
          indexed += 1;
        } else {
          gaps.push(result.gap);
        }
      }
      return { indexed, skipped, gaps };
    },
    projectForCoreMind,
    async retrieveForCoreMind(input: Readonly<{
      ownerUserId: string;
      decisionTaskId: string;
      decisionValidFrom: string;
      query: string;
      topK: number;
      evidence: readonly NormalizedEvidence[];
      claimEvidenceLinks: readonly NormalizedClaimEvidenceLink[];
    }>) {
      if (options.retrieval === undefined) {
        throw new Error("EVIDENCE_RETRIEVAL_NOT_CONFIGURED");
      }
      const retrieved = await options.retrieval.search({
        ownerUserId: input.ownerUserId,
        decisionTaskId: input.decisionTaskId,
        query: input.query,
        topK: input.topK
      });
      if (retrieved.status === "EVIDENCE_GAP") return retrieved;
      const evidenceById = new Map(
        input.evidence
          .filter(
            (item) =>
              item.ownerUserId === input.ownerUserId &&
              item.decisionTaskId === input.decisionTaskId
          )
          .map((item) => [item.evidenceId, item] as const)
      );
      const selectedIds = new Set<string>();
      const rankedEvidence: NormalizedEvidence[] = [];
      for (const result of retrieved.results) {
        const item = evidenceById.get(result.evidenceId);
        if (item !== undefined && !selectedIds.has(item.evidenceId)) {
          selectedIds.add(item.evidenceId);
          rankedEvidence.push(item);
        }
      }
      return {
        status: "RETRIEVED" as const,
        projection: projectForCoreMind({
          ownerUserId: input.ownerUserId,
          decisionTaskId: input.decisionTaskId,
          decisionValidFrom: input.decisionValidFrom,
          evidence: rankedEvidence,
          claimEvidenceLinks: input.claimEvidenceLinks.filter((link) =>
            selectedIds.has(link.evidenceId)
          )
        })
      };
    },
    expandEvidence(input: Readonly<{
      ownerUserId: string;
      decisionTaskId: string;
      evidenceId: string;
      evidence: readonly NormalizedEvidence[];
    }>) {
      const item = input.evidence.find(
        (candidate) =>
          candidate.ownerUserId === input.ownerUserId &&
          candidate.decisionTaskId === input.decisionTaskId &&
          candidate.evidenceId === input.evidenceId
      );
      if (item === undefined) return undefined;
      return {
        evidenceId: item.evidenceId,
        capturedAt: item.capturedAt,
        validUntil: item.validUntil,
        excerpt: item.excerpt,
        locator: item.locator,
        source: item.source,
        sourceRole: item.sourceRole,
        subject: item.subject
      };
    },
    async purgeExpiredRawArtifacts(input: Readonly<{
      now: string;
      ownerUserId: string;
      evidence: readonly NormalizedEvidence[];
    }>) {
      if (input.evidence.some((item) => item.ownerUserId !== input.ownerUserId)) {
        throw new Error("EVIDENCE_ARTIFACT_SCOPE_MISMATCH");
      }
      if (options.deleteRawArtifact === undefined) {
        throw new Error("EVIDENCE_ARTIFACT_DELETE_NOT_CONFIGURED");
      }
      const now = Date.parse(input.now);
      const expired = input.evidence.filter(
        (item) =>
          item.rawArtifact.lifecycle === "TRANSIENT_PLATFORM" &&
          Date.parse(item.rawArtifact.expiresAt) <= now
      );
      const artifacts = new Map(expired.map((item) => [item.rawArtifact.objectKey, item.rawArtifact]));
      await Promise.all(
        [...artifacts.values()].map((artifact) => options.deleteRawArtifact?.(artifact))
      );
      return { deleted: artifacts.size };
    }
  };
}

function toPublicWebEvidence(evidence: NormalizedEvidence): PublicWebEvidenceV1 {
  if (evidence.source.sourceType !== "LIVE_PLATFORM") {
    throw new Error("EVIDENCE_PUBLIC_WEB_CONVERSION_INVALID");
  }
  return {
    contractType: "evidence",
    contractVersion: "1.0",
    evidenceId: evidence.evidenceId,
    decisionTaskId: evidence.decisionTaskId,
    capturedAt: evidence.capturedAt,
    locator: evidence.locator,
    excerpt: evidence.excerpt,
    validUntil: evidence.validUntil,
    synthetic: false,
    source: {
      sourceKind: "PUBLIC_WEB",
      sourceId: evidence.source.sourceId,
      title: evidence.source.title,
      url: evidence.source.url
    },
    excerptHash: evidence.excerptHash,
    parserVersion: evidence.parserVersion,
    rawArtifact: {
      algorithm: evidence.rawArtifact.algorithm,
      digest: evidence.rawArtifact.digest,
      objectKey: evidence.rawArtifact.objectKey
    }
  };
}

function stableEvidenceIdentity(prefix: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
  return `${prefix}-${digest.slice(0, 32)}`;
}

function decodeResearchEvidenceMaterial(value: unknown): ResearchEvidenceMaterial | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isMeaningfulString(value.capturedAt) ||
    !isMeaningfulString(value.validUntil) ||
    !isMeaningfulString(value.excerpt) ||
    value.excerpt.length > MAX_EVIDENCE_EXCERPT_CHARACTERS ||
    !isMeaningfulString(value.parserVersion) ||
    !isLocator(value.locator) ||
    !isEvidenceRawArtifact(value.rawArtifact) ||
    !isEvidenceSource(value.source) ||
    !isEvidenceSourceRole(value.sourceRole) ||
    !isEvidenceSubject(value.subject) ||
    !Array.isArray(value.claimLinks) ||
    !value.claimLinks.every(isClaimLinkCandidate)
  ) {
    return undefined;
  }
  const rawArtifact: EvidenceRawArtifact =
    value.rawArtifact.lifecycle === "TRANSIENT_PLATFORM"
      ? {
          algorithm: "sha256",
          digest: value.rawArtifact.digest,
          objectKey: value.rawArtifact.objectKey,
          lifecycle: "TRANSIENT_PLATFORM",
          expiresAt: value.rawArtifact.expiresAt
        }
      : {
          algorithm: "sha256",
          digest: value.rawArtifact.digest,
          objectKey: value.rawArtifact.objectKey,
          lifecycle: "PRIVATE_FILE"
        };
  const source: EvidenceSource =
    value.source.sourceType === "LIVE_PLATFORM"
      ? {
          sourceType: "LIVE_PLATFORM",
          sourceId: value.source.sourceId,
          platform: value.source.platform,
          title: value.source.title,
          url: value.source.url,
          ...(isMeaningfulString(value.source.contentId)
            ? { contentId: value.source.contentId }
            : {})
        }
      : {
          sourceType: "PRIVATE_FILE",
          sourceId: value.source.sourceId,
          fileId: value.source.fileId,
          title: value.source.title,
          mediaType: value.source.mediaType
        };
  const subject: EvidenceSubject =
    value.subject.subjectType === "CANDIDATE"
      ? {
          subjectType: "CANDIDATE",
          candidateId: value.subject.candidateId
        }
      : {
          subjectType: "OFFER",
          candidateId: value.subject.candidateId,
          offerId: value.subject.offerId,
          channel: value.subject.channel,
          sku: value.subject.sku
        };
  const material: ResearchEvidenceMaterial = {
    capturedAt: value.capturedAt,
    validUntil: value.validUntil,
    excerpt: value.excerpt,
    locator: {
      section: value.locator.section,
      field: value.locator.field
    },
    parserVersion: value.parserVersion,
    rawArtifact,
    source,
    sourceRole: value.sourceRole,
    subject,
    claimLinks: value.claimLinks.map((link) => ({
      claimId: link.claimId,
      direction: link.direction
    }))
  };
  // 同时限制元数据与关联，避免通过非摘录字段传入完整原文。
  return Buffer.byteLength(JSON.stringify(material), "utf8") <= MAX_EVIDENCE_MATERIAL_BYTES
    ? material
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMeaningfulString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isLocator(value: unknown): value is ResearchEvidenceMaterial["locator"] {
  return (
    isRecord(value) &&
    isMeaningfulString(value.section) &&
    isMeaningfulString(value.field)
  );
}

function isEvidenceRawArtifact(value: unknown): value is EvidenceRawArtifact {
  if (
    !isRecord(value) ||
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.digest) ||
    !isMeaningfulString(value.objectKey)
  ) {
    return false;
  }
  return (
    (value.lifecycle === "TRANSIENT_PLATFORM" && isMeaningfulString(value.expiresAt)) ||
    value.lifecycle === "PRIVATE_FILE"
  );
}

function isEvidenceSource(value: unknown): value is EvidenceSource {
  if (!isRecord(value) || !isMeaningfulString(value.sourceId) || !isMeaningfulString(value.title)) {
    return false;
  }
  if (value.sourceType === "LIVE_PLATFORM") {
    if (!isMeaningfulString(value.platform) || !isMeaningfulString(value.url)) return false;
    try {
      const url = new URL(value.url);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }
  return (
    value.sourceType === "PRIVATE_FILE" &&
    isMeaningfulString(value.fileId) &&
    isMeaningfulString(value.mediaType)
  );
}

function isEvidenceSourceRole(value: unknown): value is EvidenceSourceRole {
  return value === "OFFICIAL" || value === "OFFER" || value === "INDEPENDENT";
}

function isEvidenceSubject(value: unknown): value is EvidenceSubject {
  if (!isRecord(value) || !isMeaningfulString(value.candidateId)) return false;
  if (value.subjectType === "CANDIDATE") return true;
  return (
    value.subjectType === "OFFER" &&
    isMeaningfulString(value.offerId) &&
    isMeaningfulString(value.channel) &&
    isMeaningfulString(value.sku)
  );
}

function isClaimLinkCandidate(
  value: unknown
): value is ResearchEvidenceMaterial["claimLinks"][number] {
  return (
    isRecord(value) &&
    isMeaningfulString(value.claimId) &&
    (value.direction === "SUPPORTS" || value.direction === "REFUTES")
  );
}

export interface DataSourceConnector<
  TResult extends DataSourceCollectionResult = DataSourceCollectionResult
> {
  collect(input: Readonly<{
    policy: Readonly<{
      allowedMediaTypes: readonly string[];
      maxBytes: number;
    }>;
    resolvedAddress: string;
    signal?: AbortSignal;
    sourceId: string;
    title: string;
    url: string;
  }>): Promise<TResult>;
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
      extractLinks?: boolean;
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
          ...(input.extractLinks === true ? { extractLinks: true } : {}),
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
      if (input.extractLinks === true && parsed.value.output.links === undefined) {
        return parserEvidenceGap(options, input.decisionTaskId, false, "SOURCE_LINK_DISCOVERY_UNSUPPORTED");
      }

      const excerpt = parsed.value.output.text;
      const excerptDigest = createHash("sha256").update(excerpt, "utf8").digest("hex");
      return {
        status: "EVIDENCE_CREATED" as const,
        documentSignals,
        ...(input.extractLinks === true ? { links: parsed.value.output.links } : {}),
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
  retryable: boolean,
  code: "SOURCE_PARSE_FAILED" | "SOURCE_LINK_DISCOVERY_UNSUPPORTED" = "SOURCE_PARSE_FAILED"
) {
  return {
    status: "EVIDENCE_GAP" as const,
    gap: {
      code,
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

type HttpDataSourceConnectorOptions = Readonly<{
  collectorVersion?: string;
  fetch(input: Readonly<{
    redirect: "manual";
    resolvedAddress: string;
    signal: AbortSignal;
    url: string;
  }>): Promise<
    Readonly<{
      arrayBuffer(): Promise<ArrayBuffer>;
      body?: ReadableStream<Uint8Array> | null;
      headers: Readonly<{ get(name: string): string | null }>;
      ok: boolean;
      status: number;
      url: string;
    }>
  >;
  now: () => Date;
  objectStore: RawEvidenceObjectStore;
  readDurationMs: () => number;
  timeoutMs?: number;
}>;

export function createHttpDataSourceConnector(
  options: HttpDataSourceConnectorOptions & Readonly<{ includeResponseMetadata: true }>
): DataSourceConnector<DataSourceCollectionResultWithResponseMetadata>;
export function createHttpDataSourceConnector(
  options: HttpDataSourceConnectorOptions & Readonly<{ includeResponseMetadata?: false }>
): DataSourceConnector;
export function createHttpDataSourceConnector(
  options: HttpDataSourceConnectorOptions & Readonly<{ includeResponseMetadata?: boolean }>
): DataSourceConnector {
  return {
    async collect(input) {
      let response: Awaited<ReturnType<typeof options.fetch>>;
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const fetchSignal =
        input.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([input.signal, timeoutSignal]);
      try {
        response = await options.fetch({
          redirect: "manual",
          resolvedAddress: input.resolvedAddress,
          signal: fetchSignal,
          url: input.url
        });
      } catch {
        return {
          ok: false,
          error: { code: "SOURCE_FETCH_FAILED", retryable: true },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await cancelResponseBody(response);
        if (location !== null && location.trim() !== "") {
          return {
            ok: false,
            redirect: { location },
            metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
          };
        }
        return {
          ok: false,
          error: { code: "SOURCE_REDIRECT_REJECTED", retryable: false },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        return {
          ok: false,
          error: {
            code:
              response.status === 401 || response.status === 403
                ? "SOURCE_ACCESS_CHALLENGE"
                : "SOURCE_FETCH_FAILED",
            retryable:
              response.status !== 401 &&
              response.status !== 403 &&
              (response.status === 408 || response.status === 429 || response.status >= 500)
          },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }
      const contentEncoding = response.headers.get("content-encoding")?.trim();
      if (
        contentEncoding !== undefined &&
        contentEncoding !== "" &&
        contentEncoding.toLowerCase() !== "identity"
      ) {
        await cancelResponseBody(response);
        return {
          ok: false,
          error: { code: "SOURCE_FETCH_FAILED", retryable: false },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (
        mediaType === undefined ||
        !input.policy.allowedMediaTypes.includes(mediaType)
      ) {
        await cancelResponseBody(response);
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
        await cancelResponseBody(response);
        return {
          ok: false,
          error: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }

      let body: Awaited<ReturnType<typeof readBoundedResponseBody>>;
      try {
        body = await readBoundedResponseBody(response, input.policy.maxBytes, fetchSignal);
      } catch {
        return {
          ok: false,
          error: { code: "SOURCE_FETCH_FAILED", retryable: true },
          metrics: { bytesFetched: 0, durationMs: options.readDurationMs() }
        };
      }
      if (body.exceeded) {
        return {
          ok: false,
          error: { code: "SOURCE_SIZE_EXCEEDED", retryable: false },
          metrics: {
            bytesFetched: body.bytesFetched,
            durationMs: options.readDurationMs()
          }
        };
      }
      const bytes = body.bytes;
      fetchSignal.throwIfAborted();
      const capturedAt = options.now();
      const rawArtifact = await options.objectStore.put(bytes, {
        expiresAt: new Date(capturedAt.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString()
      });
      return {
        ok: true,
        sourceFacts: {
          capturedAt: capturedAt.toISOString(),
          ...(options.collectorVersion === undefined
            ? {}
            : { collectorVersion: options.collectorVersion }),
          mediaType,
          sourceId: input.sourceId,
          title: input.title,
          url: response.url
        },
        rawArtifact,
        metrics: {
          bytesFetched: bytes.byteLength,
          durationMs: options.readDurationMs()
        },
        ...(options.includeResponseMetadata === true
          ? {
              response: {
                status: response.status,
                headers: selectBrowserResponseHeaders(response.headers)
              }
            }
          : {})
      };
    }
  };
}

const BROWSER_RESPONSE_HEADER_NAMES = [
  "access-control-allow-credentials",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "content-encoding",
  "content-language",
  "content-security-policy",
  "content-type",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "location",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options"
] as const;

function selectBrowserResponseHeaders(
  headers: Readonly<{ get(name: string): string | null }>
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of BROWSER_RESPONSE_HEADER_NAMES) {
    const value = headers.get(name);
    if (value !== null) selected[name] = value;
  }
  return selected;
}

async function cancelResponseBody(response: Readonly<{
  body?: ReadableStream<Uint8Array> | null;
}>): Promise<void> {
  await response.body?.cancel();
}

async function readBoundedResponseBody(
  response: Readonly<{
    arrayBuffer(): Promise<ArrayBuffer>;
    body?: ReadableStream<Uint8Array> | null;
  }>,
  maxBytes: number,
  signal?: AbortSignal
): Promise<
  | Readonly<{ exceeded: true; bytesFetched: number }>
  | Readonly<{ exceeded: false; bytes: Uint8Array }>
> {
  if (response.body === undefined || response.body === null) {
    const bytes = new Uint8Array(await abortable(response.arrayBuffer(), signal));
    return bytes.byteLength > maxBytes
      ? { exceeded: true, bytesFetched: bytes.byteLength }
      : { exceeded: false, bytes };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesFetched = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytesFetched += next.value.byteLength;
      if (bytesFetched > maxBytes) {
        await reader.cancel();
        return { exceeded: true, bytesFetched };
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(bytesFetched);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { exceeded: false, bytes };
}

type EvidenceIngestionInput = Readonly<{
  correlationId: string;
  decisionTaskId: string;
  operationId: string;
  source: Readonly<{ sourceId: string; title: string; url: string }>;
  signal?: AbortSignal;
  userId: string;
}>;

type EvidenceIngestionGap = Readonly<{
  status: "EVIDENCE_GAP";
  gap: Readonly<{
    code:
      | "SOURCE_ACCESS_CHALLENGE"
      | "SOURCE_DNS_FAILED"
      | "SOURCE_FETCH_FAILED"
      | "SOURCE_MIME_REJECTED"
      | "SOURCE_NOT_APPROVED"
      | "SOURCE_REDIRECT_REJECTED"
      | "SOURCE_SCHEME_REJECTED"
      | "SOURCE_SIZE_EXCEEDED"
      | "SOURCE_SSRF_BLOCKED";
    decisionTaskId: string;
    gapId: string;
    metrics?: Readonly<{ bytesFetched: number; durationMs: number }>;
    retryable: boolean;
    sourceId: string;
  }>;
}>;

type EvidenceIngestionRedirect = Readonly<{
  status: "REDIRECT";
  location: string;
  metrics: Readonly<{ bytesFetched: number; durationMs: number }>;
}>;

type EvidenceIngestionResult<
  TResult extends DataSourceCollectionResult,
  TRedirectMode extends "follow" | "manual"
> =
  | Readonly<{
      status: "COLLECTED";
      collection: Extract<TResult, Readonly<{ ok: true }>>;
    }>
  | EvidenceIngestionGap
  | (TRedirectMode extends "manual" ? EvidenceIngestionRedirect : never);

type EvidenceIngestionService<
  TResult extends DataSourceCollectionResult,
  TRedirectMode extends "follow" | "manual"
> = Readonly<{
  ingest(input: EvidenceIngestionInput): Promise<
    EvidenceIngestionResult<TResult, TRedirectMode>
  >;
}>;

type EvidenceIngestionServiceOptions<
  TResult extends DataSourceCollectionResult = DataSourceCollectionResult
> = Readonly<{
  approvedSourceOrigins?: ReadonlySet<string>;
  approvedSourceUrls: ReadonlySet<string>;
  collectionPolicy: Readonly<{
    allowedMediaTypes: readonly string[];
    maxBytes: number;
  }>;
  connector: DataSourceConnector<TResult>;
  egressGuard: EgressGuard;
  nextGapId: () => string;
  redirectMode?: "follow" | "manual";
  resolveHost(hostname: string): Promise<readonly string[]>;
}>;

export function createEvidenceIngestionService<
  TResult extends DataSourceCollectionResult
>(
  options: EvidenceIngestionServiceOptions<TResult> & Readonly<{ redirectMode: "manual" }>
): EvidenceIngestionService<TResult, "manual">;
export function createEvidenceIngestionService<
  TResult extends DataSourceCollectionResult
>(
  options: EvidenceIngestionServiceOptions<TResult> & Readonly<{ redirectMode?: "follow" }>
): EvidenceIngestionService<TResult, "follow">;
export function createEvidenceIngestionService(
  options: EvidenceIngestionServiceOptions
): EvidenceIngestionService<DataSourceCollectionResult, "follow" | "manual"> {
  return {
    async ingest(input) {
      let sourceUrl = new URL(input.source.url);
      for (let hop = 0; hop <= 3; hop += 1) {
        if (sourceUrl.username !== "" || sourceUrl.password !== "" || sourceUrl.hash !== "") {
          return {
            status: "EVIDENCE_GAP" as const,
            gap: {
              code: hop === 0 ? "SOURCE_NOT_APPROVED" as const : "SOURCE_REDIRECT_REJECTED" as const,
              decisionTaskId: input.decisionTaskId,
              gapId: options.nextGapId(),
              retryable: false,
              sourceId: input.source.sourceId
            }
          };
        }
        const approved =
          options.approvedSourceUrls.has(sourceUrl.href) ||
          (hop > 0 && options.approvedSourceOrigins?.has(sourceUrl.origin) === true);
        if (!approved) {
          return {
            status: "EVIDENCE_GAP" as const,
            gap: {
              code: hop === 0 ? "SOURCE_NOT_APPROVED" as const : "SOURCE_REDIRECT_REJECTED" as const,
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
        const hostname = normalizeHostname(sourceUrl.hostname);
        let resolvedAddresses: readonly string[];
        try {
          resolvedAddresses =
            isIP(hostname) === 0
              ? await abortable(options.resolveHost(hostname), input.signal)
              : [hostname];
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
        const resolvedAddress = resolvedAddresses[0];
        if (
          isLocalHostname(hostname) ||
          resolvedAddress === undefined ||
          resolvedAddresses.some((address) => !isPublicNetworkAddress(address))
        ) {
          return ssrfEvidenceGap(options, input);
        }
        const guarded = await options.egressGuard.execute({
          userId: input.userId,
          operationId: `${input.operationId}:hop-${hop}`,
          operation: "READ_PUBLIC_SOURCE",
          correlationId: input.correlationId,
          destinationUrl: sourceUrl.href,
          method: "GET",
          perform: () =>
            options.connector.collect({
              ...input.source,
              resolvedAddress,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              url: sourceUrl.href,
              policy: {
                allowedMediaTypes: [...options.collectionPolicy.allowedMediaTypes],
                maxBytes: options.collectionPolicy.maxBytes
              }
            })
        });
        if (guarded.status === "COMPLETED") {
          if (!guarded.value.ok) {
            if ("redirect" in guarded.value) {
              if (hop === 3) {
                return collectionEvidenceGap(options, input, {
                  code: "SOURCE_REDIRECT_REJECTED",
                  retryable: false,
                  metrics: guarded.value.metrics
                });
              }
              try {
                sourceUrl = new URL(guarded.value.redirect.location, sourceUrl);
              } catch {
                return collectionEvidenceGap(options, input, {
                  code: "SOURCE_REDIRECT_REJECTED",
                  retryable: false,
                  metrics: guarded.value.metrics
                });
              }
              if (options.redirectMode === "manual") {
                const approvedRedirect =
                  sourceUrl.username === "" &&
                  sourceUrl.password === "" &&
                  sourceUrl.hash === "" &&
                  sourceUrl.protocol === "https:" &&
                  (options.approvedSourceUrls.has(sourceUrl.href) ||
                    options.approvedSourceOrigins?.has(sourceUrl.origin) === true);
                if (!approvedRedirect) {
                  return collectionEvidenceGap(options, input, {
                    code: "SOURCE_REDIRECT_REJECTED",
                    retryable: false,
                    metrics: guarded.value.metrics
                  });
                }
                return {
                  status: "REDIRECT" as const,
                  location: sourceUrl.href,
                  metrics: guarded.value.metrics
                };
              }
              continue;
            }
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

      throw new Error("公开来源采集未完成");
    }
  };
}

function collectionEvidenceGap(
  options: Readonly<{ nextGapId: () => string }>,
  input: Readonly<{
    decisionTaskId: string;
    source: Readonly<{ sourceId: string }>;
  }>,
  error: Readonly<{
    code: "SOURCE_REDIRECT_REJECTED";
    retryable: boolean;
    metrics: Readonly<{ bytesFetched: number; durationMs: number }>;
  }>
) {
  return {
    status: "EVIDENCE_GAP" as const,
    gap: {
      code: error.code,
      decisionTaskId: input.decisionTaskId,
      gapId: options.nextGapId(),
      metrics: error.metrics,
      retryable: error.retryable,
      sourceId: input.source.sourceId
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

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export * from "./static-public-web.js";
