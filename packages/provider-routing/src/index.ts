import { createHmac, randomUUID } from "node:crypto";

import type {
	CredentialVault,
	EgressGuard,
	SecretValue,
	SecurityActor,
} from "@choicemind/security";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";

export type ProviderCapabilityV1 =
	| "DECISION_TEXT"
	| "VISION"
	| "DOCUMENT_ANALYSIS"
	| "ASR"
	| "EMBEDDING"
	| "RERANKER";

export type ProviderModelIdentityV1 = Readonly<{
	providerId: string;
	region: string;
	modelId: string;
	routePolicyVersion: "p1-v1";
}>;

export type ProviderUsageBudgetV1 = Readonly<{
	inputTokens?: number | undefined;
	outputTokens?: number | undefined;
	images?: number | undefined;
	audioSeconds?: number | undefined;
	videoSeconds?: number | undefined;
}>;

export type ProviderTextDataClassV1 =
	| "MINIMIZED_REQUIREMENT"
	| "PUBLIC_EVIDENCE";

export type AcquireCapabilityRouteV1 = Readonly<{
	contractVersion: "1.0";
	requestId: string;
	ownerUserId: string;
	decisionTaskId: string;
	agentRunId: string;
	capability: ProviderCapabilityV1;
	dataClasses: readonly (ProviderTextDataClassV1 | "PRIVATE_FILE_MATERIAL")[];
	estimatedUsage: ProviderUsageBudgetV1;
	textEgressConsentId?: string | undefined;
	privateFileConsentIds?: readonly string[] | undefined;
}>;

export type ProviderEffectStateV1 =
	| "NOT_STARTED"
	| "STARTED"
	| "PARTIAL"
	| "COMMITTED"
	| "UNKNOWN";

export type ProviderActualUsageV1 = ProviderUsageBudgetV1;

export type AuthorizedProviderAttemptV1 = Readonly<{
	attemptId: string;
	identity: ProviderModelIdentityV1;
	routeKind: "PLATFORM" | "USER_BYOK" | "LOCAL";
	endpointOrigin: string;
	withCredential(
		operation: (credential: SecretValue | undefined) => Promise<void>,
	): Promise<void>;
}>;

export type ProviderAttemptOutcomeV1<T> =
	| Readonly<{
			status: "COMPLETED";
			value: T;
			usage?: ProviderActualUsageV1 | undefined;
			providerRequestId?: string | undefined;
	  }>
	| Readonly<{
			status: "FAILED";
			code: ProviderRoutingErrorCodeV1;
			effectState: ProviderEffectStateV1;
			usage?: ProviderActualUsageV1 | undefined;
	  }>
	| Readonly<{
			status: "CANCELLED";
			effectState: ProviderEffectStateV1;
			usage?: ProviderActualUsageV1 | undefined;
	  }>;

export type ProviderCapabilityResultV1<T> =
	| Readonly<{
			status: "COMPLETED";
			value: T;
			identity: ProviderModelIdentityV1;
			attribution: "PLATFORM" | "USER_BYOK" | "LOCAL";
			fallbackUsed: boolean;
	  }>
	| Readonly<{
			status: "FAILED" | "PAUSED";
			code: ProviderRoutingErrorCodeV1;
			retryable: boolean;
			effectState: ProviderEffectStateV1;
			identity?: ProviderModelIdentityV1 | undefined;
			fallbackUsed: boolean;
	  }>;

export interface CapabilityRouteLeaseV1 {
	run<T>(
		operation: (
			attempt: AuthorizedProviderAttemptV1,
		) => Promise<ProviderAttemptOutcomeV1<T>>,
	): Promise<ProviderCapabilityResultV1<T>>;
}

export type ProviderConfigurationSummaryV1 = Readonly<{
	configurationId: string;
	scope: "USER" | "PLATFORM";
	capability: ProviderCapabilityV1;
	identity: ProviderModelIdentityV1;
	endpointOrigin: string;
	credentialPresent: true;
	status: "ENABLED" | "DISABLED";
	updatedAt: string;
}>;

export type TestPlatformProviderConnectionV1 = Readonly<{
	contractVersion: "1.0";
	type: "TEST_PLATFORM_CONNECTION";
	requestId: string;
	actor: SecurityActor;
	capability: ProviderCapabilityV1;
}>;

export type PlatformProviderConnectionTargetV1 = Readonly<{
	identity: ProviderModelIdentityV1;
	endpointUrl: string;
	credential: SecretValue;
}>;

export type ProviderRoutingErrorCodeV1 =
	| "PROVIDER_CONFIGURATION_REQUIRED"
	| "PROVIDER_CONFIGURATION_DISABLED"
	| "PROVIDER_CAPABILITY_UNCERTIFIED"
	| "PROVIDER_CONSENT_REQUIRED"
	| "PROVIDER_LIMIT_EXCEEDED"
	| "PROVIDER_AUTHENTICATION_FAILED"
	| "PROVIDER_PERMISSION_DENIED"
	| "PROVIDER_BALANCE_EXHAUSTED"
	| "PROVIDER_REQUEST_REJECTED"
	| "PROVIDER_RATE_LIMITED"
	| "PROVIDER_UNAVAILABLE"
	| "PROVIDER_TIMEOUT"
	| "PROVIDER_CANCELLED"
	| "PROVIDER_PARTIAL_RESULT"
	| "PROVIDER_RESULT_UNKNOWN"
	| "PROVIDER_INVALID_RESPONSE"
	| "PROVIDER_ROUTE_UNAVAILABLE"
	| "PROVIDER_IDEMPOTENCY_CONFLICT"
	| "PROVIDER_USAGE_UNCONFIRMED";

export class ProviderRoutingOperationError extends Error {
	readonly name = "ProviderRoutingOperationError";

	constructor(
		readonly code: ProviderRoutingErrorCodeV1,
		readonly retryable = false,
	) {
		super(code);
	}
}

export type SaveProviderConfigurationCommandV1 = Readonly<{
	contractVersion: "1.0";
	type: "SAVE_CONFIGURATION";
	requestId: string;
	actor: SecurityActor;
	scope: "USER" | "PLATFORM";
	ownerUserId: string;
	capability: ProviderCapabilityV1;
	providerId: string;
	region: string;
	modelId: string;
	endpointUrl: string;
	credential: string;
}>;

export type ImportProviderCertificationCommandV1 = Readonly<{
	contractVersion: "1.0";
	type: "IMPORT_CERTIFICATION";
	requestId: string;
	actor: SecurityActor;
	identity: ProviderModelIdentityV1;
	capabilities: readonly ProviderCapabilityV1[];
	evidenceDigest: string;
	certifiedAt: string;
}>;

export type ConfirmProviderRouteCommandV1 = Readonly<{
	contractVersion: "1.0";
	type: "CONFIRM_ROUTE";
	requestId: string;
	actor: SecurityActor;
	ownerUserId: string;
	capability: ProviderCapabilityV1;
	routeKind: "USER_BYOK" | "PLATFORM";
	localFallbackEnabled: boolean;
}>;

export type RevokeProviderRouteCommandV1 = Readonly<{
	contractVersion: "1.0";
	type: "REVOKE_ROUTE";
	requestId: string;
	actor: SecurityActor;
	ownerUserId: string;
	capability: ProviderCapabilityV1;
}>;

export type SetProviderTextEgressConsentCommandV1 = Readonly<{
	contractVersion: "1.0";
	type: "SET_TEXT_EGRESS_CONSENT";
	requestId: string;
	actor: SecurityActor;
	ownerUserId: string;
	providerId: string;
	region: string;
	dataClasses: readonly ProviderTextDataClassV1[];
	granted: boolean;
}>;

export type SetPlatformProviderLimitCommandV1 = Readonly<{
	contractVersion: "1.0";
	type: "SET_PLATFORM_LIMIT";
	requestId: string;
	actor: SecurityActor;
	limitScope: "GLOBAL" | "DEFAULT_USER" | "USER";
	subjectUserId?: string | undefined;
	capability: ProviderCapabilityV1;
	providerId: string;
	modelId: string;
	budget: ProviderUsageBudgetV1;
}>;

export type SetProviderConfigurationStatusCommandV1 = Readonly<{
	contractVersion: "1.0";
	type: "SET_CONFIGURATION_STATUS";
	requestId: string;
	actor: SecurityActor;
	scope: "USER" | "PLATFORM";
	ownerUserId: string;
	capability: ProviderCapabilityV1;
	status: "ENABLED" | "DISABLED";
}>;

export type DeleteUserProviderConfigurationCommandV1 = Readonly<{
	contractVersion: "1.0";
	type: "DELETE_USER_CONFIGURATION";
	requestId: string;
	actor: SecurityActor;
	ownerUserId: string;
	capability: ProviderCapabilityV1;
}>;

export type ProviderRoutingCommandV1 =
	| SaveProviderConfigurationCommandV1
	| ImportProviderCertificationCommandV1
	| ConfirmProviderRouteCommandV1
	| RevokeProviderRouteCommandV1
	| SetProviderTextEgressConsentCommandV1
	| SetPlatformProviderLimitCommandV1
	| SetProviderConfigurationStatusCommandV1
	| DeleteUserProviderConfigurationCommandV1;

export type ProviderRoutingCommandResultV1 =
	| Readonly<{
			contractVersion: "1.0";
			requestId: string;
			resultType: "CONFIGURATION_SAVED";
			configuration: ProviderConfigurationSummaryV1;
	  }>
	| Readonly<{
			contractVersion: "1.0";
			requestId: string;
			resultType: "CERTIFICATION_IMPORTED";
			identity: ProviderModelIdentityV1;
			capabilities: readonly ProviderCapabilityV1[];
			evidenceDigest: string;
			certifiedAt: string;
	  }>
	| Readonly<{
			contractVersion: "1.0";
			requestId: string;
			resultType: "ROUTE_CONFIRMED";
			ownerUserId: string;
			capability: ProviderCapabilityV1;
			routeKind: "USER_BYOK" | "PLATFORM";
			localFallbackEnabled: boolean;
	  }>
	| Readonly<{
			contractVersion: "1.0";
			requestId: string;
			resultType: "ROUTE_REVOKED";
			ownerUserId: string;
			capability: ProviderCapabilityV1;
	  }>
	| Readonly<{
			contractVersion: "1.0";
			requestId: string;
			resultType: "TEXT_EGRESS_CONSENT_UPDATED";
			providerId: string;
			region: string;
			dataClasses: readonly ProviderTextDataClassV1[];
			granted: boolean;
	  }>
	| Readonly<{
			contractVersion: "1.0";
			requestId: string;
			resultType: "PLATFORM_LIMIT_SET";
			limitScope: "GLOBAL" | "DEFAULT_USER" | "USER";
			subjectUserId?: string | undefined;
			capability: ProviderCapabilityV1;
			providerId: string;
			modelId: string;
			budget: ProviderUsageBudgetV1;
	  }>
	| Readonly<{
			contractVersion: "1.0";
			requestId: string;
			resultType: "CONFIGURATION_STATUS_SET";
			configuration: ProviderConfigurationSummaryV1;
	  }>
	| Readonly<{
			contractVersion: "1.0";
			requestId: string;
			resultType: "USER_CONFIGURATION_DELETED";
			ownerUserId: string;
			capability: ProviderCapabilityV1;
	  }>;

export type GetUserProviderConfigurationQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_USER_CONFIGURATION";
	actor: SecurityActor;
	ownerUserId: string;
	capability: ProviderCapabilityV1;
}>;

export type GetPlatformProviderConfigurationQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_PLATFORM_CONFIGURATION";
	actor: SecurityActor;
	capability: ProviderCapabilityV1;
}>;

export type GetProviderRoutePreferenceQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_ROUTE_PREFERENCE";
	actor: SecurityActor;
	ownerUserId: string;
	capability: ProviderCapabilityV1;
}>;

export type GetProviderTextEgressConsentQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_TEXT_EGRESS_CONSENT";
	actor: SecurityActor;
	ownerUserId: string;
	providerId: string;
	region: string;
}>;

export type ListProviderTextEgressConsentsQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "LIST_TEXT_EGRESS_CONSENTS";
	actor: SecurityActor;
	ownerUserId: string;
}>;

export type GetUserPlatformUsageQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_USER_PLATFORM_USAGE";
	actor: SecurityActor;
	ownerUserId: string;
	capability: ProviderCapabilityV1;
}>;

export type GetPlatformUsageQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_PLATFORM_USAGE";
	actor: SecurityActor;
	ownerUserId?: string | undefined;
	capability: ProviderCapabilityV1;
	providerId: string;
	modelId: string;
}>;

export type GetPlatformLimitsQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_PLATFORM_LIMITS";
	actor: SecurityActor;
	capability: ProviderCapabilityV1;
	providerId: string;
	modelId: string;
}>;

export type GetProviderCapabilityCertificationQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_CAPABILITY_CERTIFICATION";
	actor: SecurityActor;
	identity: ProviderModelIdentityV1;
	capability: ProviderCapabilityV1;
}>;

export type ProviderRoutingQueryV1 =
	| GetUserProviderConfigurationQueryV1
	| GetPlatformProviderConfigurationQueryV1
	| GetEffectiveProviderRouteQueryV1
	| GetProviderRoutePreferenceQueryV1
	| GetProviderTextEgressConsentQueryV1
	| ListProviderTextEgressConsentsQueryV1
	| GetUserPlatformUsageQueryV1
	| GetPlatformUsageQueryV1
	| GetPlatformLimitsQueryV1
	| GetProviderCapabilityCertificationQueryV1;

export type GetEffectiveProviderRouteQueryV1 = Readonly<{
	contractVersion: "1.0";
	type: "GET_EFFECTIVE_ROUTE";
	actor: SecurityActor;
	ownerUserId: string;
	capability: ProviderCapabilityV1;
	dataClasses: readonly ProviderTextDataClassV1[];
}>;

export type ProviderRoutingQueryResultV1 =
	| Readonly<{
			resultType: "CONFIGURATION";
			configuration: ProviderConfigurationSummaryV1 | null;
	  }>
	| Readonly<{
			resultType: "EFFECTIVE_ROUTE";
			status: "AVAILABLE";
			routeKind: "USER_BYOK" | "PLATFORM";
			identity: ProviderModelIdentityV1;
	  }>
	| Readonly<{
			resultType: "EFFECTIVE_ROUTE";
			status: "BLOCKED";
			code: ProviderRoutingErrorCodeV1;
			routeKind?: "USER_BYOK" | "PLATFORM";
			identity?: ProviderModelIdentityV1;
	  }>
	| Readonly<{
			resultType: "ROUTE_PREFERENCE";
			preference: Readonly<{
				routeKind: "USER_BYOK" | "PLATFORM";
				localFallbackEnabled: boolean;
				confirmedAt: string;
				updatedAt: string;
			}> | null;
	  }>
	| Readonly<{
			resultType: "TEXT_EGRESS_CONSENT";
			providerId: string;
			region: string;
			dataClasses: readonly Readonly<{
				dataClass: ProviderTextDataClassV1;
				granted: boolean;
				updatedAt: string;
			}>[];
	  }>
	| Readonly<{
			resultType: "TEXT_EGRESS_CONSENTS";
			consents: readonly Readonly<{
				providerId: string;
				region: string;
				dataClasses: readonly Readonly<{
					dataClass: ProviderTextDataClassV1;
					granted: true;
					updatedAt: string;
				}>[];
			}>[];
	  }>
	| Readonly<{
			resultType: "PLATFORM_USAGE";
			usage: Readonly<{
				ownerUserId?: string | undefined;
				capability: ProviderCapabilityV1;
				providerId: string;
				modelId: string;
				used: ProviderUsageBudgetV1;
				settled: ProviderUsageBudgetV1;
				held: ProviderUsageBudgetV1;
				limit?: ProviderUsageBudgetV1 | undefined;
				remaining?: ProviderUsageBudgetV1 | undefined;
			}> | null;
	  }>
	| Readonly<{
			resultType: "PLATFORM_LIMITS";
			limits: readonly Readonly<{
				limitScope: "GLOBAL" | "DEFAULT_USER" | "USER";
				subjectUserId?: string | undefined;
				capability: ProviderCapabilityV1;
				providerId: string;
				modelId: string;
				budget: ProviderUsageBudgetV1;
				updatedAt: string;
			}>[];
	  }>
	| Readonly<{
			resultType: "CAPABILITY_CERTIFICATION";
			certification: Readonly<{
				identity: ProviderModelIdentityV1;
				capability: ProviderCapabilityV1;
				evidenceDigest: string;
				status: "CERTIFIED" | "DISABLED";
				certifiedAt: string;
				importedAt: string;
			}> | null;
	  }>;

