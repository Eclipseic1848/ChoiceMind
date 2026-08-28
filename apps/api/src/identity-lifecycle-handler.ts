import type { Conversation } from "@choicemind/conversation";
import type { IdentityLifecycleEvent } from "@choicemind/identity-access";
import type { PersistentDecisionTaskModule } from "@choicemind/task-persistence";
import type { SourceAccess } from "@choicemind/source-access";
import type { SourceResearch } from "@choicemind/source-research";

export function createIdentityLifecycleHandler(
	taskPersistence: Pick<
		PersistentDecisionTaskModule,
		"cancelActiveTasksForOwner" | "purgePrivateDataForOwner"
	>,
	conversation: Pick<Conversation, "purgePrivateDataForOwner">,
	sourceAccess?: Pick<SourceAccess, "purgePrivateDataForOwner">,
	sourceResearch?: Pick<SourceResearch, "purgePrivateDataForOwner">,
): (event: IdentityLifecycleEvent) => Promise<void> {
	return async (event) => {
		await taskPersistence.cancelActiveTasksForOwner(
			event.accountId,
			event.correlationId,
		);
		if (event.eventType === "DELETE_ACCOUNT") {
			await sourceResearch?.purgePrivateDataForOwner(event.accountId);
			await sourceAccess?.purgePrivateDataForOwner(event.accountId);
			await taskPersistence.purgePrivateDataForOwner(event.accountId);
			await conversation.purgePrivateDataForOwner(event.accountId);
		}
	};
}
