import { expect, type Route, test } from "@playwright/test";

type Message = {
	messageId: string;
	ordinal: number;
	role: "ASSISTANT" | "USER";
	text: string;
	createdAt: string;
};

test.beforeEach(async ({ page }) => {
	await page.route("**/api/identity/me", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			status: 200,
			body: JSON.stringify({
				access: "FULL",
				account: { role: "USER", username: "小星" },
			}),
		});
	});
});

test("创建 Session、逐步形成 MVR，并在刷新后恢复对话", async ({ page }) => {
	let session: ReturnType<typeof buildSession> | undefined;
	const receivedUpdates: unknown[] = [];
	await page.route(/\/api\/conversations(?:\/.*)?$/, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const parts = url.pathname.split("/").filter(Boolean);
		if (request.method() === "GET" && parts.length === 2) {
			await json(route, 200, session === undefined ? [] : [summary(session)]);
			return;
		}
		if (request.method() === "POST" && parts.length === 2) {
			session = buildSession();
			await json(route, 201, session);
			return;
		}
		if (
			request.method() === "GET" &&
			parts.length === 3 &&
			session !== undefined
		) {
			await json(route, 200, session);
			return;
		}
		if (
			request.method() === "POST" &&
			parts.at(-1) === "turns" &&
			session !== undefined
		) {
			const body = request.postDataJSON() as {
				text: string;
				requirementUpdate: Record<string, unknown>;
			};
			receivedUpdates.push(body.requirementUpdate);
			session = appendTurn(session, body.text, body.requirementUpdate);
			await json(route, 200, session);
			return;
		}
		await json(route, 404, { error: { code: "NOT_FOUND" } });
	});

	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "把消费问题理清，再开始研究" }),
	).toBeVisible();
	await expect(page.getByText("还没有决策会话")).toBeVisible();

	await page.getByRole("button", { name: "新建决策" }).click();
	await expect(page).toHaveURL(/session=session-web-1/);
	const thread = page.getByLabel("对话记录");
	await expect(
		thread.getByText("先告诉我，你这次想解决什么消费问题？"),
	).toBeVisible();

	await page.getByLabel("这次想解决什么消费问题？").fill("购买一台工作显示器");
	await page.getByRole("button", { name: "发送并记录目标" }).click();
	await expect(
		thread.getByText("它主要会用在什么场景？", { exact: false }),
	).toBeVisible();

	await page.getByLabel("主要使用场景").fill("每天长时间编程和办公");
	await page.getByRole("button", { name: "发送并记录场景" }).click();
	await expect(
		thread.getByText("哪些条件一旦不满足，你就不会考虑？", { exact: false }),
	).toBeVisible();

	await page
		.getByLabel("硬性条件（每行一项）")
		.fill("至少 4K\n支持 USB-C 供电");
	await page.getByRole("button", { name: "发送并记录硬性条件" }).click();
	await expect(
		thread.getByText("关键信息已经足够，可以开始有界研究。", { exact: false }),
	).toBeVisible();
	await expect(page.getByText("需求已可研究")).toBeVisible();
	await page.getByRole("button", { name: "修改消费目标" }).click();
	await expect(page.getByLabel("这次想解决什么消费问题？")).toBeFocused();
	await page.getByLabel("这次想解决什么消费问题？").fill("更换一台工作显示器");
	await page.getByRole("button", { name: "更新消费目标" }).click();
	await expect(page.getByText("Revision 4")).toBeVisible();
	expect(receivedUpdates).toEqual([
		{ consumptionGoal: "购买一台工作显示器" },
		{ primaryScenario: "每天长时间编程和办公" },
		{ hardConstraints: ["至少 4K", "支持 USB-C 供电"] },
		{ consumptionGoal: "更换一台工作显示器" },
	]);

	await page.reload();
	await expect(
		page.getByRole("heading", { name: "更换一台工作显示器" }),
	).toBeVisible();
	await expect(page.getByText("需求已可研究")).toBeVisible();
});