export interface ProviderRouting {
	execute(
		command: ProviderRoutingCommandV1,
	): Promise<ProviderRoutingCommandResultV1>;
	read(query: ProviderRoutingQueryV1): Promise<ProviderRoutingQueryResultV1>;
	acquire(request: AcquireCapabilityRouteV1): Promise<CapabilityRouteLeaseV1>;
	testPlatformConnection(
		request: TestPlatformProviderConnectionV1,
		operation: (target: PlatformProviderConnectionTargetV1) => Promise<void>,
	): Promise<ProviderModelIdentityV1>;
	close(): Promise<void>;
}

type ProviderConfigurationRow = Readonly<{
	configuration_id: string;
	scope: "USER" | "PLATFORM";
	capability: ProviderCapabilityV1;
	provider_id: string;
	region: string;
	model_id: string;
	endpoint_url: string;
	credential_owner_user_id?: string;
	credential_id?: string;
	status: "ENABLED" | "DISABLED";
	updated_at: Date;
}>;

type ProviderCommandRecordRow = Readonly<{
	request_fingerprint: string;
	result: unknown;
}>;

type PlatformUsageRow = Readonly<{
	owner_user_id: string;
	status: "RESERVED" | "SETTLED" | "UNCONFIRMED" | "RELEASED";
	reserved_budget: unknown;
	actual_usage: unknown | null;
}>;

type LocalFallbackRoute = Readonly<{
	identity: ProviderModelIdentityV1;
	endpointUrl: string;
	isHealthy(): Promise<boolean>;
}>;

type LeaseConfiguration = Readonly<{
	configuration_id?: string | undefined;
	endpoint_url: string;
	credential_owner_user_id?: string | undefined;
	credential_id?: string | undefined;
	updated_at?: Date | undefined;
}>;

const usageKeys = [
	"inputTokens",
	"outputTokens",
	"images",
	"audioSeconds",
	"videoSeconds",
] as const;

const capabilitySchema = z.enum([
	"DECISION_TEXT",
	"VISION",
	"DOCUMENT_ANALYSIS",
	"ASR",
	"EMBEDDING",
	"RERANKER",
]);
const providerRoutingErrorCodeSchema = z.enum([
	"PROVIDER_CONFIGURATION_REQUIRED",
	"PROVIDER_CONFIGURATION_DISABLED",
	"PROVIDER_CAPABILITY_UNCERTIFIED",
	"PROVIDER_CONSENT_REQUIRED",
	"PROVIDER_LIMIT_EXCEEDED",
	"PROVIDER_AUTHENTICATION_FAILED",
	"PROVIDER_PERMISSION_DENIED",
	"PROVIDER_BALANCE_EXHAUSTED",
	"PROVIDER_REQUEST_REJECTED",
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_UNAVAILABLE",
	"PROVIDER_TIMEOUT",
	"PROVIDER_CANCELLED",
	"PROVIDER_PARTIAL_RESULT",
	"PROVIDER_RESULT_UNKNOWN",
	"PROVIDER_INVALID_RESPONSE",
	"PROVIDER_ROUTE_UNAVAILABLE",
	"PROVIDER_IDEMPOTENCY_CONFLICT",
	"PROVIDER_USAGE_UNCONFIRMED",
]);
const providerEffectStateSchema = z.enum([
	"NOT_STARTED",
	"STARTED",
	"PARTIAL",
	"COMMITTED",
	"UNKNOWN",
]);
const actualUsageSchema = z
	.object({
		inputTokens: z.number().int().nonnegative().optional(),
		outputTokens: z.number().int().nonnegative().optional(),
		images: z.number().int().nonnegative().optional(),
		audioSeconds: z.number().nonnegative().optional(),
		videoSeconds: z.number().nonnegative().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0);
const providerAttemptOutcomeSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("COMPLETED"),
			value: z.unknown(),
			usage: actualUsageSchema.optional(),
			providerRequestId: z.string().trim().min(1).max(500).optional(),
		})
		.strict()
		.refine((value) => Object.hasOwn(value, "value")),
	z
		.object({
			status: z.literal("FAILED"),
			code: providerRoutingErrorCodeSchema,
			effectState: providerEffectStateSchema,
			usage: actualUsageSchema.optional(),
		})
		.strict(),
	z
		.object({
			status: z.literal("CANCELLED"),
			effectState: providerEffectStateSchema,
			usage: actualUsageSchema.optional(),
		})
		.strict(),
]);
const actorSchema = z
	.object({
		userId: z.string().trim().min(1).max(200),
		role: z.enum(["USER", "ADMIN", "SUPERADMIN", "SYSTEM"]),
	})
	.strict();
const identitySchema = z
	.object({
		providerId: z.string().trim().min(1).max(100),
		region: z.string().trim().min(1).max(100),
		modelId: z.string().trim().min(1).max(200),
		routePolicyVersion: z.literal("p1-v1"),
	})
	.strict();
const textDataClassSchema = z.enum([
	"MINIMIZED_REQUIREMENT",
	"PUBLIC_EVIDENCE",
]);
const usageBudgetSchema = z
	.object({
		inputTokens: z.number().int().positive().optional(),
		outputTokens: z.number().int().positive().optional(),
		images: z.number().int().positive().optional(),
		audioSeconds: z.number().int().positive().optional(),
		videoSeconds: z.number().int().positive().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0);
const saveConfigurationSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("SAVE_CONFIGURATION"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		scope: z.enum(["USER", "PLATFORM"]),
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
		providerId: z.string().trim().min(1).max(100),
		region: z.string().trim().min(1).max(100),
		modelId: z.string().trim().min(1).max(200),
		endpointUrl: z.string().trim().min(1).max(2_000),
		credential: z.string().min(1).max(8_192),
	})
	.strict();
const getUserConfigurationSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_USER_CONFIGURATION"),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
	})
	.strict();
const getPlatformConfigurationSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_PLATFORM_CONFIGURATION"),
		actor: actorSchema,
		capability: capabilitySchema,
	})
	.strict();
const getRoutePreferenceSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_ROUTE_PREFERENCE"),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
	})
	.strict();
const getTextEgressConsentSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_TEXT_EGRESS_CONSENT"),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		providerId: z.string().trim().min(1).max(100),
		region: z.string().trim().min(1).max(100),
	})
	.strict();
const listTextEgressConsentsSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("LIST_TEXT_EGRESS_CONSENTS"),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
	})
	.strict();
const getUserPlatformUsageSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_USER_PLATFORM_USAGE"),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
	})
	.strict();
const getPlatformUsageSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_PLATFORM_USAGE"),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200).optional(),
		capability: capabilitySchema,
		providerId: z.string().trim().min(1).max(100),
		modelId: z.string().trim().min(1).max(200),
	})
	.strict();
const getPlatformLimitsSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_PLATFORM_LIMITS"),
		actor: actorSchema,
		capability: capabilitySchema,
		providerId: z.string().trim().min(1).max(100),
		modelId: z.string().trim().min(1).max(200),
	})
	.strict();
const getCapabilityCertificationSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_CAPABILITY_CERTIFICATION"),
		actor: actorSchema,
		identity: identitySchema,
		capability: capabilitySchema,
	})
	.strict();
const importCertificationSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("IMPORT_CERTIFICATION"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		identity: identitySchema,
		capabilities: z.array(capabilitySchema).min(1).max(6),
		evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
		certifiedAt: z.iso.datetime({ offset: true }),
	})
	.strict();
const confirmRouteSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("CONFIRM_ROUTE"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
		routeKind: z.enum(["USER_BYOK", "PLATFORM"]),
		localFallbackEnabled: z.boolean(),
	})
	.strict();
const revokeRouteSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("REVOKE_ROUTE"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
	})
	.strict();
const setTextEgressConsentSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("SET_TEXT_EGRESS_CONSENT"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		providerId: z.string().trim().min(1).max(100),
		region: z.string().trim().min(1).max(100),
		dataClasses: z.array(textDataClassSchema).min(1).max(2),
		granted: z.boolean(),
	})
	.strict();
const setPlatformLimitSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("SET_PLATFORM_LIMIT"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		limitScope: z.enum(["GLOBAL", "DEFAULT_USER", "USER"]),
		subjectUserId: z.string().trim().min(1).max(200).optional(),
		capability: capabilitySchema,
		providerId: z.string().trim().min(1).max(100),
		modelId: z.string().trim().min(1).max(200),
		budget: usageBudgetSchema,
	})
	.strict()
	.refine(
		(value) =>
			(value.limitScope === "USER") === (value.subjectUserId !== undefined),
	);
const setConfigurationStatusSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("SET_CONFIGURATION_STATUS"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		scope: z.enum(["USER", "PLATFORM"]),
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
		status: z.enum(["ENABLED", "DISABLED"]),
	})
	.strict();
const deleteUserConfigurationSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("DELETE_USER_CONFIGURATION"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
	})
	.strict();
const getEffectiveRouteSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("GET_EFFECTIVE_ROUTE"),
		actor: actorSchema,
		ownerUserId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
		dataClasses: z.array(textDataClassSchema).min(1).max(2),
	})
	.strict();
const testPlatformConnectionSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		type: z.literal("TEST_PLATFORM_CONNECTION"),
		requestId: z.string().trim().min(1).max(200),
		actor: actorSchema,
		capability: capabilitySchema,
	})
	.strict();
const acquireCapabilityRouteSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		requestId: z.string().trim().min(1).max(200),
		ownerUserId: z.string().trim().min(1).max(200),
		decisionTaskId: z.string().trim().min(1).max(200),
		agentRunId: z.string().trim().min(1).max(200),
		capability: capabilitySchema,
		dataClasses: z
			.array(
				z.enum([
					"MINIMIZED_REQUIREMENT",
					"PUBLIC_EVIDENCE",
					"PRIVATE_FILE_MATERIAL",
				]),
			)
			.min(1)
			.max(3),
		estimatedUsage: usageBudgetSchema,
		textEgressConsentId: z.string().trim().min(1).max(200).optional(),
		privateFileConsentIds: z
			.array(z.string().trim().min(1).max(200))
			.max(100)
			.optional(),
	})
	.strict();
const configurationSummarySchema = z
	.object({
		configurationId: z.string().uuid(),
		scope: z.enum(["USER", "PLATFORM"]),
		capability: capabilitySchema,
		identity: z
			.object({
				providerId: z.string(),
				region: z.string(),
				modelId: z.string(),
				routePolicyVersion: z.literal("p1-v1"),
			})
			.strict(),
		endpointOrigin: z.string().url(),
		credentialPresent: z.literal(true),
		status: z.enum(["ENABLED", "DISABLED"]),
		updatedAt: z.iso.datetime({ offset: true }),
	})
	.strict();
const configurationCommandResultSchema = z
	.object({
		contractVersion: z.literal("1.0"),
		requestId: z.string(),
		resultType: z.literal("CONFIGURATION_SAVED"),
		configuration: configurationSummarySchema,
	})
	.strict();
const commandResultSchema = z.discriminatedUnion("resultType", [
	configurationCommandResultSchema,
	z
		.object({
			contractVersion: z.literal("1.0"),
			requestId: z.string(),
			resultType: z.literal("CERTIFICATION_IMPORTED"),
			identity: identitySchema,
			capabilities: z.array(capabilitySchema),
			evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
			certifiedAt: z.iso.datetime({ offset: true }),
		})
		.strict(),
	z
		.object({
			contractVersion: z.literal("1.0"),
			requestId: z.string(),
			resultType: z.literal("ROUTE_REVOKED"),
			ownerUserId: z.string(),
			capability: capabilitySchema,
		})
		.strict(),
	z
		.object({
			contractVersion: z.literal("1.0"),
			requestId: z.string(),
			resultType: z.literal("ROUTE_CONFIRMED"),
			ownerUserId: z.string(),
			capability: capabilitySchema,
			routeKind: z.enum(["USER_BYOK", "PLATFORM"]),
			localFallbackEnabled: z.boolean(),
		})
		.strict(),
	z
		.object({
			contractVersion: z.literal("1.0"),
			requestId: z.string(),
			resultType: z.literal("TEXT_EGRESS_CONSENT_UPDATED"),
			providerId: z.string(),
			region: z.string(),
			dataClasses: z.array(textDataClassSchema),
			granted: z.boolean(),
		})
		.strict(),
	z
		.object({
			contractVersion: z.literal("1.0"),
			requestId: z.string(),
			resultType: z.literal("PLATFORM_LIMIT_SET"),
			limitScope: z.enum(["GLOBAL", "DEFAULT_USER", "USER"]),
			subjectUserId: z.string().optional(),
			capability: capabilitySchema,
			providerId: z.string(),
			modelId: z.string(),
			budget: usageBudgetSchema,
		})
		.strict(),
	z
		.object({
			contractVersion: z.literal("1.0"),
			requestId: z.string(),
			resultType: z.literal("CONFIGURATION_STATUS_SET"),
			configuration: configurationSummarySchema,
		})
		.strict(),
	z
		.object({
			contractVersion: z.literal("1.0"),
			requestId: z.string(),
			resultType: z.literal("USER_CONFIGURATION_DELETED"),
			ownerUserId: z.string(),
			capability: capabilitySchema,
		})
		.strict(),
]);

