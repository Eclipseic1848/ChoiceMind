import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	openPersistentDecisionTaskModule,
	type PersistentDecisionTaskModule,
} from "../../src/index.js";
import { resetPersistentDecisionTaskTestData } from "./support.js";

const openModules: PersistentDecisionTaskModule[] = [];

beforeEach(async () => {
	await resetPersistentDecisionTaskTestData(requireDatabaseUrl());
});

afterEach(async () => {
	await Promise.all(
		openModules.splice(0).map(async (module) => module.close()),
	);
});

describe("PersistentDecisionTaskModule account lifecycle", () => {
	it("只取消目标用户的未完成任务", async () => {
		const module = await openModule();
		const first = await module.submit(buildCommand("owner-a-1"), "owner-a");
		const second = await module.submit(buildCommand("owner-a-2"), "owner-a");
		const other = await module.submit(buildCommand("owner-b-1"), "owner-b");

		await expect(
			module.cancelActiveTasksForOwner(
				"owner-a",
				"correlation-account-restricted",
			),
		).resolves.toEqual({ cancelled: 2 });
		await expect(
			module.get(first.decisionTaskId, "owner-a"),
		).resolves.toMatchObject({
			state: "CANCELLED",
		});
		await expect(
			module.get(second.decisionTaskId, "owner-a"),
		).resolves.toMatchObject({
			state: "CANCELLED",
		});
		await expect(
			module.get(other.decisionTaskId, "owner-b"),
		).resolves.toMatchObject({
			state: "ACCEPTED",
		});
	});

	it("永久删除仅清理目标用户的任务与凭据", async () => {
		const module = await openModule();
		const target = await module.submit(buildCommand("delete-a"), "owner-a");
		const other = await module.submit(buildCommand("keep-b"), "owner-b");
		await module.saveEncryptedCredential(
			buildCredential("owner-a", "credential-a"),
		);
		await module.saveEncryptedCredential(
			buildCredential("owner-b", "credential-b"),
		);

		await expect(module.purgePrivateDataForOwner("owner-a")).resolves.toEqual({
			deletedCredentials: 1,
			deletedTasks: 1,
		});
		await expect(
			module.get(target.decisionTaskId, "owner-a"),
		).resolves.toBeUndefined();
		await expect(
			module.loadEncryptedCredential("credential-a", "owner-a"),
		).resolves.toBeUndefined();
		await expect(
			module.get(other.decisionTaskId, "owner-b"),
		).resolves.toMatchObject({
			state: "ACCEPTED",
		});
		await expect(
			module.loadEncryptedCredential("credential-b", "owner-b"),
		).resolves.toBeDefined();
	});
});

async function openModule(): Promise<PersistentDecisionTaskModule> {
	const module = await openPersistentDecisionTaskModule({
		databaseUrl: requireDatabaseUrl(),
	});
	openModules.push(module);
	return module;
}

function buildCommand(suffix: string): ExecuteDecisionTaskCommandV1 {
	return {
		contractType: "execute-decision-task-command",
		contractVersion: "1.0",
		executionRequestId: `exec-lifecycle-${suffix}`,
		requirementRevision: {
			contractType: "requirement-revision",
			contractVersion: "1.0",
			requirementRevisionId: `requirement-lifecycle-${suffix}-r1`,
			decisionTaskId: `task-lifecycle-${suffix}`,
			revision: 1,
			submittedText: "账号生命周期隔离测试",
			market: { country: "CN", currency: "CNY", locale: "zh-CN" },
			intendedUses: ["账号生命周期测试"],
			mustHaves: [],
			niceToHaves: [],
			mustNotHaves: [],
			unknowns: [],
		},
	};
}

function buildCredential(ownerUserId: string, credentialId: string) {
	return {
		ownerUserId,
		credentialId,
		secretType: "SOURCE_CREDENTIAL" as const,
		encryptionVersion: "AES_256_GCM_ENVELOPE_V1" as const,
		ciphertext: "ciphertext",
		ciphertextIv: "ciphertext-iv",
		ciphertextTag: "ciphertext-tag",
		wrappedDataKey: "wrapped-key",
		wrappedDataKeyIv: "wrapped-key-iv",
		wrappedDataKeyTag: "wrapped-key-tag",
	};
}

function requireDatabaseUrl(): string {
	const value = process.env.CHOICEMIND_TEST_DATABASE_URL;
	if (value === undefined || value.length === 0) {
		throw new Error(
			"CHOICEMIND_TEST_DATABASE_URL 必须指向隔离的真实 Postgres 测试库",
		);
	}
	return value;
}
