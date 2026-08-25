import {
	openPersistentDecisionTaskWorker,
	openRuntimeRecoveryStore,
} from "@choicemind/task-persistence";
import { createEgressGuard } from "@choicemind/security";
import { randomUUID } from "node:crypto";

import { createDecisionTaskExecutor } from "./decision-tasks/executor.js";
import { createAgentRuntimeAdapter } from "./runtime/agent-runtime-factory.js";

const databaseUrl = requireEnvironment("CHOICEMIND_DATABASE_URL");
const recoveryStore = await openRuntimeRecoveryStore({ databaseUrl });
const egressGuard = createEgressGuard({
	appendRecord: (record) => recoveryStore.appendEgressRecord(record),
	nextId: () => `egress-${randomUUID()}`,
	now: () => new Date(),
});
const executor = createDecisionTaskExecutor({
	runtime: createAgentRuntimeAdapter({ recoveryStore, egressGuard }),
});
let worker: Awaited<ReturnType<typeof openPersistentDecisionTaskWorker>>;
try {
	worker = await openPersistentDecisionTaskWorker({
		databaseUrl,
		redisUrl: requireEnvironment("CHOICEMIND_REDIS_URL"),
		streamName: process.env.CHOICEMIND_TASK_STREAM ?? "choicemind:decision-tasks",
		consumerGroup:
			process.env.CHOICEMIND_TASK_CONSUMER_GROUP ?? "choicemind-orchestrator",
		workerId:
			process.env.CHOICEMIND_WORKER_ID ?? `orchestrator-worker-${process.pid}`,
		async execute(claim) {
			return executor.executePersistent(claim.command, {
				agentRunId: claim.agentRunId,
				userId: claim.ownerUserId,
				operationId: claim.operationId,
				correlationId: claim.operationId,
				egressConfirmation: {
					operationId: claim.operationId,
					userId: claim.ownerUserId,
				},
			});
		},
		async executeRuntimeControl(claim) {
			return executor.resumePersistent(
				claim.command,
				{ snapshot: claim.snapshot, effectReceipts: claim.effectReceipts },
				{
					agentRunId: claim.agentRunId,
					userId: claim.ownerUserId,
					operationId: claim.controlRequestId,
					correlationId: claim.correlationId,
					egressConfirmation: claim.egressConfirmation,
				},
			);
		},
	});
} catch (error) {
	await recoveryStore.close();
	throw error;
}
let stopping = false;
const requestStop = () => {
	stopping = true;
};

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

try {
	while (!stopping) {
		await worker.runOnce();
	}
} finally {
	process.off("SIGINT", requestStop);
	process.off("SIGTERM", requestStop);
	try {
		await worker.close();
	} finally {
		await recoveryStore.close();
	}
}

function requireEnvironment(name: string): string {
	const value = process.env[name];

	if (value === undefined || value.length === 0) {
		throw new Error(`${name} 未配置`);
	}

	return value;
}