export async function openPostgresProviderRouting(
	options: Readonly<{
		databaseUrl: string;
		credentialVault: CredentialVault;
		credentialSystemActor: Readonly<{
			userId: string;
			role: "SYSTEM";
		}>;
		egressGuard?: EgressGuard;
		localFallback?: Readonly<{
			identity: ProviderModelIdentityV1;
			endpointUrl: string;
			isHealthy(): Promise<boolean>;
		}>;
		validatePrivateFileConsentIds?(
			input: Readonly<{
				ownerUserId: string;
				decisionTaskId: string;
				identity: ProviderModelIdentityV1;
				routeKind: "PLATFORM" | "USER_BYOK";
				consentIds: readonly string[];
			}>,
		): Promise<boolean>;
		certificationSystemActor?: Readonly<{
			userId: string;
			role: "SYSTEM";
		}>;
		commandFingerprintKey: Uint8Array;
		now?: () => Date;
	}>,
): Promise<ProviderRouting> {
	if (options.commandFingerprintKey.byteLength !== 32) {
		throw new Error("Provider Routing 指纹密钥必须是 32 字节");
	}
	const pool = new Pool({ connectionString: options.databaseUrl });
	try {
		await migrateProviderRouting(pool);
	} catch (error) {
		await pool.end();
		throw error;
	}
	const now = options.now ?? (() => new Date());
	const localFallback =
		options.localFallback === undefined
			? undefined
			: {
					...options.localFallback,
					endpointUrl: normalizeLocalProviderEndpoint(
						options.localFallback.endpointUrl,
					).href,
				};
	try {
		await drainCredentialDeletions(
			pool,
			options.credentialVault,
			options.credentialSystemActor,
		);
	} catch (error) {
		await pool.end();
		throw error;
	}

	return {
		execute: async (untrustedCommand) => {
			switch (readType(untrustedCommand)) {
				case "SAVE_CONFIGURATION":
					return saveConfiguration(
						pool,
						options.credentialVault,
						options.credentialSystemActor,
						options.commandFingerprintKey,
						decodeSaveConfiguration(untrustedCommand),
						now(),
					);
				case "IMPORT_CERTIFICATION":
					return importCertification(
						pool,
						options.commandFingerprintKey,
						decodeImportCertification(untrustedCommand),
						options.certificationSystemActor,
						now(),
					);
				case "CONFIRM_ROUTE":
					return confirmRoute(
						pool,
						options.commandFingerprintKey,
						decodeConfirmRoute(untrustedCommand),
						now(),
					);
				case "REVOKE_ROUTE":
					return revokeRoute(
						pool,
						options.commandFingerprintKey,
						decodeRevokeRoute(untrustedCommand),
						now(),
					);
				case "SET_TEXT_EGRESS_CONSENT":
					return setTextEgressConsent(
						pool,
						options.commandFingerprintKey,
						decodeSetTextEgressConsent(untrustedCommand),
						now(),
					);
				case "SET_PLATFORM_LIMIT":
					return setPlatformLimit(
						pool,
						options.commandFingerprintKey,
						decodeSetPlatformLimit(untrustedCommand),
						now(),
					);
				case "SET_CONFIGURATION_STATUS":
					return setConfigurationStatus(
						pool,
						options.commandFingerprintKey,
						decodeSetConfigurationStatus(untrustedCommand),
						now(),
					);
				case "DELETE_USER_CONFIGURATION":
					return deleteUserConfiguration(
						pool,
						options.credentialVault,
						options.commandFingerprintKey,
						decodeDeleteUserConfiguration(untrustedCommand),
						now(),
					);
				default:
					throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
			}
		},
		read: async (untrustedQuery) => {
			switch (readType(untrustedQuery)) {
				case "GET_USER_CONFIGURATION":
					return getUserConfiguration(
						pool,
						decodeGetUserConfiguration(untrustedQuery),
					);
				case "GET_PLATFORM_CONFIGURATION":
					return getPlatformConfiguration(
						pool,
						decodeGetPlatformConfiguration(untrustedQuery),
					);
				case "GET_EFFECTIVE_ROUTE":
					return getEffectiveRoute(
						pool,
						decodeGetEffectiveRoute(untrustedQuery),
					);
				case "GET_ROUTE_PREFERENCE":
					return getRoutePreference(
						pool,
						decodeGetRoutePreference(untrustedQuery),
					);
				case "GET_TEXT_EGRESS_CONSENT":
					return getTextEgressConsent(
						pool,
						decodeGetTextEgressConsent(untrustedQuery),
					);
				case "LIST_TEXT_EGRESS_CONSENTS":
					return listTextEgressConsents(
						pool,
						decodeListTextEgressConsents(untrustedQuery),
					);
				case "GET_USER_PLATFORM_USAGE":
					return getUserPlatformUsage(
						pool,
						decodeGetUserPlatformUsage(untrustedQuery),
					);
				case "GET_PLATFORM_USAGE":
					return getPlatformUsage(pool, decodeGetPlatformUsage(untrustedQuery));
				case "GET_PLATFORM_LIMITS":
					return getPlatformLimits(
						pool,
						decodeGetPlatformLimits(untrustedQuery),
					);
				case "GET_CAPABILITY_CERTIFICATION":
					return getCapabilityCertification(
						pool,
						decodeGetCapabilityCertification(untrustedQuery),
					);
				default:
					throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
			}
		},
		acquire: async (untrustedRequest) =>
			acquireCapabilityRoute(
				pool,
				options.credentialVault,
				options.credentialSystemActor,
				options.egressGuard,
				localFallback,
				options.validatePrivateFileConsentIds,
				decodeAcquireCapabilityRoute(untrustedRequest),
				now,
			),
		testPlatformConnection: async (untrustedRequest, operation) =>
			testPlatformConnection(
				pool,
				options.credentialVault,
				options.credentialSystemActor,
				options.egressGuard,
				decodeTestPlatformConnection(untrustedRequest),
				operation,
			),
		close: async () => pool.end(),
	};
}

async function acquireCapabilityRoute(
	pool: Pool,
	vault: CredentialVault,
	credentialSystemActor:
		| Readonly<{ userId: string; role: "SYSTEM" }>
		| undefined,
	egressGuard: EgressGuard | undefined,
	localFallback: LocalFallbackRoute | undefined,
	validatePrivateFileConsentIds:
		| ((
				input: Readonly<{
					ownerUserId: string;
					decisionTaskId: string;
					identity: ProviderModelIdentityV1;
					routeKind: "PLATFORM" | "USER_BYOK";
					consentIds: readonly string[];
				}>,
		  ) => Promise<boolean>)
		| undefined,
	request: AcquireCapabilityRouteV1,
	now: () => Date,
): Promise<CapabilityRouteLeaseV1> {
	await reserveRouteRequest(pool, request, now());
	const textDataClasses = request.dataClasses.filter(
		(value): value is ProviderTextDataClassV1 =>
			value !== "PRIVATE_FILE_MATERIAL",
	);
	const route = await getEffectiveRoute(pool, {
		contractVersion: "1.0",
		type: "GET_EFFECTIVE_ROUTE",
		actor: { userId: request.ownerUserId, role: "USER" },
		ownerUserId: request.ownerUserId,
		capability: request.capability,
		dataClasses: textDataClasses,
	});
	if (route.resultType !== "EFFECTIVE_ROUTE" || route.status !== "AVAILABLE") {
		if (
			route.resultType === "EFFECTIVE_ROUTE" &&
			route.code === "PROVIDER_LIMIT_EXCEEDED"
		) {
			const local = await getAvailableLocalFallback(
				pool,
				request,
				localFallback,
			);
			if (local !== undefined) {
				return createCapabilityRouteLease({
					pool,
					vault,
					credentialSystemActor,
					egressGuard,
					request,
					configuration: { endpoint_url: local.endpointUrl },
					routeKind: "LOCAL",
					identity: local.identity,
					primaryLocalFallback: local,
					localFallback: undefined,
					usageId: undefined,
					initialFallbackReason: "PROVIDER_LIMIT_EXCEEDED",
					validatePrivateFileConsentIds,
					now,
				});
			}
		}
		const code =
			route.resultType === "EFFECTIVE_ROUTE"
				? route.code
				: "PROVIDER_ROUTE_UNAVAILABLE";
		if (
			route.resultType === "EFFECTIVE_ROUTE" &&
			route.identity !== undefined &&
			(code === "PROVIDER_LIMIT_EXCEEDED" ||
				code === "PROVIDER_CONSENT_REQUIRED")
		) {
			await recordPausedRouteDecision(
				pool,
				request,
				route.identity,
				code,
				now(),
			);
		}
		throw new ProviderRoutingOperationError(code);
	}
	const scope = route.routeKind === "PLATFORM" ? "PLATFORM" : "USER";
	const routeSubjectId =
		route.routeKind === "PLATFORM" ? "__PLATFORM__" : request.ownerUserId;
	const configured = await pool.query<ProviderConfigurationRow>(
		`SELECT configuration_id, scope, capability, provider_id, region,
		        model_id, endpoint_url, credential_owner_user_id, credential_id,
		        status, updated_at
		 FROM provider_configurations
		 WHERE scope = $1 AND route_subject_id = $2 AND capability = $3
		   AND status = 'ENABLED'`,
		[scope, routeSubjectId, request.capability],
	);
	const configuration = configured.rows[0];
	if (
		configuration?.credential_id === undefined ||
		configuration.credential_owner_user_id === undefined
	) {
		throw new ProviderRoutingOperationError("PROVIDER_CONFIGURATION_REQUIRED");
	}
	const availableLocalFallback = await getAvailableLocalFallback(
		pool,
		request,
		localFallback,
	);
	if (
		textDataClasses.length > 0 &&
		request.textEgressConsentId !== undefined &&
		!(await matchesCurrentTextEgressConsent(
			pool,
			request,
			route.identity,
			textDataClasses,
		))
	) {
		await recordPausedRouteDecision(
			pool,
			request,
			route.identity,
			"PROVIDER_CONSENT_REQUIRED",
			now(),
		);
		throw new ProviderRoutingOperationError("PROVIDER_CONSENT_REQUIRED");
	}
	if (request.dataClasses.includes("PRIVATE_FILE_MATERIAL")) {
		const consentIds = request.privateFileConsentIds ?? [];
		if (
			consentIds.length === 0 ||
			validatePrivateFileConsentIds === undefined ||
			!(await validatePrivateFileConsentIds({
				ownerUserId: request.ownerUserId,
				decisionTaskId: request.decisionTaskId,
				identity: route.identity,
				routeKind: route.routeKind,
				consentIds,
			}))
		) {
			await recordPausedRouteDecision(
				pool,
				request,
				route.identity,
				"PROVIDER_CONSENT_REQUIRED",
				now(),
			);
			throw new ProviderRoutingOperationError("PROVIDER_CONSENT_REQUIRED");
		}
	}
	let usageId: string | undefined;
	if (route.routeKind === "PLATFORM") {
		try {
			usageId = await reservePlatformUsage(pool, request, configuration, now());
		} catch (error) {
			if (
				error instanceof ProviderRoutingOperationError &&
				error.code === "PROVIDER_LIMIT_EXCEEDED" &&
				availableLocalFallback !== undefined
			) {
				return createCapabilityRouteLease({
					pool,
					vault,
					credentialSystemActor,
					egressGuard,
					request,
					configuration: {
						endpoint_url: availableLocalFallback.endpointUrl,
					},
					routeKind: "LOCAL",
					identity: availableLocalFallback.identity,
					primaryLocalFallback: availableLocalFallback,
					localFallback: undefined,
					usageId: undefined,
					initialFallbackReason: "PROVIDER_LIMIT_EXCEEDED",
					validatePrivateFileConsentIds,
					now,
				});
			}
			if (
				error instanceof ProviderRoutingOperationError &&
				error.code === "PROVIDER_LIMIT_EXCEEDED"
			) {
				await recordPausedRouteDecision(
					pool,
					request,
					route.identity,
					error.code,
					now(),
				);
			}
			throw error;
		}
	}
	return createCapabilityRouteLease({
		pool,
		vault,
		credentialSystemActor,
		egressGuard,
		request,
		configuration,
		routeKind: route.routeKind,
		identity: route.identity,
		primaryLocalFallback: undefined,
		localFallback: availableLocalFallback,
		usageId,
		initialFallbackReason: undefined,
		validatePrivateFileConsentIds,
		now,
	});
}

async function reserveRouteRequest(
	pool: Pool,
	request: AcquireCapabilityRouteV1,
	timestamp: Date,
): Promise<void> {
	const stored = await pool.query(
		`INSERT INTO provider_route_requests (
		   owner_user_id, request_id, decision_task_id, agent_run_id,
		   capability, fallback_used, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, false, $6, $6)
		 ON CONFLICT (owner_user_id, request_id) DO NOTHING
		 RETURNING 1`,
		[
			request.ownerUserId,
			request.requestId,
			request.decisionTaskId,
			request.agentRunId,
			request.capability,
			timestamp,
		],
	);
	if (stored.rowCount !== 1) {
		throw new ProviderRoutingOperationError("PROVIDER_IDEMPOTENCY_CONFLICT");
	}
}

async function reservePlatformUsage(
	pool: Pool,
	request: AcquireCapabilityRouteV1,
	configuration: ProviderConfigurationRow,
	timestamp: Date,
): Promise<string> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			[
				`${request.capability}:${configuration.provider_id}:${configuration.model_id}`,
			],
		);
		await client.query(
			`UPDATE platform_provider_usage
			 SET status = 'UNCONFIRMED', updated_at = $1
			 WHERE status = 'RESERVED'
			   AND updated_at < $1::timestamptz - INTERVAL '1 hour'`,
			[timestamp],
		);
		const existing = await client.query(
			`SELECT 1 FROM platform_provider_usage
			 WHERE owner_user_id = $1 AND request_id = $2`,
			[request.ownerUserId, request.requestId],
		);
		if (existing.rowCount !== 0) {
			throw new ProviderRoutingOperationError("PROVIDER_IDEMPOTENCY_CONFLICT");
		}
		const limits = await client.query<{
			limit_scope: "GLOBAL" | "DEFAULT_USER" | "USER";
			budget: unknown;
		}>(
			`SELECT limit_scope, budget FROM platform_provider_limits
			 WHERE capability = $1 AND provider_id = $2 AND model_id = $3
			   AND (
			     (limit_scope = 'GLOBAL' AND subject_user_id = '__GLOBAL__')
			     OR (limit_scope = 'DEFAULT_USER' AND subject_user_id = '__DEFAULT_USER__')
			     OR (limit_scope = 'USER' AND subject_user_id = $4)
			   )`,
			[
				request.capability,
				configuration.provider_id,
				configuration.model_id,
				request.ownerUserId,
			],
		);
		const globalLimit = parseBudget(
			limits.rows.find((row) => row.limit_scope === "GLOBAL")?.budget,
		);
		const userLimit = parseBudget(
			(
				limits.rows.find((row) => row.limit_scope === "USER") ??
				limits.rows.find((row) => row.limit_scope === "DEFAULT_USER")
			)?.budget,
		);
		if (globalLimit === undefined || userLimit === undefined) {
			throw new ProviderRoutingOperationError("PROVIDER_LIMIT_EXCEEDED");
		}
		const usage = await client.query<PlatformUsageRow>(
			`SELECT owner_user_id, status, reserved_budget, actual_usage
			 FROM platform_provider_usage
			 WHERE capability = $1 AND provider_id = $2 AND model_id = $3
			   AND status IN ('RESERVED', 'SETTLED', 'UNCONFIRMED')`,
			[request.capability, configuration.provider_id, configuration.model_id],
		);
		const globalUsed = totalUsage(usage.rows);
		const userUsed = totalUsage(
			usage.rows.filter((row) => row.owner_user_id === request.ownerUserId),
		);
		if (
			!withinBudget(globalUsed, request.estimatedUsage, globalLimit) ||
			!withinBudget(userUsed, request.estimatedUsage, userLimit)
		) {
			throw new ProviderRoutingOperationError("PROVIDER_LIMIT_EXCEEDED");
		}
		const usageId = randomUUID();
		await client.query(
			`INSERT INTO platform_provider_usage (
			   usage_id, owner_user_id, request_id, decision_task_id, agent_run_id,
			   capability, provider_id, model_id, status, reserved_budget,
			   created_at, updated_at
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RESERVED', $9::jsonb, $10, $10)`,
			[
				usageId,
				request.ownerUserId,
				request.requestId,
				request.decisionTaskId,
				request.agentRunId,
				request.capability,
				configuration.provider_id,
				configuration.model_id,
				JSON.stringify(request.estimatedUsage),
				timestamp,
			],
		);
		await client.query("COMMIT");
		return usageId;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function getAvailableLocalFallback(
	pool: Pool,
	request: AcquireCapabilityRouteV1,
	configured: LocalFallbackRoute | undefined,
): Promise<LocalFallbackRoute | undefined> {
	if (
		request.dataClasses.includes("PRIVATE_FILE_MATERIAL") ||
		configured === undefined ||
		configured.identity.routePolicyVersion !== "p1-v1"
	) {
		return undefined;
	}
	const eligible = await pool.query(
		`SELECT 1
		 FROM provider_route_preferences preference
		 JOIN provider_capability_certifications certification
		   ON certification.provider_id = $3
		  AND certification.region = $4
		  AND certification.model_id = $5
		  AND certification.route_policy_version = $6
		  AND certification.capability = preference.capability
		  AND certification.status = 'CERTIFIED'
		 WHERE preference.owner_user_id = $1
		   AND preference.capability = $2
		   AND preference.local_fallback_enabled = true`,
		[
			request.ownerUserId,
			request.capability,
			configured.identity.providerId,
			configured.identity.region,
			configured.identity.modelId,
			configured.identity.routePolicyVersion,
		],
	);
	if (eligible.rowCount !== 1) return undefined;
	try {
		return (await configured.isHealthy()) ? configured : undefined;
	} catch {
		return undefined;
	}
}

