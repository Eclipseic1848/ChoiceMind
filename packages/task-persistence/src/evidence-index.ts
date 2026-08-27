import type { PublicWebEvidenceV1 } from "@choicemind/contracts/decision/v1";
import { Pool } from "pg";

import { migratePersistentDecisionTasks } from "./migration.js";

export type EvidenceIndexRecord = Readonly<{
  evidenceId: string;
  decisionTaskId: string;
  capturedAt: string;
  validUntil: string;
  locator: PublicWebEvidenceV1["locator"];
  source: PublicWebEvidenceV1["source"];
  excerptHash: PublicWebEvidenceV1["excerptHash"];
  parserVersion: string;
  rawArtifact: PublicWebEvidenceV1["rawArtifact"];
  embedding: Readonly<{ dimensions: number; model: string }>;
}>;

export type EvidenceIndexStore = Readonly<{
  save(
    evidence: PublicWebEvidenceV1,
    embedding: Readonly<{ model: string; vector: readonly number[] }>
  ): Promise<void>;
  get(evidenceId: string): Promise<EvidenceIndexRecord | undefined>;
  nearest(input: Readonly<{
    limit: number;
    model: string;
    queryVector: readonly number[];
  }>): Promise<readonly Readonly<{ distance: number; evidence: EvidenceIndexRecord }>[]>;
  close(): Promise<void>;
}>;

type EvidenceIndexRow = Readonly<{
  evidence_id: string;
  decision_task_id: string;
  captured_at: Date;
  valid_until: Date;
  locator_section: string;
  locator_field: string;
  source_id: string;
  source_title: string;
  source_url: string;
  excerpt_sha256: string;
  parser_version: string;
  raw_artifact_digest: string;
  raw_artifact_object_key: string;
  embedding_model: string;
  embedding_dimensions: number;
}>;

type NearestEvidenceIndexRow = EvidenceIndexRow & Readonly<{ distance: number }>;

export async function openEvidenceIndexStore(options: Readonly<{
  databaseUrl: string;
}>): Promise<EvidenceIndexStore> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    max: 5
  });
  pool.on("error", () => undefined);
  const migrationClient = await pool.connect();
  try {
    await migratePersistentDecisionTasks(migrationClient);
  } finally {
    migrationClient.release();
  }

  return {
    async save(evidence, embedding) {
      assertEmbedding(embedding);
      await pool.query(
        `INSERT INTO evidence_index (
           evidence_id, decision_task_id, captured_at, valid_until,
           locator_section, locator_field,
           source_id, source_title, source_url,
           excerpt_sha256, parser_version,
           raw_artifact_digest, raw_artifact_object_key,
           embedding_model, embedding_dimensions, embedding
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
           $16::vector
         )
         ON CONFLICT (evidence_id) DO NOTHING`,
        [
          evidence.evidenceId,
          evidence.decisionTaskId,
          evidence.capturedAt,
          evidence.validUntil,
          evidence.locator.section,
          evidence.locator.field,
          evidence.source.sourceId,
          evidence.source.title,
          evidence.source.url,
          evidence.excerptHash.digest,
          evidence.parserVersion,
          evidence.rawArtifact.digest,
          evidence.rawArtifact.objectKey,
          embedding.model,
          embedding.vector.length,
          toVectorLiteral(embedding.vector)
        ]
      );
    },
    async get(evidenceId) {
      const result = await pool.query<EvidenceIndexRow>(
        `SELECT ${evidenceIndexColumnList()}
         FROM evidence_index
         WHERE evidence_id = $1`,
        [evidenceId]
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toEvidenceIndexRecord(row);
    },
    async nearest(input) {
      assertQuery(input);
      const result = await pool.query<NearestEvidenceIndexRow>(
        `SELECT ${evidenceIndexColumnList()},
                (embedding <=> $1::vector) AS distance
         FROM evidence_index
         WHERE embedding_model = $2 AND embedding_dimensions = $3
         ORDER BY embedding <=> $1::vector ASC, evidence_id ASC
         LIMIT $4`,
        [
          toVectorLiteral(input.queryVector),
          input.model,
          input.queryVector.length,
          input.limit
        ]
      );
      return result.rows.map((row) => ({
        distance: Number(row.distance),
        evidence: toEvidenceIndexRecord(row)
      }));
    },
    close: () => pool.end()
  };
}

function evidenceIndexColumnList(): string {
  return `evidence_id, decision_task_id, captured_at, valid_until,
          locator_section, locator_field,
          source_id, source_title, source_url,
          excerpt_sha256, parser_version,
          raw_artifact_digest, raw_artifact_object_key,
          embedding_model, embedding_dimensions`;
}

function toEvidenceIndexRecord(row: EvidenceIndexRow): EvidenceIndexRecord {
  return {
    evidenceId: row.evidence_id,
    decisionTaskId: row.decision_task_id,
    capturedAt: row.captured_at.toISOString(),
    validUntil: row.valid_until.toISOString(),
    locator: { section: row.locator_section, field: row.locator_field },
    source: {
      sourceKind: "PUBLIC_WEB",
      sourceId: row.source_id,
      title: row.source_title,
      url: row.source_url
    },
    excerptHash: { algorithm: "sha256", digest: row.excerpt_sha256 },
    parserVersion: row.parser_version,
    rawArtifact: {
      algorithm: "sha256",
      digest: row.raw_artifact_digest,
      objectKey: row.raw_artifact_object_key
    },
    embedding: {
      dimensions: row.embedding_dimensions,
      model: row.embedding_model
    }
  };
}

function assertEmbedding(embedding: Readonly<{
  model: string;
  vector: readonly number[];
}>): void {
  if (
    embedding.model.trim() === "" ||
    embedding.vector.length === 0 ||
    embedding.vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Evidence embedding 无效");
  }
}

function assertQuery(input: Readonly<{
  limit: number;
  model: string;
  queryVector: readonly number[];
}>): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.model.trim() === "" ||
    input.queryVector.length === 0 ||
    input.queryVector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Evidence 检索参数无效");
  }
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
