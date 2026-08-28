import { createHash } from "node:crypto";

import type { SourceAdapter } from "./worker.js";

export function createFixtureSourceAdapter(options: Readonly<{
  loginUrl: string;
}>): SourceAdapter {
  return {
    officialLoginUrl: options.loginUrl,
    async run(input) {
      input.signal.throwIfAborted();
      input.revealCredential();
      await input.saveCheckpoint({ stage: "fixture-collected", query: input.claim.query });
      input.signal.throwIfAborted();
      const digest = createHash("sha256")
        .update(`${input.claim.sourceId}\0${input.claim.query}`, "utf8")
        .digest("hex")
        .slice(0, 24);
      return {
        type: "EVIDENCE",
        resultKey: `fixture:${digest}`,
        evidenceId: `evidence-fixture-${digest}`,
        summary: `Fixture 来源已验证研究骨架：${input.claim.query}`,
        costUnits: 0
      };
    }
  };
}
