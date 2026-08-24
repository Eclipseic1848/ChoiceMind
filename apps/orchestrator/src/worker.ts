import { openPersistentDecisionTaskWorker } from "@choicemind/task-persistence";

import { createDecisionTaskExecutor } from "./decision-tasks/executor.js";
import { createAgentRuntimeAdapter } from "./runtime/agent-runtime-factory.js";

const executor = createDecisionTaskExecutor({
	runtime: createAgentRuntimeAdapter(),
});
const worker = await openPersistentDecisionTaskWorker({
	databaseUrl: requireEnvironment("CHOICEMIND_DATABASE_URL"),
	redisUrl: requireEnvironment("CHOICEMIND_REDIS_URL"),
	streamName: process.env.CHOICEMIND_TASK_STREAM ?? "choicemind:decision-tasks",
	consumerGroup:
		process.env.CHOICEMIND_TASK_CONSUMER_GROUP ?? "choicemind-orchestrator",
	workerId:
		process.env.CHOICEMIND_WORKER_ID ?? `orchestrator-worker-${process.pid}`,
	async execute(claim) {
		return executor.executePersistent(claim.command, {
			agentRunId: claim.agentRunId,
		});
	},
});
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
	await worker.close();
}

function requireEnvironment(name: string): string {
	const value = process.env[name];

	if (value === undefined || value.length === 0) {
		throw new Error(`${name} 未配置`);
	}

	return value;
}