function createCapabilityRouteLease(
	options: Readonly<{
		pool: Pool;
		vault: CredentialVault;
		credentialSystemActor:
			| Readonly<{ userId: string; role: "SYSTEM" }>
			| undefined;
		egressGuard: EgressGuard | undefined;
		request: AcquireCapabilityRouteV1;
		configuration: LeaseConfiguration;
		routeKind: "PLATFORM" | "USER_BYOK" | "LOCAL";
		identity: ProviderModelIdentityV1;
		primaryLocalFallback: LocalFallbackRoute | undefined;
		localFallback: LocalFallbackRoute | undefined;
		usageId: string | undefined;
		initialFallbackReason: ProviderRoutingErrorCodeV1 | undefined;
		validatePrivateFileConsentIds:
			| ((
					input: Readonly<{
						ownerUserId: string;
						decisionTaskId: string;
						identity: ProviderModelIdentityV1;
						routeKind: "PLATFORM" | "USER_BYOK";
						consentIds: readonly string[];
					}>,
			  ) => Promise<boolean>)
			| undefined;
		now: () => Date;
	}>,
): CapabilityRouteLeaseV1 {
	let leaseUsed = false;
	return {
		async run<T>(
			operation: (
				attempt: AuthorizedProviderAttemptV1,
			) => Promise<ProviderAttemptOutcomeV1<T>>,
		) {
			if (leaseUsed) {
				throw new ProviderRoutingOperationError(
					"PROVIDER_IDEMPOTENCY_CONFLICT",
				);
			}
			leaseUsed = true;
			const authorizationCode = await getLeaseAuthorizationFailure(options);
			if (authorizationCode !== undefined) {
				const outcome = {
					status: "FAILED" as const,
					code: authorizationCode,
					effectState: "NOT_STARTED" as const,
				};
				if (options.usageId !== undefined) {
					await settlePlatformUsage(
						options.pool,
						options.usageId,
						outcome,
						options.now(),
					);
				}
				const paused =
					authorizationCode === "PROVIDER_CONSENT_REQUIRED" ||
					authorizationCode === "PROVIDER_LIMIT_EXCEEDED";
				const result: ProviderCapabilityResultV1<T> = {
					status: paused ? "PAUSED" : "FAILED",
					code: authorizationCode,
					retryable: paused,
					effectState: "NOT_STARTED",
					identity: options.identity,
					fallbackUsed: false,
				};
				await recordRouteDecision(
					options.pool,
					options.request,
					options.identity,
					result,
					undefined,
					options.now(),
					paused ? "PAUSED" : undefined,
				);
				return result;
			}
			if (
				options.initialFallbackReason !== undefined &&
				!(await claimRunFallback(options.pool, options.request, options.now()))
			) {
				const result: ProviderCapabilityResultV1<T> = {
					status: "FAILED",
					code: options.initialFallbackReason,
					retryable: false,
					effectState: "NOT_STARTED",
					identity: options.identity,
					fallbackUsed: false,
				};
				await recordRouteDecision(
					options.pool,
					options.request,
					options.identity,
					result,
					options.initialFallbackReason,
					options.now(),
				);
				return result;
			}
			const attemptId = options.usageId ?? randomUUID();
			const attempt = createAuthorizedAttempt({
				attemptId,
				identity: options.identity,
				routeKind: options.routeKind,
				configuration: options.configuration,
				request: options.request,
				vault: options.vault,
				credentialSystemActor: options.credentialSystemActor,
				egressGuard: options.egressGuard,
			});
			const outcome = await invokeAttempt(operation, attempt);
			if (options.usageId !== undefined) {
				await settlePlatformUsage(
					options.pool,
					options.usageId,
					outcome,
					options.now(),
				);
			}
			const local = options.localFallback;
			if (
				local !== undefined &&
				shouldFallback(outcome, local) &&
				(await getAvailableLocalFallback(
					options.pool,
					options.request,
					local,
				)) !== undefined &&
				(await claimRunFallback(options.pool, options.request, options.now()))
			) {
				const localOutcome = await invokeAttempt(
					operation,
					createAuthorizedAttempt({
						attemptId: `${attemptId}:local`,
						identity: local.identity,
						routeKind: "LOCAL",
						configuration: { endpoint_url: local.endpointUrl },
						request: options.request,
						vault: options.vault,
						credentialSystemActor: options.credentialSystemActor,
						egressGuard: options.egressGuard,
					}),
				);
				const result = toCapabilityResult(
					localOutcome,
					local.identity,
					"LOCAL",
					true,
				);
				await recordRouteDecision(
					options.pool,
					options.request,
					options.identity,
					result,
					outcome.status === "FAILED" ? outcome.code : undefined,
					options.now(),
				);
				return result;
			}
			const result = toCapabilityResult(
				outcome,
				options.identity,
				options.routeKind,
				options.initialFallbackReason !== undefined,
			);
			await recordRouteDecision(
				options.pool,
				options.request,
				options.identity,
				result,
				options.initialFallbackReason,
				options.now(),
			);
			return result;
		},
	};
}

async function getLeaseAuthorizationFailure(
	options: Readonly<{
		pool: Pool;
		request: AcquireCapabilityRouteV1;
		routeKind: "PLATFORM" | "USER_BYOK" | "LOCAL";
		identity: ProviderModelIdentityV1;
		configuration: LeaseConfiguration;
		primaryLocalFallback: LocalFallbackRoute | undefined;
		validatePrivateFileConsentIds:
			| ((
					input: Readonly<{
						ownerUserId: string;
						decisionTaskId: string;
						identity: ProviderModelIdentityV1;
						routeKind: "PLATFORM" | "USER_BYOK";
						consentIds: readonly string[];
					}>,
			  ) => Promise<boolean>)
			| undefined;
	}>,
): Promise<ProviderRoutingErrorCodeV1 | undefined> {
	if (options.routeKind === "LOCAL") {
		const allowed = await options.pool.query(
			`SELECT 1
			 FROM provider_route_preferences preference
			 JOIN provider_capability_certifications certification
			   ON certification.provider_id = $3
			  AND certification.region = $4
			  AND certification.model_id = $5
			  AND certification.route_policy_version = 'p1-v1'
			  AND certification.capability = $2
			  AND certification.status = 'CERTIFIED'
			 WHERE preference.owner_user_id = $1
			   AND preference.capability = $2
			   AND preference.local_fallback_enabled = true`,
			[
				options.request.ownerUserId,
				options.request.capability,
				options.identity.providerId,
				options.identity.region,
				options.identity.modelId,
			],
		);
		if (
			allowed.rowCount !== 1 ||
			options.primaryLocalFallback === undefined ||
			!sameProviderIdentity(
				options.primaryLocalFallback.identity,
				options.identity,
			)
		) {
			return "PROVIDER_ROUTE_UNAVAILABLE";
		}
		try {
			return (await options.primaryLocalFallback.isHealthy())
				? undefined
				: "PROVIDER_ROUTE_UNAVAILABLE";
		} catch {
			return "PROVIDER_ROUTE_UNAVAILABLE";
		}
	}
	const textDataClasses = options.request.dataClasses.filter(
		(value): value is ProviderTextDataClassV1 =>
			value !== "PRIVATE_FILE_MATERIAL",
	);
	const route = await getEffectiveRoute(options.pool, {
		contractVersion: "1.0",
		type: "GET_EFFECTIVE_ROUTE",
		actor: { userId: options.request.ownerUserId, role: "USER" },
		ownerUserId: options.request.ownerUserId,
		capability: options.request.capability,
		dataClasses: textDataClasses,
	});
	if (route.resultType !== "EFFECTIVE_ROUTE" || route.status !== "AVAILABLE") {
		return route.resultType === "EFFECTIVE_ROUTE"
			? route.code
			: "PROVIDER_ROUTE_UNAVAILABLE";
	}
	if (
		route.routeKind !== options.routeKind ||
		!sameProviderIdentity(route.identity, options.identity)
	) {
		return "PROVIDER_CONFIGURATION_REQUIRED";
	}
	const configuration = options.configuration;
	if (
		configuration.configuration_id === undefined ||
		configuration.credential_owner_user_id === undefined ||
		configuration.credential_id === undefined ||
		configuration.updated_at === undefined
	) {
		return "PROVIDER_CONFIGURATION_REQUIRED";
	}
	const currentConfiguration = await options.pool.query(
		`SELECT 1 FROM provider_configurations
		 WHERE configuration_id = $1 AND scope = $2 AND route_subject_id = $3
		   AND capability = $4 AND endpoint_url = $5
		   AND credential_owner_user_id = $6 AND credential_id = $7
		   AND updated_at = $8 AND status = 'ENABLED'`,
		[
			configuration.configuration_id,
			options.routeKind === "PLATFORM" ? "PLATFORM" : "USER",
			options.routeKind === "PLATFORM"
				? "__PLATFORM__"
				: options.request.ownerUserId,
			options.request.capability,
			configuration.endpoint_url,
			configuration.credential_owner_user_id,
			configuration.credential_id,
			configuration.updated_at,
		],
	);
	if (currentConfiguration.rowCount !== 1) {
		return "PROVIDER_CONFIGURATION_REQUIRED";
	}
	if (
		textDataClasses.length > 0 &&
		options.request.textEgressConsentId !== undefined &&
		!(await matchesCurrentTextEgressConsent(
			options.pool,
			options.request,
			options.identity,
			textDataClasses,
		))
	) {
		return "PROVIDER_CONSENT_REQUIRED";
	}
	if (options.request.dataClasses.includes("PRIVATE_FILE_MATERIAL")) {
		const consentIds = options.request.privateFileConsentIds ?? [];
		if (
			consentIds.length === 0 ||
			options.validatePrivateFileConsentIds === undefined ||
			!(await options.validatePrivateFileConsentIds({
				ownerUserId: options.request.ownerUserId,
				decisionTaskId: options.request.decisionTaskId,
				identity: options.identity,
				routeKind: options.routeKind,
				consentIds,
			}))
		) {
			return "PROVIDER_CONSENT_REQUIRED";
		}
	}
	return undefined;
}

function sameProviderIdentity(
	left: ProviderModelIdentityV1,
	right: ProviderModelIdentityV1,
): boolean {
	return (
		left.providerId === right.providerId &&
		left.region === right.region &&
		left.modelId === right.modelId &&
		left.routePolicyVersion === right.routePolicyVersion
	);
}

async function matchesCurrentTextEgressConsent(
	pool: Pool,
	request: AcquireCapabilityRouteV1,
	identity: ProviderModelIdentityV1,
	dataClasses: readonly ProviderTextDataClassV1[],
): Promise<boolean> {
	const stored = await pool.query<{
		result: unknown;
		created_at: Date;
	}>(
		`SELECT result, created_at FROM provider_command_records
		 WHERE actor_user_id = $1 AND request_id = $2`,
		[request.ownerUserId, request.textEgressConsentId],
	);
	const row = stored.rows[0];
	if (row === undefined) return false;
	const parsed = commandResultSchema.safeParse(row.result);
	if (
		!parsed.success ||
		parsed.data.resultType !== "TEXT_EGRESS_CONSENT_UPDATED"
	) {
		return false;
	}
	const consent = parsed.data;
	if (
		!consent.granted ||
		consent.providerId !== identity.providerId ||
		consent.region !== identity.region ||
		!dataClasses.every((dataClass) => consent.dataClasses.includes(dataClass))
	) {
		return false;
	}
	const current = await pool.query<{ data_class: ProviderTextDataClassV1 }>(
		`SELECT data_class FROM provider_text_egress_consents
		 WHERE owner_user_id = $1 AND provider_id = $2 AND region = $3
		   AND data_class = ANY($4::text[]) AND status = 'GRANTED'
		   AND updated_at = $5`,
		[
			request.ownerUserId,
			identity.providerId,
			identity.region,
			dataClasses,
			row.created_at,
		],
	);
	return (
		new Set(current.rows.map((item) => item.data_class)).size ===
		dataClasses.length
	);
}

async function claimRunFallback(
	pool: Pool,
	request: AcquireCapabilityRouteV1,
	timestamp: Date,
): Promise<boolean> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			[`${request.ownerUserId}:${request.agentRunId}:provider-fallback`],
		);
		const used = await client.query(
			`SELECT 1 FROM provider_route_requests
			 WHERE owner_user_id = $1 AND agent_run_id = $2 AND fallback_used = true
			 LIMIT 1`,
			[request.ownerUserId, request.agentRunId],
		);
		if (used.rowCount !== 0) {
			await client.query("ROLLBACK");
			return false;
		}
		const claimed = await client.query(
			`UPDATE provider_route_requests
			 SET fallback_used = true, updated_at = $3
			 WHERE owner_user_id = $1 AND request_id = $2`,
			[request.ownerUserId, request.requestId, timestamp],
		);
		if (claimed.rowCount !== 1) {
			throw new ProviderRoutingOperationError("PROVIDER_IDEMPOTENCY_CONFLICT");
		}
		await client.query("COMMIT");
		return true;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

type AuthorizedAttemptGuard = Readonly<{
	attempt: AuthorizedProviderAttemptV1;
	completedCredentialUse(): boolean;
}>;

function createAuthorizedAttempt(
	options: Readonly<{
		attemptId: string;
		identity: ProviderModelIdentityV1;
		routeKind: "PLATFORM" | "USER_BYOK" | "LOCAL";
		configuration: LeaseConfiguration;
		request: AcquireCapabilityRouteV1;
		vault: CredentialVault;
		credentialSystemActor:
			| Readonly<{ userId: string; role: "SYSTEM" }>
			| undefined;
		egressGuard: EgressGuard | undefined;
	}>,
): AuthorizedAttemptGuard {
	let credentialUsed = false;
	let credentialUseCompleted = false;
	const attempt: AuthorizedProviderAttemptV1 = {
		attemptId: options.attemptId,
		identity: options.identity,
		routeKind: options.routeKind,
		endpointOrigin: new URL(options.configuration.endpoint_url).origin,
		withCredential: async (operation) => {
			if (credentialUsed) {
				throw new ProviderRoutingOperationError(
					"PROVIDER_IDEMPOTENCY_CONFLICT",
				);
			}
			credentialUsed = true;
			if (options.egressGuard === undefined) {
				throw new ProviderRoutingOperationError("PROVIDER_ROUTE_UNAVAILABLE");
			}
			const guarded = await options.egressGuard.execute({
				userId: options.request.ownerUserId,
				operationId: options.attemptId,
				operation: "INVOKE_PROVIDER",
				confirmation: {
					operationId: options.attemptId,
					userId: options.request.ownerUserId,
				},
				correlationId: options.request.requestId,
				destinationUrl: options.configuration.endpoint_url,
				method: "POST",
				perform: async () => {
					if (options.routeKind === "LOCAL") return operation(undefined);
					const actor =
						options.routeKind === "PLATFORM"
							? options.credentialSystemActor
							: ({
									userId: options.request.ownerUserId,
									role: "USER",
								} as const);
					if (
						actor === undefined ||
						options.configuration.credential_id === undefined ||
						options.configuration.credential_owner_user_id === undefined
					) {
						throw new ProviderRoutingOperationError(
							"PROVIDER_ROUTE_UNAVAILABLE",
						);
					}
					await options.vault.use(
						{
							credentialId: options.configuration.credential_id,
							ownerUserId: options.configuration.credential_owner_user_id,
							actor,
							correlationId: options.request.requestId,
						},
						(secret) => operation(secret),
					);
				},
			});
			if (guarded.status !== "COMPLETED") {
				throw new ProviderRoutingOperationError("PROVIDER_CONSENT_REQUIRED");
			}
			credentialUseCompleted = true;
		},
	};
	return {
		attempt,
		completedCredentialUse: () => credentialUseCompleted,
	};
}

