"use client";

import {
	decodeDecisionTaskResultV1,
	decodeDecisionTaskSnapshotV1,
	decodePersistedRunEventV1,
	decodeRuntimeControlStatusV1,
	type DecisionTaskResultV1,
	type DecisionTaskSnapshotV1,
	type PersistedRunEventV1,
	type RetryModeV1,
	type RuntimeControlStatusV1,
} from "@choicemind/contracts/decision/v1";
import { useCallback, useEffect, useRef, useState } from "react";

import { mergePersistedEvent, TaskProgress } from "./decision-flow";

export function ConversationTaskProgress({
	decisionTaskId,
}: Readonly<{ decisionTaskId: string }>) {
	const [snapshot, setSnapshot] = useState<DecisionTaskSnapshotV1 | null>(null);
	const [result, setResult] = useState<DecisionTaskResultV1 | null>(null);
	const [events, setEvents] = useState<readonly PersistedRunEventV1[]>([]);
	const [observationError, setObservationError] = useState(false);
	const [connectionState, setConnectionState] = useState<
		"idle" | "connected" | "reconnecting"
	>("idle");
	const [controlPending, setControlPending] = useState<
		"RESUME" | "CANCEL" | null
	>(null);
	const [controlStatus, setControlStatus] =
		useState<RuntimeControlStatusV1 | null>(null);
	const [controlError, setControlError] = useState<string | null>(null);
	const activeControl = useRef<
		Readonly<{ controlRequestId: string; acceptedAt?: string }> | undefined
	>(undefined);

	const loadTask = useCallback(
		async (settleControl = false) => {
			try {
				const response = await fetch(
					`/api/decision-tasks/${encodeURIComponent(decisionTaskId)}`,
					{ cache: "no-store" },
				);
				const body: unknown = await response.json();
				const decodedSnapshot = decodeDecisionTaskSnapshotV1(body);
				if (
					response.status === 200 &&
					decodedSnapshot.ok &&
					decodedSnapshot.value.decisionTaskId === decisionTaskId
				) {
					setSnapshot(decodedSnapshot.value);
					setResult(null);
					setObservationError(false);
					if (
						settleControl &&
						decodedSnapshot.value.state.startsWith("PAUSED_")
					) {
						setControlPending(null);
						setControlStatus(null);
						activeControl.current = undefined;
					}
					return;
				}
				const decodedResult = decodeDecisionTaskResultV1(body);
				if (
					response.status === 200 &&
					decodedResult.ok &&
					"taskStatus" in decodedResult.value &&
					decodedResult.value.taskStatus.decisionTaskId === decisionTaskId
				) {
					setSnapshot(null);
					setResult(decodedResult.value);
					setObservationError(false);
					setControlPending(null);
					setControlStatus(null);
					activeControl.current = undefined;
					return;
				}
				throw new Error("任务响应不符合合同");
			} catch {
				setObservationError(true);
			}
		},
		[decisionTaskId],
	);

	useEffect(() => {
		let active = true;
		let lastEventCursor: string | undefined;
		let reconnectTimer: number | undefined;
		let source: EventSource | undefined;
		setEvents([]);
		setConnectionState("idle");
		void loadTask();

		function connect() {
			const after =
				lastEventCursor === undefined
					? ""
					: `?after=${encodeURIComponent(lastEventCursor)}`;
			const nextSource = new EventSource(
				`/api/decision-tasks/${encodeURIComponent(decisionTaskId)}/events${after}`,
			);
			source = nextSource;
			nextSource.onopen = () => {
				if (active) setConnectionState("connected");
			};
			nextSource.onmessage = (message) => {
				if (!active) return;
				try {
					const decoded = decodePersistedRunEventV1(
						JSON.parse(message.data) as unknown,
					);
					if (
						!decoded.ok ||
						decoded.value.event.decisionTaskId !== decisionTaskId
					)
						return;
					if (
						lastEventCursor === undefined ||
						BigInt(decoded.value.cursor) > BigInt(lastEventCursor)
					) {
						lastEventCursor = decoded.value.cursor;
					}
					setEvents((current) => mergePersistedEvent(current, decoded.value));
					setConnectionState("connected");
					const acceptedAt = activeControl.current?.acceptedAt;
					const eventAt = Date.parse(decoded.value.event.occurredAt);
					void loadTask(
						acceptedAt !== undefined &&
							Number.isFinite(eventAt) &&
							eventAt >= Date.parse(acceptedAt),
					);
				} catch {
					return;
				}
			};
			nextSource.onerror = () => {
				if (!active) return;
				setConnectionState("reconnecting");
				nextSource.close();
				reconnectTimer = window.setTimeout(connect, 1_000);
			};
		}

		connect();
		return () => {
			active = false;
			source?.close();
			if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
		};
	}, [decisionTaskId, loadTask]);

	async function requestControl(action: "RESUME" | "CANCEL") {
		if (snapshot === null || !("runtimeSnapshotId" in snapshot)) return;
		const controlRequestId = `control-${action.toLowerCase()}-${crypto.randomUUID()}`;
		const requestBody =
			action === "RESUME"
				? {
						contractType: "runtime-resume-request",
						contractVersion: "1.0",
						controlRequestId,
						runtimeSnapshotId: snapshot.runtimeSnapshotId,
					}
				: {
						contractType: "runtime-cancel-request",
						contractVersion: "1.0",
						controlRequestId,
						cancellationId: `cancel-${crypto.randomUUID()}`,
					};
		setControlPending(action);
		setControlStatus(null);
		setControlError(null);
		activeControl.current = { controlRequestId };
		let keepPending = false;
		try {
			const response = await fetch(
				`/api/decision-tasks/${encodeURIComponent(decisionTaskId)}/${action.toLowerCase()}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(requestBody),
				},
			);
			const decoded = decodeRuntimeControlStatusV1(
				(await response.json()) as unknown,
			);
			const expectedStatus = action === "RESUME" ? 202 : 200;
			if (
				response.status !== expectedStatus ||
				!decoded.ok ||
				decoded.value.controlRequestId !== controlRequestId ||
				decoded.value.decisionTaskId !== decisionTaskId ||
				decoded.value.action !== action
			) {
				throw new Error("控制响应不符合合同");
			}
			setControlStatus(decoded.value);
			keepPending =
				decoded.value.state === "ACCEPTED" || decoded.value.state === "RUNNING";
			activeControl.current = keepPending
				? { controlRequestId, acceptedAt: decoded.value.updatedAt }
				: undefined;
		} catch {
			setControlError(
				action === "RESUME"
					? "恢复请求状态暂时无法确认"
					: "取消请求状态暂时无法确认",
			);
		} finally {
			if (!keepPending) {
				setControlPending(null);
				activeControl.current = undefined;
			}
		}
	}

	return (
		<>
			<TaskProgress
				authoritativeState={
					snapshot?.state ??
					(result !== null && "taskStatus" in result
						? result.taskStatus.state
						: null)
				}
				connectionState={connectionState}
				events={events}
				observationError={observationError}
				controlError={controlError}
				controlPending={controlPending}
				controlStatus={controlStatus}
				onControl={requestControl}
				paused={snapshot?.state.startsWith("PAUSED_") === true}
				taskId={decisionTaskId}
			/>
			{result !== null && !result.ok ? (
				<section
					className="task-failure"
					aria-labelledby="conversation-task-failure-heading"
				>
					<h3 id="conversation-task-failure-heading">任务失败</h3>
					<p>{result.error.message}</p>
					<p>{failureNextStep(result.error.retryMode)}</p>
				</section>
			) : null}
		</>
	);
}

function failureNextStep(retryMode: RetryModeV1): string {
	if (retryMode === "NEW_EXECUTION_ALLOWED") {
		return "可以稍后重新发起一次研究；本次失败不会被伪装成结论。";
	}
	if (retryMode === "SAME_EXECUTION_ONLY") {
		return "可以安全重试当前任务；当前页面会继续保留这次失败记录。";
	}
	return "当前任务不能安全重试；请先查看失败原因，再调整需求或配置。";
}