test("响应丢失后原地重试复用同一幂等请求 ID", async ({ page }) => {
	let session: ReturnType<typeof buildSession> | undefined;
	const createRequestIds: string[] = [];
	const turnRequestIds: string[] = [];
	await page.route(/\/api\/conversations(?:\/.*)?$/, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET" && path === "/api/conversations") {
			await json(route, 200, []);
			return;
		}
		if (request.method() === "POST" && path === "/api/conversations") {
			const body = request.postDataJSON() as { clientRequestId: string };
			createRequestIds.push(body.clientRequestId);
			session ??= buildSession();
			await json(route, createRequestIds.length === 1 ? 503 : 201, session);
			return;
		}
		if (request.method() === "POST" && path.endsWith("/turns")) {
			const body = request.postDataJSON() as {
				clientTurnId: string;
				requirementUpdate: Record<string, unknown>;
				text: string;
			};
			turnRequestIds.push(body.clientTurnId);
			if (session === undefined) throw new Error("测试 Session 尚未创建");
			const updated = appendTurn(session, body.text, body.requirementUpdate);
			if (turnRequestIds.length > 1) session = updated;
			await json(route, turnRequestIds.length === 1 ? 503 : 200, updated);
			return;
		}
		await json(route, 404, { error: { code: "NOT_FOUND" } });
	});

	await page.goto("/");
	await page.getByRole("button", { name: "新建决策" }).click();
	await expect(page.locator("p.form-message[role='alert']")).toContainText(
		"无法创建新会话",
	);
	await page.getByRole("button", { name: "新建决策" }).click();
	await page.getByLabel("这次想解决什么消费问题？").fill("购买显示器");
	await page.getByRole("button", { name: "发送并记录目标" }).click();
	await expect(page.locator("p.form-message[role='alert']")).toContainText(
		"消息发送失败",
	);
	await page.getByRole("button", { name: "发送并记录目标" }).click();

	expect(createRequestIds).toHaveLength(2);
	expect(new Set(createRequestIds).size).toBe(1);
	expect(turnRequestIds).toHaveLength(2);
	expect(new Set(turnRequestIds).size).toBe(1);
});