async function invokeAttempt<T>(
	operation: (
		attempt: AuthorizedProviderAttemptV1,
	) => Promise<ProviderAttemptOutcomeV1<T>>,
	guard: AuthorizedAttemptGuard,
): Promise<ProviderAttemptOutcomeV1<T>> {
	try {
		const outcome: unknown = await operation(guard.attempt);
		if (!guard.completedCredentialUse()) {
			return {
				status: "FAILED",
				code: "PROVIDER_INVALID_RESPONSE",
				effectState: "UNKNOWN",
			};
		}
		const parsed = providerAttemptOutcomeSchema.safeParse(outcome);
		if (!parsed.success) {
			return {
				status: "FAILED",
				code: "PROVIDER_INVALID_RESPONSE",
				effectState: "UNKNOWN",
			};
		}
		return parsed.data as ProviderAttemptOutcomeV1<T>;
	} catch {
		return {
			status: "FAILED",
			code: "PROVIDER_RESULT_UNKNOWN",
			effectState: "UNKNOWN",
		};
	}
}

function shouldFallback<T>(
	outcome: ProviderAttemptOutcomeV1<T>,
	localFallback: LocalFallbackRoute | undefined,
): boolean {
	if (
		localFallback === undefined ||
		outcome.status !== "FAILED" ||
		outcome.effectState === "PARTIAL" ||
		outcome.effectState === "COMMITTED" ||
		outcome.effectState === "UNKNOWN"
	) {
		return false;
	}
	if (outcome.code === "PROVIDER_TIMEOUT") {
		return outcome.effectState === "NOT_STARTED";
	}
	return (
		outcome.code === "PROVIDER_RATE_LIMITED" ||
		outcome.code === "PROVIDER_UNAVAILABLE"
	);
}

function toCapabilityResult<T>(
	outcome: ProviderAttemptOutcomeV1<T>,
	identity: ProviderModelIdentityV1,
	attribution: "PLATFORM" | "USER_BYOK" | "LOCAL",
	fallbackUsed: boolean,
): ProviderCapabilityResultV1<T> {
	if (outcome.status === "COMPLETED") {
		return {
			status: "COMPLETED",
			value: outcome.value,
			identity,
			attribution,
			fallbackUsed,
		};
	}
	if (outcome.status === "CANCELLED") {
		return {
			status: "FAILED",
			code: "PROVIDER_CANCELLED",
			retryable: false,
			effectState: outcome.effectState,
			identity,
			fallbackUsed,
		};
	}
	return {
		status: "FAILED",
		code: outcome.code,
		retryable: isRetryableProviderOutcome(outcome),
		effectState: outcome.effectState,
		identity,
		fallbackUsed,
	};
}

async function recordRouteDecision<T>(
	pool: Pool,
	request: AcquireCapabilityRouteV1,
	primaryIdentity: ProviderModelIdentityV1,
	result: ProviderCapabilityResultV1<T>,
	fallbackReason: ProviderRoutingErrorCodeV1 | undefined,
	timestamp: Date,
	statusOverride?: "PAUSED",
): Promise<void> {
	const finalIdentity = result.identity ?? primaryIdentity;
	await pool.query(
		`INSERT INTO provider_route_decisions (
		   decision_id, owner_user_id, request_id, decision_task_id, agent_run_id,
		   capability, primary_provider_id, primary_region, primary_model_id,
		   final_provider_id, final_region, final_model_id, final_status,
		   final_code, fallback_used, fallback_reason, created_at
		 ) VALUES (
		   $1, $2, $3, $4, $5, $6, $7, $8, $9,
		   $10, $11, $12, $13, $14, $15, $16, $17
		 )
		 ON CONFLICT (owner_user_id, request_id) DO UPDATE SET
		   final_provider_id = EXCLUDED.final_provider_id,
		   final_region = EXCLUDED.final_region,
		   final_model_id = EXCLUDED.final_model_id,
		   final_status = EXCLUDED.final_status,
		   final_code = EXCLUDED.final_code,
		   fallback_used = EXCLUDED.fallback_used,
		   fallback_reason = EXCLUDED.fallback_reason`,
		[
			randomUUID(),
			request.ownerUserId,
			request.requestId,
			request.decisionTaskId,
			request.agentRunId,
			request.capability,
			primaryIdentity.providerId,
			primaryIdentity.region,
			primaryIdentity.modelId,
			finalIdentity.providerId,
			finalIdentity.region,
			finalIdentity.modelId,
			statusOverride ?? result.status,
			result.status === "COMPLETED" ? null : result.code,
			result.fallbackUsed,
			fallbackReason ?? null,
			timestamp,
		],
	);
}

async function recordPausedRouteDecision(
	pool: Pool,
	request: AcquireCapabilityRouteV1,
	identity: ProviderModelIdentityV1,
	code: "PROVIDER_CONSENT_REQUIRED" | "PROVIDER_LIMIT_EXCEEDED",
	timestamp: Date,
): Promise<void> {
	await recordRouteDecision(
		pool,
		request,
		identity,
		{
			status: "FAILED",
			code,
			retryable: true,
			effectState: "NOT_STARTED",
			identity,
			fallbackUsed: false,
		},
		undefined,
		timestamp,
		"PAUSED",
	);
}

async function settlePlatformUsage<T>(
	pool: Pool,
	usageId: string,
	outcome: ProviderAttemptOutcomeV1<T>,
	timestamp: Date,
): Promise<void> {
	const usage = outcome.usage;
	const status =
		outcome.status !== "COMPLETED" &&
		(outcome.effectState === "UNKNOWN" ||
			(outcome.status === "FAILED" &&
				outcome.code === "PROVIDER_RESULT_UNKNOWN"))
			? "UNCONFIRMED"
			: usage !== undefined
				? "SETTLED"
				: outcome.status !== "COMPLETED" &&
						outcome.effectState === "NOT_STARTED"
					? "RELEASED"
					: "UNCONFIRMED";
	await pool.query(
		`UPDATE platform_provider_usage
		 SET status = $2, actual_usage = $3::jsonb, updated_at = $4
		 WHERE usage_id = $1 AND status IN ('RESERVED', 'UNCONFIRMED')`,
		[
			usageId,
			status,
			usage === undefined ? null : JSON.stringify(usage),
			timestamp,
		],
	);
}

function parseBudget(value: unknown): ProviderUsageBudgetV1 | undefined {
	const parsed = usageBudgetSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function totalUsage(rows: readonly PlatformUsageRow[]): ProviderUsageBudgetV1 {
	const total: Record<(typeof usageKeys)[number], number> = {
		inputTokens: 0,
		outputTokens: 0,
		images: 0,
		audioSeconds: 0,
		videoSeconds: 0,
	};
	for (const row of rows) {
		const value = parseBudget(
			row.status === "SETTLED" ? row.actual_usage : row.reserved_budget,
		);
		if (value === undefined) {
			throw new ProviderRoutingOperationError("PROVIDER_USAGE_UNCONFIRMED");
		}
		for (const key of usageKeys) total[key] += value[key] ?? 0;
	}
	return total;
}

function withinBudget(
	used: ProviderUsageBudgetV1,
	estimated: ProviderUsageBudgetV1,
	limit: ProviderUsageBudgetV1,
): boolean {
	return usageKeys.every(
		(key) =>
			estimated[key] === undefined ||
			(limit[key] !== undefined &&
				(used[key] ?? 0) + estimated[key] <= limit[key]),
	);
}

function isRetryableProviderCode(code: ProviderRoutingErrorCodeV1): boolean {
	return (
		code === "PROVIDER_RATE_LIMITED" ||
		code === "PROVIDER_UNAVAILABLE" ||
		code === "PROVIDER_TIMEOUT"
	);
}

function isRetryableProviderOutcome<T>(
	outcome: Extract<ProviderAttemptOutcomeV1<T>, { status: "FAILED" }>,
): boolean {
	if (
		outcome.effectState !== "NOT_STARTED" &&
		outcome.effectState !== "STARTED"
	) {
		return false;
	}
	if (outcome.code === "PROVIDER_TIMEOUT") {
		return outcome.effectState === "NOT_STARTED";
	}
	return isRetryableProviderCode(outcome.code);
}

async function saveConfiguration(
	pool: Pool,
	vault: CredentialVault,
	credentialSystemActor: Readonly<{
		userId: string;
		role: "SYSTEM";
	}>,
	fingerprintKey: Uint8Array,
	command: SaveProviderConfigurationCommandV1,
	timestamp: Date,
): Promise<ProviderRoutingCommandResultV1> {
	assertCanSaveConfiguration(command);
	const endpoint = normalizeExternalProviderEndpoint(
		command.providerId,
		command.endpointUrl,
	);
	const fingerprint = fingerprintCommand(
		command,
		endpoint.href,
		fingerprintKey,
	);
	const client = await pool.connect();
	let credentialId: string | undefined;
	let cleanupDeletionId: string | undefined;
	let committed = false;
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			[`${command.actor.userId}:${command.requestId}`],
		);
		const replay = await readCommandReplay(client, command, fingerprint);
		if (replay !== undefined) {
			await client.query("COMMIT");
			return replay;
		}

		credentialId = randomUUID();
		cleanupDeletionId = credentialId;
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			[`provider-credential:${credentialId}`],
		);
		await pool.query(
			`INSERT INTO provider_pending_credential_deletions (
			   deletion_id, owner_user_id, credential_id,
			   deletion_authority, requested_at, not_before
			 ) VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				cleanupDeletionId,
				command.ownerUserId,
				credentialId,
				"SYSTEM",
				timestamp,
				new Date(timestamp.getTime() + 60 * 60 * 1_000),
			],
		);
		await vault.store({
			credentialId,
			ownerUserId: command.ownerUserId,
			secret: command.credential,
			secretType: "PROVIDER_CREDENTIAL",
			actor: command.actor,
			correlationId: command.requestId,
		});
		const configurationId = randomUUID();
		const routeSubjectId =
			command.scope === "PLATFORM" ? "__PLATFORM__" : command.ownerUserId;
		const previous = await client.query<ProviderConfigurationRow>(
			`SELECT configuration_id, scope, capability, provider_id, region,
			        model_id, endpoint_url, credential_owner_user_id, credential_id,
			        status, updated_at
			 FROM provider_configurations
			 WHERE scope = $1 AND route_subject_id = $2 AND capability = $3
			 FOR UPDATE`,
			[command.scope, routeSubjectId, command.capability],
		);
		const stored = await client.query<ProviderConfigurationRow>(
			`INSERT INTO provider_configurations (
			   configuration_id, scope, route_subject_id, capability,
			   provider_id, region, model_id, endpoint_url,
			   credential_owner_user_id, credential_id, status,
			   created_by_user_id, created_at, updated_at
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ENABLED', $11, $12, $12)
			 ON CONFLICT (scope, route_subject_id, capability) DO UPDATE SET
			   provider_id = EXCLUDED.provider_id,
			   region = EXCLUDED.region,
			   model_id = EXCLUDED.model_id,
			   endpoint_url = EXCLUDED.endpoint_url,
			   credential_owner_user_id = EXCLUDED.credential_owner_user_id,
			   credential_id = EXCLUDED.credential_id,
			   status = 'ENABLED',
			   updated_at = EXCLUDED.updated_at
			 RETURNING configuration_id, scope, capability, provider_id, region,
			           model_id, endpoint_url, status, updated_at`,
			[
				configurationId,
				command.scope,
				routeSubjectId,
				command.capability,
				command.providerId,
				command.region,
				command.modelId,
				endpoint.href,
				command.ownerUserId,
				credentialId,
				command.actor.userId,
				timestamp,
			],
		);
		const row = stored.rows[0];
		if (row === undefined)
			throw new Error("PROVIDER_CONFIGURATION_SAVE_FAILED");
		const result: ProviderRoutingCommandResultV1 = {
			contractVersion: "1.0",
			requestId: command.requestId,
			resultType: "CONFIGURATION_SAVED",
			configuration: toConfigurationSummary(row),
		};
		const oldCredential = previous.rows[0];
		if (
			oldCredential?.credential_id !== undefined &&
			oldCredential.credential_owner_user_id !== undefined
		) {
			await client.query(
				`INSERT INTO provider_pending_credential_deletions (
				   deletion_id, owner_user_id, credential_id,
				   deletion_authority, requested_at
				 ) VALUES ($1, $2, $3, $4, $5)`,
				[
					randomUUID(),
					oldCredential.credential_owner_user_id,
					oldCredential.credential_id,
					command.scope === "PLATFORM" ? "SYSTEM" : "USER",
					timestamp,
				],
			);
		}
		await client.query(
			`INSERT INTO provider_command_records (
			   actor_user_id, request_id, request_fingerprint, result, created_at
			 ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
			[
				command.actor.userId,
				command.requestId,
				fingerprint,
				JSON.stringify(result),
				timestamp,
			],
		);
		await client.query(
			"DELETE FROM provider_pending_credential_deletions WHERE deletion_id = $1",
			[cleanupDeletionId],
		);
		await client.query("COMMIT");
		committed = true;
		await drainCredentialDeletions(pool, vault, credentialSystemActor);
		return result;
	} catch (error) {
		if (!committed) {
			await client.query("ROLLBACK").catch(() => undefined);
		}
		if (!committed && credentialId !== undefined) {
			const referenced = await pool
				.query(
					`SELECT 1 FROM provider_configurations
					 WHERE credential_owner_user_id = $1 AND credential_id = $2
					 LIMIT 1`,
					[command.ownerUserId, credentialId],
				)
				.then((result) => result.rowCount !== 0)
				.catch(() => undefined);
			if (referenced === false) {
				const deleted = await vault
					.delete({
						credentialId,
						ownerUserId: command.ownerUserId,
						actor: credentialSystemActor,
						correlationId: command.requestId,
					})
					.then(() => true)
					.catch(() => false);
				if (deleted && cleanupDeletionId !== undefined) {
					await pool
						.query(
							"DELETE FROM provider_pending_credential_deletions WHERE deletion_id = $1",
							[cleanupDeletionId],
						)
						.catch(() => undefined);
				}
			}
		}
		throw error;
	} finally {
		client.release();
	}
}

