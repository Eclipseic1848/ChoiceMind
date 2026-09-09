import {
	createCredentialVault,
	createEgressGuard,
	type EncryptedCredentialRecord,
} from "@choicemind/security";
import { openPersistentDecisionTaskModule } from "@choicemind/task-persistence";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
	openPostgresProviderRouting,
	type ProviderAttemptOutcomeV1,
	type ProviderRouting,
	type ProviderRoutingOperationError,
} from "../../src/index.js";

const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl });
const openModules: ProviderRouting[] = [];
const testCredentialSystemActor = Object.freeze({
	userId: "provider-routing:test-runtime",
	role: "SYSTEM" as const,
});

beforeEach(async () => {
	await Promise.all(openModules.splice(0).map((module) => module.close()));
	const bootstrap = await openPostgresProviderRouting({
		databaseUrl,
		credentialVault: createCredentialVault({
			masterKey: Buffer.alloc(32, 1),
			systemAccess: {
				actor: testCredentialSystemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["DELETE"],
			},
			storage: {
				async save() {},
				async load() {
					return undefined;
				},
				async delete() {
					return false;
				},
			},
			appendAuditRecord: async () => undefined,
		}),
		credentialSystemActor: testCredentialSystemActor,
		commandFingerprintKey: Buffer.alloc(32, 2),
	});
	await bootstrap.close();
	await pool.query(
		`TRUNCATE provider_route_requests, provider_route_decisions, platform_provider_usage,
		 platform_provider_limits,
		 provider_text_egress_consents,
		 provider_route_preferences, provider_capability_certifications,
		 provider_pending_credential_deletions, provider_command_records,
		 provider_configurations`,
	);
});

afterAll(async () => {
	await Promise.all(openModules.splice(0).map((module) => module.close()));
	await pool.end();
});

