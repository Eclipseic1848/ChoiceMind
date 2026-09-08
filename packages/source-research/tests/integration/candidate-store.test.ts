import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openPostgresCandidateStore } from "../../src/candidate-store.js";

describe.runIf(process.env.CHOICEMIND_TEST_DATABASE_URL !== undefined)(
	"候选报告与审批持久化",
	() => {
		it("并发审批幂等、重启保留；新报告使旧审批失效且旧报告不能倒灌", async () => {
			const url = process.env.CHOICEMIND_TEST_DATABASE_URL ?? "";
			let store = await openPostgresCandidateStore(url);
			try {
				const input = candidateInput();
				const original = await store.record(input);
				const id = original.candidate.candidateId;
				const binding = original.lifecycle.reviewBindingSha256;
				const request = randomUUID();
				const action = {
					type: "ENABLE",
					actorId: "admin-test",
					actorRole: "ADMIN",
					occurredAt: "2026-09-08T12:01:00.000Z",
				};
				const approved = await Promise.all([
					store.transition(id, binding, request, action),
					store.transition(id, binding, request, action),
				]);
				expect(approved[0]).toEqual(approved[1]);
				expect(approved[0]?.events).toHaveLength(1);
				await expect(
					store.transition(id, binding, request, {
						...action,
						actorId: "different-admin",
					}),
				).rejects.toThrow("ADAPTER_CANDIDATE_REQUEST_CONFLICT");
				await store.close();
				store = await openPostgresCandidateStore(url);
				expect((await store.read(id))?.lifecycle.state).toBe("ENABLED");
				await store.transition(id, binding, randomUUID(), {
					type: "DISABLE",
					actorId: "admin-test",
					actorRole: "ADMIN",
					occurredAt: "2026-09-08T12:02:00.000Z",
					reasonCode: "ADMIN_REQUEST",
				});
				expect(
					(await store.transition(id, binding, request, action)).state,
				).toBe("DISABLED");
				const newer = await store.record({
					...input,
					review: { ...input.review, reportSha256: "f".repeat(64) },
				});
				expect(newer.lifecycle.state).toBe("AWAITING_APPROVAL");
				await expect(
					store.transition(id, binding, request, action),
				).rejects.toThrow("ADAPTER_CANDIDATE_REVIEW_STALE");
				expect(await store.record(input)).toEqual(newer);
				expect(await store.read(id)).toEqual(newer);
			} finally {
				await store.close();
			}
		});
		it("拒绝普通角色及失败审查，失败事务不追加事件", async () => {
			const store = await openPostgresCandidateStore(
				process.env.CHOICEMIND_TEST_DATABASE_URL ?? "",
			);
			try {
				const input = candidateInput();
				input.review.checks.secrets = {
					status: "FAILED",
					checkCount: 1,
					findingCount: 1,
				};
				const stored = await store.record(input);
				for (const role of ["ADMIN", "USER"]) {
					await expect(
						store.transition(
							stored.candidate.candidateId,
							stored.lifecycle.reviewBindingSha256,
							randomUUID(),
							{
								type: "ENABLE",
								actorId: "test",
								actorRole: role,
								occurredAt: "2026-09-08T12:01:00.000Z",
							},
						),
					).rejects.toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
				}
				expect(
					(await store.read(stored.candidate.candidateId))?.lifecycle.events,
				).toHaveLength(0);
				const passed = await store.record(candidateInput());
				await expect(
					store.transition(
						passed.candidate.candidateId,
						passed.lifecycle.reviewBindingSha256,
						randomUUID(),
						{
							type: "ENABLE",
							actorId: "ordinary-user",
							actorRole: "USER",
							occurredAt: "2026-09-08T12:01:00.000Z",
						},
					),
				).rejects.toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
				expect(
					(await store.read(passed.candidate.candidateId))?.lifecycle.state,
				).toBe("AWAITING_APPROVAL");
			} finally {
				await store.close();
			}
		});
	},
);

function candidateInput() {
	return {
		schemaVersion: "adapter-candidate.v1",
		source: {
			kind: "NPM",
			packageName: `candidate-${randomUUID()}`,
			version: "1.0.0",
			artifactSha256: "a".repeat(64),
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
	};
}
