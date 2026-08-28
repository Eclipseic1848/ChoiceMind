import { openPostgresConversation } from "@choicemind/conversation";
import {
	openPostgresIdentityAccess,
	openPostgresIdentityLifecycleWorker,
} from "@choicemind/identity-access";
import { openPersistentDecisionTaskModule } from "@choicemind/task-persistence";

import { createIdentityLifecycleHandler } from "./identity-lifecycle-handler.js";

const databaseUrl = requireEnvironment("CHOICEMIND_DATABASE_URL");
const identityAccess = await openPostgresIdentityAccess({ databaseUrl });
await identityAccess.close();
const taskPersistence = await openPersistentDecisionTaskModule({ databaseUrl });
const conversation = await openPostgresConversation({ databaseUrl });
const worker = await openPostgresIdentityLifecycleWorker({
	databaseUrl,
	handle: createIdentityLifecycleHandler(taskPersistence, conversation),
});
const pollIntervalMs = Number(
	process.env.CHOICEMIND_IDENTITY_LIFECYCLE_POLL_MS ?? 500,
);
let stopping = false;
const requestStop = () => {
	stopping = true;
};

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

try {
	while (!stopping) {
		await worker.runOnce();
		if (!stopping)
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
} finally {
	process.off("SIGINT", requestStop);
	process.off("SIGTERM", requestStop);
	await Promise.all([
		worker.close(),
		taskPersistence.close(),
		conversation.close(),
	]);
}

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0)
		throw new Error(`${name} 未配置`);
	return value;
}
