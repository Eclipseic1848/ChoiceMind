import { describe, expect, it } from "vitest";

import { decodePersistedRunEventV1 } from "./index.js";

describe("decodePersistedRunEventV1", () => {
  it("preserves the Postgres event cursor as a decimal string", () => {
    const persistedEvent = {
      contractType: "persisted-run-event",
      contractVersion: "1.0",
      cursor: "9007199254740993",
      event: {
        contractType: "run-event",
        contractVersion: "1.0",
        eventId: "event-running-1",
        decisionTaskId: "task-running-1",
        agentRunId: "run-running-1",
        sequence: 1,
        occurredAt: "2026-08-24T01:00:00.000Z",
        eventType: "TASK_STATE_CHANGED",
        taskState: "UNDERSTANDING",
        summary: "任务已开始执行",
        synthetic: true
      }
    };

    expect(decodePersistedRunEventV1(persistedEvent)).toEqual({
      ok: true,
      value: persistedEvent
    });
  });

  it("rejects a cursor beyond the PostgreSQL bigint range", () => {
    expect(
      decodePersistedRunEventV1(buildPersistedEvent({ cursor: "9223372036854775808" }))
    ).toMatchObject({
      ok: false,
      code: "CONTRACT_INVALID",
      issues: [{ path: "cursor" }]
    });
  });

  it.each(["0", 1])("rejects a non-positive-decimal-string cursor: %s", (cursor) => {
    expect(decodePersistedRunEventV1(buildPersistedEvent({ cursor }))).toMatchObject({
      ok: false,
      code: "CONTRACT_INVALID",
      issues: [{ path: "cursor" }]
    });
  });

  it("rejects an unsupported wrapper version", () => {
    expect(
      decodePersistedRunEventV1(buildPersistedEvent({ contractVersion: "2.0" }))
    ).toMatchObject({
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [{ path: "contractVersion" }]
    });
  });

  it("rejects an invalid nested run event", () => {
    const persistedEvent = buildPersistedEvent();

    expect(
      decodePersistedRunEventV1({
        ...persistedEvent,
        event: { ...persistedEvent.event, sequence: 0 }
      })
    ).toMatchObject({
      ok: false,
      code: "CONTRACT_INVALID",
      issues: [{ path: "event.sequence" }]
    });
  });
});

function buildPersistedEvent(overrides: Record<string, unknown> = {}) {
  return {
    contractType: "persisted-run-event",
    contractVersion: "1.0",
    cursor: "1",
    event: {
      contractType: "run-event",
      contractVersion: "1.0",
      eventId: "event-running-1",
      decisionTaskId: "task-running-1",
      agentRunId: "run-running-1",
      sequence: 1,
      occurredAt: "2026-08-24T01:00:00.000Z",
      eventType: "TASK_STATE_CHANGED",
      taskState: "UNDERSTANDING",
      summary: "任务已开始执行",
      synthetic: true
    },
    ...overrides
  };
}