test("在 Session 中恢复权威任务事件并执行暂停控制", async ({ page }) => {
	await page.addInitScript(() => {
		class ControlledEventSource {
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;

			constructor(_url: string | URL) {
				(
					window as unknown as {
						conversationTestEventSource: ControlledEventSource;
					}
				).conversationTestEventSource = this;
				queueMicrotask(() => this.onopen?.(new Event("open")));
			}

			close() {}
		}

		Object.defineProperty(window, "EventSource", {
			configurable: true,
			value: ControlledEventSource,
		});
	});
	const session = buildSession();
	session.decisionTasks = [
		{
			decisionTaskId: "task-conversation-web",
			linkedAt: "2026-08-27T23:10:00.000Z",
		},
	];
	let resumeBody: Record<string, unknown> | undefined;
	let taskState: "PAUSED_PERMISSION" | "RUNNING" = "PAUSED_PERMISSION";
	await page.route(/\/api\/conversations(?:\/.*)?$/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		await json(
			route,
			200,
			path === "/api/conversations" ? [summary(session)] : session,
		);
	});
	await page.route(
		"**/api/decision-tasks/task-conversation-web/resume",
		async (route) => {
			resumeBody = route.request().postDataJSON() as Record<string, unknown>;
			taskState = "RUNNING";
			await json(route, 202, {
				contractType: "runtime-control-status",
				contractVersion: "1.0",
				controlRequestId: resumeBody.controlRequestId,
				decisionTaskId: "task-conversation-web",
				agentRunId: "run-conversation-web",
				action: "RESUME",
				state: "ACCEPTED",
				updatedAt: "2026-08-27T23:10:02.000Z",
			});
		},
	);
	await page.route(
		"**/api/decision-tasks/task-conversation-web",
		async (route) => {
			await json(route, 200, {
				contractType: "decision-task-snapshot",
				contractVersion: "1.0",
				executionRequestId: "exec-conversation-web",
				decisionTaskId: "task-conversation-web",
				agentRunId: "run-conversation-web",
				state: taskState,
				terminal: false,
				...(taskState === "PAUSED_PERMISSION"
					? { runtimeSnapshotId: "snapshot-conversation-web" }
					: {}),
				updatedAt: "2026-08-27T23:10:00.000Z",
			});
		},
	);

	await page.goto("/?session=session-web-1");
	await expect(page.getByRole("heading", { name: "任务进度" })).toBeVisible();
	await page.getByRole("button", { name: "安全恢复" }).click();
	await expect(page.getByText("恢复中")).toBeVisible();
	expect(resumeBody).toMatchObject({
		contractType: "runtime-resume-request",
		contractVersion: "1.0",
		runtimeSnapshotId: "snapshot-conversation-web",
	});
	await page.evaluate(
		(data) => {
			const source = (
				window as unknown as {
					conversationTestEventSource: {
						onmessage: ((event: MessageEvent) => void) | null;
					};
				}
			).conversationTestEventSource;
			source.onmessage?.(new MessageEvent("message", { data }));
		},
		JSON.stringify({
			contractType: "persisted-run-event",
			contractVersion: "1.0",
			cursor: "1",
			event: {
				contractType: "run-event",
				contractVersion: "1.0",
				eventId: "event-conversation-web",
				decisionTaskId: "task-conversation-web",
				agentRunId: "run-conversation-web",
				sequence: 1,
				occurredAt: "2026-08-27T23:10:03.000Z",
				eventType: "TASK_STATE_CHANGED",
				taskState: "UNDERSTANDING",
				summary: "已安全恢复研究任务",
				synthetic: true,
			},
		}),
	);
	await expect(page.getByText("已安全恢复研究任务")).toBeVisible();
	await expect(page.getByText("权威状态：RUNNING")).toBeVisible();
	await expect(page.getByText("恢复中")).not.toBeVisible();
});

test("在产品壳中明确显示后台任务失败原因", async ({ page }) => {
	const session = buildSession();
	session.decisionTasks = [
		{
			decisionTaskId: "task-conversation-failed",
			linkedAt: "2026-08-27T23:10:00.000Z",
		},
	];
	await page.route(/\/api\/conversations(?:\/.*)?$/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		await json(
			route,
			200,
			path === "/api/conversations" ? [summary(session)] : session,
		);
	});
	await page.route(
		"**/api/decision-tasks/task-conversation-failed/events*",
		async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: "",
			});
		},
	);
	await page.route(
		"**/api/decision-tasks/task-conversation-failed",
		async (route) => {
			await json(route, 200, buildFailedResult());
		},
	);

	await page.goto("/?session=session-web-1");

	await expect(page.getByRole("heading", { name: "任务失败" })).toBeVisible();
	await expect(page.getByText("研究服务暂时无法完成这次任务")).toBeVisible();
	await expect(
		page.getByText("可以稍后重新发起一次研究；本次失败不会被伪装成结论。"),
	).toBeVisible();
});

