import { isPersistedRunEventCursorV1 } from "@choicemind/contracts/decision/v1";
import { createClient } from "@redis/client";

export type RunEventNotificationSubscriber = Readonly<{
  waitFor(decisionTaskId: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}>;

type RunEventNotificationSubscriberOptions = Readonly<{
  redisUrl: string;
  channelName: string;
}>;

type Waiter = Readonly<{
  finish(): void;
  fail(reason: unknown): void;
}>;

export async function openRunEventNotificationSubscriber(
  options: RunEventNotificationSubscriberOptions
): Promise<RunEventNotificationSubscriber> {
  const redis = createClient({
    url: options.redisUrl,
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: false,
      socketTimeout: 2_000
    }
  });
  redis.on("error", () => undefined);
  await redis.connect();
  const waiters = new Map<string, Set<Waiter>>();
  let closed = false;

  await redis.subscribe(options.channelName, (message) => {
    const decisionTaskId = decodeDecisionTaskId(message);

    if (decisionTaskId === undefined) {
      return;
    }

    const taskWaiters = waiters.get(decisionTaskId);

    if (taskWaiters === undefined) {
      return;
    }

    for (const waiter of [...taskWaiters]) {
      waiter.finish();
    }
  });

  return {
    async waitFor(decisionTaskId, signal) {
      if (closed) {
        throw new Error("RunEvent Notification Subscriber 已关闭");
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const taskWaiters = waiters.get(decisionTaskId) ?? new Set<Waiter>();
        const remove = () => {
          signal.removeEventListener("abort", onAbort);
          taskWaiters.delete(waiter);

          if (taskWaiters.size === 0) {
            waiters.delete(decisionTaskId);
          }
        };
        const waiter: Waiter = {
          finish() {
            if (settled) {
              return;
            }

            settled = true;
            remove();
            resolve();
          },
          fail(reason) {
            if (settled) {
              return;
            }

            settled = true;
            remove();
            reject(reason);
          }
        };
        const onAbort = () => waiter.fail(signal.reason);

        taskWaiters.add(waiter);
        waiters.set(decisionTaskId, taskWaiters);
        signal.addEventListener("abort", onAbort, { once: true });

        if (signal.aborted) {
          onAbort();
        }
      });
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;

      for (const taskWaiters of waiters.values()) {
        for (const waiter of [...taskWaiters]) {
          waiter.fail(new Error("RunEvent Notification Subscriber 已关闭"));
        }
      }

      if (!redis.isOpen) {
        redis.destroy();
        return;
      }

      try {
        await redis.unsubscribe(options.channelName);
      } catch {
        // Redis 故障时关闭仍必须可完成，Postgres 才是事件权威。
      }

      if (redis.isOpen) {
        await redis.close().catch(() => redis.destroy());
      }
    }
  };
}

function decodeDecisionTaskId(message: string): string | undefined {
  try {
    const value = JSON.parse(message) as unknown;

    if (
      typeof value === "object" &&
      value !== null &&
      "decisionTaskId" in value &&
      typeof value.decisionTaskId === "string" &&
      value.decisionTaskId.length > 0 &&
      "cursor" in value &&
      isPersistedRunEventCursorV1(value.cursor)
    ) {
      return value.decisionTaskId;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