async function importCertification(
	pool: Pool,
	fingerprintKey: Uint8Array,
	command: ImportProviderCertificationCommandV1,
	configuredActor: Readonly<{ userId: string; role: "SYSTEM" }> | undefined,
	timestamp: Date,
): Promise<ProviderRoutingCommandResultV1> {
	if (
		configuredActor === undefined ||
		command.actor.userId !== configuredActor.userId ||
		command.actor.role !== configuredActor.role
	) {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
	const capabilities = [...new Set(command.capabilities)].sort();
	return executeRecordedCommand(
		pool,
		fingerprintKey,
		command,
		timestamp,
		async (client) => {
			for (const capability of capabilities) {
				await client.query(
					`INSERT INTO provider_capability_certifications (
					   provider_id, region, model_id, route_policy_version, capability,
					   evidence_digest, status, certified_at, imported_at
					 ) VALUES ($1, $2, $3, $4, $5, $6, 'CERTIFIED', $7, $8)
					 ON CONFLICT (
					   provider_id, region, model_id, route_policy_version, capability
					 ) DO UPDATE SET
					   evidence_digest = EXCLUDED.evidence_digest,
					   status = 'CERTIFIED',
					   certified_at = EXCLUDED.certified_at,
					   imported_at = EXCLUDED.imported_at`,
					[
						command.identity.providerId,
						command.identity.region,
						command.identity.modelId,
						command.identity.routePolicyVersion,
						capability,
						command.evidenceDigest,
						command.certifiedAt,
						timestamp,
					],
				);
			}
			return {
				contractVersion: "1.0",
				requestId: command.requestId,
				resultType: "CERTIFICATION_IMPORTED",
				identity: command.identity,
				capabilities,
				evidenceDigest: command.evidenceDigest,
				certifiedAt: command.certifiedAt,
			};
		},
	);
}

async function confirmRoute(
	pool: Pool,
	fingerprintKey: Uint8Array,
	command: ConfirmProviderRouteCommandV1,
	timestamp: Date,
): Promise<ProviderRoutingCommandResultV1> {
	assertUserOwns(command.actor, command.ownerUserId);
	return executeRecordedCommand(
		pool,
		fingerprintKey,
		command,
		timestamp,
		async (client) => {
			const routeSubjectId =
				command.routeKind === "PLATFORM" ? "__PLATFORM__" : command.ownerUserId;
			const configuration = await client.query(
				`SELECT 1 FROM provider_configurations
				 WHERE scope = $1 AND route_subject_id = $2 AND capability = $3
				   AND status = 'ENABLED'`,
				[
					command.routeKind === "PLATFORM" ? "PLATFORM" : "USER",
					routeSubjectId,
					command.capability,
				],
			);
			if (configuration.rowCount !== 1) {
				throw new ProviderRoutingOperationError(
					"PROVIDER_CONFIGURATION_REQUIRED",
				);
			}
			if (command.routeKind === "PLATFORM") {
				await client.query(
					`UPDATE provider_configurations
					 SET status = 'DISABLED', updated_at = $3
					 WHERE scope = 'USER' AND route_subject_id = $1
					   AND capability = $2 AND status = 'ENABLED'`,
					[command.ownerUserId, command.capability, timestamp],
				);
			}
			await client.query(
				`INSERT INTO provider_route_preferences (
				   owner_user_id, capability, route_kind, local_fallback_enabled,
				   confirmed_at, updated_at
				 ) VALUES ($1, $2, $3, $4, $5, $5)
				 ON CONFLICT (owner_user_id, capability) DO UPDATE SET
				   route_kind = EXCLUDED.route_kind,
				   local_fallback_enabled = EXCLUDED.local_fallback_enabled,
				   confirmed_at = EXCLUDED.confirmed_at,
				   updated_at = EXCLUDED.updated_at`,
				[
					command.ownerUserId,
					command.capability,
					command.routeKind,
					command.localFallbackEnabled,
					timestamp,
				],
			);
			return {
				contractVersion: "1.0",
				requestId: command.requestId,
				resultType: "ROUTE_CONFIRMED",
				ownerUserId: command.ownerUserId,
				capability: command.capability,
				routeKind: command.routeKind,
				localFallbackEnabled: command.localFallbackEnabled,
			};
		},
	);
}

async function revokeRoute(
	pool: Pool,
	fingerprintKey: Uint8Array,
	command: RevokeProviderRouteCommandV1,
	timestamp: Date,
): Promise<ProviderRoutingCommandResultV1> {
	assertUserOwns(command.actor, command.ownerUserId);
	return executeRecordedCommand(
		pool,
		fingerprintKey,
		command,
		timestamp,
		async (client) => {
			await client.query(
				`DELETE FROM provider_route_preferences
				 WHERE owner_user_id = $1 AND capability = $2`,
				[command.ownerUserId, command.capability],
			);
			return {
				contractVersion: "1.0",
				requestId: command.requestId,
				resultType: "ROUTE_REVOKED",
				ownerUserId: command.ownerUserId,
				capability: command.capability,
			};
		},
	);
}

async function setTextEgressConsent(
	pool: Pool,
	fingerprintKey: Uint8Array,
	command: SetProviderTextEgressConsentCommandV1,
	timestamp: Date,
): Promise<ProviderRoutingCommandResultV1> {
	assertUserOwns(command.actor, command.ownerUserId);
	const dataClasses = [...new Set(command.dataClasses)].sort();
	return executeRecordedCommand(
		pool,
		fingerprintKey,
		command,
		timestamp,
		async (client) => {
			for (const dataClass of dataClasses) {
				await client.query(
					`INSERT INTO provider_text_egress_consents (
					   owner_user_id, provider_id, region, data_class, status, updated_at
					 ) VALUES ($1, $2, $3, $4, $5, $6)
					 ON CONFLICT (owner_user_id, provider_id, region, data_class)
					 DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
					[
						command.ownerUserId,
						command.providerId,
						command.region,
						dataClass,
						command.granted ? "GRANTED" : "REVOKED",
						timestamp,
					],
				);
			}
			return {
				contractVersion: "1.0",
				requestId: command.requestId,
				resultType: "TEXT_EGRESS_CONSENT_UPDATED",
				providerId: command.providerId,
				region: command.region,
				dataClasses,
				granted: command.granted,
			};
		},
	);
}

async function setPlatformLimit(
	pool: Pool,
	fingerprintKey: Uint8Array,
	command: SetPlatformProviderLimitCommandV1,
	timestamp: Date,
): Promise<ProviderRoutingCommandResultV1> {
	if (command.actor.role !== "SUPERADMIN") {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
	const subjectUserId =
		command.limitScope === "GLOBAL"
			? "__GLOBAL__"
			: command.limitScope === "DEFAULT_USER"
				? "__DEFAULT_USER__"
				: command.subjectUserId;
	if (subjectUserId === undefined) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return executeRecordedCommand(
		pool,
		fingerprintKey,
		command,
		timestamp,
		async (client) => {
			await client.query(
				`INSERT INTO platform_provider_limits (
				   limit_scope, subject_user_id, capability, provider_id, model_id,
				   budget, updated_by_user_id, updated_at
				 ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
				 ON CONFLICT (
				   limit_scope, subject_user_id, capability, provider_id, model_id
				 ) DO UPDATE SET
				   budget = EXCLUDED.budget,
				   updated_by_user_id = EXCLUDED.updated_by_user_id,
				   updated_at = EXCLUDED.updated_at`,
				[
					command.limitScope,
					subjectUserId,
					command.capability,
					command.providerId,
					command.modelId,
					JSON.stringify(command.budget),
					command.actor.userId,
					timestamp,
				],
			);
			return {
				contractVersion: "1.0",
				requestId: command.requestId,
				resultType: "PLATFORM_LIMIT_SET",
				limitScope: command.limitScope,
				...(command.subjectUserId === undefined
					? {}
					: { subjectUserId: command.subjectUserId }),
				capability: command.capability,
				providerId: command.providerId,
				modelId: command.modelId,
				budget: command.budget,
			};
		},
	);
}

async function setConfigurationStatus(
	pool: Pool,
	fingerprintKey: Uint8Array,
	command: SetProviderConfigurationStatusCommandV1,
	timestamp: Date,
): Promise<ProviderRoutingCommandResultV1> {
	assertCanManageConfiguration(command);
	return executeRecordedCommand(
		pool,
		fingerprintKey,
		command,
		timestamp,
		async (client) => {
			const routeSubjectId =
				command.scope === "PLATFORM" ? "__PLATFORM__" : command.ownerUserId;
			const updated = await client.query<ProviderConfigurationRow>(
				`UPDATE provider_configurations SET status = $4, updated_at = $5
				 WHERE scope = $1 AND route_subject_id = $2 AND capability = $3
				 RETURNING configuration_id, scope, capability, provider_id, region,
				           model_id, endpoint_url, status, updated_at`,
				[
					command.scope,
					routeSubjectId,
					command.capability,
					command.status,
					timestamp,
				],
			);
			const configuration = updated.rows[0];
			if (configuration === undefined) {
				throw new ProviderRoutingOperationError(
					"PROVIDER_CONFIGURATION_REQUIRED",
				);
			}
			return {
				contractVersion: "1.0",
				requestId: command.requestId,
				resultType: "CONFIGURATION_STATUS_SET",
				configuration: toConfigurationSummary(configuration),
			};
		},
	);
}

async function deleteUserConfiguration(
	pool: Pool,
	vault: CredentialVault,
	fingerprintKey: Uint8Array,
	command: DeleteUserProviderConfigurationCommandV1,
	timestamp: Date,
): Promise<ProviderRoutingCommandResultV1> {
	assertUserOwns(command.actor, command.ownerUserId);
	const result = await executeRecordedCommand(
		pool,
		fingerprintKey,
		command,
		timestamp,
		async (client) => {
			const current = await client.query<ProviderConfigurationRow>(
				`SELECT configuration_id, scope, capability, provider_id, region,
				        model_id, endpoint_url, credential_owner_user_id, credential_id,
				        status, updated_at
				 FROM provider_configurations
				 WHERE scope = 'USER' AND route_subject_id = $1 AND capability = $2
				 FOR UPDATE`,
				[command.ownerUserId, command.capability],
			);
			const configuration = current.rows[0];
			if (
				configuration?.credential_id === undefined ||
				configuration.credential_owner_user_id === undefined
			) {
				throw new ProviderRoutingOperationError(
					"PROVIDER_CONFIGURATION_REQUIRED",
				);
			}
			await client.query(
				`DELETE FROM provider_configurations
				 WHERE scope = 'USER' AND route_subject_id = $1 AND capability = $2`,
				[command.ownerUserId, command.capability],
			);
			await client.query(
				`DELETE FROM provider_route_preferences
				 WHERE owner_user_id = $1 AND capability = $2`,
				[command.ownerUserId, command.capability],
			);
			await client.query(
				`INSERT INTO provider_pending_credential_deletions (
				   deletion_id, owner_user_id, credential_id,
				   deletion_authority, requested_at
				 ) VALUES ($1, $2, $3, 'USER', $4)`,
				[
					randomUUID(),
					configuration.credential_owner_user_id,
					configuration.credential_id,
					timestamp,
				],
			);
			return {
				contractVersion: "1.0",
				requestId: command.requestId,
				resultType: "USER_CONFIGURATION_DELETED",
				ownerUserId: command.ownerUserId,
				capability: command.capability,
			};
		},
	);
	await drainCredentialDeletions(pool, vault, command.actor);
	return result;
}

async function executeRecordedCommand(
	pool: Pool,
	fingerprintKey: Uint8Array,
	command: Exclude<
		ProviderRoutingCommandV1,
		SaveProviderConfigurationCommandV1
	>,
	timestamp: Date,
	operation: (client: PoolClient) => Promise<ProviderRoutingCommandResultV1>,
): Promise<ProviderRoutingCommandResultV1> {
	const fingerprint = fingerprintValue(command, fingerprintKey);
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			[`${command.actor.userId}:${command.requestId}`],
		);
		const stored = await client.query<ProviderCommandRecordRow>(
			`SELECT request_fingerprint, result FROM provider_command_records
			 WHERE actor_user_id = $1 AND request_id = $2`,
			[command.actor.userId, command.requestId],
		);
		const replay = stored.rows[0];
		if (replay !== undefined) {
			if (replay.request_fingerprint !== fingerprint) {
				throw new ProviderRoutingOperationError(
					"PROVIDER_IDEMPOTENCY_CONFLICT",
				);
			}
			const parsed = commandResultSchema.safeParse(replay.result);
			if (!parsed.success) throw new Error("PROVIDER_STORED_RESULT_INVALID");
			await client.query("COMMIT");
			return parsed.data;
		}
		const result = await operation(client);
		await client.query(
			`INSERT INTO provider_command_records (
			   actor_user_id, request_id, request_fingerprint, result, created_at
			 ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
			[
				command.actor.userId,
				command.requestId,
				fingerprint,
				JSON.stringify(result),
				timestamp,
			],
		);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function getUserConfiguration(
	pool: Pool,
	query: GetUserProviderConfigurationQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	if (
		query.actor.role === "SYSTEM" ||
		query.actor.userId !== query.ownerUserId
	) {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
	const result = await pool.query<ProviderConfigurationRow>(
		`SELECT configuration_id, scope, capability, provider_id, region,
		        model_id, endpoint_url, status, updated_at
		 FROM provider_configurations
		 WHERE scope = 'USER' AND route_subject_id = $1 AND capability = $2`,
		[query.ownerUserId, query.capability],
	);
	return {
		resultType: "CONFIGURATION",
		configuration:
			result.rows[0] === undefined
				? null
				: toConfigurationSummary(result.rows[0]),
	};
}

async function getPlatformConfiguration(
	pool: Pool,
	query: GetPlatformProviderConfigurationQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	if (query.actor.role !== "SUPERADMIN") {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
	const result = await pool.query<ProviderConfigurationRow>(
		`SELECT configuration_id, scope, capability, provider_id, region,
		        model_id, endpoint_url, status, updated_at
		 FROM provider_configurations
		 WHERE scope = 'PLATFORM' AND route_subject_id = '__PLATFORM__'
		   AND capability = $1`,
		[query.capability],
	);
	return {
		resultType: "CONFIGURATION",
		configuration:
			result.rows[0] === undefined
				? null
				: toConfigurationSummary(result.rows[0]),
	};
}

async function getRoutePreference(
	pool: Pool,
	query: GetProviderRoutePreferenceQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	assertUserOwns(query.actor, query.ownerUserId);
	const result = await pool.query<{
		route_kind: "USER_BYOK" | "PLATFORM";
		local_fallback_enabled: boolean;
		confirmed_at: Date;
		updated_at: Date;
	}>(
		`SELECT route_kind, local_fallback_enabled, confirmed_at, updated_at
		 FROM provider_route_preferences
		 WHERE owner_user_id = $1 AND capability = $2`,
		[query.ownerUserId, query.capability],
	);
	const preference = result.rows[0];
	return {
		resultType: "ROUTE_PREFERENCE",
		preference:
			preference === undefined
				? null
				: {
						routeKind: preference.route_kind,
						localFallbackEnabled: preference.local_fallback_enabled,
						confirmedAt: preference.confirmed_at.toISOString(),
						updatedAt: preference.updated_at.toISOString(),
					},
	};
}

async function getTextEgressConsent(
	pool: Pool,
	query: GetProviderTextEgressConsentQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	assertUserOwns(query.actor, query.ownerUserId);
	const result = await pool.query<{
		data_class: ProviderTextDataClassV1;
		status: "GRANTED" | "REVOKED";
		updated_at: Date;
	}>(
		`SELECT data_class, status, updated_at
		 FROM provider_text_egress_consents
		 WHERE owner_user_id = $1 AND provider_id = $2 AND region = $3
		 ORDER BY data_class`,
		[query.ownerUserId, query.providerId, query.region],
	);
	return {
		resultType: "TEXT_EGRESS_CONSENT",
		providerId: query.providerId,
		region: query.region,
		dataClasses: result.rows.map((row) => ({
			dataClass: row.data_class,
			granted: row.status === "GRANTED",
			updatedAt: row.updated_at.toISOString(),
		})),
	};
}

async function listTextEgressConsents(
	pool: Pool,
	query: ListProviderTextEgressConsentsQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	assertUserOwns(query.actor, query.ownerUserId);
	const result = await pool.query<{
		provider_id: string;
		region: string;
		data_class: ProviderTextDataClassV1;
		updated_at: Date;
	}>(
		`SELECT provider_id, region, data_class, updated_at
		 FROM provider_text_egress_consents
		 WHERE owner_user_id = $1 AND status = 'GRANTED'
		 ORDER BY provider_id, region, data_class`,
		[query.ownerUserId],
	);
	const consents = new Map<
		string,
		{
			providerId: string;
			region: string;
			dataClasses: Array<{
				dataClass: ProviderTextDataClassV1;
				granted: true;
				updatedAt: string;
			}>;
		}
	>();
	for (const row of result.rows) {
		const key = `${row.provider_id}\0${row.region}`;
		const consent = consents.get(key) ?? {
			providerId: row.provider_id,
			region: row.region,
			dataClasses: [],
		};
		consent.dataClasses.push({
			dataClass: row.data_class,
			granted: true,
			updatedAt: row.updated_at.toISOString(),
		});
		consents.set(key, consent);
	}
	return {
		resultType: "TEXT_EGRESS_CONSENTS",
		consents: [...consents.values()],
	};
}

async function getUserPlatformUsage(
	pool: Pool,
	query: GetUserPlatformUsageQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	assertUserOwns(query.actor, query.ownerUserId);
	const configured = await pool.query<{
		provider_id: string;
		model_id: string;
	}>(
		`SELECT provider_id, model_id FROM provider_configurations
		 WHERE scope = 'PLATFORM' AND route_subject_id = '__PLATFORM__'
		   AND capability = $1`,
		[query.capability],
	);
	const configuration = configured.rows[0];
	if (configuration === undefined) {
		return { resultType: "PLATFORM_USAGE", usage: null };
	}
	return {
		resultType: "PLATFORM_USAGE",
		usage: await summarizePlatformUsage(pool, {
			ownerUserId: query.ownerUserId,
			capability: query.capability,
			providerId: configuration.provider_id,
			modelId: configuration.model_id,
		}),
	};
}

async function getPlatformUsage(
	pool: Pool,
	query: GetPlatformUsageQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	if (query.actor.role !== "SUPERADMIN") {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
	return {
		resultType: "PLATFORM_USAGE",
		usage: await summarizePlatformUsage(pool, query),
	};
}

async function getPlatformLimits(
	pool: Pool,
	query: GetPlatformLimitsQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	if (query.actor.role !== "SUPERADMIN") {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
	const result = await pool.query<{
		limit_scope: "GLOBAL" | "DEFAULT_USER" | "USER";
		subject_user_id: string;
		budget: unknown;
		updated_at: Date;
	}>(
		`SELECT limit_scope, subject_user_id, budget, updated_at
		 FROM platform_provider_limits
		 WHERE capability = $1 AND provider_id = $2 AND model_id = $3
		 ORDER BY limit_scope, subject_user_id`,
		[query.capability, query.providerId, query.modelId],
	);
	return {
		resultType: "PLATFORM_LIMITS",
		limits: result.rows.map((row) => {
			const budget = parseBudget(row.budget);
			if (budget === undefined)
				throw new Error("PROVIDER_STORED_LIMIT_INVALID");
			return {
				limitScope: row.limit_scope,
				...(row.limit_scope === "USER"
					? { subjectUserId: row.subject_user_id }
					: {}),
				capability: query.capability,
				providerId: query.providerId,
				modelId: query.modelId,
				budget,
				updatedAt: row.updated_at.toISOString(),
			};
		}),
	};
}

async function getCapabilityCertification(
	pool: Pool,
	query: GetProviderCapabilityCertificationQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	if (query.actor.role !== "SUPERADMIN") {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
	const result = await pool.query<{
		evidence_digest: string;
		status: "CERTIFIED" | "DISABLED";
		certified_at: Date;
		imported_at: Date;
	}>(
		`SELECT evidence_digest, status, certified_at, imported_at
		 FROM provider_capability_certifications
		 WHERE provider_id = $1 AND region = $2 AND model_id = $3
		   AND route_policy_version = $4 AND capability = $5`,
		[
			query.identity.providerId,
			query.identity.region,
			query.identity.modelId,
			query.identity.routePolicyVersion,
			query.capability,
		],
	);
	const row = result.rows[0];
	return {
		resultType: "CAPABILITY_CERTIFICATION",
		certification:
			row === undefined
				? null
				: {
						identity: query.identity,
						capability: query.capability,
						evidenceDigest: row.evidence_digest,
						status: row.status,
						certifiedAt: row.certified_at.toISOString(),
						importedAt: row.imported_at.toISOString(),
					},
	};
}

async function summarizePlatformUsage(
	pool: Pool,
	query: Readonly<{
		ownerUserId?: string | undefined;
		capability: ProviderCapabilityV1;
		providerId: string;
		modelId: string;
	}>,
) {
	const usage = await pool.query<PlatformUsageRow>(
		`SELECT owner_user_id, status, reserved_budget, actual_usage
		 FROM platform_provider_usage
		 WHERE capability = $1 AND provider_id = $2 AND model_id = $3
		   AND status IN ('RESERVED', 'SETTLED', 'UNCONFIRMED')
		   AND ($4::text IS NULL OR owner_user_id = $4)`,
		[
			query.capability,
			query.providerId,
			query.modelId,
			query.ownerUserId ?? null,
		],
	);
	const limits = await pool.query<{
		limit_scope: "GLOBAL" | "DEFAULT_USER" | "USER";
		budget: unknown;
	}>(
		`SELECT limit_scope, budget FROM platform_provider_limits
		 WHERE capability = $1 AND provider_id = $2 AND model_id = $3
		   AND (
		     (limit_scope = 'GLOBAL' AND subject_user_id = '__GLOBAL__')
		     OR ($4::text IS NOT NULL AND limit_scope = 'DEFAULT_USER'
		       AND subject_user_id = '__DEFAULT_USER__')
		     OR ($4::text IS NOT NULL AND limit_scope = 'USER'
		       AND subject_user_id = $4)
		   )`,
		[
			query.capability,
			query.providerId,
			query.modelId,
			query.ownerUserId ?? null,
		],
	);
	const globalLimit = parseBudget(
		limits.rows.find((row) => row.limit_scope === "GLOBAL")?.budget,
	);
	const userLimit = parseBudget(
		(
			limits.rows.find((row) => row.limit_scope === "USER") ??
			limits.rows.find((row) => row.limit_scope === "DEFAULT_USER")
		)?.budget,
	);
	const limit =
		query.ownerUserId === undefined
			? globalLimit
			: intersectBudgets(globalLimit, userLimit);
	const used = compactUsage(totalUsage(usage.rows));
	const settled = compactUsage(
		totalUsage(usage.rows.filter((row) => row.status === "SETTLED")),
	);
	const held = compactUsage(
		totalUsage(usage.rows.filter((row) => row.status !== "SETTLED")),
	);
	return {
		...(query.ownerUserId === undefined
			? {}
			: { ownerUserId: query.ownerUserId }),
		capability: query.capability,
		providerId: query.providerId,
		modelId: query.modelId,
		used,
		settled,
		held,
		...(limit === undefined
			? {}
			: { limit, remaining: subtractBudget(limit, used) }),
	};
}

function compactUsage(value: ProviderUsageBudgetV1): ProviderUsageBudgetV1 {
	return Object.fromEntries(
		usageKeys.flatMap((key) =>
			(value[key] ?? 0) > 0 ? [[key, value[key]]] : [],
		),
	);
}

function intersectBudgets(
	left: ProviderUsageBudgetV1 | undefined,
	right: ProviderUsageBudgetV1 | undefined,
): ProviderUsageBudgetV1 | undefined {
	if (left === undefined || right === undefined) return undefined;
	return Object.fromEntries(
		usageKeys.flatMap((key) =>
			left[key] === undefined || right[key] === undefined
				? []
				: [[key, Math.min(left[key], right[key])]],
		),
	);
}

function subtractBudget(
	limit: ProviderUsageBudgetV1,
	used: ProviderUsageBudgetV1,
): ProviderUsageBudgetV1 {
	return Object.fromEntries(
		usageKeys.flatMap((key) =>
			limit[key] === undefined
				? []
				: [[key, Math.max(0, limit[key] - (used[key] ?? 0))]],
		),
	);
}

async function testPlatformConnection(
	pool: Pool,
	vault: CredentialVault,
	credentialSystemActor:
		| Readonly<{ userId: string; role: "SYSTEM" }>
		| undefined,
	egressGuard: EgressGuard | undefined,
	request: TestPlatformProviderConnectionV1,
	operation: (target: PlatformProviderConnectionTargetV1) => Promise<void>,
): Promise<ProviderModelIdentityV1> {
	if (request.actor.role !== "SUPERADMIN") {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
	const configured = await pool.query<ProviderConfigurationRow>(
		`SELECT configuration_id, scope, capability, provider_id, region,
		        model_id, endpoint_url, credential_owner_user_id, credential_id,
		        status, updated_at
		 FROM provider_configurations
		 WHERE scope = 'PLATFORM' AND route_subject_id = '__PLATFORM__'
		   AND capability = $1`,
		[request.capability],
	);
	const configuration = configured.rows[0];
	if (configuration === undefined) {
		throw new ProviderRoutingOperationError("PROVIDER_CONFIGURATION_REQUIRED");
	}
	if (configuration.status !== "ENABLED") {
		throw new ProviderRoutingOperationError("PROVIDER_CONFIGURATION_DISABLED");
	}
	if (
		credentialSystemActor === undefined ||
		egressGuard === undefined ||
		configuration.credential_id === undefined ||
		configuration.credential_owner_user_id === undefined
	) {
		throw new ProviderRoutingOperationError("PROVIDER_ROUTE_UNAVAILABLE", true);
	}
	const identity = {
		providerId: configuration.provider_id,
		region: configuration.region,
		modelId: configuration.model_id,
		routePolicyVersion: "p1-v1" as const,
	};
	const guarded = await egressGuard.execute({
		userId: request.actor.userId,
		operationId: request.requestId,
		operation: "INVOKE_PROVIDER",
		confirmation: {
			operationId: request.requestId,
			userId: request.actor.userId,
		},
		correlationId: request.requestId,
		destinationUrl: configuration.endpoint_url,
		method: "POST",
		perform: async () => {
			await vault.use(
				{
					credentialId: configuration.credential_id as string,
					ownerUserId: configuration.credential_owner_user_id as string,
					actor: credentialSystemActor,
					correlationId: request.requestId,
				},
				(credential) =>
					operation({
						identity,
						endpointUrl: configuration.endpoint_url,
						credential,
					}),
			);
		},
	});
	if (guarded.status !== "COMPLETED") {
		throw new ProviderRoutingOperationError("PROVIDER_ROUTE_UNAVAILABLE", true);
	}
	return identity;
}

async function getEffectiveRoute(
	pool: Pool,
	query: GetEffectiveProviderRouteQueryV1,
): Promise<ProviderRoutingQueryResultV1> {
	assertUserOwns(query.actor, query.ownerUserId);
	const configured = await pool.query<ProviderConfigurationRow>(
		`SELECT configuration_id, scope, capability, provider_id, region,
		        model_id, endpoint_url, status, updated_at
		 FROM provider_configurations
		 WHERE capability = $1
		   AND ((scope = 'USER' AND route_subject_id = $2)
		     OR (scope = 'PLATFORM' AND route_subject_id = '__PLATFORM__'))
		 ORDER BY CASE status WHEN 'ENABLED' THEN 0 ELSE 1 END,
		          CASE scope WHEN 'USER' THEN 0 ELSE 1 END`,
		[query.capability, query.ownerUserId],
	);
	const preference = await pool.query<{ route_kind: "USER_BYOK" | "PLATFORM" }>(
		`SELECT route_kind FROM provider_route_preferences
		 WHERE owner_user_id = $1 AND capability = $2`,
		[query.ownerUserId, query.capability],
	);
	const preferredRouteKind = preference.rows[0]?.route_kind;
	const enabledUserConfiguration = configured.rows.find(
		(row) => row.scope === "USER" && row.status === "ENABLED",
	);
	const configuration =
		enabledUserConfiguration ??
		configured.rows.find(
			(row) =>
				preferredRouteKind === undefined ||
				(row.scope === "USER" ? "USER_BYOK" : "PLATFORM") ===
					preferredRouteKind,
		) ??
		configured.rows[0];
	if (configuration === undefined) {
		return blocked("PROVIDER_CONFIGURATION_REQUIRED");
	}
	if (configuration.status === "DISABLED") {
		return blocked("PROVIDER_CONFIGURATION_DISABLED");
	}
	const certified = await pool.query(
		`SELECT 1 FROM provider_capability_certifications
		 WHERE provider_id = $1 AND region = $2 AND model_id = $3
		   AND route_policy_version = 'p1-v1' AND capability = $4
		   AND status = 'CERTIFIED'`,
		[
			configuration.provider_id,
			configuration.region,
			configuration.model_id,
			query.capability,
		],
	);
	if (certified.rowCount !== 1) {
		return blocked("PROVIDER_CAPABILITY_UNCERTIFIED");
	}
	const expectedRouteKind =
		configuration.scope === "USER" ? "USER_BYOK" : "PLATFORM";
	if (preferredRouteKind !== expectedRouteKind) {
		return blocked("PROVIDER_CONFIGURATION_REQUIRED");
	}
	const identity = {
		providerId: configuration.provider_id,
		region: configuration.region,
		modelId: configuration.model_id,
		routePolicyVersion: "p1-v1" as const,
	};
	const dataClasses = [...new Set(query.dataClasses)];
	const consents = await pool.query<{ data_class: ProviderTextDataClassV1 }>(
		`SELECT data_class FROM provider_text_egress_consents
		 WHERE owner_user_id = $1 AND provider_id = $2 AND region = $3
		   AND data_class = ANY($4::text[]) AND status = 'GRANTED'`,
		[
			query.ownerUserId,
			configuration.provider_id,
			configuration.region,
			dataClasses,
		],
	);
	if (
		new Set(consents.rows.map((row) => row.data_class)).size !==
		dataClasses.length
	) {
		return blocked("PROVIDER_CONSENT_REQUIRED", expectedRouteKind, identity);
	}
	if (expectedRouteKind === "PLATFORM") {
		const limits = await pool.query<{
			limit_scope: "GLOBAL" | "DEFAULT_USER" | "USER";
		}>(
			`SELECT limit_scope FROM platform_provider_limits
			 WHERE capability = $1 AND provider_id = $2 AND model_id = $3
			   AND (
			     (limit_scope = 'GLOBAL' AND subject_user_id = '__GLOBAL__')
			     OR (limit_scope = 'DEFAULT_USER' AND subject_user_id = '__DEFAULT_USER__')
			     OR (limit_scope = 'USER' AND subject_user_id = $4)
			   )`,
			[
				query.capability,
				configuration.provider_id,
				configuration.model_id,
				query.ownerUserId,
			],
		);
		const scopes = new Set(limits.rows.map((row) => row.limit_scope));
		if (
			!scopes.has("GLOBAL") ||
			(!scopes.has("USER") && !scopes.has("DEFAULT_USER"))
		) {
			return blocked("PROVIDER_LIMIT_EXCEEDED", expectedRouteKind, identity);
		}
	}
	return {
		resultType: "EFFECTIVE_ROUTE",
		status: "AVAILABLE",
		routeKind: expectedRouteKind,
		identity,
	};
}

function blocked(
	code: ProviderRoutingErrorCodeV1,
	routeKind?: "USER_BYOK" | "PLATFORM",
	identity?: ProviderModelIdentityV1,
): ProviderRoutingQueryResultV1 {
	return {
		resultType: "EFFECTIVE_ROUTE",
		status: "BLOCKED",
		code,
		...(routeKind === undefined ? {} : { routeKind }),
		...(identity === undefined ? {} : { identity }),
	};
}

async function readCommandReplay(
	client: PoolClient,
	command: SaveProviderConfigurationCommandV1,
	fingerprint: string,
): Promise<ProviderRoutingCommandResultV1 | undefined> {
	const stored = await client.query<ProviderCommandRecordRow>(
		`SELECT request_fingerprint, result
		 FROM provider_command_records
		 WHERE actor_user_id = $1 AND request_id = $2`,
		[command.actor.userId, command.requestId],
	);
	const row = stored.rows[0];
	if (row === undefined) return undefined;
	if (row.request_fingerprint !== fingerprint) {
		throw new ProviderRoutingOperationError("PROVIDER_IDEMPOTENCY_CONFLICT");
	}
	const result = configurationCommandResultSchema.safeParse(row.result);
	if (!result.success) throw new Error("PROVIDER_STORED_RESULT_INVALID");
	return result.data;
}

function assertCanSaveConfiguration(
	command: SaveProviderConfigurationCommandV1,
): void {
	const canSaveUser =
		command.scope === "USER" &&
		command.actor.role !== "SYSTEM" &&
		command.actor.userId === command.ownerUserId;
	const canSavePlatform =
		command.scope === "PLATFORM" &&
		command.actor.role === "SUPERADMIN" &&
		command.actor.userId === command.ownerUserId;
	if (!canSaveUser && !canSavePlatform) {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
}

function assertCanManageConfiguration(
	command: SetProviderConfigurationStatusCommandV1,
): void {
	const canManageUser =
		command.scope === "USER" &&
		command.actor.role !== "SYSTEM" &&
		command.actor.userId === command.ownerUserId;
	const canManagePlatform =
		command.scope === "PLATFORM" && command.actor.role === "SUPERADMIN";
	if (!canManageUser && !canManagePlatform) {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
}

function assertUserOwns(actor: SecurityActor, ownerUserId: string): void {
	if (actor.role === "SYSTEM" || actor.userId !== ownerUserId) {
		throw new ProviderRoutingOperationError("PROVIDER_PERMISSION_DENIED");
	}
}

function readType(value: unknown): string {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		typeof (value as { type?: unknown }).type !== "string"
	) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return (value as { type: string }).type;
}

function decodeSaveConfiguration(
	value: unknown,
): SaveProviderConfigurationCommandV1 {
	const parsed = saveConfigurationSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeTestPlatformConnection(
	value: unknown,
): TestPlatformProviderConnectionV1 {
	const parsed = testPlatformConnectionSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeImportCertification(
	value: unknown,
): ImportProviderCertificationCommandV1 {
	const parsed = importCertificationSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeConfirmRoute(value: unknown): ConfirmProviderRouteCommandV1 {
	const parsed = confirmRouteSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeRevokeRoute(value: unknown): RevokeProviderRouteCommandV1 {
	const parsed = revokeRouteSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeSetTextEgressConsent(
	value: unknown,
): SetProviderTextEgressConsentCommandV1 {
	const parsed = setTextEgressConsentSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeSetPlatformLimit(
	value: unknown,
): SetPlatformProviderLimitCommandV1 {
	const parsed = setPlatformLimitSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeSetConfigurationStatus(
	value: unknown,
): SetProviderConfigurationStatusCommandV1 {
	const parsed = setConfigurationStatusSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeDeleteUserConfiguration(
	value: unknown,
): DeleteUserProviderConfigurationCommandV1 {
	const parsed = deleteUserConfigurationSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetUserConfiguration(
	value: unknown,
): GetUserProviderConfigurationQueryV1 {
	const parsed = getUserConfigurationSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetPlatformConfiguration(
	value: unknown,
): GetPlatformProviderConfigurationQueryV1 {
	const parsed = getPlatformConfigurationSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetRoutePreference(
	value: unknown,
): GetProviderRoutePreferenceQueryV1 {
	const parsed = getRoutePreferenceSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetTextEgressConsent(
	value: unknown,
): GetProviderTextEgressConsentQueryV1 {
	const parsed = getTextEgressConsentSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeListTextEgressConsents(
	value: unknown,
): ListProviderTextEgressConsentsQueryV1 {
	const parsed = listTextEgressConsentsSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetUserPlatformUsage(
	value: unknown,
): GetUserPlatformUsageQueryV1 {
	const parsed = getUserPlatformUsageSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetPlatformUsage(value: unknown): GetPlatformUsageQueryV1 {
	const parsed = getPlatformUsageSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetPlatformLimits(value: unknown): GetPlatformLimitsQueryV1 {
	const parsed = getPlatformLimitsSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetCapabilityCertification(
	value: unknown,
): GetProviderCapabilityCertificationQueryV1 {
	const parsed = getCapabilityCertificationSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeGetEffectiveRoute(
	value: unknown,
): GetEffectiveProviderRouteQueryV1 {
	const parsed = getEffectiveRouteSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

function decodeAcquireCapabilityRoute(
	value: unknown,
): AcquireCapabilityRouteV1 {
	const parsed = acquireCapabilityRouteSchema.safeParse(value);
	if (!parsed.success) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return parsed.data;
}

async function drainCredentialDeletions(
	pool: Pool,
	vault: CredentialVault,
	actor: SecurityActor,
): Promise<void> {
	const authority = actor.role === "SYSTEM" ? "SYSTEM" : "USER";
	const pending = await pool.query<{
		deletion_id: string;
		owner_user_id: string;
		credential_id: string;
	}>(
		`SELECT deletion_id, owner_user_id, credential_id
		 FROM provider_pending_credential_deletions
		 WHERE ($1 = 'SYSTEM' OR (deletion_authority = 'USER' AND owner_user_id = $2))
		   AND not_before <= NOW()
		 ORDER BY requested_at, deletion_id
		 LIMIT 100`,
		[authority, actor.userId],
	);
	for (const item of pending.rows) {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
				[`provider-credential:${item.credential_id}`],
			);
			const queued = await client.query(
				`SELECT 1 FROM provider_pending_credential_deletions
				 WHERE deletion_id = $1 FOR UPDATE`,
				[item.deletion_id],
			);
			if (queued.rowCount === 0) {
				await client.query("COMMIT");
				continue;
			}
			const referenced = await client.query(
				`SELECT 1 FROM provider_configurations
				 WHERE credential_owner_user_id = $1 AND credential_id = $2
				 LIMIT 1`,
				[item.owner_user_id, item.credential_id],
			);
			if (referenced.rowCount === 0) {
				try {
					await vault.delete({
						credentialId: item.credential_id,
						ownerUserId: item.owner_user_id,
						actor,
						correlationId: item.deletion_id,
					});
				} catch {
					await client.query("ROLLBACK");
					continue;
				}
			}
			await client.query(
				"DELETE FROM provider_pending_credential_deletions WHERE deletion_id = $1",
				[item.deletion_id],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
}

const allowedExternalProviderHosts = new Map<string, readonly string[]>([
	["dashscope", ["dashscope.aliyuncs.com"]],
	["bailian", ["dashscope.aliyuncs.com"]],
	["deepseek", ["api.deepseek.com"]],
	["openai", ["api.openai.com"]],
]);

export function normalizeExternalProviderEndpoint(
	providerId: string,
	value: string,
): URL {
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	if (
		endpoint.protocol !== "https:" ||
		(endpoint.port !== "" && endpoint.port !== "443") ||
		endpoint.username !== "" ||
		endpoint.password !== "" ||
		endpoint.search !== "" ||
		endpoint.hash !== "" ||
		!allowedExternalProviderHosts
			.get(providerId.trim().toLowerCase())
			?.includes(endpoint.hostname.toLowerCase())
	) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return endpoint;
}

export function normalizeLocalProviderEndpoint(value: string): URL {
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	if (
		(endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
		!isAllowedLocalProviderHost(endpoint.hostname, endpoint.port) ||
		(endpoint.pathname !== "/v1" && endpoint.pathname !== "/v1/") ||
		endpoint.username !== "" ||
		endpoint.password !== "" ||
		endpoint.search !== "" ||
		endpoint.hash !== ""
	) {
		throw new ProviderRoutingOperationError("PROVIDER_REQUEST_REJECTED");
	}
	return endpoint;
}

function isAllowedLocalProviderHost(hostname: string, port: string): boolean {
	const normalized = hostname.toLowerCase();
	if (port !== "6013") return false;
	if (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "[::1]" ||
		normalized === "::1"
	) {
		return true;
	}
	const octets = normalized.split(".").map(Number);
	if (
		octets.length !== 4 ||
		octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
	) {
		return false;
	}
	return (
		octets[0] === 10 ||
		(octets[0] === 172 &&
			octets[1] !== undefined &&
			octets[1] >= 16 &&
			octets[1] <= 31) ||
		(octets[0] === 192 && octets[1] === 168)
	);
}

function fingerprintCommand(
	command: SaveProviderConfigurationCommandV1,
	endpointUrl: string,
	key: Uint8Array,
): string {
	return createHmac("sha256", key)
		.update(
			JSON.stringify({
				contractVersion: command.contractVersion,
				type: command.type,
				requestId: command.requestId,
				actor: command.actor,
				scope: command.scope,
				ownerUserId: command.ownerUserId,
				capability: command.capability,
				providerId: command.providerId,
				region: command.region,
				modelId: command.modelId,
				endpointUrl,
				credential: command.credential,
			}),
			"utf8",
		)
		.digest("hex");
}

function fingerprintValue(value: unknown, key: Uint8Array): string {
	return createHmac("sha256", key)
		.update(JSON.stringify(value), "utf8")
		.digest("hex");
}

function toConfigurationSummary(
	row: ProviderConfigurationRow,
): ProviderConfigurationSummaryV1 {
	return {
		configurationId: row.configuration_id,
		scope: row.scope,
		capability: row.capability,
		identity: {
			providerId: row.provider_id,
			region: row.region,
			modelId: row.model_id,
			routePolicyVersion: "p1-v1",
		},
		endpointOrigin: new URL(row.endpoint_url).origin,
		credentialPresent: true,
		status: row.status,
		updatedAt: row.updated_at.toISOString(),
	};
}

async function migrateProviderRouting(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('choicemind-provider-routing-migration', 0))",
		);
		await client.query(`
			CREATE TABLE IF NOT EXISTS provider_configurations (
				configuration_id uuid NOT NULL,
				scope text NOT NULL CHECK (scope IN ('USER', 'PLATFORM')),
				route_subject_id text NOT NULL,
				capability text NOT NULL CHECK (
					capability IN ('DECISION_TEXT', 'VISION', 'DOCUMENT_ANALYSIS', 'ASR', 'EMBEDDING', 'RERANKER')
				),
				provider_id text NOT NULL,
				region text NOT NULL,
				model_id text NOT NULL,
				endpoint_url text NOT NULL,
				credential_owner_user_id text NOT NULL,
				credential_id text NOT NULL,
				status text NOT NULL CHECK (status IN ('ENABLED', 'DISABLED')),
				created_by_user_id text NOT NULL,
				created_at timestamptz NOT NULL,
				updated_at timestamptz NOT NULL,
				PRIMARY KEY (scope, route_subject_id, capability),
				UNIQUE (configuration_id),
				CHECK (
					(scope = 'PLATFORM' AND route_subject_id = '__PLATFORM__')
					OR (scope = 'USER' AND route_subject_id = credential_owner_user_id)
				)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS provider_command_records (
				actor_user_id text NOT NULL,
				request_id text NOT NULL,
				request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
				result jsonb NOT NULL,
				created_at timestamptz NOT NULL,
				PRIMARY KEY (actor_user_id, request_id)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS provider_pending_credential_deletions (
				deletion_id uuid PRIMARY KEY,
				owner_user_id text NOT NULL,
				credential_id text NOT NULL,
				deletion_authority text NOT NULL DEFAULT 'SYSTEM'
					CHECK (deletion_authority IN ('USER', 'SYSTEM')),
				requested_at timestamptz NOT NULL,
				not_before timestamptz NOT NULL DEFAULT '-infinity'
			)
		`);
		await client.query(`
			ALTER TABLE provider_pending_credential_deletions
			ADD COLUMN IF NOT EXISTS deletion_authority text NOT NULL DEFAULT 'SYSTEM'
			CHECK (deletion_authority IN ('USER', 'SYSTEM'))
		`);
		await client.query(`
			ALTER TABLE provider_pending_credential_deletions
			ADD COLUMN IF NOT EXISTS not_before timestamptz NOT NULL DEFAULT '-infinity'
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS provider_capability_certifications (
				provider_id text NOT NULL,
				region text NOT NULL,
				model_id text NOT NULL,
				route_policy_version text NOT NULL CHECK (route_policy_version = 'p1-v1'),
				capability text NOT NULL CHECK (
					capability IN ('DECISION_TEXT', 'VISION', 'DOCUMENT_ANALYSIS', 'ASR', 'EMBEDDING', 'RERANKER')
				),
				evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
				status text NOT NULL CHECK (status IN ('CERTIFIED', 'DISABLED')),
				certified_at timestamptz NOT NULL,
				imported_at timestamptz NOT NULL,
				PRIMARY KEY (provider_id, region, model_id, route_policy_version, capability)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS provider_route_preferences (
				owner_user_id text NOT NULL,
				capability text NOT NULL CHECK (
					capability IN ('DECISION_TEXT', 'VISION', 'DOCUMENT_ANALYSIS', 'ASR', 'EMBEDDING', 'RERANKER')
				),
				route_kind text NOT NULL CHECK (route_kind IN ('USER_BYOK', 'PLATFORM')),
				local_fallback_enabled boolean NOT NULL,
				confirmed_at timestamptz NOT NULL,
				updated_at timestamptz NOT NULL,
				PRIMARY KEY (owner_user_id, capability)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS provider_text_egress_consents (
				owner_user_id text NOT NULL,
				provider_id text NOT NULL,
				region text NOT NULL,
				data_class text NOT NULL CHECK (
					data_class IN ('MINIMIZED_REQUIREMENT', 'PUBLIC_EVIDENCE')
				),
				status text NOT NULL CHECK (status IN ('GRANTED', 'REVOKED')),
				updated_at timestamptz NOT NULL,
				PRIMARY KEY (owner_user_id, provider_id, region, data_class)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS platform_provider_limits (
				limit_scope text NOT NULL CHECK (limit_scope IN ('GLOBAL', 'DEFAULT_USER', 'USER')),
				subject_user_id text NOT NULL,
				capability text NOT NULL CHECK (
					capability IN ('DECISION_TEXT', 'VISION', 'DOCUMENT_ANALYSIS', 'ASR', 'EMBEDDING', 'RERANKER')
				),
				provider_id text NOT NULL,
				model_id text NOT NULL,
				budget jsonb NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
				updated_by_user_id text NOT NULL,
				updated_at timestamptz NOT NULL,
				PRIMARY KEY (limit_scope, subject_user_id, capability, provider_id, model_id)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS platform_provider_usage (
				usage_id uuid PRIMARY KEY,
				owner_user_id text NOT NULL,
				request_id text NOT NULL,
				decision_task_id text NOT NULL,
				agent_run_id text NOT NULL,
				capability text NOT NULL CHECK (
					capability IN ('DECISION_TEXT', 'VISION', 'DOCUMENT_ANALYSIS', 'ASR', 'EMBEDDING', 'RERANKER')
				),
				provider_id text NOT NULL,
				model_id text NOT NULL,
				status text NOT NULL CHECK (
					status IN ('RESERVED', 'SETTLED', 'UNCONFIRMED', 'RELEASED')
				),
				reserved_budget jsonb NOT NULL CHECK (jsonb_typeof(reserved_budget) = 'object'),
				actual_usage jsonb CHECK (
					actual_usage IS NULL OR jsonb_typeof(actual_usage) = 'object'
				),
				created_at timestamptz NOT NULL,
				updated_at timestamptz NOT NULL,
				UNIQUE (owner_user_id, request_id)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS provider_route_requests (
				owner_user_id text NOT NULL,
				request_id text NOT NULL,
				decision_task_id text NOT NULL,
				agent_run_id text NOT NULL,
				capability text NOT NULL CHECK (
					capability IN ('DECISION_TEXT', 'VISION', 'DOCUMENT_ANALYSIS', 'ASR', 'EMBEDDING', 'RERANKER')
				),
				fallback_used boolean NOT NULL,
				created_at timestamptz NOT NULL,
				updated_at timestamptz NOT NULL,
				PRIMARY KEY (owner_user_id, request_id)
			)
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS provider_route_decisions (
				decision_id uuid PRIMARY KEY,
				owner_user_id text NOT NULL,
				request_id text NOT NULL,
				decision_task_id text NOT NULL,
				agent_run_id text NOT NULL,
				capability text NOT NULL CHECK (
					capability IN ('DECISION_TEXT', 'VISION', 'DOCUMENT_ANALYSIS', 'ASR', 'EMBEDDING', 'RERANKER')
				),
				primary_provider_id text NOT NULL,
				primary_region text NOT NULL,
				primary_model_id text NOT NULL,
				final_provider_id text NOT NULL,
				final_region text NOT NULL,
				final_model_id text NOT NULL,
				final_status text NOT NULL CHECK (final_status IN ('COMPLETED', 'FAILED', 'PAUSED')),
				final_code text,
				fallback_used boolean NOT NULL,
				fallback_reason text,
				created_at timestamptz NOT NULL,
				UNIQUE (owner_user_id, request_id)
			)
		`);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
