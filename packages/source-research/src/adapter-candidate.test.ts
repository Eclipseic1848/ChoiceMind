import { describe, expect, it } from "vitest";

import {
	createAdapterCandidate,
	createAdapterCandidateLifecycle,
	readApprovedAdapterCandidate,
	transitionAdapterCandidateLifecycle,
} from "./adapter-candidate.js";

describe("Adapter Candidate 合同", () => {
	it("正式读取须匹配批准报告和制品，不能伪造 ENABLED 状态", () => {
		const candidate = validCandidate();
		const enabled = enable(candidate);
		expect(
			readApprovedAdapterCandidate(
				candidate,
				enabled,
				enabled.reviewBindingSha256,
				candidate.source.artifactSha256,
			),
		).toEqual(candidate);
		expect(
			readApprovedAdapterCandidate(
				candidate,
				enabled,
				"f".repeat(64),
				candidate.source.artifactSha256,
			),
		).toBeUndefined();
		expect(
			readApprovedAdapterCandidate(
				candidate,
				enabled,
				enabled.reviewBindingSha256,
				"f".repeat(64),
			),
		).toBeUndefined();
		const pending = createAdapterCandidateLifecycle(candidate);
		expect(
			readApprovedAdapterCandidate(
				candidate,
				pending,
				pending.reviewBindingSha256,
				candidate.source.artifactSha256,
			),
		).toBeUndefined();
		expect(() =>
			readApprovedAdapterCandidate(
				candidate,
				{ ...pending, state: "ENABLED" },
				pending.reviewBindingSha256,
				candidate.source.artifactSha256,
			),
		).toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
	});
	it("报告摘要未变但审查内容改变，也必须重新审批", () => {
		const candidate = validCandidate();
		const review = passedReview();
		const changed = validCandidate({
			...review,
			checks: {
				...review.checks,
				network: { ...review.checks.network, checkCount: 2 },
			},
		});
		expect(() =>
			transitionAdapterCandidateLifecycle(changed, enable(candidate), {
				type: "DISABLE",
				actorId: "admin-1",
				actorRole: "ADMIN",
				occurredAt: "2026-08-30T12:02:00.000Z",
				reasonCode: "ADMIN_REQUEST",
			}),
		).toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
		expect(createAdapterCandidateLifecycle(changed).state).toBe(
			"AWAITING_APPROVAL",
		);
	});
	it("不接受缺少报告绑定的旧审批", () => {
		const candidate = validCandidate();
		const { reviewBindingSha256: _binding, ...legacy } = enable(candidate);
		expect(() =>
			transitionAdapterCandidateLifecycle(candidate, legacy, {
				type: "DISABLE",
				actorId: "admin-1",
				actorRole: "ADMIN",
				occurredAt: "2026-08-30T12:02:00.000Z",
				reasonCode: "ADMIN_REQUEST",
			}),
		).toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
	});
	it("报告替换后不能沿用同一制品的旧审批", () => {
		const candidate = validCandidate();
		const approved = enable(candidate);
		const changed = validCandidate({
			...passedReview(),
			reportSha256: "f".repeat(64),
		});
		expect(changed.candidateId).toBe(candidate.candidateId);
		expect(() =>
			transitionAdapterCandidateLifecycle(changed, approved, {
				type: "DISABLE",
				actorId: "admin-1",
				actorRole: "ADMIN",
				occurredAt: "2026-08-30T12:02:00.000Z",
				reasonCode: "ADMIN_REQUEST",
			}),
		).toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
	});
	it("把通过审查的精确 GitHub commit 固定为不可变候选，但不自动启用", () => {
		const candidate = createAdapterCandidate({
			schemaVersion: "adapter-candidate.v1",
			source: {
				kind: "GITHUB",
				repository: "Eclipseic1848/adapter-example",
				commitSha: "a".repeat(40),
				artifactSha256: "c".repeat(64),
			},
			review: passedReview(),
		});

		expect(candidate).toMatchObject({
			schemaVersion: "adapter-candidate.v1",
			candidateId: expect.stringMatching(/^adapter-candidate-[0-9a-f]{64}$/),
			source: {
				kind: "GITHUB",
				repository: "eclipseic1848/adapter-example",
				commitSha: "a".repeat(40),
				artifactSha256: "c".repeat(64),
			},
			review: passedReview(),
		});
		expect(Object.isFrozen(candidate)).toBe(true);
		expect(Object.isFrozen(candidate.source)).toBe(true);
		expect(
			createAdapterCandidate({
				schemaVersion: "adapter-candidate.v1",
				source: { ...candidate.source, artifactSha256: "d".repeat(64) },
				review: passedReview(),
			}).candidateId,
		).not.toBe(candidate.candidateId);
		expect(createAdapterCandidateLifecycle(candidate)).toEqual({
			schemaVersion: "adapter-candidate-lifecycle.v1",
			candidateId: candidate.candidateId,
			reviewBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			state: "AWAITING_APPROVAL",
			events: [],
		});
	});

	it("只接受 npm/PyPI 精确版本与制品 SHA-256", () => {
		const npm = createAdapterCandidate({
			schemaVersion: "adapter-candidate.v1",
			source: {
				kind: "NPM",
				packageName: "@example/source-adapter",
				version: "1.2.3-rc.1",
				artifactSha256: "C".repeat(64),
			},
			review: passedReview(),
		});
		const pypi = createAdapterCandidate({
			schemaVersion: "adapter-candidate.v1",
			source: {
				kind: "PYPI",
				packageName: "Media_Crawler",
				version: "1.2.0rc1",
				artifactSha256: "d".repeat(64),
			},
			review: passedReview(),
		});

		expect(npm.source).toEqual({
			kind: "NPM",
			packageName: "@example/source-adapter",
			version: "1.2.3-rc.1",
			artifactSha256: "c".repeat(64),
		});
		expect(pypi.source).toEqual({
			kind: "PYPI",
			packageName: "media-crawler",
			version: "1.2.0rc1",
			artifactSha256: "d".repeat(64),
		});
		expect(npm.candidateId).not.toBe(pypi.candidateId);
	});

	it.each([
		[
			"GitHub 短 commit",
			{
				kind: "GITHUB",
				repository: "owner/repo",
				commitSha: "abc123",
				artifactSha256: "c".repeat(64),
			},
		],
		[
			"GitHub 缺少制品哈希",
			{ kind: "GITHUB", repository: "owner/repo", commitSha: "a".repeat(40) },
		],
		[
			"npm 浮动版本",
			{
				kind: "NPM",
				packageName: "source-adapter",
				version: "^1.2.3",
				artifactSha256: "c".repeat(64),
			},
		],
		[
			"PyPI 版本范围",
			{
				kind: "PYPI",
				packageName: "source-adapter",
				version: ">=1.2.3",
				artifactSha256: "c".repeat(64),
			},
		],
		[
			"来源附加未知字段",
			{
				kind: "GITHUB",
				repository: "owner/repo",
				commitSha: "a".repeat(40),
				artifactSha256: "c".repeat(64),
				token: "secret",
			},
		],
	])("拒绝%s", (_label, source) => {
		expect(() =>
			createAdapterCandidate({
				schemaVersion: "adapter-candidate.v1",
				source,
				review: passedReview(),
			}),
		).toThrow("ADAPTER_CANDIDATE_INVALID");
	});

	it("审查摘要精确覆盖九类门禁且不接受秘密或原始错误字段", () => {
		const extraSummary = passedReview();
		(extraSummary.checks.network as Record<string, unknown>).details =
			"Authorization: Bearer secret";
		expect(() => validCandidate(extraSummary)).toThrow(
			"ADAPTER_CANDIDATE_INVALID",
		);

		const inconsistent = passedReview();
		inconsistent.checks.secrets = {
			status: "PASSED",
			checkCount: 1,
			findingCount: 1,
		};
		expect(() => validCandidate(inconsistent)).toThrow(
			"ADAPTER_CANDIDATE_INVALID",
		);

		const failed = passedReview();
		failed.checks.basicCollection = {
			status: "FAILED",
			checkCount: 1,
			findingCount: 1,
		};
		const candidate = validCandidate(failed);
		const lifecycle = createAdapterCandidateLifecycle(candidate);
		expect(lifecycle.state).toBe("REVIEW_FAILED");
		expect(() =>
			transitionAdapterCandidateLifecycle(candidate, lifecycle, {
				type: "ENABLE",
				actorId: "admin-1",
				actorRole: "ADMIN",
				occurredAt: "2026-08-30T12:01:00.000Z",
			}),
		).toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
	});

	it("只有显式 ADMIN 或 SUPERADMIN 动作可以启用", () => {
		const candidate = validCandidate();
		const pending = createAdapterCandidateLifecycle(candidate);

		expect(() =>
			transitionAdapterCandidateLifecycle(candidate, pending, {
				type: "ENABLE",
				actorId: "user-1",
				actorRole: "USER",
				occurredAt: "2026-08-30T12:01:00.000Z",
			}),
		).toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");

		const enabled = transitionAdapterCandidateLifecycle(candidate, pending, {
			type: "ENABLE",
			actorId: "admin-1",
			actorRole: "ADMIN",
			occurredAt: "2026-08-30T12:01:00.000Z",
		});
		expect(enabled).toEqual({
			schemaVersion: "adapter-candidate-lifecycle.v1",
			candidateId: candidate.candidateId,
			reviewBindingSha256: pending.reviewBindingSha256,
			state: "ENABLED",
			events: [
				{
					sequence: 1,
					type: "ENABLED",
					actorId: "admin-1",
					actorRole: "ADMIN",
					occurredAt: "2026-08-30T12:01:00.000Z",
				},
			],
		});
	});

	it("记录管理员禁用和系统失败回滚，不接收原始失败详情", () => {
		const candidate = validCandidate();
		const enabled = enable(candidate);
		const disabled = transitionAdapterCandidateLifecycle(candidate, enabled, {
			type: "DISABLE",
			actorId: "superadmin-1",
			actorRole: "SUPERADMIN",
			occurredAt: "2026-08-30T12:02:00.000Z",
			reasonCode: "SECURITY_REVIEW",
		});
		expect(disabled.state).toBe("DISABLED");
		expect(disabled.events.at(-1)).toMatchObject({
			type: "DISABLED",
			reasonCode: "SECURITY_REVIEW",
		});

		const rolledBack = transitionAdapterCandidateLifecycle(candidate, enabled, {
			type: "ROLLBACK_FAILURE",
			actorId: "source-worker",
			actorRole: "SYSTEM",
			occurredAt: "2026-08-30T12:02:00.000Z",
			failureCode: "HEALTH_CHECK_FAILED",
		});
		expect(rolledBack.state).toBe("DISABLED");
		expect(rolledBack.events.at(-1)).toMatchObject({
			type: "FAILED_ROLLBACK",
			failureCode: "HEALTH_CHECK_FAILED",
		});
		expect(() =>
			transitionAdapterCandidateLifecycle(candidate, enabled, {
				type: "ROLLBACK_FAILURE",
				actorId: "source-worker",
				actorRole: "SYSTEM",
				occurredAt: "2026-08-30T12:02:00.000Z",
				failureCode: "HEALTH_CHECK_FAILED",
				error: "Cookie=secret",
			}),
		).toThrow("ADAPTER_CANDIDATE_LIFECYCLE_INVALID");
	});
});

function validCandidate(review = passedReview()) {
	return createAdapterCandidate({
		schemaVersion: "adapter-candidate.v1",
		source: {
			kind: "GITHUB",
			repository: "owner/repo",
			commitSha: "a".repeat(40),
			artifactSha256: "c".repeat(64),
		},
		review,
	});
}

function enable(candidate: ReturnType<typeof validCandidate>) {
	return transitionAdapterCandidateLifecycle(
		candidate,
		createAdapterCandidateLifecycle(candidate),
		{
			type: "ENABLE",
			actorId: "admin-1",
			actorRole: "ADMIN",
			occurredAt: "2026-08-30T12:01:00.000Z",
		},
	);
}

function passedReview() {
	const passed = {
		status: "PASSED" as "PASSED" | "FAILED" | "NOT_RUN",
		checkCount: 1,
		findingCount: 0,
	};
	return {
		reportSha256: "b".repeat(64),
		reviewedAt: "2026-08-30T12:00:00.000Z",
		checks: {
			dependencies: passed,
			entrypoints: passed,
			network: passed,
			secrets: passed,
			basicCollection: passed,
			loginExpiry: passed,
			rateLimit: passed,
			emptyResult: passed,
			failureHandling: passed,
		},
	};
}
