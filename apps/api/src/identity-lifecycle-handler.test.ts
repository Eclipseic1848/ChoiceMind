import type { IdentityLifecycleEvent } from "@choicemind/identity-access";
import { describe, expect, it, vi } from "vitest";

import { createIdentityLifecycleHandler } from "./identity-lifecycle-handler.js";

const baseEvent: IdentityLifecycleEvent = {
	accountId: "user-a",
	attemptCount: 0,
	correlationId: "correlation-a",
	eventId: "event-a",
	eventType: "RESTRICT_ACCOUNT",
	occurredAt: "2026-08-27T00:00:00.000Z",
	scheduledAt: "2026-08-27T00:00:00.000Z",
};

describe("Identity lifecycle handler", () => {
	it("限制账号时只取消活跃任务，不删除私人数据", async () => {
		const taskPersistence = {
			cancelActiveTasksForOwner: vi.fn().mockResolvedValue({ cancelled: 0 }),
			purgePrivateDataForOwner: vi
				.fn()
				.mockResolvedValue({ deletedCredentials: 0, deletedTasks: 0 }),
		};
		const conversation = {
			purgePrivateDataForOwner: vi
				.fn()
				.mockResolvedValue({ deletedSessions: 0 }),
		};
		const handle = createIdentityLifecycleHandler(
			taskPersistence,
			conversation,
		);

		await handle(baseEvent);

		expect(taskPersistence.cancelActiveTasksForOwner).toHaveBeenCalledWith(
			"user-a",
			"correlation-a",
		);
		expect(taskPersistence.purgePrivateDataForOwner).not.toHaveBeenCalled();
		expect(conversation.purgePrivateDataForOwner).not.toHaveBeenCalled();
	});

	it("删除账号前同时清理任务和 Conversation 私人数据", async () => {
		const calls: string[] = [];
		const taskPersistence = {
			cancelActiveTasksForOwner: vi.fn(async () => {
				calls.push("cancel");
				return { cancelled: 0 };
			}),
			purgePrivateDataForOwner: vi.fn(async () => {
				calls.push("tasks");
				return { deletedCredentials: 0, deletedTasks: 0 };
			}),
		};
		const conversation = {
			purgePrivateDataForOwner: vi.fn(async () => {
				calls.push("conversation");
				return { deletedSessions: 0 };
			}),
		};
		const handle = createIdentityLifecycleHandler(
			taskPersistence,
			conversation,
		);

		await handle({ ...baseEvent, eventType: "DELETE_ACCOUNT" });

		expect(calls).toEqual(["cancel", "tasks", "conversation"]);
	});

	it("Conversation 清理失败时抛错，让生命周期事件重试", async () => {
		const taskPersistence = {
			cancelActiveTasksForOwner: vi.fn().mockResolvedValue({ cancelled: 0 }),
			purgePrivateDataForOwner: vi
				.fn()
				.mockResolvedValue({ deletedCredentials: 0, deletedTasks: 0 }),
		};
		const conversation = {
			purgePrivateDataForOwner: vi
				.fn()
				.mockRejectedValue(new Error("conversation purge failed")),
		};
		const handle = createIdentityLifecycleHandler(
			taskPersistence,
			conversation,
		);

		await expect(
			handle({ ...baseEvent, eventType: "DELETE_ACCOUNT" }),
		).rejects.toThrow("conversation purge failed");
	});
});
