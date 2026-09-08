import { createHash, randomUUID } from "node:crypto";
import { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { describe, expect, it, vi } from "vitest";
import { loadPersistedCandidateAdapter } from "./approved-candidate-adapter.js";

describe.runIf(process.env.CHOICEMIND_TEST_DATABASE_URL !== undefined)(
	"持久制品加载",
	() => {
		it("重启后取回精确字节，未批准/缺失/撤销均不调用工厂", async () => {
			const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL ?? "";
			let store = await openPostgresCandidateStore(databaseUrl);
			try {
				const artifact = Buffer.from(`synthetic-${randomUUID()}`);
				const digest = createHash("sha256").update(artifact).digest("hex");
				const candidate = await store.record({
					schemaVersion: "adapter-candidate.v1",
					source: {
						kind: "NPM",
						packageName: "synthetic-test",
						version: "1.0.0",
						artifactSha256: digest,
					},
					review: {
						reportSha256: "b".repeat(64),
						reviewedAt: "2026-09-08T12:00:00.000Z",
						checks: Object.fromEntries(
							[
								"dependencies",
								"entrypoints",
								"network",
								"secrets",
								"basicCollection",
								"loginExpiry",
								"rateLimit",
								"emptyResult",
								"failureHandling",
							].map((key) => [
								key,
								{ status: "PASSED", checkCount: 1, findingCount: 0 },
							]),
						),
					},
				});
				const candidateId = candidate.candidate.candidateId;
				const reviewBindingSha256 = candidate.lifecycle.reviewBindingSha256;
				const run = vi.fn(async () => ({
					type: "NO_RESULT" as const,
					summary: "合成结果",
					costUnits: 0,
				}));
				const load = vi.fn(async (bytes: Uint8Array) => {
					expect(Buffer.from(bytes)).toEqual(artifact);
					return { accessMode: "PUBLIC" as const, run };
				});
				const loadCurrent = () =>
					loadPersistedCandidateAdapter({
						candidateId,
						reviewBindingSha256,
						approvals: store,
						load,
					});
				expect(await store.saveArtifact(artifact)).toBe(digest);
				expect(await store.saveArtifact(artifact)).toBe(digest);
				await expect(store.saveArtifact(Buffer.alloc(0))).rejects.toThrow(
					"ADAPTER_CANDIDATE_ARTIFACT_INVALID",
				);
				await expect(loadCurrent()).rejects.toThrow(
					"ADAPTER_CANDIDATE_NOT_APPROVED",
				);
				expect(load).not.toHaveBeenCalled();
				await store.transition(candidateId, reviewBindingSha256, randomUUID(), {
					type: "ENABLE",
					actorId: "synthetic-admin",
					actorRole: "ADMIN",
					occurredAt: "2026-09-08T12:01:00.000Z",
				});
				await store.close();
				store = await openPostgresCandidateStore(databaseUrl);
				const adapter = await loadCurrent();
				await expect(adapter.run({} as never)).resolves.toMatchObject({
					type: "NO_RESULT",
				});
				await store.transition(candidateId, reviewBindingSha256, randomUUID(), {
					type: "DISABLE",
					actorId: "synthetic-admin",
					actorRole: "ADMIN",
					occurredAt: "2026-09-08T12:02:00.000Z",
					reasonCode: "ADMIN_REQUEST",
				});
				await expect(adapter.run({} as never)).rejects.toThrow(
					"ADAPTER_CANDIDATE_NOT_APPROVED",
				);
				await expect(loadCurrent()).rejects.toThrow(
					"ADAPTER_CANDIDATE_NOT_APPROVED",
				);
				expect(load).toHaveBeenCalledOnce();
				expect(run).toHaveBeenCalledOnce();
			} finally {
				await store.close();
			}
		});
	},
);