describe("Postgres Provider Routing", () => {
	it("只允许 User 配置自己的 BYOK，并且公开结果不泄露 Secret 或 Credential ID", async () => {
		const records = new Map<string, EncryptedCredentialRecord>();
		const vault = createCredentialVault({
			masterKey: Buffer.alloc(32, 7),
			systemAccess: {
				actor: testCredentialSystemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["DELETE"],
			},
			storage: {
				async save(record) {
					records.set(`${record.ownerUserId}:${record.credentialId}`, record);
				},
				async load(credentialId, ownerUserId) {
					return records.get(`${ownerUserId}:${credentialId}`);
				},
				async delete(credentialId, ownerUserId) {
					return records.delete(`${ownerUserId}:${credentialId}`);
				},
			},
			appendAuditRecord: async () => undefined,
		});
		const routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor: testCredentialSystemActor,
			commandFingerprintKey: Buffer.alloc(32, 9),
		});
		openModules.push(routing);

		const result = await routing.execute({
			contractVersion: "1.0",
			type: "SAVE_CONFIGURATION",
			requestId: "save-user-a-decision",
			actor: { userId: "user-a", role: "USER" },
			scope: "USER",
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			providerId: "dashscope",
			region: "cn-beijing",
			modelId: "qwen3.8-max",
			endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			credential: "user-a-secret",
		});

		expect(result).toMatchObject({
			resultType: "CONFIGURATION_SAVED",
			configuration: {
				scope: "USER",
				capability: "DECISION_TEXT",
				endpointOrigin: "https://dashscope.aliyuncs.com",
				credentialPresent: true,
			},
		});
		expect(JSON.stringify(result)).not.toContain("user-a-secret");
		expect(JSON.stringify(result)).not.toContain("credentialId");
		await expect(
			routing.execute({
				contractVersion: "1.0",
				type: "SAVE_CONFIGURATION",
				requestId: "save-user-a-unlisted-endpoint",
				actor: { userId: "user-a", role: "USER" },
				scope: "USER",
				ownerUserId: "user-a",
				capability: "DECISION_TEXT",
				providerId: "dashscope",
				region: "cn-beijing",
				modelId: "qwen3.8-max",
				endpointUrl: "https://unlisted.example/compatible-mode/v1",
				credential: "must-not-store",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_REQUEST_REJECTED" });
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_USER_CONFIGURATION",
				actor: { userId: "user-b", role: "USER" },
				ownerUserId: "user-b",
				capability: "DECISION_TEXT",
			}),
		).resolves.toEqual({ resultType: "CONFIGURATION", configuration: null });
		await expect(
			routing.execute({
				contractVersion: "1.0",
				type: "SAVE_CONFIGURATION",
				requestId: "user-a-writes-user-b",
				actor: { userId: "user-a", role: "USER" },
				scope: "USER",
				ownerUserId: "user-b",
				capability: "DECISION_TEXT",
				providerId: "dashscope",
				region: "cn-beijing",
				modelId: "qwen3.8-max",
				endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				credential: "must-not-store",
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<ProviderRoutingOperationError>>({
				code: "PROVIDER_PERMISSION_DENIED",
			}),
		);
	});

	it("数据库提交失败时不遗留无引用 Provider 凭据", async () => {
		const records = new Map<string, EncryptedCredentialRecord>();
		const vault = createCredentialVault({
			masterKey: Buffer.alloc(32, 21),
			systemAccess: {
				actor: testCredentialSystemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["DELETE"],
			},
			storage: {
				async save(record) {
					records.set(`${record.ownerUserId}:${record.credentialId}`, record);
				},
				async load(credentialId, ownerUserId) {
					return records.get(`${ownerUserId}:${credentialId}`);
				},
				async delete(credentialId, ownerUserId) {
					return records.delete(`${ownerUserId}:${credentialId}`);
				},
			},
			appendAuditRecord: async () => undefined,
		});
		const routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor: testCredentialSystemActor,
			commandFingerprintKey: Buffer.alloc(32, 22),
		});
		openModules.push(routing);
		await pool.query(`
			CREATE OR REPLACE FUNCTION fail_provider_command_commit_test()
			RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.request_id = 'force-deferred-commit-failure' THEN
					RAISE EXCEPTION 'forced deferred commit failure';
				END IF;
				RETURN NEW;
			END
			$$
		`);
		await pool.query(`
			CREATE CONSTRAINT TRIGGER fail_provider_command_commit_test
			AFTER INSERT ON provider_command_records
			DEFERRABLE INITIALLY DEFERRED
			FOR EACH ROW EXECUTE FUNCTION fail_provider_command_commit_test()
		`);
		try {
			await expect(
				routing.execute({
					contractVersion: "1.0",
					type: "SAVE_CONFIGURATION",
					requestId: "force-deferred-commit-failure",
					actor: { userId: "commit-user", role: "USER" },
					scope: "USER",
					ownerUserId: "commit-user",
					capability: "DECISION_TEXT",
					providerId: "openai",
					region: "global",
					modelId: "commit-model",
					endpointUrl: "https://api.openai.com/v1",
					credential: "must-be-deleted",
				}),
			).rejects.toThrow("forced deferred commit failure");
			expect(records.size).toBe(0);
			await expect(
				pool.query(
					"SELECT count(*)::int AS count FROM provider_pending_credential_deletions",
				),
			).resolves.toMatchObject({ rows: [{ count: 0 }] });
		} finally {
			await pool.query(
				"DROP TRIGGER IF EXISTS fail_provider_command_commit_test ON provider_command_records",
			);
			await pool.query(
				"DROP FUNCTION IF EXISTS fail_provider_command_commit_test()",
			);
		}
	});

	it("启动时只清理已过等待期且未被配置引用的 Provider 凭据", async () => {
		const records = new Map<string, EncryptedCredentialRecord>();
		const systemActor = Object.freeze({
			userId: "provider-routing:runtime",
			role: "SYSTEM" as const,
		});
		const vault = createCredentialVault({
			masterKey: Buffer.alloc(32, 23),
			systemAccess: {
				actor: systemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["DELETE"],
			},
			storage: {
				async save(record) {
					records.set(`${record.ownerUserId}:${record.credentialId}`, record);
				},
				async load(credentialId, ownerUserId) {
					return records.get(`${ownerUserId}:${credentialId}`);
				},
				async delete(credentialId, ownerUserId) {
					return records.delete(`${ownerUserId}:${credentialId}`);
				},
			},
			appendAuditRecord: async () => undefined,
		});
		let routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor: systemActor,
			commandFingerprintKey: Buffer.alloc(32, 24),
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "SAVE_CONFIGURATION",
			requestId: "save-referenced-provider-credential",
			actor: { userId: "active-owner", role: "USER" },
			scope: "USER",
			ownerUserId: "active-owner",
			capability: "DECISION_TEXT",
			providerId: "openai",
			region: "global",
			modelId: "active-model",
			endpointUrl: "https://api.openai.com/v1",
			credential: "active-secret",
		});
		await routing.close();
		const activeRecord = [...records.values()][0];
		if (activeRecord === undefined) throw new Error("缺少测试用有效凭据");

		const credentialId = "00000000-0000-4000-8000-000000000023";
		await vault.store({
			credentialId,
			ownerUserId: "orphan-owner",
			secret: "orphan-secret",
			secretType: "PROVIDER_CREDENTIAL",
			actor: { userId: "orphan-owner", role: "USER" },
			correlationId: "create-orphan",
		});
		await pool.query(
			`INSERT INTO provider_pending_credential_deletions (
			   deletion_id, owner_user_id, credential_id,
			   deletion_authority, requested_at, not_before
			 ) VALUES
			   ($1, $2, $3, 'SYSTEM', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour'),
			   ($4, $5, $6, 'SYSTEM', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
			[
				credentialId,
				"orphan-owner",
				credentialId,
				"00000000-0000-4000-8000-000000000024",
				activeRecord.ownerUserId,
				activeRecord.credentialId,
			],
		);

		routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor: systemActor,
			commandFingerprintKey: Buffer.alloc(32, 24),
		});
		openModules.push(routing);
		expect(records.size).toBe(1);
		expect(
			records.has(`${activeRecord.ownerUserId}:${activeRecord.credentialId}`),
		).toBe(true);
		await expect(
			pool.query(
				"SELECT count(*)::int AS count FROM provider_pending_credential_deletions",
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });
	});

	it("只允许 SUPERADMIN 管理平台配置，并在替换后删除旧凭据", async () => {
		const records = new Map<string, EncryptedCredentialRecord>();
		const systemActor = Object.freeze({
			userId: "provider-routing:runtime",
			role: "SYSTEM" as const,
		});
		const vault = createCredentialVault({
			masterKey: Buffer.alloc(32, 8),
			systemAccess: {
				actor: systemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["USE", "DELETE"],
			},
			storage: {
				async save(record) {
					records.set(`${record.ownerUserId}:${record.credentialId}`, record);
				},
				async load(credentialId, ownerUserId) {
					return records.get(`${ownerUserId}:${credentialId}`);
				},
				async delete(credentialId, ownerUserId) {
					return records.delete(`${ownerUserId}:${credentialId}`);
				},
			},
			appendAuditRecord: async () => undefined,
		});
		const routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor: systemActor,
			commandFingerprintKey: Buffer.alloc(32, 10),
		});
		openModules.push(routing);
		const base = {
			contractVersion: "1.0" as const,
			type: "SAVE_CONFIGURATION" as const,
			scope: "PLATFORM" as const,
			capability: "DECISION_TEXT" as const,
			providerId: "dashscope",
			region: "cn-beijing",
			modelId: "qwen3.8-max",
			endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		};

		await expect(
			routing.execute({
				...base,
				requestId: "user-cannot-save-platform",
				actor: { userId: "user-a", role: "USER" },
				ownerUserId: "user-a",
				credential: "must-not-store",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_PERMISSION_DENIED" });
		await routing.execute({
			...base,
			requestId: "admin-a-platform",
			actor: { userId: "admin-a", role: "SUPERADMIN" },
			ownerUserId: "admin-a",
			credential: "platform-secret-a",
		});
		expect(records.size).toBe(1);
		const replaced = await routing.execute({
			...base,
			requestId: "admin-b-platform",
			actor: { userId: "admin-b", role: "SUPERADMIN" },
			ownerUserId: "admin-b",
			credential: "platform-secret-b",
		});
		expect(records.size).toBe(1);
		expect(JSON.stringify(replaced)).not.toContain("platform-secret");
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_PLATFORM_CONFIGURATION",
				actor: { userId: "user-a", role: "USER" },
				capability: "DECISION_TEXT",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_PERMISSION_DENIED" });
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_PLATFORM_CONFIGURATION",
				actor: { userId: "admin-b", role: "SUPERADMIN" },
				capability: "DECISION_TEXT",
			}),
		).resolves.toMatchObject({
			resultType: "CONFIGURATION",
			configuration: { scope: "PLATFORM", credentialPresent: true },
		});
	});

	it("User 只能停用或删除自己的配置，删除后同时清除凭据", async () => {
		const records = new Map<string, EncryptedCredentialRecord>();
		const vault = createCredentialVault({
			masterKey: Buffer.alloc(32, 13),
			systemAccess: {
				actor: testCredentialSystemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["DELETE"],
			},
			storage: {
				async save(record) {
					records.set(`${record.ownerUserId}:${record.credentialId}`, record);
				},
				async load(credentialId, ownerUserId) {
					return records.get(`${ownerUserId}:${credentialId}`);
				},
				async delete(credentialId, ownerUserId) {
					return records.delete(`${ownerUserId}:${credentialId}`);
				},
			},
			appendAuditRecord: async () => undefined,
		});
		const routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor: testCredentialSystemActor,
			commandFingerprintKey: Buffer.alloc(32, 14),
		});
		openModules.push(routing);
		await routing.execute({
			contractVersion: "1.0",
			type: "SAVE_CONFIGURATION",
			requestId: "save-user-a-for-lifecycle",
			actor: { userId: "user-a", role: "USER" },
			scope: "USER",
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			providerId: "dashscope",
			region: "cn-beijing",
			modelId: "qwen3.8-max",
			endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			credential: "user-a-lifecycle-secret",
		});
		expect(records.size).toBe(1);

		await expect(
			routing.execute({
				contractVersion: "1.0",
				type: "SET_CONFIGURATION_STATUS",
				requestId: "user-b-disables-user-a",
				actor: { userId: "user-b", role: "USER" },
				scope: "USER",
				ownerUserId: "user-a",
				capability: "DECISION_TEXT",
				status: "DISABLED",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_PERMISSION_DENIED" });
		await routing.execute({
			contractVersion: "1.0",
			type: "SET_CONFIGURATION_STATUS",
			requestId: "user-a-disables-own",
			actor: { userId: "user-a", role: "USER" },
			scope: "USER",
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			status: "DISABLED",
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_USER_CONFIGURATION",
				actor: { userId: "user-a", role: "USER" },
				ownerUserId: "user-a",
				capability: "DECISION_TEXT",
			}),
		).resolves.toMatchObject({
			configuration: { status: "DISABLED" },
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_EFFECTIVE_ROUTE",
				actor: { userId: "user-a", role: "USER" },
				ownerUserId: "user-a",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
			}),
		).resolves.toMatchObject({
			status: "BLOCKED",
			code: "PROVIDER_CONFIGURATION_DISABLED",
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "DELETE_USER_CONFIGURATION",
			requestId: "user-a-deletes-own",
			actor: { userId: "user-a", role: "USER" },
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
		});
		expect(records.size).toBe(0);
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_USER_CONFIGURATION",
				actor: { userId: "user-a", role: "USER" },
				ownerUserId: "user-a",
				capability: "DECISION_TEXT",
			}),
		).resolves.toEqual({ resultType: "CONFIGURATION", configuration: null });
	});

	it("平台路线必须经过认证、用户确认、外传同意和显式有限额度", async () => {
		const records = new Map<string, EncryptedCredentialRecord>();
		const credentialSystemActor = Object.freeze({
			userId: "provider-routing:runtime",
			role: "SYSTEM" as const,
		});
		const certificationSystemActor = Object.freeze({
			userId: "provider-certification:runner",
			role: "SYSTEM" as const,
		});
		const vault = createCredentialVault({
			masterKey: Buffer.alloc(32, 11),
			systemAccess: {
				actor: credentialSystemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["USE", "DELETE"],
			},
			storage: {
				async save(record) {
					records.set(`${record.ownerUserId}:${record.credentialId}`, record);
				},
				async load(credentialId, ownerUserId) {
					return records.get(`${ownerUserId}:${credentialId}`);
				},
				async delete(credentialId, ownerUserId) {
					return records.delete(`${ownerUserId}:${credentialId}`);
				},
			},
			appendAuditRecord: async () => undefined,
		});
		const routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor,
			certificationSystemActor,
			egressGuard: createEgressGuard({
				appendRecord: async () => undefined,
				nextId: () => "egress-platform-connection",
				now: () => new Date("2026-08-30T12:00:00.000Z"),
			}),
			commandFingerprintKey: Buffer.alloc(32, 12),
		});
		openModules.push(routing);
		await routing.execute({
			contractVersion: "1.0",
			type: "SAVE_CONFIGURATION",
			requestId: "save-platform-route",
			actor: { userId: "admin-a", role: "SUPERADMIN" },
			scope: "PLATFORM",
			ownerUserId: "admin-a",
			capability: "DECISION_TEXT",
			providerId: "dashscope",
			region: "cn-beijing",
			modelId: "qwen3.8-max",
			endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			credential: "platform-secret",
		});
		let connectionCredential: string | undefined;
		await expect(
			routing.testPlatformConnection(
				{
					contractVersion: "1.0",
					type: "TEST_PLATFORM_CONNECTION",
					requestId: "test-platform-connection",
					actor: { userId: "admin-a", role: "SUPERADMIN" },
					capability: "DECISION_TEXT",
				},
				async (target) => {
					connectionCredential = target.credential.reveal();
					expect(target.endpointUrl).toBe(
						"https://dashscope.aliyuncs.com/compatible-mode/v1",
					);
				},
			),
		).resolves.toMatchObject({
			providerId: "dashscope",
			region: "cn-beijing",
			modelId: "qwen3.8-max",
		});
		expect(connectionCredential).toBe("platform-secret");
		const routeQuery = {
			contractVersion: "1.0" as const,
			type: "GET_EFFECTIVE_ROUTE" as const,
			actor: { userId: "user-a", role: "USER" as const },
			ownerUserId: "user-a",
			capability: "DECISION_TEXT" as const,
			dataClasses: ["MINIMIZED_REQUIREMENT"] as const,
		};

		await expect(routing.read(routeQuery)).resolves.toMatchObject({
			resultType: "EFFECTIVE_ROUTE",
			status: "BLOCKED",
			code: "PROVIDER_CAPABILITY_UNCERTIFIED",
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "IMPORT_CERTIFICATION",
			requestId: "certify-dashscope-qwen",
			actor: certificationSystemActor,
			identity: {
				providerId: "dashscope",
				region: "cn-beijing",
				modelId: "qwen3.8-max",
				routePolicyVersion: "p1-v1",
			},
			capabilities: ["DECISION_TEXT"],
			evidenceDigest: "a".repeat(64),
			certifiedAt: "2026-08-30T10:00:00.000Z",
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "CONFIRM_ROUTE",
			requestId: "confirm-user-a-platform-route",
			actor: { userId: "user-a", role: "USER" },
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			routeKind: "PLATFORM",
			localFallbackEnabled: false,
		});
		const revokeCommand = {
			contractVersion: "1.0" as const,
			type: "REVOKE_ROUTE" as const,
			requestId: "revoke-user-a-platform-route",
			actor: { userId: "user-a", role: "USER" as const },
			ownerUserId: "user-a",
			capability: "DECISION_TEXT" as const,
		};
		await expect(routing.execute(revokeCommand)).resolves.toMatchObject({
			resultType: "ROUTE_REVOKED",
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
		});
		await expect(routing.execute(revokeCommand)).resolves.toMatchObject({
			resultType: "ROUTE_REVOKED",
			requestId: revokeCommand.requestId,
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_ROUTE_PREFERENCE",
				actor: { userId: "user-a", role: "USER" },
				ownerUserId: "user-a",
				capability: "DECISION_TEXT",
			}),
		).resolves.toMatchObject({
			resultType: "ROUTE_PREFERENCE",
			preference: null,
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "SAVE_CONFIGURATION",
			requestId: "save-user-a-before-platform-switch",
			actor: { userId: "user-a", role: "USER" },
			scope: "USER",
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			providerId: "openai",
			region: "global",
			modelId: "user-model",
			endpointUrl: "https://api.openai.com/v1",
			credential: "user-secret",
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "CONFIRM_ROUTE",
			requestId: "reconfirm-user-a-platform-route",
			actor: { userId: "user-a", role: "USER" },
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			routeKind: "PLATFORM",
			localFallbackEnabled: false,
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_USER_CONFIGURATION",
				actor: { userId: "user-a", role: "USER" },
				ownerUserId: "user-a",
				capability: "DECISION_TEXT",
			}),
		).resolves.toMatchObject({
			resultType: "CONFIGURATION",
			configuration: { status: "DISABLED" },
		});
		await expect(routing.read(routeQuery)).resolves.toMatchObject({
			status: "BLOCKED",
			code: "PROVIDER_CONSENT_REQUIRED",
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "SET_TEXT_EGRESS_CONSENT",
			requestId: "consent-user-a-dashscope",
			actor: { userId: "user-a", role: "USER" },
			ownerUserId: "user-a",
			providerId: "dashscope",
			region: "cn-beijing",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			granted: true,
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "LIST_TEXT_EGRESS_CONSENTS",
				actor: { userId: "user-a", role: "USER" },
				ownerUserId: "user-a",
			}),
		).resolves.toMatchObject({
			resultType: "TEXT_EGRESS_CONSENTS",
			consents: [
				{
					providerId: "dashscope",
					region: "cn-beijing",
					dataClasses: [
						expect.objectContaining({
							dataClass: "MINIMIZED_REQUIREMENT",
							granted: true,
						}),
					],
				},
			],
		});
		await expect(routing.read(routeQuery)).resolves.toMatchObject({
			status: "BLOCKED",
			code: "PROVIDER_LIMIT_EXCEEDED",
		});
		await expect(
			routing.acquire({
				contractVersion: "1.0",
				requestId: "platform-limit-paused",
				ownerUserId: "user-a",
				decisionTaskId: "task-platform-limit",
				agentRunId: "run-platform-limit",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				estimatedUsage: { inputTokens: 100, outputTokens: 20 },
			}),
		).rejects.toMatchObject({ code: "PROVIDER_LIMIT_EXCEEDED" });
		const pausedLimitDecision = await pool.query<{
			finalCode: string;
			finalStatus: string;
		}>(
			`SELECT final_status AS "finalStatus", final_code AS "finalCode"
			 FROM provider_route_decisions
			 WHERE owner_user_id = $1 AND request_id = $2`,
			["user-a", "platform-limit-paused"],
		);
		expect(pausedLimitDecision.rows).toEqual([
			{ finalStatus: "PAUSED", finalCode: "PROVIDER_LIMIT_EXCEEDED" },
		]);
		for (const [requestId, limitScope] of [
			["limit-platform-global", "GLOBAL"],
			["limit-platform-default-user", "DEFAULT_USER"],
		] as const) {
			await routing.execute({
				contractVersion: "1.0",
				type: "SET_PLATFORM_LIMIT",
				requestId,
				actor: { userId: "admin-a", role: "SUPERADMIN" },
				limitScope,
				capability: "DECISION_TEXT",
				providerId: "dashscope",
				modelId: "qwen3.8-max",
				budget: { inputTokens: 10_000, outputTokens: 2_000 },
			});
		}
		await expect(routing.read(routeQuery)).resolves.toMatchObject({
			resultType: "EFFECTIVE_ROUTE",
			status: "AVAILABLE",
			routeKind: "PLATFORM",
			identity: {
				providerId: "dashscope",
				region: "cn-beijing",
				modelId: "qwen3.8-max",
			},
		});
		await expect(
			routing.acquire({
				contractVersion: "1.0",
				requestId: "forged-text-consent-id",
				ownerUserId: "user-a",
				decisionTaskId: "task-forged-consent",
				agentRunId: "run-forged-consent",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				textEgressConsentId: "not-a-consent-command",
				estimatedUsage: { inputTokens: 100, outputTokens: 20 },
			}),
		).rejects.toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED" });

		const platformReservations = await Promise.allSettled([
			routing.acquire({
				contractVersion: "1.0",
				requestId: "reserve-platform-a",
				ownerUserId: "user-a",
				decisionTaskId: "task-a",
				agentRunId: "run-a",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				textEgressConsentId: "consent-user-a-dashscope",
				estimatedUsage: { inputTokens: 6_000, outputTokens: 1_000 },
			}),
			routing.acquire({
				contractVersion: "1.0",
				requestId: "reserve-platform-b",
				ownerUserId: "user-a",
				decisionTaskId: "task-b",
				agentRunId: "run-b",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				estimatedUsage: { inputTokens: 6_000, outputTokens: 1_000 },
			}),
		]);
		expect(platformReservations.map((item) => item.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(
			platformReservations.find((item) => item.status === "rejected"),
		).toMatchObject({ reason: { code: "PROVIDER_LIMIT_EXCEEDED" } });
		await expect(
			pool.query("SELECT count(*)::int AS count FROM platform_provider_usage"),
		).resolves.toMatchObject({ rows: [{ count: 1 }] });

		const revokedConsentLease = await routing.acquire({
			contractVersion: "1.0",
			requestId: "consent-revoked-after-acquire",
			ownerUserId: "user-a",
			decisionTaskId: "task-consent-revoked",
			agentRunId: "run-consent-revoked",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "SET_TEXT_EGRESS_CONSENT",
			requestId: "revoke-consent-after-acquire",
			actor: { userId: "user-a", role: "USER" },
			ownerUserId: "user-a",
			providerId: "dashscope",
			region: "cn-beijing",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			granted: false,
		});
		let invokedAfterRevocation = false;
		await expect(
			revokedConsentLease.run(async (attempt) => {
				invokedAfterRevocation = true;
				await attempt.withCredential(async () => undefined);
				return { status: "COMPLETED", value: "must-not-run" };
			}),
		).resolves.toMatchObject({
			status: "PAUSED",
			code: "PROVIDER_CONSENT_REQUIRED",
			effectState: "NOT_STARTED",
		});
		expect(invokedAfterRevocation).toBe(false);
		await expect(
			pool.query(
				`SELECT status FROM platform_provider_usage
				 WHERE owner_user_id = $1 AND request_id = $2`,
				["user-a", "consent-revoked-after-acquire"],
			),
		).resolves.toMatchObject({ rows: [{ status: "RELEASED" }] });
		await routing.execute({
			contractVersion: "1.0",
			type: "SET_TEXT_EGRESS_CONSENT",
			requestId: "restore-consent-after-acquire",
			actor: { userId: "user-a", role: "USER" },
			ownerUserId: "user-a",
			providerId: "dashscope",
			region: "cn-beijing",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			granted: true,
		});
		await expect(
			routing.acquire({
				contractVersion: "1.0",
				requestId: "stale-text-consent-id",
				ownerUserId: "user-a",
				decisionTaskId: "task-stale-consent",
				agentRunId: "run-stale-consent",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				textEgressConsentId: "consent-user-a-dashscope",
				estimatedUsage: { inputTokens: 100, outputTokens: 20 },
			}),
		).rejects.toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED" });

		await routing.execute({
			contractVersion: "1.0",
			type: "SAVE_CONFIGURATION",
			requestId: "save-user-a-byok-route",
			actor: { userId: "user-a", role: "USER" },
			scope: "USER",
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			providerId: "dashscope",
			region: "cn-beijing",
			modelId: "qwen3.8-max",
			endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			credential: "user-a-byok-secret",
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "CONFIRM_ROUTE",
			requestId: "confirm-user-a-byok-route",
			actor: { userId: "user-a", role: "USER" },
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			routeKind: "USER_BYOK",
			localFallbackEnabled: false,
		});
		await expect(
			routing.acquire({
				contractVersion: "1.0",
				requestId: "acquire-user-a-byok",
				ownerUserId: "user-a",
				decisionTaskId: "task-byok",
				agentRunId: "run-byok",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				estimatedUsage: { inputTokens: 6_000, outputTokens: 1_000 },
			}),
		).resolves.toBeDefined();
		await expect(
			routing.acquire({
				contractVersion: "1.0",
				requestId: "acquire-user-a-byok",
				ownerUserId: "user-a",
				decisionTaskId: "task-byok",
				agentRunId: "run-byok",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				estimatedUsage: { inputTokens: 6_000, outputTokens: 1_000 },
			}),
		).rejects.toMatchObject({ code: "PROVIDER_IDEMPOTENCY_CONFLICT" });
		await expect(
			pool.query("SELECT count(*)::int AS count FROM platform_provider_usage"),
		).resolves.toMatchObject({ rows: [{ count: 2 }] });
		await routing.execute({
			contractVersion: "1.0",
			type: "CONFIRM_ROUTE",
			requestId: "switch-user-a-back-to-platform",
			actor: { userId: "user-a", role: "USER" },
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			routeKind: "PLATFORM",
			localFallbackEnabled: false,
		});
		await expect(routing.read(routeQuery)).resolves.toMatchObject({
			resultType: "EFFECTIVE_ROUTE",
			status: "AVAILABLE",
			routeKind: "PLATFORM",
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_USER_CONFIGURATION",
				actor: { userId: "user-a", role: "USER" },
				ownerUserId: "user-a",
				capability: "DECISION_TEXT",
			}),
		).resolves.toMatchObject({ configuration: { status: "DISABLED" } });
		await routing.execute({
			contractVersion: "1.0",
			type: "SET_CONFIGURATION_STATUS",
			requestId: "reenable-user-a-byok-after-platform-choice",
			actor: { userId: "user-a", role: "USER" },
			scope: "USER",
			ownerUserId: "user-a",
			capability: "DECISION_TEXT",
			status: "ENABLED",
		});
		await expect(routing.read(routeQuery)).resolves.toMatchObject({
			status: "BLOCKED",
			code: "PROVIDER_CONFIGURATION_REQUIRED",
		});
	});

	it("真实 PostgreSQL Vault 在重启后仍能读取安全摘要并删除密文", async () => {
		const systemActor = Object.freeze({
			userId: "provider-routing:runtime",
			role: "SYSTEM" as const,
		});
		let persistence = await openPersistentDecisionTaskModule({ databaseUrl });
		let routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: createPersistentVault(persistence, systemActor),
			credentialSystemActor: systemActor,
			commandFingerprintKey: Buffer.alloc(32, 15),
		});
		try {
			await routing.execute({
				contractVersion: "1.0",
				type: "SAVE_CONFIGURATION",
				requestId: "save-persistent-user-route",
				actor: { userId: "persistent-user", role: "USER" },
				scope: "USER",
				ownerUserId: "persistent-user",
				capability: "DECISION_TEXT",
				providerId: "dashscope",
				region: "cn-beijing",
				modelId: "qwen3.8-max",
				endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				credential: "persistent-secret",
			});
			await routing.close();
			await persistence.close();

			persistence = await openPersistentDecisionTaskModule({ databaseUrl });
			routing = await openPostgresProviderRouting({
				databaseUrl,
				credentialVault: createPersistentVault(persistence, systemActor),
				credentialSystemActor: systemActor,
				commandFingerprintKey: Buffer.alloc(32, 15),
			});
			const summary = await routing.read({
				contractVersion: "1.0",
				type: "GET_USER_CONFIGURATION",
				actor: { userId: "persistent-user", role: "USER" },
				ownerUserId: "persistent-user",
				capability: "DECISION_TEXT",
			});
			expect(summary).toMatchObject({
				configuration: { credentialPresent: true, status: "ENABLED" },
			});
			expect(JSON.stringify(summary)).not.toContain("persistent-secret");
			await routing.execute({
				contractVersion: "1.0",
				type: "DELETE_USER_CONFIGURATION",
				requestId: "delete-persistent-user-route",
				actor: { userId: "persistent-user", role: "USER" },
				ownerUserId: "persistent-user",
				capability: "DECISION_TEXT",
			});
			await expect(
				pool.query(
					`SELECT count(*)::int AS count FROM encrypted_credentials
					 WHERE owner_user_id = 'persistent-user'`,
				),
			).resolves.toMatchObject({ rows: [{ count: 0 }] });
		} finally {
			await Promise.allSettled([routing.close(), persistence.close()]);
		}
	});

	it("SUPERADMIN 可读认证状态，旧 Lease 不使用已被替换的配置", async () => {
		const records = new Map<string, EncryptedCredentialRecord>();
		const systemActor = Object.freeze({
			userId: "provider-routing:lease-runtime",
			role: "SYSTEM" as const,
		});
		const certificationActor = Object.freeze({
			userId: "provider-certification:lease-test",
			role: "SYSTEM" as const,
		});
		const vault = createCredentialVault({
			masterKey: Buffer.alloc(32, 25),
			systemAccess: {
				actor: systemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["USE", "DELETE"],
			},
			storage: {
				async save(record) {
					records.set(`${record.ownerUserId}:${record.credentialId}`, record);
				},
				async load(credentialId, ownerUserId) {
					return records.get(`${ownerUserId}:${credentialId}`);
				},
				async delete(credentialId, ownerUserId) {
					return records.delete(`${ownerUserId}:${credentialId}`);
				},
			},
			appendAuditRecord: async () => undefined,
		});
		const routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor: systemActor,
			certificationSystemActor: certificationActor,
			commandFingerprintKey: Buffer.alloc(32, 26),
		});
		openModules.push(routing);
		await configureFallbackRoute(routing, certificationActor);
		const identity = {
			providerId: "dashscope",
			region: "cn-beijing",
			modelId: "qwen3.8-max",
			routePolicyVersion: "p1-v1" as const,
		};
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_CAPABILITY_CERTIFICATION",
				actor: { userId: "fallback-admin", role: "SUPERADMIN" },
				identity,
				capability: "DECISION_TEXT",
			}),
		).resolves.toMatchObject({
			resultType: "CAPABILITY_CERTIFICATION",
			certification: {
				identity,
				capability: "DECISION_TEXT",
				status: "CERTIFIED",
				evidenceDigest: "b".repeat(64),
			},
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_CAPABILITY_CERTIFICATION",
				actor: { userId: "fallback-user", role: "USER" },
				identity,
				capability: "DECISION_TEXT",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_PERMISSION_DENIED" });

		const lease = await routing.acquire({
			contractVersion: "1.0",
			requestId: "lease-before-configuration-replacement",
			ownerUserId: "fallback-user",
			decisionTaskId: "task-before-configuration-replacement",
			agentRunId: "run-before-configuration-replacement",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "SAVE_CONFIGURATION",
			requestId: "replace-platform-before-lease-run",
			actor: { userId: "fallback-admin", role: "SUPERADMIN" },
			scope: "PLATFORM",
			ownerUserId: "fallback-admin",
			capability: "DECISION_TEXT",
			providerId: identity.providerId,
			region: identity.region,
			modelId: identity.modelId,
			endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			credential: "replacement-platform-secret",
		});
		let invoked = false;
		await expect(
			lease.run(async () => {
				invoked = true;
				return { status: "COMPLETED", value: "must-not-run" };
			}),
		).resolves.toMatchObject({
			status: "FAILED",
			code: "PROVIDER_CONFIGURATION_REQUIRED",
			effectState: "NOT_STARTED",
		});
		expect(invoked).toBe(false);
		expect(records.size).toBe(1);
	});

	it("只在安全可重试失败时最多一次回退到已认证本地模型", async () => {
		const records = new Map<string, EncryptedCredentialRecord>();
		const systemActor = Object.freeze({
			userId: "provider-routing:runtime",
			role: "SYSTEM" as const,
		});
		const certificationActor = Object.freeze({
			userId: "provider-certification:runner",
			role: "SYSTEM" as const,
		});
		let localHealthy = true;
		const vault = createCredentialVault({
			masterKey: Buffer.alloc(32, 17),
			systemAccess: {
				actor: systemActor,
				secretType: "PROVIDER_CREDENTIAL",
				actions: ["USE", "DELETE"],
			},
			storage: {
				async save(record) {
					records.set(`${record.ownerUserId}:${record.credentialId}`, record);
				},
				async load(credentialId, ownerUserId) {
					return records.get(`${ownerUserId}:${credentialId}`);
				},
				async delete(credentialId, ownerUserId) {
					return records.delete(`${ownerUserId}:${credentialId}`);
				},
			},
			appendAuditRecord: async () => undefined,
		});
		const routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: vault,
			credentialSystemActor: systemActor,
			certificationSystemActor: certificationActor,
			egressGuard: createEgressGuard({
				appendRecord: async () => undefined,
				nextId: () => "egress-fallback",
				now: () => new Date("2026-08-30T12:00:00.000Z"),
			}),
			localFallback: {
				identity: {
					providerId: "local-openai",
					region: "lan-6013",
					modelId: "Qwen3.8-27B",
					routePolicyVersion: "p1-v1",
				},
				endpointUrl: "http://192.168.121.32:6013/v1",
				isHealthy: async () => localHealthy,
			},
			validatePrivateFileConsentIds: async (input) =>
				input.ownerUserId === "fallback-user" &&
				input.decisionTaskId === "task-private" &&
				input.identity.providerId === "dashscope" &&
				input.routeKind === "PLATFORM" &&
				input.consentIds.length === 1 &&
				input.consentIds[0] === "private-consent-valid",
			commandFingerprintKey: Buffer.alloc(32, 18),
		});
		openModules.push(routing);
		await configureFallbackRoute(routing, certificationActor);
		const privateRequest = {
			contractVersion: "1.0" as const,
			requestId: "fallback-private-request",
			ownerUserId: "fallback-user",
			decisionTaskId: "task-private",
			agentRunId: "run-private",
			capability: "DECISION_TEXT" as const,
			dataClasses: ["MINIMIZED_REQUIREMENT", "PRIVATE_FILE_MATERIAL"] as const,
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		};
		await expect(
			routing.acquire({
				...privateRequest,
				privateFileConsentIds: ["private-consent-forged"],
			}),
		).rejects.toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED" });
		const pausedConsentDecision = await pool.query<{
			finalCode: string;
			finalStatus: string;
		}>(
			`SELECT final_status AS "finalStatus", final_code AS "finalCode"
			 FROM provider_route_decisions
			 WHERE owner_user_id = $1 AND request_id = $2`,
			["fallback-user", "fallback-private-request"],
		);
		expect(pausedConsentDecision.rows).toEqual([
			{ finalStatus: "PAUSED", finalCode: "PROVIDER_CONSENT_REQUIRED" },
		]);
		const privateLease = await routing.acquire({
			...privateRequest,
			requestId: "fallback-private-request-valid",
			agentRunId: "run-private-valid",
			privateFileConsentIds: ["private-consent-valid"],
		});
		await expect(
			privateLease.run(async (attempt) => {
				await attempt.withCredential(async () => undefined);
				return {
					status: "COMPLETED" as const,
					value: "private-ok",
					usage: { inputTokens: 80, outputTokens: 10 },
				};
			}),
		).resolves.toMatchObject({ status: "COMPLETED", value: "private-ok" });

		const cases: readonly Readonly<{
			name: string;
			outcome: ProviderAttemptOutcomeV1<string>;
			fallback: boolean;
		}>[] = [
			{
				name: "rate-limited",
				outcome: {
					status: "FAILED",
					code: "PROVIDER_RATE_LIMITED",
					effectState: "STARTED",
				},
				fallback: true,
			},
			{
				name: "unavailable",
				outcome: {
					status: "FAILED",
					code: "PROVIDER_UNAVAILABLE",
					effectState: "NOT_STARTED",
				},
				fallback: true,
			},
			{
				name: "safe-timeout",
				outcome: {
					status: "FAILED",
					code: "PROVIDER_TIMEOUT",
					effectState: "NOT_STARTED",
				},
				fallback: true,
			},
			{
				name: "committed-timeout",
				outcome: {
					status: "FAILED",
					code: "PROVIDER_TIMEOUT",
					effectState: "COMMITTED",
				},
				fallback: false,
			},
			{
				name: "authentication",
				outcome: {
					status: "FAILED",
					code: "PROVIDER_AUTHENTICATION_FAILED",
					effectState: "STARTED",
				},
				fallback: false,
			},
			{
				name: "bad-request",
				outcome: {
					status: "FAILED",
					code: "PROVIDER_REQUEST_REJECTED",
					effectState: "NOT_STARTED",
				},
				fallback: false,
			},
			{
				name: "partial",
				outcome: {
					status: "FAILED",
					code: "PROVIDER_PARTIAL_RESULT",
					effectState: "PARTIAL",
				},
				fallback: false,
			},
			{
				name: "unknown",
				outcome: {
					status: "FAILED",
					code: "PROVIDER_RESULT_UNKNOWN",
					effectState: "UNKNOWN",
				},
				fallback: false,
			},
			{
				name: "cancelled",
				outcome: { status: "CANCELLED", effectState: "STARTED" },
				fallback: false,
			},
		];
		for (const item of cases) {
			const attempts: string[] = [];
			const lease = await routing.acquire({
				contractVersion: "1.0",
				requestId: `fallback-${item.name}`,
				ownerUserId: "fallback-user",
				decisionTaskId: `task-${item.name}`,
				agentRunId: `run-${item.name}`,
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				estimatedUsage: { inputTokens: 100, outputTokens: 20 },
			});
			const result = await lease.run(async (attempt) => {
				attempts.push(attempt.routeKind);
				await attempt.withCredential(async (credential) => {
					if (attempt.routeKind === "LOCAL") {
						expect(credential).toBeUndefined();
					} else {
						expect(credential?.reveal()).toBe("fallback-platform-secret");
					}
				});
				return attempt.routeKind === "LOCAL"
					? { status: "COMPLETED", value: "local-result" }
					: item.outcome;
			});
			expect(attempts).toEqual(
				item.fallback ? ["PLATFORM", "LOCAL"] : ["PLATFORM"],
			);
			expect(result.fallbackUsed).toBe(item.fallback);
			if (item.name === "committed-timeout") {
				expect(result).toMatchObject({ retryable: false });
			}
			if (item.fallback) {
				expect(result).toMatchObject({
					status: "COMPLETED",
					value: "local-result",
					attribution: "LOCAL",
				});
			}
			await expect(
				lease.run(async () => ({ status: "COMPLETED", value: "duplicate" })),
			).rejects.toMatchObject({ code: "PROVIDER_IDEMPOTENCY_CONFLICT" });
		}
		const sharedRunAttempts: string[] = [];
		for (const requestId of [
			"fallback-shared-run-a",
			"fallback-shared-run-b",
		]) {
			const lease = await routing.acquire({
				contractVersion: "1.0",
				requestId,
				ownerUserId: "fallback-user",
				decisionTaskId: "task-shared-run",
				agentRunId: "run-shared-fallback",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				estimatedUsage: { inputTokens: 100, outputTokens: 20 },
			});
			const result = await lease.run(async (attempt) => {
				sharedRunAttempts.push(`${requestId}:${attempt.routeKind}`);
				await attempt.withCredential(async () => undefined);
				return attempt.routeKind === "LOCAL"
					? { status: "COMPLETED", value: "local" }
					: {
							status: "FAILED",
							code: "PROVIDER_UNAVAILABLE",
							effectState: "NOT_STARTED",
						};
			});
			expect(result.fallbackUsed).toBe(requestId.endsWith("a"));
		}
		expect(sharedRunAttempts).toEqual([
			"fallback-shared-run-a:PLATFORM",
			"fallback-shared-run-a:LOCAL",
			"fallback-shared-run-b:PLATFORM",
		]);

		const bypassLease = await routing.acquire({
			contractVersion: "1.0",
			requestId: "adapter-bypasses-authorized-attempt",
			ownerUserId: "fallback-user",
			decisionTaskId: "task-adapter-bypass",
			agentRunId: "run-adapter-bypass",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		await expect(
			bypassLease.run(async () => ({ status: "COMPLETED", value: "bypassed" })),
		).resolves.toMatchObject({
			status: "FAILED",
			code: "PROVIDER_INVALID_RESPONSE",
			effectState: "UNKNOWN",
		});

		const invalidLease = await routing.acquire({
			contractVersion: "1.0",
			requestId: "adapter-invalid-outcome",
			ownerUserId: "fallback-user",
			decisionTaskId: "task-invalid-outcome",
			agentRunId: "run-invalid-outcome",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		await expect(
			invalidLease.run(async (attempt) => {
				await attempt.withCredential(async () => undefined);
				return {
					status: "FAILED",
					code: "NOT_A_PROVIDER_ERROR",
					effectState: "NOT_STARTED",
				} as never;
			}),
		).resolves.toMatchObject({
			status: "FAILED",
			code: "PROVIDER_INVALID_RESPONSE",
			effectState: "UNKNOWN",
		});
		for (const [name, usage, expectedStatus] of [
			["actual-usage", { inputTokens: 80, outputTokens: 10 }, "SETTLED"],
			["missing-usage", undefined, "UNCONFIRMED"],
		] as const) {
			const lease = await routing.acquire({
				contractVersion: "1.0",
				requestId: `settle-${name}`,
				ownerUserId: "fallback-user",
				decisionTaskId: `settle-task-${name}`,
				agentRunId: `settle-run-${name}`,
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				estimatedUsage: { inputTokens: 100, outputTokens: 20 },
			});
			await lease.run(async (attempt) => {
				await attempt.withCredential(async () => undefined);
				return {
					status: "COMPLETED",
					value: name,
					...(usage === undefined ? {} : { usage }),
				};
			});
			await expect(
				pool.query(
					`SELECT status, actual_usage FROM platform_provider_usage
					 WHERE owner_user_id = $1 AND request_id = $2`,
					["fallback-user", `settle-${name}`],
				),
			).resolves.toMatchObject({
				rows: [
					{
						status: expectedStatus,
						actual_usage: usage === undefined ? null : usage,
					},
				],
			});
		}
		const unknownUsageLease = await routing.acquire({
			contractVersion: "1.0",
			requestId: "settle-unknown-with-usage",
			ownerUserId: "fallback-user",
			decisionTaskId: "settle-task-unknown-with-usage",
			agentRunId: "settle-run-unknown-with-usage",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		await unknownUsageLease.run(async (attempt) => {
			await attempt.withCredential(async () => undefined);
			return {
				status: "FAILED",
				code: "PROVIDER_RESULT_UNKNOWN",
				effectState: "UNKNOWN",
				usage: { inputTokens: 80, outputTokens: 10 },
			};
		});
		await expect(
			pool.query(
				`SELECT status FROM platform_provider_usage
				 WHERE owner_user_id = $1 AND request_id = $2`,
				["fallback-user", "settle-unknown-with-usage"],
			),
		).resolves.toMatchObject({ rows: [{ status: "UNCONFIRMED" }] });

		await routing.acquire({
			contractVersion: "1.0",
			requestId: "stale-platform-reservation",
			ownerUserId: "fallback-user",
			decisionTaskId: "stale-reservation-task",
			agentRunId: "stale-reservation-run",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		await pool.query(
			`UPDATE platform_provider_usage
			 SET updated_at = NOW() - INTERVAL '2 hours'
			 WHERE owner_user_id = $1 AND request_id = $2`,
			["fallback-user", "stale-platform-reservation"],
		);
		await routing.acquire({
			contractVersion: "1.0",
			requestId: "trigger-stale-reservation-recovery",
			ownerUserId: "fallback-user",
			decisionTaskId: "stale-reservation-task",
			agentRunId: "trigger-stale-reservation-run",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		await expect(
			pool.query(
				`SELECT status FROM platform_provider_usage
				 WHERE owner_user_id = $1 AND request_id = $2`,
				["fallback-user", "stale-platform-reservation"],
			),
		).resolves.toMatchObject({ rows: [{ status: "UNCONFIRMED" }] });
		await routing.execute({
			contractVersion: "1.0",
			type: "SET_PLATFORM_LIMIT",
			requestId: "fallback-exhaust-user-limit",
			actor: { userId: "fallback-admin", role: "SUPERADMIN" },
			limitScope: "USER",
			subjectUserId: "fallback-user",
			capability: "DECISION_TEXT",
			providerId: "dashscope",
			modelId: "qwen3.8-max",
			budget: { inputTokens: 50, outputTokens: 10 },
		});
		await expect(
			routing.acquire({
				contractVersion: "1.0",
				requestId: "private-file-must-not-fallback-local",
				ownerUserId: "fallback-user",
				decisionTaskId: "task-private",
				agentRunId: "run-private-no-local-fallback",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT", "PRIVATE_FILE_MATERIAL"],
				privateFileConsentIds: ["private-consent-valid"],
				estimatedUsage: { inputTokens: 100, outputTokens: 20 },
			}),
		).rejects.toMatchObject({ code: "PROVIDER_LIMIT_EXCEEDED" });
		const unhealthyLocalLease = await routing.acquire({
			contractVersion: "1.0",
			requestId: "fallback-unhealthy-before-run",
			ownerUserId: "fallback-user",
			decisionTaskId: "fallback-unhealthy-task",
			agentRunId: "fallback-unhealthy-run",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		localHealthy = false;
		let unhealthyLocalInvoked = false;
		await expect(
			unhealthyLocalLease.run(async () => {
				unhealthyLocalInvoked = true;
				return { status: "COMPLETED", value: "must-not-run" };
			}),
		).resolves.toMatchObject({
			status: "FAILED",
			code: "PROVIDER_ROUTE_UNAVAILABLE",
			effectState: "NOT_STARTED",
		});
		expect(unhealthyLocalInvoked).toBe(false);
		localHealthy = true;
		const localOnlyAttempts: string[] = [];
		const localOnlyLease = await routing.acquire({
			contractVersion: "1.0",
			requestId: "fallback-before-platform-call",
			ownerUserId: "fallback-user",
			decisionTaskId: "fallback-limit-task",
			agentRunId: "fallback-limit-run",
			capability: "DECISION_TEXT",
			dataClasses: ["MINIMIZED_REQUIREMENT"],
			estimatedUsage: { inputTokens: 100, outputTokens: 20 },
		});
		await expect(
			localOnlyLease.run(async (attempt) => {
				localOnlyAttempts.push(attempt.routeKind);
				await attempt.withCredential(async (credential) =>
					expect(credential).toBeUndefined(),
				);
				return { status: "COMPLETED", value: "local-before-call" };
			}),
		).resolves.toMatchObject({
			status: "COMPLETED",
			attribution: "LOCAL",
			fallbackUsed: true,
		});
		expect(localOnlyAttempts).toEqual(["LOCAL"]);
		await expect(
			pool.query(
				`SELECT count(*)::int AS count FROM provider_route_decisions
				 WHERE owner_user_id = 'fallback-user'`,
			),
		).resolves.toMatchObject({ rows: [{ count: cases.length + 12 }] });

		await pool.query(
			`INSERT INTO platform_provider_usage (
			   usage_id, owner_user_id, request_id, decision_task_id, agent_run_id,
			   capability, provider_id, model_id, status, reserved_budget,
			   created_at, updated_at
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'UNCONFIRMED', '{}'::jsonb, NOW(), NOW())`,
			[
				"00000000-0000-4000-8000-000000000001",
				"fallback-user",
				"corrupt-usage-row",
				"corrupt-usage-task",
				"corrupt-usage-run",
				"DECISION_TEXT",
				"dashscope",
				"qwen3.8-max",
			],
		);
		await expect(
			routing.acquire({
				contractVersion: "1.0",
				requestId: "fail-closed-on-corrupt-usage",
				ownerUserId: "fallback-user",
				decisionTaskId: "corrupt-usage-task",
				agentRunId: "corrupt-usage-run-2",
				capability: "DECISION_TEXT",
				dataClasses: ["MINIMIZED_REQUIREMENT"],
				estimatedUsage: { inputTokens: 1, outputTokens: 1 },
			}),
		).rejects.toMatchObject({ code: "PROVIDER_USAGE_UNCONFIRMED" });
	});

	it("只向 User 返回自己的路线、同意和平台用量摘要", async () => {
		const routing = await openPostgresProviderRouting({
			databaseUrl,
			credentialVault: createCredentialVault({
				masterKey: Buffer.alloc(32, 19),
				storage: {
					async save() {},
					async load() {
						return undefined;
					},
				},
				appendAuditRecord: async () => undefined,
			}),
			credentialSystemActor: {
				userId: "provider-routing:runtime",
				role: "SYSTEM",
			},
			commandFingerprintKey: Buffer.alloc(32, 20),
			now: () => new Date("2026-08-30T13:00:00.000Z"),
		});
		openModules.push(routing);
		const admin = { userId: "summary-admin", role: "SUPERADMIN" as const };
		const user = { userId: "summary-user", role: "USER" as const };
		await routing.execute({
			contractVersion: "1.0",
			type: "SAVE_CONFIGURATION",
			requestId: "summary-save-platform",
			actor: admin,
			scope: "PLATFORM",
			ownerUserId: admin.userId,
			capability: "DECISION_TEXT",
			providerId: "dashscope",
			region: "cn-beijing",
			modelId: "qwen3.8-max",
			endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			credential: "summary-platform-secret",
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "CONFIRM_ROUTE",
			requestId: "summary-confirm-route",
			actor: user,
			ownerUserId: user.userId,
			capability: "DECISION_TEXT",
			routeKind: "PLATFORM",
			localFallbackEnabled: true,
		});
		await routing.execute({
			contractVersion: "1.0",
			type: "SET_TEXT_EGRESS_CONSENT",
			requestId: "summary-grant-consent",
			actor: user,
			ownerUserId: user.userId,
			providerId: "dashscope",
			region: "cn-beijing",
			dataClasses: ["MINIMIZED_REQUIREMENT", "PUBLIC_EVIDENCE"],
			granted: true,
		});
		for (const [requestId, limitScope, budget] of [
			[
				"summary-global-limit",
				"GLOBAL",
				{ inputTokens: 1_000, outputTokens: 200 },
			],
			[
				"summary-default-limit",
				"DEFAULT_USER",
				{ inputTokens: 500, outputTokens: 100 },
			],
		] as const) {
			await routing.execute({
				contractVersion: "1.0",
				type: "SET_PLATFORM_LIMIT",
				requestId,
				actor: admin,
				limitScope,
				capability: "DECISION_TEXT",
				providerId: "dashscope",
				modelId: "qwen3.8-max",
				budget,
			});
		}
		await pool.query(
			`INSERT INTO platform_provider_usage (
			   usage_id, owner_user_id, request_id, decision_task_id, agent_run_id,
			   capability, provider_id, model_id, status, reserved_budget,
			   actual_usage, created_at, updated_at
			 ) VALUES (
			   '3ad7cbb0-ece2-475d-8a86-4818972c2d0d', $1, 'summary-usage',
			   'summary-task', 'summary-run', 'DECISION_TEXT', 'dashscope',
			   'qwen3.8-max', 'SETTLED', '{"inputTokens":100,"outputTokens":20}'::jsonb,
			   '{"inputTokens":80,"outputTokens":10}'::jsonb, $2, $2
			 )`,
			[user.userId, new Date("2026-08-30T13:00:00.000Z")],
		);

		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_ROUTE_PREFERENCE",
				actor: user,
				ownerUserId: user.userId,
				capability: "DECISION_TEXT",
			}),
		).resolves.toMatchObject({
			resultType: "ROUTE_PREFERENCE",
			preference: { routeKind: "PLATFORM", localFallbackEnabled: true },
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_TEXT_EGRESS_CONSENT",
				actor: user,
				ownerUserId: user.userId,
				providerId: "dashscope",
				region: "cn-beijing",
			}),
		).resolves.toMatchObject({
			resultType: "TEXT_EGRESS_CONSENT",
			dataClasses: [
				{ dataClass: "MINIMIZED_REQUIREMENT", granted: true },
				{ dataClass: "PUBLIC_EVIDENCE", granted: true },
			],
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_USER_PLATFORM_USAGE",
				actor: user,
				ownerUserId: user.userId,
				capability: "DECISION_TEXT",
			}),
		).resolves.toMatchObject({
			resultType: "PLATFORM_USAGE",
			usage: {
				used: { inputTokens: 80, outputTokens: 10 },
				settled: { inputTokens: 80, outputTokens: 10 },
				held: {},
				limit: { inputTokens: 500, outputTokens: 100 },
				remaining: { inputTokens: 420, outputTokens: 90 },
			},
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_PLATFORM_LIMITS",
				actor: admin,
				capability: "DECISION_TEXT",
				providerId: "dashscope",
				modelId: "qwen3.8-max",
			}),
		).resolves.toMatchObject({
			resultType: "PLATFORM_LIMITS",
			limits: [
				{ limitScope: "DEFAULT_USER", budget: { inputTokens: 500 } },
				{ limitScope: "GLOBAL", budget: { inputTokens: 1_000 } },
			],
		});
		await expect(
			routing.read({
				contractVersion: "1.0",
				type: "GET_PLATFORM_USAGE",
				actor: user,
				capability: "DECISION_TEXT",
				providerId: "dashscope",
				modelId: "qwen3.8-max",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_PERMISSION_DENIED" });
	});
});

async function configureFallbackRoute(
	routing: ProviderRouting,
	certificationActor: Readonly<{ userId: string; role: "SYSTEM" }>,
): Promise<void> {
	await routing.execute({
		contractVersion: "1.0",
		type: "SAVE_CONFIGURATION",
		requestId: "fallback-save-platform",
		actor: { userId: "fallback-admin", role: "SUPERADMIN" },
		scope: "PLATFORM",
		ownerUserId: "fallback-admin",
		capability: "DECISION_TEXT",
		providerId: "dashscope",
		region: "cn-beijing",
		modelId: "qwen3.8-max",
		endpointUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		credential: "fallback-platform-secret",
	});
	for (const [requestId, identity] of [
		[
			"fallback-certify-platform",
			{
				providerId: "dashscope",
				region: "cn-beijing",
				modelId: "qwen3.8-max",
				routePolicyVersion: "p1-v1" as const,
			},
		],
		[
			"fallback-certify-local",
			{
				providerId: "local-openai",
				region: "lan-6013",
				modelId: "Qwen3.8-27B",
				routePolicyVersion: "p1-v1" as const,
			},
		],
	] as const) {
		await routing.execute({
			contractVersion: "1.0",
			type: "IMPORT_CERTIFICATION",
			requestId,
			actor: certificationActor,
			identity,
			capabilities: ["DECISION_TEXT"],
			evidenceDigest: "b".repeat(64),
			certifiedAt: "2026-08-30T11:00:00.000Z",
		});
	}
	await routing.execute({
		contractVersion: "1.0",
		type: "CONFIRM_ROUTE",
		requestId: "fallback-confirm-route",
		actor: { userId: "fallback-user", role: "USER" },
		ownerUserId: "fallback-user",
		capability: "DECISION_TEXT",
		routeKind: "PLATFORM",
		localFallbackEnabled: true,
	});
	await routing.execute({
		contractVersion: "1.0",
		type: "SET_TEXT_EGRESS_CONSENT",
		requestId: "fallback-consent",
		actor: { userId: "fallback-user", role: "USER" },
		ownerUserId: "fallback-user",
		providerId: "dashscope",
		region: "cn-beijing",
		dataClasses: ["MINIMIZED_REQUIREMENT"],
		granted: true,
	});
	for (const [requestId, limitScope] of [
		["fallback-global-limit", "GLOBAL"],
		["fallback-user-limit", "DEFAULT_USER"],
	] as const) {
		await routing.execute({
			contractVersion: "1.0",
			type: "SET_PLATFORM_LIMIT",
			requestId,
			actor: { userId: "fallback-admin", role: "SUPERADMIN" },
			limitScope,
			capability: "DECISION_TEXT",
			providerId: "dashscope",
			modelId: "qwen3.8-max",
			budget: { inputTokens: 1_000_000, outputTokens: 100_000 },
		});
	}
}

function createPersistentVault(
	persistence: Awaited<ReturnType<typeof openPersistentDecisionTaskModule>>,
	systemActor: Readonly<{ userId: string; role: "SYSTEM" }>,
) {
	return createCredentialVault({
		masterKey: Buffer.alloc(32, 16),
		systemAccess: {
			actor: systemActor,
			secretType: "PROVIDER_CREDENTIAL",
			actions: ["USE", "DELETE"],
		},
		storage: {
			save: async (record) => persistence.saveEncryptedCredential(record),
			load: async (credentialId, ownerUserId) =>
				persistence.loadEncryptedCredential(credentialId, ownerUserId),
			delete: async (credentialId, ownerUserId) =>
				persistence.deleteEncryptedCredential(credentialId, ownerUserId),
		},
		appendAuditRecord: async (record) =>
			persistence.appendAuditRecord({
				actor: {
					principalId: record.actor.userId,
					role: record.actor.role,
					userId: record.actor.userId,
				},
				action: record.action,
				object: record.object,
				result: record.result,
				correlationId: record.correlationId,
			}),
	});
}

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") {
		throw new Error(`${name} is required`);
	}
	return value;
}