test("移动端在 reduced motion 下可用键盘创建，并把错误焦点交给用户", async ({
	page,
}) => {
	await page.setViewportSize({ width: 360, height: 800 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.route(/\/api\/conversations(?:\/.*)?$/, async (route) => {
		if (route.request().method() === "POST") {
			await json(route, 503, {
				error: { message: "会话服务正在恢复，请稍后再试" },
			});
			return;
		}
		await json(route, 200, []);
	});

	await page.goto("/");
	const createButton = page.getByRole("button", { name: "新建决策" });
	await createButton.focus();
	await page.keyboard.press("Enter");

	const alert = page.locator("p.form-message[role='alert']");
	await expect(alert).toHaveText("会话服务正在恢复，请稍后再试");
	await expect(alert).toBeFocused();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
});

test("切换 Session 时不复用上一项任务的暂停控制状态", async ({ page }) => {
	const first = buildSession();
	first.title = "第一项决策";
	first.decisionTasks = [
		{
			decisionTaskId: "task-session-first",
			linkedAt: "2026-08-27T23:10:00.000Z",
		},
	];
	const second = buildSession();
	second.sessionId = "session-web-2";
	second.title = "第二项决策";
	second.decisionTasks = [
		{
			decisionTaskId: "task-session-second",
			linkedAt: "2026-08-27T23:11:00.000Z",
		},
	];
	await page.route(/\/api\/conversations(?:\/.*)?$/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/conversations") {
			await json(route, 200, [summary(first), summary(second)]);
			return;
		}
		await json(route, 200, path.endsWith(first.sessionId) ? first : second);
	});
	await page.route("**/api/decision-tasks/*/events*", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body: "",
		});
	});
	await page.route(
		"**/api/decision-tasks/task-session-first",
		async (route) => {
			await json(
				route,
				200,
				buildTaskSnapshot("task-session-first", "PAUSED_PERMISSION"),
			);
		},
	);
	await page.route(
		"**/api/decision-tasks/task-session-second",
		async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			await json(
				route,
				200,
				buildTaskSnapshot("task-session-second", "RUNNING"),
			);
		},
	);

	await page.goto(`/?session=${first.sessionId}`);
	await expect(page.getByRole("button", { name: "安全恢复" })).toBeVisible();
	await page.getByRole("button", { name: /第二项决策/ }).click();

	await expect(
		page.getByRole("button", { name: "安全恢复" }),
	).not.toBeVisible();
	await expect(page.getByText("权威状态：RUNNING")).toBeVisible();
});

function buildSession() {
	return {
		sessionId: "session-web-1",
		title: "新的消费决策",
		createdAt: "2026-08-27T23:00:00.000Z",
		updatedAt: "2026-08-27T23:00:00.000Z",
		currentRequirement: null as null | {
			revisionId: string;
			revisionNumber: number;
			consumptionGoal: string | null;
			primaryScenario: string | null;
			hardConstraints: string[] | null;
			missingKeys: string[];
			readiness: "NEEDS_CLARIFICATION" | "READY_FOR_RESEARCH";
			createdAt: string;
		},
		decisionTasks: [] as Array<{ decisionTaskId: string; linkedAt: string }>,
		messages: [
			{
				messageId: "message-web-1",
				ordinal: 1,
				role: "ASSISTANT" as const,
				text: "先告诉我，你这次想解决什么消费问题？",
				createdAt: "2026-08-27T23:00:00.000Z",
			},
		] as Message[],
	};
}

