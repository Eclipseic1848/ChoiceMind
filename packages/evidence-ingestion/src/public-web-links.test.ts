import { expect, it, vi } from "vitest";
import { createPublicWebEvidenceGenerator } from "./index.js";

it.each([undefined, [], [{ href: "/product", text: "产品", next: false }]])(
  "显式链接发现不能将旧 Parser 缺失字段当作空结果：%j", async (links) => {
    const nextEvidenceId = vi.fn(() => "evidence");
    const signal = new AbortController().signal;
    const generator = createPublicWebEvidenceGenerator({
      nextEvidenceId, nextGapId: () => "gap", nextParserRequestId: () => "parse",
      objectStore: { async put() { throw new Error("不能写入"); },
        async read() { return new TextEncoder().encode("<main>产品</main>"); } },
      parse: async (request, receivedSignal) => {
        expect(receivedSignal).toBe(signal);
        expect(request.input.extractLinks).toBe(true);
        return { contractType: "local-service-result", contractVersion: "1.0",
          requestId: request.requestId, port: "DOCUMENT_PARSER", ok: true,
          output: { parser: "synthetic", text: "产品", pageCount: 1,
            ...(links === undefined ? {} : { links }) } };
      }
    });
    const result = await generator.generate({
      extractLinks: true, signal, decisionTaskId: "task", validUntil: "2026-09-08T00:00:00Z",
      collection: { ok: true, sourceFacts: { capturedAt: "2026-09-01T00:00:00Z",
        mediaType: "text/html", sourceId: "brand", title: "品牌", url: "https://brand.example" },
        rawArtifact: { algorithm: "sha256", digest: "a".repeat(64), objectKey: "synthetic" },
        metrics: { bytesFetched: 10, durationMs: 1 } }
    });
    if (links === undefined) {
      expect(result).toMatchObject({ status: "EVIDENCE_GAP",
        gap: { code: "SOURCE_LINK_DISCOVERY_UNSUPPORTED", retryable: false } });
      expect(nextEvidenceId).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ status: "EVIDENCE_CREATED", links });
    }
  }
);
