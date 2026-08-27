import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateP0GoldGate, saveP0GoldArtifacts } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("saveP0GoldArtifacts", () => {
  it("以 UTF-8 原子写入 EvaluationReport 和证据索引", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "choicemind-p0-gold-"));
    temporaryDirectories.push(outputDirectory);
    const evaluation = evaluateP0GoldGate({
      executedAt: "2026-08-26T14:30:00.000Z",
      baselineCommit: "90b45d3a31ae8392ac2a0aa96c97e41795c35bee",
      coreModifiedFiles: [],
      gateResults: [],
      localServiceReport: {
        contractType: "local-service-smoke-report",
        contractVersion: "1.0",
        status: "SMOKE_PASSED",
        executedAt: "2026-08-26T14:25:00.000Z",
        services: [
          "qwen-model",
          "qwen-embedding",
          "qwen-reranker",
          "paddleocr-vl",
          "mineru",
          "choicemind-html-parser"
        ].map((serviceId) => ({ serviceId, status: "SMOKE_PASSED" as const }))
      }
    });

    await saveP0GoldArtifacts(outputDirectory, evaluation);

    expect(await readdir(outputDirectory)).toEqual([
      "evaluation-report.json",
      "evidence-index.json"
    ]);
    expect(JSON.parse(await readFile(path.join(outputDirectory, "evaluation-report.json"), "utf8"))).toEqual(
      evaluation.report
    );
    expect(JSON.parse(await readFile(path.join(outputDirectory, "evidence-index.json"), "utf8"))).toEqual(
      evaluation.evidenceIndex
    );
  });
});
