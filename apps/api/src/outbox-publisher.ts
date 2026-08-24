import {
  openOutboxPublisher,
  openRunEventNotificationPublisher
} from "@choicemind/task-persistence";

const databaseUrl = requireEnvironment("CHOICEMIND_DATABASE_URL");
const redisUrl = requireEnvironment("CHOICEMIND_REDIS_URL");
const publisher = await openOutboxPublisher({
	databaseUrl,
	redisUrl,
	streamName: process.env.CHOICEMIND_TASK_STREAM ?? "choicemind:decision-tasks"
});
let eventPublisher: Awaited<ReturnType<typeof openRunEventNotificationPublisher>>;

try {
	eventPublisher = await openRunEventNotificationPublisher({
		channelName: process.env.CHOICEMIND_RUN_EVENT_CHANNEL ?? "choicemind:run-events",
		databaseUrl,
		redisUrl
	});
} catch (error) {
	await publisher.close();
	throw error;
}
const pollIntervalMs = Number(process.env.CHOICEMIND_PUBLISHER_POLL_MS ?? 250);
let stopping = false;
const requestStop = () => {
	stopping = true;
};

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

try {
	while (!stopping) {
		await Promise.all([publisher.runOnce(), eventPublisher.runOnce()]);

		if (!stopping) {
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}
} finally {
	process.off("SIGINT", requestStop);
	process.off("SIGTERM", requestStop);
	await Promise.all([publisher.close(), eventPublisher.close()]);
}

function requireEnvironment(name: string): string {
	const value = process.env[name];

	if (value === undefined || value.length === 0) {
		throw new Error(`${name} 未配置`);
	}

	return value;
}
