import { openPostgresConversation } from "@choicemind/conversation";
import {
	openPostgresIdentityAccess,
	openPostgresIdentityLifecycleWorker,
} from "@choicemind/identity-access";
import { openPersistentDecisionTaskModule } from "@choicemind/task-persistence";
import { createCredentialVault } from "@choicemind/security";
import { openPostgresSourceAccess } from "@choicemind/source-access";
import { openPostgresSourceResearch } from "@choicemind/source-research";

import { createIdentityLifecycleHandler } from "./identity-lifecycle-handler.js";

const databaseUrl = requireEnvironment("CHOICEMIND_DATABASE_URL");
const identityAccess = await openPostgresIdentityAccess({ databaseUrl });
await identityAccess.close();
const taskPersistence = await openPersistentDecisionTaskModule({ databaseUrl });
const conversation = await openPostgresConversation({ databaseUrl });
const credentialMasterKey = Buffer.from(
	requireEnvironment("CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64"),
	"base64",
);
if (credentialMasterKey.byteLength !== 32)
	throw new Error("CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64 解码后必须是 32 字节");
const vault = createCredentialVault({
	masterKey: credentialMasterKey,
	storage: {
		save: async (record) => taskPersistence.saveEncryptedCredential(record),
		load: async (credentialId, ownerUserId) =>
			taskPersistence.loadEncryptedCredential(credentialId, ownerUserId),
		delete: async (credentialId, ownerUserId) =>
			taskPersistence.deleteEncryptedCredential(credentialId, ownerUserId),
	},
	appendAuditRecord: async (record) =>
		taskPersistence.appendAuditRecord({
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
const sourceAccess = await openPostgresSourceAccess({ databaseUrl, vault });
const sourceResearch = await openPostgresSourceResearch({ databaseUrl });
const worker = await openPostgresIdentityLifecycleWorker({
	databaseUrl,
	handle: createIdentityLifecycleHandler(
		taskPersistence,
		conversation,
		sourceAccess,
		sourceResearch,
	),
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
		sourceAccess.close(),
		sourceResearch.close(),
	]);
	credentialMasterKey.fill(0);
}

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0)
		throw new Error(`${name} 未配置`);
	return value;
}