function appendTurn(
	current: ReturnType<typeof buildSession>,
	text: string,
	update: Record<string, unknown>,
) {
	const previous = current.currentRequirement;
	const consumptionGoal =
		typeof update.consumptionGoal === "string"
			? update.consumptionGoal
			: (previous?.consumptionGoal ?? null);
	const primaryScenario =
		typeof update.primaryScenario === "string"
			? update.primaryScenario
			: (previous?.primaryScenario ?? null);
	const hardConstraints = Array.isArray(update.hardConstraints)
		? (update.hardConstraints as string[])
		: (previous?.hardConstraints ?? null);
	const missingKeys = [
		...(consumptionGoal === null ? ["CONSUMPTION_GOAL"] : []),
		...(primaryScenario === null ? ["PRIMARY_SCENARIO"] : []),
		...(hardConstraints === null ? ["HARD_CONSTRAINTS"] : []),
	];
	const assistantText =
		missingKeys[0] === "PRIMARY_SCENARIO"
			? "它主要会用在什么场景？请说最常见、最重要的使用方式。"
			: missingKeys[0] === "HARD_CONSTRAINTS"
				? "哪些条件一旦不满足，你就不会考虑？如果没有，也可以明确告诉我没有硬性条件。"
				: "关键信息已经足够，可以开始有界研究。你仍可继续补充偏好或预算。";
	const ordinal = current.messages.length + 1;
	return {
		...current,
		title: consumptionGoal ?? current.title,
		updatedAt: "2026-08-27T23:01:00.000Z",
		currentRequirement: {
			revisionId: `revision-${ordinal}`,
			revisionNumber: (previous?.revisionNumber ?? 0) + 1,
			consumptionGoal,
			primaryScenario,
			hardConstraints,
			missingKeys,
			readiness:
				missingKeys.length === 0
					? ("READY_FOR_RESEARCH" as const)
					: ("NEEDS_CLARIFICATION" as const),
			createdAt: "2026-08-27T23:01:00.000Z",
		},
		messages: [
			...current.messages,
			{
				messageId: `message-${ordinal}`,
				ordinal,
				role: "USER" as const,
				text,
				createdAt: "2026-08-27T23:01:00.000Z",
			},
			{
				messageId: `message-${ordinal + 1}`,
				ordinal: ordinal + 1,
				role: "ASSISTANT" as const,
				text: assistantText,
				createdAt: "2026-08-27T23:01:00.000Z",
			},
		],
	};
}

function summary(session: ReturnType<typeof buildSession>) {
	return {
		sessionId: session.sessionId,
		title: session.title,
		latestMessage: session.messages.at(-1)?.text ?? "",
		readiness: session.currentRequirement?.readiness ?? null,
		updatedAt: session.updatedAt,
	};
}

async function json(route: Route, status: number, body: unknown) {
	await route.fulfill({
		contentType: "application/json",
		status,
		body: JSON.stringify(body),
	});
}

function buildFailedResult() {
	return {
		contractType: "decision-task-result",
		contractVersion: "1.0",
		ok: false,
		taskStatus: {
			contractType: "decision-task-status",
			contractVersion: "1.0",
			decisionTaskId: "task-conversation-failed",
			agentRunId: "run-conversation-failed",
			state: "FAILED",
			terminal: true,
			latestEventSequence: 1,
			errorId: "error-conversation-failed",
			updatedAt: "2026-08-27T23:10:00.000Z",
		},
		runEvents: [
			{
				contractType: "run-event",
				contractVersion: "1.0",
				eventId: "event-conversation-failed",
				decisionTaskId: "task-conversation-failed",
				agentRunId: "run-conversation-failed",
				sequence: 1,
				occurredAt: "2026-08-27T23:10:00.000Z",
				eventType: "RUNTIME_FAILED",
				taskState: "FAILED",
				summary: "研究任务失败",
				synthetic: true,
			},
		],
		error: {
			contractType: "choice-mind-error",
			contractVersion: "1.0",
			errorId: "error-conversation-failed",
			code: "AGENT_RUNTIME_FAILED",
			category: "RUNTIME",
			message: "研究服务暂时无法完成这次任务",
			retryMode: "NEW_EXECUTION_ALLOWED",
			issues: [],
			occurredAt: "2026-08-27T23:10:00.000Z",
		},
	};
}

function buildTaskSnapshot(
	decisionTaskId: string,
	state: "PAUSED_PERMISSION" | "RUNNING",
) {
	return {
		contractType: "decision-task-snapshot",
		contractVersion: "1.0",
		executionRequestId: `exec-${decisionTaskId}`,
		decisionTaskId,
		agentRunId: `run-${decisionTaskId}`,
		state,
		terminal: false,
		...(state === "PAUSED_PERMISSION"
			? { runtimeSnapshotId: `snapshot-${decisionTaskId}` }
			: {}),
		updatedAt: "2026-08-27T23:10:00.000Z",
	};
}
