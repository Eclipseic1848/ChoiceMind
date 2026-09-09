import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
	type Memory,
	openPostgresMemory as openMemory,
	type ProposeMemoryChangesCommand,
} from "../../src/index.js";

const sourceVerifier = {
	async verifyUserMessage({ source }: { source: { userExcerpt: string } }) {
		return source.userExcerpt;
	},
	async conversationExists() {
		return true;
	},
};

function openPostgresMemory(
	options: Omit<Parameters<typeof openMemory>[0], "sourceVerifier">,
) {
	return openMemory({ ...options, sourceVerifier });
}

describe("Memory Interface", () => {
	let memory: Memory | undefined;

	afterEach(async () => {
		await memory?.close();
		memory = undefined;
	});

	it("keeps authorization isolated and closes Tool-assisted Memory with the main switch", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const userA = `user-memory-a-${randomUUID()}`;
		const userB = `user-memory-b-${randomUUID()}`;

		await expect(
			memory.read({ type: "GET_SETTINGS", ownerUserId: userA }),
		).resolves.toEqual({
			ownerUserId: userA,
			memoryEnabled: false,
			toolAssistedEnabled: false,
			updatedAt: null,
		});
		await expect(
			memory.execute({
				type: "SET_AUTHORIZATION",
				ownerUserId: userA,
				memoryEnabled: true,
				toolAssistedEnabled: true,
			}),
		).resolves.toMatchObject({
			ownerUserId: userA,
			memoryEnabled: true,
			toolAssistedEnabled: true,
		});
		await expect(
			memory.read({ type: "GET_SETTINGS", ownerUserId: userB }),
		).resolves.toEqual({
			ownerUserId: userB,
			memoryEnabled: false,
			toolAssistedEnabled: false,
			updatedAt: null,
		});

		await expect(
			memory.execute({
				type: "SET_AUTHORIZATION",
				ownerUserId: userA,
				memoryEnabled: false,
				toolAssistedEnabled: true,
			}),
		).resolves.toMatchObject({
			ownerUserId: userA,
			memoryEnabled: false,
			toolAssistedEnabled: false,
		});
		await expect(
			memory.read({ type: "GET_SETTINGS", ownerUserId: userA }),
		).resolves.toMatchObject({
			ownerUserId: userA,
			memoryEnabled: false,
			toolAssistedEnabled: false,
		});
	});

	it("stops before source verification when memory is disabled", async () => {
		let verificationCalls = 0;
		memory = await openMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			sourceVerifier: {
				async verifyUserMessage() {
					verificationCalls += 1;
					return undefined;
				},
				async conversationExists() {
					return true;
				},
			},
		});
		const ownerUserId = `user-memory-disabled-${randomUUID()}`;

		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: {
					sourceType: "USER_MESSAGE",
					sessionId: randomUUID(),
					messageId: randomUUID(),
					userExcerpt: "我偏好静音键盘。",
					occurredAt: "2026-08-28T12:00:00.000Z",
				},
				changes: [
					{
						key: "keyboard.noise",
						value: { valueType: "TEXT", value: "quiet" },
						statement: "偏好静音键盘",
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
				],
			}),
		).rejects.toThrowError("MEMORY_DISABLED");
		expect(verificationCalls).toBe(0);
	});

	it("gates Tool-assisted Memory and keeps inferred changes reviewable with provenance", async () => {
		let conversationAvailable = true;
		let verificationCalls = 0;
		memory = await openMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			sourceVerifier: {
				async verifyUserMessage({ source }) {
					verificationCalls += 1;
					return source.userExcerpt;
				},
				async conversationExists() {
					return conversationAvailable;
				},
			},
		});
		const ownerUserId = `user-memory-tool-assisted-${randomUUID()}`;
		const source = {
			sourceType: "TOOL_ASSISTED_CHAT" as const,
			sessionId: randomUUID(),
			messageId: randomUUID(),
			userExcerpt: "我只是看了几款鼠标和键盘，没有明确表达偏好。",
			occurredAt: "2026-08-28T12:00:00.000Z",
		};
		const changes = [
			{
				key: "mouse.weight",
				value: { valueType: "TEXT" as const, value: "light" },
				statement: "可能偏好轻量鼠标",
				sensitivity: "ORDINARY" as const,
				applicationMode: "SOFT_PREFERENCE" as const,
				inference: "BEHAVIOR_INFERRED" as const,
			},
			{
				key: "keyboard.noise",
				value: { valueType: "TEXT" as const, value: "quiet" },
				statement: "可能偏好静音键盘",
				sensitivity: "ORDINARY" as const,
				applicationMode: "SOFT_PREFERENCE" as const,
				inference: "TOOL_INFERRED" as const,
			},
		];

		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source,
				changes,
			}),
		).rejects.toThrowError("TOOL_ASSISTED_MEMORY_DISABLED");
		expect(verificationCalls).toBe(0);

		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: true,
		});
		const result = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source,
			changes,
		});
		expect(result.applied).toEqual([]);
		expect(
			result.proposals.map(({ key, reason }) => ({ key, reason })),
		).toEqual([
			{ key: "mouse.weight", reason: "BEHAVIOR_INFERRED" },
			{ key: "keyboard.noise", reason: "TOOL_INFERRED" },
		]);

		conversationAvailable = false;
		const proposals = await memory.read({
			type: "LIST_PROPOSALS",
			ownerUserId,
			status: "PENDING",
		});
		expect(
			proposals.proposals.map((proposal) => proposal.source.conversationState),
		).toEqual(["DELETED", "DELETED"]);
	});

	it("directly maintains an explicit ordinary preference with User provenance", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const ownerUserId = `user-memory-direct-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});

		const result = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "以后选显示器时，我更喜欢文字清晰的哑光屏。",
				occurredAt: "2026-08-28T12:00:00.000Z",
			},
			changes: [
				{
					key: "display.text_clarity",
					value: { valueType: "TEXT", value: "HIGH" },
					statement: "偏好文字清晰的哑光显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});

		expect(result).toMatchObject({
			applied: [
				{
					ownerUserId,
					key: "display.text_clarity",
					value: { valueType: "TEXT", value: "HIGH" },
					statement: "偏好文字清晰的哑光显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					status: "ACTIVE",
					source: {
						sourceType: "USER_MESSAGE",
						userExcerpt: "以后选显示器时，我更喜欢文字清晰的哑光屏。",
					},
				},
			],
			proposals: [],
			changes: [{ key: "display.text_clarity", changeType: "CREATED" }],
		});
		await expect(
			memory.read({ type: "LIST_ITEMS", ownerUserId }),
		).resolves.toMatchObject({
			items: [{ key: "display.text_clarity", status: "ACTIVE" }],
		});
	});

	it("routes an explicit candidate without support in the verified User Message to UNCERTAIN", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const ownerUserId = `user-memory-unsupported-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});

		const result = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我只是随便看看键盘，并没有表达具体偏好。",
				occurredAt: "2026-08-28T12:00:00.000Z",
			},
			changes: [
				{
					key: "keyboard.noise",
					value: { valueType: "TEXT", value: "quiet" },
					statement: "偏好静音键盘",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});

		expect(result.applied).toEqual([]);
		expect(result.proposals[0]).toMatchObject({
			reason: "UNCERTAIN",
			sensitivity: "ORDINARY",
		});
	});

	it("routes semantically inconsistent candidates to UNCERTAIN", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const ownerUserId = `user-memory-semantic-risk-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const cases: readonly Readonly<{
			key: string;
			statement: string;
			text: string;
			value:
				| Readonly<{ valueType: "NUMBER"; value: number }>
				| Readonly<{ valueType: "TEXT"; value: string }>;
		}>[] = [
			{
				key: "mobile.color_negated",
				statement: "偏好红色手机",
				text: "我不喜欢红色手机。",
				value: { valueType: "TEXT", value: "红色" },
			},
			{
				key: "mobile.color_reversed",
				statement: "偏好红色手机",
				text: "我以前喜欢红色手机，现在改成蓝色手机。",
				value: { valueType: "TEXT", value: "红色" },
			},
			{
				key: "mobile.color_conflict",
				statement: "偏好红色手机",
				text: "我喜欢蓝色手机。",
				value: { valueType: "TEXT", value: "红色" },
			},
			{
				key: "display.size_mismatch",
				statement: "偏好 32 英寸显示器",
				text: "我偏好 27 英寸显示器。",
				value: { valueType: "NUMBER", value: 32 },
			},
		];

		for (const [index, item] of cases.entries()) {
			const result = await memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: {
					sourceType: "USER_MESSAGE",
					sessionId: "session-semantic-risk",
					messageId: `message-semantic-risk-${index}`,
					userExcerpt: item.text,
					occurredAt: `2026-08-28T12:0${index}:00.000Z`,
				},
				changes: [
					{
						key: item.key,
						value: item.value,
						statement: item.statement,
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
				],
			});
			expect(result.applied).toEqual([]);
			expect(result.proposals).toMatchObject([
				{ key: item.key, reason: "UNCERTAIN" },
			]);
		}
		await expect(
			memory.read({ type: "LIST_ITEMS", ownerUserId }),
		).resolves.toEqual({ items: [] });
	});

	it("rejects duplicate stable keys in one untrusted change batch", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const ownerUserId = `user-memory-duplicate-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: {
					sourceType: "USER_MESSAGE",
					sessionId: randomUUID(),
					messageId: randomUUID(),
					userExcerpt: "显示器预算 5000 元，最多可以到 6000 元。",
					occurredAt: "2026-08-28T12:00:00.000Z",
				},
				changes: [
					{
						key: "budget.default",
						value: { valueType: "NUMBER", value: 5000 },
						statement: "显示器预算约 5000 元",
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
					{
						key: "budget.default",
						value: { valueType: "NUMBER", value: 6000 },
						statement: "显示器预算最多 6000 元",
						sensitivity: "ORDINARY",
						applicationMode: "CURRENT_CONFIRMATION_REQUIRED",
						inference: "EXPLICIT",
					},
				],
			}),
		).rejects.toThrowError("MEMORY_CHANGES_INVALID");
		await expect(
			memory.read({ type: "LIST_ITEMS", ownerUserId }),
		).resolves.toEqual({ items: [] });
	});

	it("enforces MemoryValue bounds at the Module boundary", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const ownerUserId = `user-memory-value-bounds-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const source = {
			sourceType: "USER_MESSAGE" as const,
			sessionId: randomUUID(),
			messageId: randomUUID(),
			userExcerpt: "我偏好静音键盘。",
			occurredAt: "2026-08-28T12:00:00.000Z",
		};

		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source,
				changes: [
					{
						key: "keyboard.notes",
						value: { valueType: "TEXT", value: "x".repeat(2_001) },
						statement: "偏好静音键盘",
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
				],
			}),
		).rejects.toThrowError("MEMORY_CHANGE_INVALID");

		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: { ...source, messageId: randomUUID() },
				changes: [
					{
						key: "keyboard.features",
						value: {
							valueType: "TEXT_SET",
							value: Array.from(
								{ length: 21 },
								(_, index) => `feature-${index}`,
							),
						},
						statement: "偏好这些键盘功能",
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
				],
			}),
		).rejects.toThrowError("MEMORY_CHANGE_INVALID");
	});

	it("routes sensitive and inferred changes through User-reviewed Proposals", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const ownerUserId = `user-memory-proposal-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: true,
		});
		const source = {
			sourceType: "USER_MESSAGE" as const,
			sessionId: randomUUID(),
			messageId: randomUUID(),
			userExcerpt: "我怀孕了，选家具时希望尽量低气味。",
			occurredAt: "2026-08-28T12:00:00.000Z",
		};

		const proposed = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source,
			changes: [
				{
					key: "health.pregnancy.low_odor",
					value: { valueType: "BOOLEAN", value: true },
					statement: "孕期选购家具时偏好低气味",
					sensitivity: "ORDINARY",
					applicationMode: "CURRENT_CONFIRMATION_REQUIRED",
					inference: "EXPLICIT",
				},
			],
		});

		expect(proposed).toMatchObject({
			applied: [],
			proposals: [
				{
					ownerUserId,
					key: "health.pregnancy.low_odor",
					reason: "SENSITIVE",
					status: "PENDING",
					source,
				},
			],
			changes: [],
		});
		const addressProposal = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "我住在北京市朝阳区望京街道 1 号。",
			},
			changes: [
				{
					key: "profile.home_location",
					value: { valueType: "TEXT", value: "北京市朝阳区望京街道 1 号" },
					statement: "我住在北京市朝阳区望京街道 1 号",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		expect(addressProposal.proposals[0]).toMatchObject({
			key: "profile.home_location",
			reason: "SENSITIVE",
			sensitivity: "SENSITIVE",
		});
		const unknownSensitiveWording = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "我喜欢佛教。",
			},
			changes: [
				{
					key: "profile.faith",
					value: { valueType: "TEXT", value: "佛教" },
					statement: "我喜欢佛教",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		expect(unknownSensitiveWording.applied).toEqual([]);
		expect(unknownSensitiveWording.proposals[0]).toMatchObject({
			reason: "SENSITIVE",
			sensitivity: "SENSITIVE",
		});
		const unknownOrdinaryWording = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "我选机械轴。",
			},
			changes: [
				{
					key: "keyboard.switch_type",
					value: { valueType: "TEXT", value: "机械轴" },
					statement: "偏好机械轴",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		expect(unknownOrdinaryWording.applied).toEqual([]);
		expect(unknownOrdinaryWording.proposals[0]).toMatchObject({
			reason: "UNCERTAIN",
			sensitivity: "ORDINARY",
		});
		const sensitiveSourceWithOrdinarySummary = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "我患有糖尿病，所以选显示器时需要更护眼。",
			},
			changes: [
				{
					key: "display.eye_comfort",
					value: { valueType: "BOOLEAN", value: true },
					statement: "偏好护眼显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		expect(sensitiveSourceWithOrdinarySummary.applied).toEqual([]);
		expect(sensitiveSourceWithOrdinarySummary.proposals[0]).toMatchObject({
			reason: "SENSITIVE",
			sensitivity: "SENSITIVE",
		});
		const mixedHealthAndConsumerSource = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "我有高血压，买食品时偏好低钠食品。",
			},
			changes: [
				{
					key: "food.sodium_preference",
					value: { valueType: "TEXT", value: "低钠" },
					statement: "偏好低钠食品",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		expect(mixedHealthAndConsumerSource.applied).toEqual([]);
		expect(mixedHealthAndConsumerSource.proposals[0]).toMatchObject({
			reason: "SENSITIVE",
			sensitivity: "SENSITIVE",
		});
		const mixedPoliticalAndConsumerSource = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "作为党员，我喜欢国产手机。",
			},
			changes: [
				{
					key: "mobile.brand_domestic",
					value: { valueType: "BOOLEAN", value: true },
					statement: "偏好国产手机",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		expect(mixedPoliticalAndConsumerSource.applied).toEqual([]);
		expect(mixedPoliticalAndConsumerSource.proposals[0]).toMatchObject({
			reason: "SENSITIVE",
			sensitivity: "SENSITIVE",
		});
		const mixedFaithAndConsumerSource = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "我信奉锡克教，所以买食品时只选清真认证产品。",
			},
			changes: [
				{
					key: "food.certification_preference",
					value: { valueType: "TEXT", value: "清真认证" },
					statement: "偏好清真认证食品",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		expect(mixedFaithAndConsumerSource.applied).toEqual([]);
		expect(mixedFaithAndConsumerSource.proposals[0]).toMatchObject({
			reason: "SENSITIVE",
			sensitivity: "SENSITIVE",
		});
		const ambiguousIdentityAndConsumerSource = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "作为摄影师，我喜欢国产手机。",
				occurredAt: "2026-08-28T12:01:00.000Z",
			},
			changes: [
				{
					key: "mobile.brand_domestic",
					value: { valueType: "BOOLEAN", value: true },
					statement: "偏好国产手机",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		expect(ambiguousIdentityAndConsumerSource.applied).toEqual([]);
		expect(ambiguousIdentityAndConsumerSource.proposals[0]).toMatchObject({
			reason: "UNCERTAIN",
			sensitivity: "ORDINARY",
		});
		for (const [index, sensitiveText] of [
			"我的微信号是 alice_2026。",
			"I live at 123 Main Street, Springfield.",
			"我女儿买显示器时偏好大屏幕。",
			"我儿子选键盘时偏好静音键盘。",
			"给宝宝买耳机时偏好轻量款。",
			"我有近视，买显示器时偏好护眼屏。",
			"我感染 HIV，买手机时偏好大屏幕手机。",
			"我感染了艾滋病毒，买手机时偏好大屏幕手机。",
		].entries()) {
			const unrecognizedSensitive = await memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: {
					...source,
					messageId: randomUUID(),
					userExcerpt: sensitiveText,
				},
				changes: [
					{
						key: `product.preference_${index}`,
						value: { valueType: "TEXT", value: sensitiveText },
						statement: sensitiveText,
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
				],
			});
			expect(unrecognizedSensitive.applied).toEqual([]);
			expect(unrecognizedSensitive.proposals[0]).toMatchObject({
				reason: "SENSITIVE",
				sensitivity: "SENSITIVE",
			});
		}
		const proposal = proposed.proposals[0];
		expect(proposal).toBeDefined();
		if (proposal === undefined) throw new Error("测试 Proposal 缺失");

		await expect(
			memory.execute({
				type: "REVIEW_PROPOSAL",
				requestId: randomUUID(),
				ownerUserId: `user-memory-foreign-${randomUUID()}`,
				proposalId: proposal.proposalId,
				decision: "ACCEPT",
			}),
		).rejects.toThrowError("MEMORY_PROPOSAL_NOT_FOUND");
		const reviewCommand = {
			type: "REVIEW_PROPOSAL" as const,
			requestId: randomUUID(),
			ownerUserId,
			proposalId: proposal.proposalId,
			decision: "ACCEPT" as const,
		};
		const accepted = await memory.execute(reviewCommand);
		expect(accepted).toMatchObject({
			proposal: { proposalId: proposal.proposalId, status: "ACCEPTED" },
			item: {
				key: "health.pregnancy.low_odor",
				sensitivity: "SENSITIVE",
				applicationMode: "CURRENT_CONFIRMATION_REQUIRED",
				status: "ACTIVE",
			},
		});
		await expect(memory.execute(reviewCommand)).resolves.toEqual(accepted);
		expect(accepted.item).toBeDefined();
		if (accepted.item === undefined)
			throw new Error("测试敏感 Memory Item 缺失");
		await expect(
			memory.execute({
				type: "EDIT_ITEM",
				requestId: randomUUID(),
				ownerUserId,
				memoryId: accepted.item.memoryId,
				value: accepted.item.value,
				statement: accepted.item.statement,
				applicationMode: accepted.item.applicationMode,
			}),
		).rejects.toThrowError("MEMORY_EDIT_REQUIRES_PROPOSAL");
	});

	it("classifies the verified full User Message before persisting a bounded excerpt", async () => {
		const fullUserText = `${"普通消费说明".repeat(35)}我有高血压，买食品时偏好低钠食品。`;
		const storedExcerpt = fullUserText.slice(0, 200);
		expect(storedExcerpt).not.toContain("高血压");
		memory = await openMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			sourceVerifier: {
				async verifyUserMessage() {
					return fullUserText;
				},
				async conversationExists() {
					return true;
				},
			},
		});
		const ownerUserId = `user-memory-long-sensitive-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});

		const result = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: storedExcerpt,
				occurredAt: "2026-08-28T12:00:00.000Z",
			},
			changes: [
				{
					key: "food.sodium_preference",
					value: { valueType: "TEXT", value: "低钠" },
					statement: "偏好低钠食品",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});

		expect(result.applied).toEqual([]);
		expect(result.proposals[0]).toMatchObject({
			reason: "SENSITIVE",
			sensitivity: "SENSITIVE",
			source: { userExcerpt: storedExcerpt },
		});
	});

	it("starts the accepted Proposal lifecycle from the actual review time", async () => {
		let currentTime = new Date("2026-12-31T00:00:00.000Z");
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => currentTime,
		});
		const ownerUserId = `user-memory-proposal-review-time-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const proposed = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我有乳胶过敏，选手套时需要避开乳胶。",
				occurredAt: "2026-12-30T00:00:00.000Z",
			},
			changes: [
				{
					key: "health.latex_allergy",
					value: { valueType: "BOOLEAN", value: true },
					statement: "选择手套时需要避开乳胶",
					sensitivity: "SENSITIVE",
					applicationMode: "CURRENT_CONFIRMATION_REQUIRED",
					inference: "EXPLICIT",
				},
			],
		});
		const proposal = proposed.proposals[0];
		if (proposal === undefined) throw new Error("测试 Proposal 缺失");

		currentTime = new Date("2027-01-01T00:00:00.000Z");
		const reviewed = await memory.execute({
			type: "REVIEW_PROPOSAL",
			requestId: randomUUID(),
			ownerUserId,
			proposalId: proposal.proposalId,
			decision: "ACCEPT",
		});

		expect(reviewed.item).toMatchObject({
			lastConfirmedAt: "2027-01-01T00:00:00.000Z",
			reviewAt: "2027-06-30T00:00:00.000Z",
		});
	});

	it("rejects an expired explicit reviewAt when a Proposal is accepted later", async () => {
		let currentTime = new Date("2027-01-01T00:00:00.000Z");
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => currentTime,
		});
		const ownerUserId = `user-memory-expired-proposal-review-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const proposed = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我有近视，买显示器时偏好护眼屏。",
				occurredAt: "2026-12-31T00:00:00.000Z",
			},
			changes: [
				{
					key: "display.eye_comfort",
					value: { valueType: "BOOLEAN", value: true },
					statement: "偏好护眼显示器",
					sensitivity: "SENSITIVE",
					applicationMode: "CURRENT_CONFIRMATION_REQUIRED",
					inference: "EXPLICIT",
					reviewAt: "2027-01-02T00:00:00.000Z",
				},
			],
		});
		const proposal = proposed.proposals[0];
		if (proposal === undefined) throw new Error("测试 Proposal 缺失");
		currentTime = new Date("2027-01-03T00:00:00.000Z");

		await expect(
			memory.execute({
				type: "REVIEW_PROPOSAL",
				requestId: randomUUID(),
				ownerUserId,
				proposalId: proposal.proposalId,
				decision: "ACCEPT",
			}),
		).rejects.toThrowError("MEMORY_REVIEW_AT_INVALID");
		expect(
			(await memory.read({ type: "LIST_PROPOSALS", ownerUserId })).proposals[0],
		).toMatchObject({ status: "PENDING" });
		await expect(
			memory.read({ type: "LIST_ITEMS", ownerUserId }),
		).resolves.toEqual({ items: [] });
	});

	it("refuses an older Proposal after a newer value for the same key is active", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const ownerUserId = `user-memory-stale-proposal-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const proposed = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: "session-stale-proposal",
				messageId: "message-stale-proposal",
				userExcerpt: "我可能偏好 27 英寸显示器。",
				occurredAt: "2026-08-28T10:00:00.000Z",
			},
			changes: [
				{
					key: "display.size_preference",
					value: { valueType: "NUMBER", value: 27 },
					statement: "可能偏好 27 英寸显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "UNCERTAIN",
				},
			],
		});
		const proposal = proposed.proposals[0];
		if (proposal === undefined) throw new Error("测试 Proposal 缺失");
		await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: "session-stale-proposal",
				messageId: "message-current-item",
				userExcerpt: "我偏好 32 英寸显示器。",
				occurredAt: "2026-08-28T11:00:00.000Z",
			},
			changes: [
				{
					key: "display.size_preference",
					value: { valueType: "NUMBER", value: 32 },
					statement: "偏好 32 英寸显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});

		await expect(
			memory.execute({
				type: "REVIEW_PROPOSAL",
				requestId: randomUUID(),
				ownerUserId,
				proposalId: proposal.proposalId,
				decision: "ACCEPT",
			}),
		).rejects.toThrowError("MEMORY_PROPOSAL_STALE");
		expect(
			(await memory.read({ type: "LIST_ITEMS", ownerUserId })).items[0],
		).toMatchObject({ statement: "偏好 32 英寸显示器", status: "ACTIVE" });
		expect(
			(await memory.read({ type: "LIST_PROPOSALS", ownerUserId })).proposals[0],
		).toMatchObject({
			proposalId: proposal.proposalId,
			status: "REJECTED",
			reviewedAt: expect.any(String),
		});
		await expect(
			memory.read({ type: "LIST_PROPOSALS", ownerUserId, status: "PENDING" }),
		).resolves.toEqual({ proposals: [] });
	});

	it("replays the same change request exactly once and preserves replacement history", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2026-08-30T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-idempotent-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const firstCommand = {
			type: "PROPOSE_CHANGES" as const,
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE" as const,
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我偏好 27 英寸显示器。",
				occurredAt: "2026-08-28T12:00:00.000Z",
			},
			changes: [
				{
					key: "display.size_preference",
					value: { valueType: "NUMBER" as const, value: 27 },
					statement: "偏好 27 英寸显示器",
					sensitivity: "ORDINARY" as const,
					applicationMode: "SOFT_PREFERENCE" as const,
					inference: "EXPLICIT" as const,
				},
			],
		};

		const first = await memory.execute(firstCommand);
		await expect(memory.execute(firstCommand)).resolves.toEqual(first);
		const secondCommand: ProposeMemoryChangesCommand = {
			...firstCommand,
			requestId: randomUUID(),
			source: {
				...firstCommand.source,
				messageId: randomUUID(),
				userExcerpt: "现在我更想要 32 英寸显示器。",
				occurredAt: "2026-08-29T12:00:00.000Z",
			},
			changes: [
				{
					key: "display.size_preference",
					value: { valueType: "NUMBER", value: 32 } as const,
					statement: "偏好 32 英寸显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		};
		const second = await memory.execute(secondCommand);
		expect(second.changes).toEqual([
			{
				key: "display.size_preference",
				changeType: "REPLACED",
				previousStatement: "偏好 27 英寸显示器",
				statement: "偏好 32 英寸显示器",
			},
		]);

		const listed = await memory.read({ type: "LIST_ITEMS", ownerUserId });
		expect(listed.items).toHaveLength(2);
		expect(listed.items.map((item) => item.status).sort()).toEqual([
			"ACTIVE",
			"SUPERSEDED",
		]);
	});

	it("does not let an older message overwrite a newer value for the same key", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2026-08-30T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-order-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const change = (value: number) => ({
			key: "display.size_preference",
			value: { valueType: "NUMBER" as const, value },
			statement: `偏好 ${value} 英寸显示器`,
			sensitivity: "ORDINARY" as const,
			applicationMode: "SOFT_PREFERENCE" as const,
			inference: "EXPLICIT" as const,
		});
		const newer = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: "session-order",
				messageId: "message-newer",
				userExcerpt: "现在我偏好 32 英寸显示器。",
				occurredAt: "2026-08-29T12:00:00.000Z",
			},
			changes: [change(32)],
		});

		expect(newer.applied).toHaveLength(1);
		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: {
					sourceType: "USER_MESSAGE",
					sessionId: "session-order",
					messageId: "message-older",
					userExcerpt: "之前我偏好 27 英寸显示器。",
					occurredAt: "2026-08-29T12:00:00.000Z",
				},
				changes: [change(27)],
			}),
		).rejects.toThrowError("MEMORY_SOURCE_ORDER_AMBIGUOUS");
		const active = (
			await memory.read({ type: "LIST_ITEMS", ownerUserId })
		).items.filter((item) => item.status === "ACTIVE");
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			statement: "偏好 32 英寸显示器",
			source: { messageId: "message-newer" },
		});
	});

	it("does not let an older sensitive message create a proposal for a newer key", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2026-08-30T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-proposal-order-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: "session-proposal-order",
				messageId: "message-newer",
				userExcerpt: "现在我偏好 32 英寸显示器。",
				occurredAt: "2026-08-29T12:01:00.000Z",
			},
			changes: [
				{
					key: "display.size_preference",
					value: { valueType: "NUMBER", value: 32 },
					statement: "偏好 32 英寸显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});

		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: {
					sourceType: "USER_MESSAGE",
					sessionId: "session-proposal-order",
					messageId: "message-older-sensitive",
					userExcerpt: "我感染 HIV，之前偏好 27 英寸显示器。",
					occurredAt: "2026-08-29T12:00:00.000Z",
				},
				changes: [
					{
						key: "display.size_preference",
						value: { valueType: "NUMBER", value: 27 },
						statement: "偏好 27 英寸显示器",
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
				],
			}),
		).resolves.toEqual({ applied: [], proposals: [], changes: [] });
		await expect(
			memory.read({
				type: "LIST_PROPOSALS",
				ownerUserId,
				status: "PENDING",
			}),
		).resolves.toEqual({ proposals: [] });
		await expect(
			memory.read({ type: "LIST_ITEMS", ownerUserId }),
		).resolves.toMatchObject({
			items: [{ statement: "偏好 32 英寸显示器", status: "ACTIVE" }],
		});
	});

	it("does not let an older direct change overtake a newer proposal", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2026-08-30T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-proposal-waterline-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: "session-proposal-waterline",
				messageId: "message-newer-proposal",
				userExcerpt: "我可能更偏好 32 英寸显示器。",
				occurredAt: "2026-08-29T12:01:00.000Z",
			},
			changes: [
				{
					key: "display.size_preference",
					value: { valueType: "NUMBER", value: 32 },
					statement: "可能偏好 32 英寸显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "UNCERTAIN",
				},
			],
		});

		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: {
					sourceType: "USER_MESSAGE",
					sessionId: "session-proposal-waterline",
					messageId: "message-older-direct",
					userExcerpt: "之前我偏好 27 英寸显示器。",
					occurredAt: "2026-08-29T12:00:00.000Z",
				},
				changes: [
					{
						key: "display.size_preference",
						value: { valueType: "NUMBER", value: 27 },
						statement: "偏好 27 英寸显示器",
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
				],
			}),
		).resolves.toEqual({ applied: [], proposals: [], changes: [] });
		await expect(
			memory.read({ type: "LIST_ITEMS", ownerUserId }),
		).resolves.toEqual({ items: [] });
		await expect(
			memory.read({
				type: "LIST_PROPOSALS",
				ownerUserId,
				status: "PENDING",
			}),
		).resolves.toMatchObject({
			proposals: [{ source: { messageId: "message-newer-proposal" } }],
		});
	});

	it("fails closed when proposals for the same key share a timestamp", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2026-08-30T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-proposal-tie-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const proposal = (messageId: string, value: number) => ({
			type: "PROPOSE_CHANGES" as const,
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE" as const,
				sessionId: "session-proposal-tie",
				messageId,
				userExcerpt: `我可能偏好 ${value} 英寸显示器。`,
				occurredAt: "2026-08-29T12:00:00.000Z",
			},
			changes: [
				{
					key: "display.size_preference",
					value: { valueType: "NUMBER" as const, value },
					statement: `可能偏好 ${value} 英寸显示器`,
					sensitivity: "ORDINARY" as const,
					applicationMode: "SOFT_PREFERENCE" as const,
					inference: "UNCERTAIN" as const,
				},
			],
		});
		await memory.execute(proposal("message-proposal-a", 27));

		await expect(
			memory.execute(proposal("message-proposal-b", 32)),
		).rejects.toThrowError("MEMORY_SOURCE_ORDER_AMBIGUOUS");
		await expect(
			memory.read({
				type: "LIST_PROPOSALS",
				ownerUserId,
				status: "PENDING",
			}),
		).resolves.toMatchObject({
			proposals: [{ source: { messageId: "message-proposal-a" } }],
		});
	});

	it("replays a committed proposal result through the public query after restart", async () => {
		const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
		memory = await openPostgresMemory({ databaseUrl });
		const ownerUserId = `user-memory-result-replay-${randomUUID()}`;
		const requestId = `conversation-memory:${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const written = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId,
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我喜欢静音键盘。",
				occurredAt: "2026-08-29T00:00:00.000Z",
			},
			changes: [
				{
					key: "keyboard.noise",
					value: { valueType: "TEXT", value: "quiet" },
					statement: "偏好静音键盘",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		await memory.close();
		memory = await openPostgresMemory({ databaseUrl });

		await expect(
			memory.read({ type: "GET_CHANGE_RESULT", ownerUserId, requestId }),
		).resolves.toEqual(written);
		await expect(
			memory.read({
				type: "GET_CHANGE_RESULT",
				ownerUserId: `${ownerUserId}-other`,
				requestId,
			}),
		).resolves.toBeUndefined();
		await expect(
			memory.read({
				type: "GET_CHANGE_RESULT",
				ownerUserId,
				requestId: `${requestId}-missing`,
			}),
		).resolves.toBeUndefined();
		const item = written.applied[0];
		if (item === undefined) throw new Error("测试 Memory Item 缺失");
		await memory.execute({
			type: "DELETE_ITEM",
			requestId: randomUUID(),
			ownerUserId,
			memoryId: item.memoryId,
		});
		await expect(
			memory.read({ type: "GET_CHANGE_RESULT", ownerUserId, requestId }),
		).rejects.toThrowError("MEMORY_REQUEST_RETIRED");
	});

	it("selects a hard-bounded projection and separates current confirmation", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2027-01-01T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-projection-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: `这些是我选择显示器时的长期偏好：${Array.from(
					{ length: 11 },
					(_, index) => `显示器偏好 ${index}`,
				).join("、")}。`,
				occurredAt: "2026-12-01T00:00:00.000Z",
			},
			changes: Array.from({ length: 11 }, (_, index) => ({
				key: `display.preference_${index}`,
				value: { valueType: "NUMBER" as const, value: index },
				statement: `显示器偏好 ${index}`,
				sensitivity: "ORDINARY" as const,
				applicationMode:
					index === 0
						? ("CURRENT_CONFIRMATION_REQUIRED" as const)
						: ("SOFT_PREFERENCE" as const),
				inference: "EXPLICIT" as const,
			})),
		});

		const projection = await memory.read({
			type: "SELECT_RELEVANT",
			ownerUserId,
			query: "帮我选择一台显示器",
			limit: 100,
		});
		expect(
			projection.applied.length + projection.confirmationRequired.length,
		).toBe(10);
		expect(projection.confirmationRequired).toHaveLength(1);
		expect(projection.confirmationRequired[0]).toMatchObject({
			key: "display.preference_0",
			applicationMode: "CURRENT_CONFIRMATION_REQUIRED",
		});
		expect(JSON.stringify(projection).length).toBeLessThanOrEqual(4_000);
		expect(JSON.stringify(projection)).not.toContain("Evidence");

		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: false,
			toolAssistedEnabled: false,
		});
		await expect(
			memory.read({
				type: "SELECT_RELEVANT",
				ownerUserId,
				query: "显示器",
				limit: 10,
			}),
		).resolves.toEqual({
			applied: [],
			confirmationRequired: [],
			reviewRequired: [],
		});
	});

	it("moves expired relevant memory to review without applying it", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2027-01-01T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-lifecycle-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我喜欢静音键盘。",
				occurredAt: "2026-06-01T00:00:00.000Z",
			},
			changes: [
				{
					key: "keyboard.noise",
					value: { valueType: "TEXT", value: "quiet" },
					statement: "偏好静音键盘",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});

		const first = await memory.read({
			type: "SELECT_RELEVANT",
			ownerUserId,
			query: "推荐静音键盘",
			limit: 10,
		});
		expect(first.applied).toEqual([]);
		expect(first.reviewRequired).toHaveLength(1);
		expect(
			(await memory.read({ type: "LIST_ITEMS", ownerUserId })).items[0]?.status,
		).toBe("NEEDS_REVIEW");
		const refreshed = await memory.read({
			type: "SELECT_RELEVANT",
			ownerUserId,
			query: "推荐静音键盘",
			limit: 10,
		});
		expect(refreshed.applied).toEqual([]);
		expect(refreshed.confirmationRequired).toEqual([]);
		expect(refreshed.reviewRequired).toEqual(first.reviewRequired);

		const expiredItem = (await memory.read({ type: "LIST_ITEMS", ownerUserId }))
			.items[0];
		expect(expiredItem).toBeDefined();
		if (expiredItem === undefined) throw new Error("测试过期 Memory Item 缺失");
		const reviewed = await memory.execute({
			type: "EDIT_ITEM",
			requestId: randomUUID(),
			ownerUserId,
			memoryId: expiredItem.memoryId,
			value: expiredItem.value,
			statement: expiredItem.statement,
			applicationMode: expiredItem.applicationMode,
		});
		expect(reviewed.item).toMatchObject({
			status: "ACTIVE",
			key: "keyboard.noise",
		});
	});

	it("only retires expired items returned in the bounded review projection", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2028-01-01T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-review-bound-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: `这些是我的显示器偏好：${Array.from(
					{ length: 11 },
					(_, index) => `显示器偏好 ${index}`,
				).join("、")}。`,
				occurredAt: "2027-01-01T00:00:00.000Z",
			},
			changes: Array.from({ length: 11 }, (_, index) => ({
				key: `display.expired_${index}`,
				value: { valueType: "NUMBER" as const, value: index },
				statement: `显示器偏好 ${index}`,
				sensitivity: "ORDINARY" as const,
				applicationMode: "SOFT_PREFERENCE" as const,
				inference: "EXPLICIT" as const,
			})),
		});

		const projection = await memory.read({
			type: "SELECT_RELEVANT",
			ownerUserId,
			query: "显示器",
			limit: 100,
		});
		expect(projection.reviewRequired).toHaveLength(10);
		const statuses = (
			await memory.read({ type: "LIST_ITEMS", ownerUserId })
		).items.map((item) => item.status);
		expect(statuses.filter((status) => status === "NEEDS_REVIEW")).toHaveLength(
			10,
		);
		expect(statuses.filter((status) => status === "ACTIVE")).toHaveLength(1);
	});

	it("edits, exports and deletes one stable key without crossing User boundaries", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2027-02-01T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-manage-${randomUUID()}`;
		const otherUserId = `user-memory-other-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId: otherUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const source = {
			sourceType: "USER_MESSAGE" as const,
			sessionId: randomUUID(),
			messageId: randomUUID(),
			userExcerpt: "我平时喜欢低调的深色键盘。",
			occurredAt: "2027-01-20T00:00:00.000Z",
		};
		const createCommand: ProposeMemoryChangesCommand = {
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source,
			changes: [
				{
					key: "keyboard.color",
					value: { valueType: "TEXT", value: "dark" },
					statement: "偏好深色键盘",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		};
		const created = await memory.execute(createCommand);
		const sensitiveSource = {
			...source,
			messageId: randomUUID(),
			userExcerpt: "我的联系邮箱是 private@example.com。",
		};
		await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: sensitiveSource,
			changes: [
				{
					key: "identity.contact.email",
					value: { valueType: "TEXT", value: "private@example.com" },
					statement: "联系邮箱是 private@example.com",
					sensitivity: "ORDINARY",
					applicationMode: "CURRENT_CONFIRMATION_REQUIRED",
					inference: "EXPLICIT",
				},
			],
		});
		const original = created.applied[0];
		expect(original).toBeDefined();
		if (original === undefined) throw new Error("测试 Memory Item 缺失");

		await expect(
			memory.execute({
				type: "EDIT_ITEM",
				requestId: randomUUID(),
				ownerUserId: otherUserId,
				memoryId: original.memoryId,
				value: { valueType: "TEXT", value: "light" },
				statement: "偏好浅色键盘",
				applicationMode: "SOFT_PREFERENCE",
			}),
		).rejects.toThrowError("MEMORY_ITEM_NOT_FOUND");
		await expect(
			memory.execute({
				type: "EDIT_ITEM",
				requestId: randomUUID(),
				ownerUserId,
				memoryId: original.memoryId,
				value: { valueType: "TEXT", value: "糖尿病" },
				statement: "我的健康状况是糖尿病",
				applicationMode: "SOFT_PREFERENCE",
			}),
		).rejects.toThrowError("MEMORY_EDIT_REQUIRES_PROPOSAL");
		const edited = await memory.execute({
			type: "EDIT_ITEM",
			requestId: randomUUID(),
			ownerUserId,
			memoryId: original.memoryId,
			value: { valueType: "TEXT", value: "charcoal" },
			statement: "偏好炭黑色键盘",
			applicationMode: "SOFT_PREFERENCE",
		});
		expect(edited.item).toMatchObject({
			key: "keyboard.color",
			statement: "偏好炭黑色键盘",
			status: "ACTIVE",
			supersedesMemoryId: original.memoryId,
		});
		const firstItemPage = await memory.read({
			type: "LIST_ITEMS",
			ownerUserId,
			limit: 1,
		});
		expect(firstItemPage.items).toHaveLength(1);
		expect(firstItemPage.items[0]?.memoryId).toBe(edited.item.memoryId);
		expect(firstItemPage.nextCursor).toBe("1");
		if (firstItemPage.nextCursor === undefined) {
			throw new Error("测试分页 Cursor 缺失");
		}
		const secondItemPage = await memory.read({
			type: "LIST_ITEMS",
			ownerUserId,
			limit: 1,
			cursor: firstItemPage.nextCursor,
		});
		expect(secondItemPage.items).toHaveLength(1);
		expect(secondItemPage.items[0]?.memoryId).toBe(original.memoryId);
		expect(secondItemPage.nextCursor).toBeUndefined();
		const currentItemPage = await memory.read({
			type: "LIST_ITEMS",
			ownerUserId,
			currentOnly: true,
			limit: 1,
		});
		expect(currentItemPage.items.map((item) => item.memoryId)).toEqual([
			edited.item.memoryId,
		]);
		expect(currentItemPage.nextCursor).toBeUndefined();
		const itemVersions = await memory.read({
			type: "LIST_ITEMS",
			ownerUserId,
			keys: [edited.item.key],
		});
		expect(itemVersions.items.map((item) => item.memoryId)).toEqual([
			edited.item.memoryId,
			original.memoryId,
		]);
		const searchedItemPage = await memory.read({
			type: "LIST_ITEMS",
			ownerUserId,
			limit: 1,
			search: "偏好深色",
		});
		expect(searchedItemPage.items).toHaveLength(1);
		expect(searchedItemPage.items[0]?.memoryId).toBe(original.memoryId);
		expect(searchedItemPage.nextCursor).toBeUndefined();
		await expect(
			memory.read({
				type: "LIST_ITEMS",
				ownerUserId,
				limit: 101,
			}),
		).rejects.toThrowError("MEMORY_LIST_LIMIT_INVALID");

		const exported = await memory.read({ type: "EXPORT", ownerUserId });
		expect(exported).toMatchObject({
			schemaVersion: 1,
			authorization: { ownerUserId },
		});
		expect(exported.items).toHaveLength(2);
		expect(exported.proposals).toHaveLength(1);
		await expect(
			memory.read({
				type: "LIST_PROPOSALS",
				ownerUserId,
				limit: 1,
				sessionId: sensitiveSource.sessionId,
				status: "PENDING",
			}),
		).resolves.toMatchObject({
			proposals: [{ source: { sessionId: sensitiveSource.sessionId } }],
		});
		await expect(
			memory.read({
				type: "LIST_PROPOSALS",
				ownerUserId,
				sessionId: randomUUID(),
				status: "PENDING",
			}),
		).resolves.toEqual({ proposals: [] });
		expect(JSON.stringify(exported)).toContain(source.userExcerpt);
		expect(JSON.stringify(exported)).toContain(sensitiveSource.userExcerpt);
		expect(
			JSON.stringify(
				await memory.read({ type: "EXPORT", ownerUserId: otherUserId }),
			),
		).not.toContain(source.userExcerpt);

		await memory.execute({
			type: "DELETE_ITEM",
			requestId: randomUUID(),
			ownerUserId,
			memoryId: edited.item.memoryId,
		});
		expect(
			(await memory.read({ type: "LIST_ITEMS", ownerUserId })).items.filter(
				(item) => item.key === "keyboard.color",
			),
		).toEqual([]);
		expect(
			(
				await memory.read({ type: "LIST_PROPOSALS", ownerUserId })
			).proposals.filter((proposal) => proposal.key === "keyboard.color"),
		).toEqual([]);
		expect(
			JSON.stringify(await memory.read({ type: "EXPORT", ownerUserId })),
		).not.toContain(source.userExcerpt);
		await expect(memory.execute(createCommand)).rejects.toThrowError(
			"MEMORY_REQUEST_RETIRED",
		);
		expect(
			(await memory.read({ type: "LIST_ITEMS", ownerUserId })).items,
		).toEqual([]);
	});

	it("rejects edits after Memory Authorization is disabled without creating a version", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2027-02-01T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-disabled-edit-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const created = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我喜欢静音键盘。",
				occurredAt: "2027-01-20T00:00:00.000Z",
			},
			changes: [
				{
					key: "keyboard.noise",
					value: { valueType: "TEXT", value: "quiet" },
					statement: "偏好静音键盘",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		const item = created.applied[0];
		expect(item).toBeDefined();
		if (item === undefined) throw new Error("测试 Memory Item 缺失");
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: false,
			toolAssistedEnabled: false,
		});

		await expect(
			memory.execute({
				type: "EDIT_ITEM",
				requestId: randomUUID(),
				ownerUserId,
				memoryId: item.memoryId,
				value: { valueType: "TEXT", value: "loud" },
				statement: "偏好有声键盘",
				applicationMode: "SOFT_PREFERENCE",
			}),
		).rejects.toThrowError("MEMORY_DISABLED");
		await expect(
			memory.read({ type: "LIST_ITEMS", ownerUserId }),
		).resolves.toMatchObject({
			items: [
				{
					memoryId: item.memoryId,
					statement: "偏好静音键盘",
					status: "ACTIVE",
				},
			],
		});
	});

	it("atomically restores the previous version without rewriting its provenance or lifecycle", async () => {
		let currentTime = new Date("2027-02-01T00:00:00.000Z");
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => currentTime,
		});
		const ownerUserId = `user-memory-restore-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const originalSource = {
			sourceType: "USER_MESSAGE" as const,
			sessionId: randomUUID(),
			messageId: randomUUID(),
			userExcerpt: "我通常偏好暖色显示器。",
			occurredAt: "2027-01-20T00:00:00.000Z",
		};
		const original = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: originalSource,
			changes: [
				{
					key: "display.color_preference",
					value: { valueType: "TEXT", value: "暖色" },
					statement: "通常偏好暖色显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
					reviewAt: "2027-03-01T00:00:00.000Z",
				},
			],
		});
		const originalItem = original.applied[0];
		expect(originalItem).toBeDefined();
		if (originalItem === undefined)
			throw new Error("测试原始 Memory Item 缺失");
		const replacement = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...originalSource,
				messageId: randomUUID(),
				userExcerpt: "我现在通常偏好冷色显示器。",
				occurredAt: "2027-01-25T00:00:00.000Z",
			},
			changes: [
				{
					key: "display.color_preference",
					value: { valueType: "TEXT", value: "冷色" },
					statement: "通常偏好冷色显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		const replacementItem = replacement.applied[0];
		expect(replacementItem).toBeDefined();
		if (replacementItem === undefined)
			throw new Error("测试替换 Memory Item 缺失");
		currentTime = new Date("2027-04-01T00:00:00.000Z");
		const requestId = randomUUID();
		const restoreCommand = {
			type: "EDIT_ITEM" as const,
			requestId,
			ownerUserId,
			memoryId: replacementItem.memoryId,
			restoreMemoryId: originalItem.memoryId,
			value: { valueType: "TEXT" as const, value: "不应写入" },
			statement: "不应写入",
			applicationMode: "CURRENT_CONFIRMATION_REQUIRED" as const,
		};

		const restored = await memory.execute(restoreCommand);
		await expect(memory.execute(restoreCommand)).resolves.toEqual(restored);
		expect(restored.item).toMatchObject({
			memoryId: originalItem.memoryId,
			value: { valueType: "TEXT", value: "暖色" },
			statement: "通常偏好暖色显示器",
			source: originalItem.source,
			lastConfirmedAt: originalItem.lastConfirmedAt,
			reviewAt: originalItem.reviewAt,
			status: "NEEDS_REVIEW",
		});
		const versions = (
			await memory.read({ type: "LIST_ITEMS", ownerUserId })
		).items.filter((item) => item.key === "display.color_preference");
		expect(versions).toHaveLength(2);
		expect(versions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					memoryId: originalItem.memoryId,
					status: "NEEDS_REVIEW",
				}),
				expect.objectContaining({
					memoryId: replacementItem.memoryId,
					status: "SUPERSEDED",
				}),
			]),
		);
	});

	it("deletes all memory content while retaining authorization settings", async () => {
		const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
		memory = await openPostgresMemory({
			databaseUrl,
		});
		const ownerUserId = `user-memory-delete-all-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: true,
		});
		const created = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我偏好轻量鼠标。",
				occurredAt: "2026-08-28T00:00:00.000Z",
			},
			changes: [
				{
					key: "mouse.weight",
					value: { valueType: "TEXT", value: "light" },
					statement: "偏好轻量鼠标",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		const item = created.applied[0];
		if (item === undefined) throw new Error("测试 Memory Item 缺失");
		const database = new Pool({ connectionString: databaseUrl });
		try {
			await database.query(
				`INSERT INTO memory_embeddings (
					owner_user_id, memory_id, memory_key, embedding, created_at
				) VALUES ($1, $2, $3, $4::jsonb, $5)`,
				[
					ownerUserId,
					item.memoryId,
					item.key,
					JSON.stringify([0.1, 0.2]),
					new Date(),
				],
			);
			await database.query(
				`INSERT INTO memory_projection_cache (
					owner_user_id, memory_key, cache_key, projection, created_at
				) VALUES ($1, $2, $3, $4::jsonb, $5)`,
				[
					ownerUserId,
					item.key,
					randomUUID(),
					JSON.stringify({ statement: item.statement }),
					new Date(),
				],
			);

			await expect(
				memory.execute({
					type: "DELETE_ALL",
					requestId: randomUUID(),
					ownerUserId,
				}),
			).resolves.toMatchObject({ deleted: true });
			await expect(
				memory.read({ type: "LIST_ITEMS", ownerUserId }),
			).resolves.toEqual({ items: [] });
			await expect(
				memory.read({ type: "LIST_PROPOSALS", ownerUserId }),
			).resolves.toEqual({ proposals: [] });
			const derived = await database.query<{
				embeddings: string;
				caches: string;
			}>(
				`SELECT
					(SELECT count(*) FROM memory_embeddings WHERE owner_user_id = $1) AS embeddings,
					(SELECT count(*) FROM memory_projection_cache WHERE owner_user_id = $1) AS caches`,
				[ownerUserId],
			);
			expect(derived.rows[0]).toEqual({ embeddings: "0", caches: "0" });
		} finally {
			await database.end();
		}
		await expect(
			memory.read({ type: "GET_SETTINGS", ownerUserId }),
		).resolves.toMatchObject({
			memoryEnabled: true,
			toolAssistedEnabled: true,
		});
	});

	it("retires only idempotency results whose content was deleted", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2027-01-01T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-selective-retirement-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const createDisplay: ProposeMemoryChangesCommand = {
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我偏好 27 英寸显示器。",
				occurredAt: "2026-12-31T00:00:00.000Z",
			},
			changes: [
				{
					key: "display.size_inches",
					value: { valueType: "NUMBER", value: 27 },
					statement: "偏好 27 英寸显示器",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		};
		const createKeyboard: ProposeMemoryChangesCommand = {
			...createDisplay,
			requestId: randomUUID(),
			source: {
				...createDisplay.source,
				messageId: randomUUID(),
				userExcerpt: "我偏好静音键盘。",
			},
			changes: [
				{
					key: "keyboard.noise",
					value: { valueType: "TEXT", value: "quiet" },
					statement: "偏好静音键盘",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		};
		const display = await memory.execute(createDisplay);
		const keyboard = await memory.execute(createKeyboard);
		const displayItem = display.applied[0];
		const keyboardItem = keyboard.applied[0];
		if (displayItem === undefined || keyboardItem === undefined) {
			throw new Error("测试 Memory Item 缺失");
		}
		const deleteDisplay = {
			type: "DELETE_ITEM" as const,
			requestId: randomUUID(),
			ownerUserId,
			memoryId: displayItem.memoryId,
		};
		await memory.execute(deleteDisplay);
		await expect(memory.execute(createDisplay)).rejects.toThrowError(
			"MEMORY_REQUEST_RETIRED",
		);
		await expect(memory.execute(createKeyboard)).resolves.toEqual(keyboard);
		await memory.execute({
			type: "DELETE_ITEM",
			requestId: randomUUID(),
			ownerUserId,
			memoryId: keyboardItem.memoryId,
		});
		await expect(memory.execute(deleteDisplay)).resolves.toEqual({
			deleted: true,
		});
	});

	it("rolls back a deletion when a derived database operation fails", async () => {
		const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
		memory = await openPostgresMemory({ databaseUrl });
		const ownerUserId = `user-memory-delete-failure-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const created = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我偏好静音耳机。",
				occurredAt: "2026-08-28T00:00:00.000Z",
			},
			changes: [
				{
					key: "headphone.noise",
					value: { valueType: "TEXT", value: "quiet" },
					statement: "偏好静音耳机",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		const item = created.applied[0];
		expect(item).toBeDefined();
		if (item === undefined) throw new Error("测试 Memory Item 缺失");
		const suffix = randomUUID().replaceAll("-", "");
		const functionName = `memory_test_fail_${suffix}`;
		const triggerName = `memory_test_trigger_${suffix}`;
		const deleteCommand = {
			type: "DELETE_ITEM" as const,
			requestId: randomUUID(),
			ownerUserId,
			memoryId: item.memoryId,
		};
		const database = new Pool({ connectionString: databaseUrl });
		try {
			await database.query(
				`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'forced memory delete failure'; END; $$`,
			);
			await database.query(
				`CREATE TRIGGER ${triggerName} BEFORE DELETE ON memory_items
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
			);
			await expect(memory.execute(deleteCommand)).rejects.toThrowError(
				"forced memory delete failure",
			);
			expect(
				(await memory.read({ type: "LIST_ITEMS", ownerUserId })).items,
			).toHaveLength(1);
		} finally {
			await database.query(
				`DROP TRIGGER IF EXISTS ${triggerName} ON memory_items`,
			);
			await database.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
			await database.end();
		}
		await expect(memory.execute(deleteCommand)).resolves.toEqual({
			deleted: true,
		});
	});

	it("stops applying a conflicting key and refuses Proposal acceptance while disabled", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
		});
		const ownerUserId = `user-memory-conflict-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const source = {
			sourceType: "USER_MESSAGE" as const,
			sessionId: randomUUID(),
			messageId: randomUUID(),
			userExcerpt: "选商品时颜色偏好红色。",
			occurredAt: "2026-08-28T00:00:00.000Z",
		};
		await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source,
			changes: [
				{
					key: "color.preference",
					value: { valueType: "TEXT", value: "red" },
					statement: "选商品时颜色偏好红色",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		const proposed = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				...source,
				messageId: randomUUID(),
				userExcerpt: "现在好像更喜欢蓝色。",
				occurredAt: "2026-08-28T00:01:00.000Z",
			},
			changes: [
				{
					key: "color.preference",
					value: { valueType: "TEXT", value: "blue" },
					statement: "选商品时可能改为颜色偏好蓝色",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "UNCERTAIN",
				},
			],
		});
		expect(
			(await memory.read({ type: "LIST_ITEMS", ownerUserId })).items[0]?.status,
		).toBe("NEEDS_REVIEW");
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: false,
			toolAssistedEnabled: false,
		});
		const proposal = proposed.proposals[0];
		expect(proposal).toBeDefined();
		if (proposal === undefined) throw new Error("测试 Proposal 缺失");
		await expect(
			memory.execute({
				type: "REVIEW_PROPOSAL",
				requestId: randomUUID(),
				ownerUserId,
				proposalId: proposal.proposalId,
				decision: "ACCEPT",
			}),
		).rejects.toThrowError("MEMORY_DISABLED");
	});

	it("rejects a Memory Source timestamp in the future", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2027-01-01T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-future-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		await expect(
			memory.execute({
				type: "PROPOSE_CHANGES",
				requestId: randomUUID(),
				ownerUserId,
				source: {
					sourceType: "USER_MESSAGE",
					sessionId: randomUUID(),
					messageId: randomUUID(),
					userExcerpt: "未来的偏好不应被提前记录。",
					occurredAt: "2027-01-02T00:00:00.000Z",
				},
				changes: [
					{
						key: "future.preference",
						value: { valueType: "BOOLEAN", value: true },
						statement: "未来偏好",
						sensitivity: "ORDINARY",
						applicationMode: "SOFT_PREFERENCE",
						inference: "EXPLICIT",
					},
				],
			}),
		).rejects.toThrowError("MEMORY_SOURCE_INVALID");
	});

	it("reclassifies hard constraints and honors an explicit review deadline", async () => {
		memory = await openPostgresMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2027-01-01T00:00:00.000Z"),
		});
		const ownerUserId = `user-memory-classification-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const result = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "预算绝不能超过 5000 元。",
				occurredAt: "2026-12-31T00:00:00.000Z",
			},
			changes: [
				{
					key: "budget.max",
					value: { valueType: "NUMBER", value: 5000 },
					statement: "预算绝不能超过 5000 元",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
					reviewAt: "2027-02-01T00:00:00.000Z",
				},
			],
		});
		expect(result.applied[0]).toMatchObject({
			applicationMode: "CURRENT_CONFIRMATION_REQUIRED",
			reviewAt: "2027-02-01T00:00:00.000Z",
		});
	});

	it("fails closed when provenance is not the User Message and reports deleted sessions", async () => {
		let conversationAvailable = true;
		memory = await openMemory({
			databaseUrl: requireEnvironment("CHOICEMIND_TEST_DATABASE_URL"),
			now: () => new Date("2027-01-01T00:00:00.000Z"),
			sourceVerifier: {
				async verifyUserMessage(input) {
					return input.source.userExcerpt !== "工具返回的伪造内容"
						? input.source.userExcerpt
						: undefined;
				},
				async conversationExists() {
					return conversationAvailable;
				},
			},
		});
		const ownerUserId = `user-memory-provenance-${randomUUID()}`;
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: true,
		});
		const baseCommand = {
			type: "PROPOSE_CHANGES" as const,
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "TOOL_ASSISTED_CHAT" as const,
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "工具返回的伪造内容",
				occurredAt: "2026-12-31T00:00:00.000Z",
			},
			changes: [
				{
					key: "mouse.color",
					value: { valueType: "TEXT" as const, value: "black" },
					statement: "偏好黑色鼠标",
					sensitivity: "ORDINARY" as const,
					applicationMode: "SOFT_PREFERENCE" as const,
					inference: "EXPLICIT" as const,
				},
			],
		};
		await expect(memory.execute(baseCommand)).rejects.toThrowError(
			"MEMORY_SOURCE_NOT_USER_MESSAGE",
		);
		const created = await memory.execute({
			...baseCommand,
			requestId: randomUUID(),
			source: {
				...baseCommand.source,
				messageId: randomUUID(),
				userExcerpt: "我偏好黑色鼠标",
			},
		});
		expect(created.applied[0]?.source.conversationState).toBe("AVAILABLE");
		conversationAvailable = false;
		expect(
			(await memory.read({ type: "LIST_ITEMS", ownerUserId })).items[0]?.source,
		).toMatchObject({ conversationState: "DELETED" });
	});

	it("recovers after restart and removes derived rows with the stable key", async () => {
		const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
		const ownerUserId = `user-memory-restart-${randomUUID()}`;
		memory = await openPostgresMemory({
			databaseUrl,
			now: () => new Date("2027-01-01T00:00:00.000Z"),
		});
		await memory.execute({
			type: "SET_AUTHORIZATION",
			ownerUserId,
			memoryEnabled: true,
			toolAssistedEnabled: false,
		});
		const created = await memory.execute({
			type: "PROPOSE_CHANGES",
			requestId: randomUUID(),
			ownerUserId,
			source: {
				sourceType: "USER_MESSAGE",
				sessionId: randomUUID(),
				messageId: randomUUID(),
				userExcerpt: "我偏好静音鼠标。",
				occurredAt: "2026-12-31T00:00:00.000Z",
			},
			changes: [
				{
					key: "mouse.noise",
					value: { valueType: "TEXT", value: "quiet" },
					statement: "偏好静音鼠标",
					sensitivity: "ORDINARY",
					applicationMode: "SOFT_PREFERENCE",
					inference: "EXPLICIT",
				},
			],
		});
		const item = created.applied[0];
		expect(item).toBeDefined();
		if (item === undefined) throw new Error("测试 Memory Item 缺失");
		await memory.close();
		memory = await openPostgresMemory({
			databaseUrl,
			now: () => new Date("2027-01-02T00:00:00.000Z"),
		});
		expect(
			(await memory.read({ type: "LIST_ITEMS", ownerUserId })).items[0],
		).toMatchObject({
			memoryId: item.memoryId,
			statement: "偏好静音鼠标",
		});

		const database = new Pool({ connectionString: databaseUrl });
		try {
			await database.query(
				`INSERT INTO memory_embeddings (
           owner_user_id, memory_id, memory_key, embedding, created_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
				[
					ownerUserId,
					item.memoryId,
					item.key,
					JSON.stringify([0.1, 0.2]),
					new Date(),
				],
			);
			await database.query(
				`INSERT INTO memory_projection_cache (
           owner_user_id, memory_key, cache_key, projection, created_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
				[
					ownerUserId,
					item.key,
					randomUUID(),
					JSON.stringify({ statement: item.statement }),
					new Date(),
				],
			);
			await memory.execute({
				type: "DELETE_ITEM",
				requestId: randomUUID(),
				ownerUserId,
				memoryId: item.memoryId,
			});
			const derived = await database.query<{
				embeddings: string;
				caches: string;
			}>(
				`SELECT
           (SELECT count(*) FROM memory_embeddings WHERE owner_user_id = $1) AS embeddings,
           (SELECT count(*) FROM memory_projection_cache WHERE owner_user_id = $1) AS caches`,
				[ownerUserId],
			);
			expect(derived.rows[0]).toEqual({ embeddings: "0", caches: "0" });
			const audit = await database.query<{ object_id_hash: string }>(
				`SELECT object_id_hash FROM memory_deletion_audit
         WHERE owner_user_id = $1 ORDER BY deleted_at DESC LIMIT 1`,
				[ownerUserId],
			);
			expect(audit.rows[0]?.object_id_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(audit.rows[0]?.object_id_hash).not.toBe(item.memoryId);
		} finally {
			await database.end();
		}
	});
});

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") {
		throw new Error(`${name} 必须指向隔离的真实集成测试资源`);
	}
	return value;
}
