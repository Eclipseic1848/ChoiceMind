import { describe, expect, it } from "vitest";

import { decodeDecisionTaskSnapshotV1 } from "./index.js";

describe("decodeDecisionTaskSnapshotV1", () => {
  it("accepts a persisted task that has not started running", () => {
    const snapshot = {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-persistent-accepted",
      decisionTaskId: "task-persistent-accepted",
      agentRunId: "run-persistent-accepted",
      state: "ACCEPTED",
      terminal: false,
      updatedAt: "2026-08-23T20:00:00.000Z"
    };

    expect(decodeDecisionTaskSnapshotV1(snapshot)).toEqual({
      ok: true,
      value: snapshot
    });
  });

  it("accepts a persisted task while its Agent Run is running", () => {
    const snapshot = {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-persistent-running",
      decisionTaskId: "task-persistent-running",
      agentRunId: "run-persistent-running",
      state: "RUNNING",
      terminal: false,
      updatedAt: "2026-08-23T20:30:00.000Z"
    };

    expect(decodeDecisionTaskSnapshotV1(snapshot)).toEqual({
      ok: true,
      value: snapshot
    });
  });

  it("exposes a retryable failure without marking the Decision Task terminal", () => {
    const snapshot = {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-persistent-retryable",
      decisionTaskId: "task-persistent-retryable",
      agentRunId: "run-persistent-retryable",
      state: "FAILED_RETRYABLE",
      terminal: false,
      updatedAt: "2026-08-23T21:00:00.000Z"
    };

    expect(decodeDecisionTaskSnapshotV1(snapshot)).toEqual({
      ok: true,
      value: snapshot
    });
  });

  it("exposes a final failure as a terminal Decision Task", () => {
    const snapshot = {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-persistent-final",
      decisionTaskId: "task-persistent-final",
      agentRunId: "run-persistent-final",
      state: "FAILED_FINAL",
      terminal: true,
      updatedAt: "2026-08-23T21:05:00.000Z"
    };

    expect(decodeDecisionTaskSnapshotV1(snapshot)).toEqual({
      ok: true,
      value: snapshot
    });
  });

  it("exposes a partial execution without presenting a successful Decision", () => {
    const snapshot = {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-persistent-partial",
      decisionTaskId: "task-persistent-partial",
      agentRunId: "run-persistent-partial",
      state: "PARTIAL",
      terminal: false,
      updatedAt: "2026-08-23T21:10:00.000Z"
    };

    expect(decodeDecisionTaskSnapshotV1(snapshot)).toEqual({
      ok: true,
      value: snapshot
    });
  });
});
