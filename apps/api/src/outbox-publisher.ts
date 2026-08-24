import { openOutboxPublisher } from "@choicemind/task-persistence";

const publisher = await openOutboxPublisher({
	databaseUrl: requireEnvironment("CHOICEMIND_DATABASE_URL"),
	redisUrl: requireEnvironment("CHOICEMIND_REDIS_URL"),
	streamName: process.env.CHOICEMIND_TASK_STREAM ?? "choicemind:decision-tasks",
});
const pollIntervalMs = Number(process.env.CHOICEMIND_PUBLISHER_POLL_MS ?? 250);
let stopping = false;
const requestStop = () => {
	stopping = true;
};

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

try {
	while (!stopping) {
		await publisher.runOnce();

		if (!stopping) {
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}
} finally {
	process.off("SIGINT", requestStop);
	process.off("SIGTERM", requestStop);
	await publisher.close();
}

function requireEnvironment(name: string): string {
	const value = process.env[name];

	if (value === undefined || value.length === 0) {
		throw new Error(`${name} 未配置`);
	}

	return value;
}
