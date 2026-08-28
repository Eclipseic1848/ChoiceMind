import type { Conversation } from "@choicemind/conversation";
import type { IdentityLifecycleEvent } from "@choicemind/identity-access";
import type { PersistentDecisionTaskModule } from "@choicemind/task-persistence";

export function createIdentityLifecycleHandler(
	taskPersistence: Pick<
		PersistentDecisionTaskModule,
		"cancelActiveTasksForOwner" | "purgePrivateDataForOwner"
	>,
	conversation: Pick<Conversation, "purgePrivateDataForOwner">,
): (event: IdentityLifecycleEvent) => Promise<void> {
	return async (event) => {
		await taskPersistence.cancelActiveTasksForOwner(
			event.accountId,
			event.correlationId,
		);
		if (event.eventType === "DELETE_ACCOUNT") {
			await taskPersistence.purgePrivateDataForOwner(event.accountId);
			await conversation.purgePrivateDataForOwner(event.accountId);
		}
	};
}
