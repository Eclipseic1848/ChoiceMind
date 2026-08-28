import { openPostgresConversation } from "@choicemind/conversation";
import type { ExecuteDecisionTaskCommandV1 } from "@choicemind/contracts/decision/v1";
import {
	openPostgresIdentityAccess,
	openPostgresIdentityLifecycleWorker,
} from "@choicemind/identity-access";
import { openPersistentDecisionTaskModule } from "@choicemind/task-persistence";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createIdentityLifecycleHandler } from "../../src/identity-lifecycle-handler.js";

const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
const schemasToDelete: string[] = [];

describe.skipIf(databaseUrl === undefined)(
	"Identity lifecycle across API modules",
	() => {
		afterEach(async () => {
			if (databaseUrl === undefined) return;
			const pool = new Pool({ connectionString: databaseUrl });
			try {
				for (const schema of schemasToDelete.splice(0)) {
					await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
				}
			} finally {
				await pool.end();
			}
		});

		it("停用取消任务，到期删除先清理私有数据且不影响其他用户", async () => {
			if (databaseUrl === undefined) throw new Error("测试数据库未配置");
			const isolated = await createIsolatedDatabaseUrl(databaseUrl);
			let now = new Date("2026-08-27T20:00:00.000Z");
			const identity = await openPostgresIdentityAccess({
				databaseUrl: isolated,
				now: () => now,
			});
			const tasks = await openPersistentDecisionTaskModule({
				databaseUrl: isolated,
				now: () => now,
			});
			const conversation = await openPostgresConversation({
				databaseUrl: isolated,
				now: () => now,
			});
			const worker = await openPostgresIdentityLifecycleWorker({
				databaseUrl: isolated,
				handle: createIdentityLifecycleHandler(tasks, conversation),
				now: () => now,
			});
			try {
				const bootstrap = await identity.execute({
					type: "BOOTSTRAP_SUPERADMIN",
					correlationId: "correlation-bootstrap",
					isLocalRequest: true,
					password: "super123!",
					username: "RootAdmin",
				});
				if (!bootstrap.ok) throw new Error("测试初始化失败");
				const target = await identity.execute({
					type: "CREATE_ACCOUNT",
					correlationId: "correlation-create-target",
					role: "USER",
					sessionToken: bootstrap.sessionToken,
					username: "TargetUser",
				});
				const other = await identity.execute({
					type: "CREATE_ACCOUNT",
					correlationId: "correlation-create-other",
					role: "USER",
					sessionToken: bootstrap.sessionToken,
					username: "OtherUser",
				});
				if (
					!target.ok ||
					!("account" in target) ||
					!other.ok ||
					!("account" in other)
				) {
					throw new Error("测试账号创建失败");
				}
				const targetTask = await tasks.submit(
					buildCommand("target"),
					target.account.accountId,
				);
				const otherTask = await tasks.submit(
					buildCommand("other"),
					other.account.accountId,
				);
				await tasks.saveEncryptedCredential(
					buildCredential(target.account.accountId, "target-key"),
				);
				await tasks.saveEncryptedCredential(
					buildCredential(other.account.accountId, "other-key"),
				);
				const targetSession = await conversation.execute({
					type: "CREATE_SESSION",
					clientRequestId: "target-session",
					ownerUserId: target.account.accountId,
				});
				const otherSession = await conversation.execute({
					type: "CREATE_SESSION",
					clientRequestId: "other-session",
					ownerUserId: other.account.accountId,
				});

				await identity.execute({
					type: "SET_ACCOUNT_STATUS",
					accountId: target.account.accountId,
					correlationId: "correlation-disable",
					sessionToken: bootstrap.sessionToken,
					status: "DISABLED",
				});
				await expect(worker.runOnce()).resolves.toMatchObject({
					status: "PROCESSED",
				});
				await expect(
					tasks.get(targetTask.decisionTaskId, target.account.accountId),
				).resolves.toMatchObject({
					state: "CANCELLED",
				});
				await expect(
					tasks.get(otherTask.decisionTaskId, other.account.accountId),
				).resolves.toMatchObject({
					state: "ACCEPTED",
				});

				await identity.execute({
					type: "SET_ACCOUNT_STATUS",
					accountId: target.account.accountId,
					correlationId: "correlation-enable",
					sessionToken: bootstrap.sessionToken,
					status: "ACTIVE",
				});
				await identity.execute({
					type: "REQUEST_ACCOUNT_DELETION",
					accountId: target.account.accountId,
					correlationId: "correlation-delete",
					currentPassword: "super123!",
					sessionToken: bootstrap.sessionToken,
				});
				await expect(worker.runOnce()).resolves.toMatchObject({
					status: "PROCESSED",
				});
				now = new Date("2026-09-03T20:00:00.001Z");
				await expect(worker.runOnce()).resolves.toMatchObject({
					status: "PROCESSED",
				});

				await expect(
					tasks.get(targetTask.decisionTaskId, target.account.accountId),
				).resolves.toBeUndefined();
				await expect(
					tasks.loadEncryptedCredential("target-key", target.account.accountId),
				).resolves.toBeUndefined();
				await expect(
					tasks.get(otherTask.decisionTaskId, other.account.accountId),
				).resolves.toMatchObject({
					state: "ACCEPTED",
				});
				await expect(
					tasks.loadEncryptedCredential("other-key", other.account.accountId),
				).resolves.toBeDefined();
				await expect(
					conversation.read({
						type: "GET_SESSION",
						ownerUserId: target.account.accountId,
						sessionId: targetSession.sessionId,
					}),
				).resolves.toBeUndefined();
				await expect(
					conversation.read({
						type: "GET_SESSION",
						ownerUserId: other.account.accountId,
						sessionId: otherSession.sessionId,
					}),
				).resolves.toEqual(otherSession);
			} finally {
				await Promise.all([
					worker.close(),
					tasks.close(),
					conversation.close(),
					identity.close(),
				]);
			}
		}, 30_000);
	},
);

async function createIsolatedDatabaseUrl(baseUrl: string): Promise<string> {
	const schema = `api_identity_lifecycle_${randomUUID().replaceAll("-", "")}`;
	const pool = new Pool({ connectionString: baseUrl });
	try {
		await pool.query(`CREATE SCHEMA "${schema}"`);
	} finally {
		await pool.end();
	}
	schemasToDelete.push(schema);
	const url = new URL(baseUrl);
	url.searchParams.set("options", `-c search_path=${schema},public`);
	return url.toString();
}

function buildCommand(suffix: string): ExecuteDecisionTaskCommandV1 {
	return {
		contractType: "execute-decision-task-command",
		contractVersion: "1.0",
		executionRequestId: `exec-api-lifecycle-${suffix}`,
		requirementRevision: {
			contractType: "requirement-revision",
			contractVersion: "1.0",
			requirementRevisionId: `requirement-api-lifecycle-${suffix}-r1`,
			decisionTaskId: `task-api-lifecycle-${suffix}`,
			revision: 1,
			submittedText: "跨模块账号生命周期测试",
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
