"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { ConversationTaskProgress } from "./conversation-task-progress";

type RequirementMissingKey =
	| "CONSUMPTION_GOAL"
	| "PRIMARY_SCENARIO"
	| "HARD_CONSTRAINTS";

type RequirementRevision = {
	revisionId: string;
	revisionNumber: number;
	consumptionGoal: string | null;
	primaryScenario: string | null;
	hardConstraints: string[] | null;
	missingKeys: RequirementMissingKey[];
	readiness: "NEEDS_CLARIFICATION" | "READY_FOR_RESEARCH";
	createdAt: string;
};

type ConversationSession = {
	sessionId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: Array<{
		messageId: string;
		ordinal: number;
		role: "ASSISTANT" | "USER";
		text: string;
		createdAt: string;
	}>;
	currentRequirement: RequirementRevision | null;
	decisionTasks: Array<{ decisionTaskId: string; linkedAt: string }>;
};

type SessionSummary = {
	sessionId: string;
	title: string;
	latestMessage: string;
	readiness: RequirementRevision["readiness"] | null;
	updatedAt: string;
};

export function ConversationWorkbench({
	systemHealth,
}: Readonly<{ systemHealth: "healthy" | "unavailable" | "unhealthy" }>) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const requestedSessionId = searchParams.get("session");
	const [summaries, setSummaries] = useState<SessionSummary[]>([]);
	const [session, setSession] = useState<ConversationSession>();
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState<"CREATE" | "SEND" | null>(null);
	const [draft, setDraft] = useState("");
	const [editingRequirementKey, setEditingRequirementKey] =
		useState<RequirementMissingKey>();
	const [error, setError] = useState<string>();
	const createRequestIdRef = useRef<string | undefined>(undefined);
	const sessionRequestSequenceRef = useRef(0);
	const turnAttemptRef = useRef<
		| Readonly<{
				clientTurnId: string;
				promptKey: ReturnType<typeof composerPrompt>["key"];
				sessionId: string;
				text: string;
		  }>
		| undefined
	>(undefined);
	const focusLatestMessage = useRef(false);
	const latestAssistantRef = useRef<HTMLElement>(null);
	const errorRef = useRef<HTMLParagraphElement>(null);
	const draftRef = useRef<HTMLTextAreaElement>(null);
	const latestMessageId = session?.messages.at(-1)?.messageId;

	useEffect(() => {
		let active = true;
		const requestSequence = ++sessionRequestSequenceRef.current;
		void (async () => {
			try {
				const response = await fetch("/api/conversations", {
					cache: "no-store",
				});
				if (!response.ok) throw new Error("会话列表暂时无法读取");
				const nextSummaries = (await response.json()) as SessionSummary[];
				if (!active || sessionRequestSequenceRef.current !== requestSequence)
					return;
				setSummaries(nextSummaries);
				const sessionId = requestedSessionId ?? nextSummaries[0]?.sessionId;
				if (sessionId === undefined) {
					setSession(undefined);
					setLoading(false);
					return;
				}
				const sessionResponse = await fetch(`/api/conversations/${sessionId}`, {
					cache: "no-store",
				});
				if (!sessionResponse.ok) throw new Error("当前会话暂时无法读取");
				const restored = (await sessionResponse.json()) as ConversationSession;
				if (!active || sessionRequestSequenceRef.current !== requestSequence)
					return;
				setSession(restored);
				if (requestedSessionId === null)
					router.replace(`/?session=${restored.sessionId}`);
			} catch (cause) {
				if (active && sessionRequestSequenceRef.current === requestSequence)
					setError(
						cause instanceof Error ? cause.message : "会话服务暂时不可用",
					);
			} finally {
				if (active && sessionRequestSequenceRef.current === requestSequence)
					setLoading(false);
			}
		})();
		return () => {
			active = false;
		};
	}, [requestedSessionId, router]);

	useEffect(() => {
		if (latestMessageId !== undefined && focusLatestMessage.current) {
			latestAssistantRef.current?.focus();
			focusLatestMessage.current = false;
		}
	}, [latestMessageId]);

	useEffect(() => {
		if (error !== undefined) errorRef.current?.focus();
	}, [error]);

	async function createSession() {
		sessionRequestSequenceRef.current += 1;
		setPending("CREATE");
		setError(undefined);
		const clientRequestId = createRequestIdRef.current ?? crypto.randomUUID();
		createRequestIdRef.current = clientRequestId;
		try {
			const response = await fetch("/api/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ clientRequestId }),
			});
			if (!response.ok)
				throw new Error(await readError(response, "无法创建新会话"));
			const created = (await response.json()) as ConversationSession;
			setSession(created);
			setSummaries((current) => upsertSummary(current, created));
			createRequestIdRef.current = undefined;
			turnAttemptRef.current = undefined;
			setEditingRequirementKey(undefined);
			setDraft("");
			router.replace(`/?session=${created.sessionId}`);
			focusLatestMessage.current = true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "无法创建新会话");
		} finally {
			setPending(null);
		}
	}

	async function openSession(sessionId: string) {
		const requestSequence = ++sessionRequestSequenceRef.current;
		setLoading(true);
		setError(undefined);
		try {
			const response = await fetch(`/api/conversations/${sessionId}`, {
				cache: "no-store",
			});
			if (!response.ok)
				throw new Error(await readError(response, "无法打开会话"));
			if (sessionRequestSequenceRef.current !== requestSequence) return;
			setSession((await response.json()) as ConversationSession);
			createRequestIdRef.current = undefined;
			turnAttemptRef.current = undefined;
			setEditingRequirementKey(undefined);
			setDraft("");
			router.replace(`/?session=${sessionId}`);
		} catch (cause) {
			if (sessionRequestSequenceRef.current === requestSequence)
				setError(cause instanceof Error ? cause.message : "无法打开会话");
		} finally {
			if (sessionRequestSequenceRef.current === requestSequence)
				setLoading(false);
		}
	}

	async function submitTurn(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (session === undefined || draft.trim().length === 0) return;
		const prompt = composerPrompt(
			session.currentRequirement,
			editingRequirementKey,
		);
		const text = draft.trim();
		const requirementUpdate = buildRequirementUpdate(prompt.key, text);
		const previousAttempt = turnAttemptRef.current;
		const clientTurnId =
			previousAttempt?.sessionId === session.sessionId &&
			previousAttempt.promptKey === prompt.key &&
			previousAttempt.text === text
				? previousAttempt.clientTurnId
				: crypto.randomUUID();
		turnAttemptRef.current = {
			clientTurnId,
			promptKey: prompt.key,
			sessionId: session.sessionId,
			text,
		};
		setPending("SEND");
		setError(undefined);
		try {
			const response = await fetch(
				`/api/conversations/${session.sessionId}/turns`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						clientTurnId,
						requirementUpdate,
						text,
					}),
				},
			);
			if (!response.ok)
				throw new Error(await readError(response, "消息发送失败"));
			const updated = (await response.json()) as ConversationSession;
			setSession(updated);
			setSummaries((current) => upsertSummary(current, updated));
			setDraft("");
			setEditingRequirementKey(undefined);
			turnAttemptRef.current = undefined;
			focusLatestMessage.current = true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "消息发送失败");
		} finally {
			setPending(null);
		}
	}

	function editRequirement(key: RequirementMissingKey) {
		const requirement = session?.currentRequirement;
		if (requirement === null || requirement === undefined) return;
		setEditingRequirementKey(key);
		turnAttemptRef.current = undefined;
		setDraft(
			key === "CONSUMPTION_GOAL"
				? (requirement.consumptionGoal ?? "")
				: key === "PRIMARY_SCENARIO"
					? (requirement.primaryScenario ?? "")
					: requirement.hardConstraints?.length === 0
						? "没有额外硬性条件"
						: (requirement.hardConstraints?.join("\n") ?? ""),
		);
		requestAnimationFrame(() => draftRef.current?.focus());
	}

	const prompt = composerPrompt(
		session?.currentRequirement ?? null,
		editingRequirementKey,
	);
	const latestTask = session?.decisionTasks.at(-1);

	return (
		<main className="conversation-workbench">
			<section
				className="conversation-intro"
				aria-labelledby="conversation-heading"
			>
				<p className="eyebrow">Decision route / 01</p>
				<h1 id="conversation-heading">把消费问题理清，再开始研究</h1>
				<p>
					ChoiceMind
					先确认真正会改变筛选结果的信息，再启动有界研究。未确认的内容会保持未知，不替你猜。
				</p>
			</section>

			<div className="conversation-grid">
				<aside className="session-rail" aria-labelledby="session-list-heading">
					<div className="rail-heading">
						<div>
							<p className="eyebrow">Sessions</p>
							<h2 id="session-list-heading">决策会话</h2>
						</div>
						{summaries.length === 0 ? null : (
							<button
								className="rail-action"
								type="button"
								disabled={pending !== null}
								onClick={() => void createSession()}
							>
								{pending === "CREATE" ? "正在创建" : "新建另一项决策"}
							</button>
						)}
					</div>
					{summaries.length === 0 ? (
						<p className="empty-copy">还没有决策会话</p>
					) : (
						<ol className="session-list">
							{summaries.map((summary) => (
								<li key={summary.sessionId}>
									<button
										type="button"
										disabled={pending !== null}
										aria-current={
											summary.sessionId === session?.sessionId
												? "page"
												: undefined
										}
										onClick={() => void openSession(summary.sessionId)}
									>
										<strong>{summary.title}</strong>
										<span>{summary.latestMessage}</span>
										<small>
											{summary.readiness === "READY_FOR_RESEARCH"
												? "可研究"
												: "继续澄清"}
										</small>
									</button>
								</li>
							))}
						</ol>
					)}
				</aside>

				<section className="dialogue-column" aria-labelledby="dialogue-heading">
					<header className="dialogue-heading">
						<div>
							<p className="eyebrow">Current conversation</p>
							<h2 id="dialogue-heading">
								{session?.title ?? "从一个真实问题开始"}
							</h2>
						</div>
						{session?.currentRequirement === null ? (
							<span className="route-status">等待目标</span>
						) : session?.currentRequirement.readiness ===
							"READY_FOR_RESEARCH" ? (
							<span className="route-status route-status-ready">
								需求已可研究
							</span>
						) : (
							<span className="route-status">还需澄清</span>
						)}
					</header>

					{error === undefined ? null : (
						<p
							className="form-message"
							role="alert"
							tabIndex={-1}
							ref={errorRef}
						>
							{error}
						</p>
					)}
					{loading ? <p className="loading-copy">正在恢复会话…</p> : null}
					{!loading && session === undefined ? (
						<div className="conversation-empty">
							<p className="route-node" aria-hidden="true" />
							<h3>从一次消费判断开始</h3>
							<p>
								可以是“要不要换显示器”，也可以是服务、订阅或任何需要比较证据的消费问题。
							</p>
							<button
								className="primary-action"
								type="button"
								disabled={pending !== null}
								onClick={() => void createSession()}
							>
								{pending === "CREATE" ? "正在创建" : "新建决策"}
							</button>
						</div>
					) : null}

					{session === undefined ? null : (
						<>
							<ol className="message-thread" aria-label="对话记录">
								{session.messages.map((message, index) => {
									const isLatestAssistant =
										message.role === "ASSISTANT" &&
										index === session.messages.length - 1;
									return (
										<li
											key={message.messageId}
											className={`message message-${message.role.toLowerCase()}`}
										>
											<article
												ref={isLatestAssistant ? latestAssistantRef : undefined}
												tabIndex={isLatestAssistant ? -1 : undefined}
											>
												<p className="message-role">
													{message.role === "USER" ? "你" : "ChoiceMind"}
												</p>
												<p>{message.text}</p>
											</article>
										</li>
									);
								})}
							</ol>
							<form
								className="conversation-composer"
								onSubmit={(event) => void submitTurn(event)}
							>
								<label htmlFor="conversation-draft">{prompt.label}</label>
								<textarea
									ref={draftRef}
									id="conversation-draft"
									rows={prompt.key === "HARD_CONSTRAINTS" ? 4 : 3}
									value={draft}
									disabled={pending !== null}
									placeholder={prompt.placeholder}
									onChange={(event) => setDraft(event.target.value)}
								/>
								<div className="composer-footer">
									<p>{prompt.hint}</p>
									<button
										className="primary-action"
										type="submit"
										disabled={pending !== null || draft.trim().length === 0}
									>
										{pending === "SEND" ? "正在发送" : prompt.action}
									</button>
								</div>
							</form>
						</>
					)}
				</section>

				<aside className="context-rail" aria-labelledby="requirement-heading">
					<section>
						<p className="eyebrow">Requirement</p>
						<h2 id="requirement-heading">当前需求</h2>
						<RequirementSummary
							requirement={session?.currentRequirement ?? null}
							onEdit={editRequirement}
						/>
					</section>
					<section
						className="research-state"
						aria-labelledby="research-heading"
					>
						<p className="eyebrow">Background task</p>
						<h2 id="research-heading">研究任务</h2>
						{latestTask === undefined ? (
							<p>
								{session?.currentRequirement?.readiness === "READY_FOR_RESEARCH"
									? "需求已经达到研究门槛。后续任务状态会从权威后台事件进入这里。"
									: "先补齐阻塞研究的信息；ChoiceMind 不会用热门商品填补空白。"}
							</p>
						) : (
							<ConversationTaskProgress
								key={latestTask.decisionTaskId}
								decisionTaskId={latestTask.decisionTaskId}
							/>
						)}
					</section>
					<p
						className={`system-pulse system-pulse-${systemHealth}`}
						role="status"
					>
						<span aria-hidden="true" />
						{systemHealth === "healthy"
							? "本地服务正常"
							: systemHealth === "unhealthy"
								? "部分服务异常"
								: "健康状态暂不可用"}
					</p>
				</aside>
			</div>
		</main>
	);
}

function RequirementSummary({
	requirement,
	onEdit,
}: Readonly<{
	requirement: RequirementRevision | null;
	onEdit: (key: RequirementMissingKey) => void;
}>) {
	if (requirement === null) {
		return <p className="empty-copy">还没有形成 Requirement Revision。</p>;
	}
	return (
		<>
			<dl className="requirement-list">
				<div>
					<dt>消费目标</dt>
					<dd>{requirement.consumptionGoal ?? "待确认"}</dd>
				</div>
				<div>
					<dt>主要场景</dt>
					<dd>{requirement.primaryScenario ?? "待确认"}</dd>
				</div>
				<div>
					<dt>硬性条件</dt>
					<dd>
						{requirement.hardConstraints === null
							? "待确认"
							: requirement.hardConstraints.length === 0
								? "已确认没有额外硬性条件"
								: requirement.hardConstraints.join("；")}
					</dd>
				</div>
				<div>
					<dt>版本</dt>
					<dd>Revision {requirement.revisionNumber}</dd>
				</div>
			</dl>
			<fieldset className="requirement-actions" aria-label="修改当前需求">
				<button type="button" onClick={() => onEdit("CONSUMPTION_GOAL")}>
					修改消费目标
				</button>
				<button type="button" onClick={() => onEdit("PRIMARY_SCENARIO")}>
					修改主要场景
				</button>
				<button type="button" onClick={() => onEdit("HARD_CONSTRAINTS")}>
					修改硬性条件
				</button>
			</fieldset>
		</>
	);
}

function composerPrompt(
	requirement: RequirementRevision | null,
	editingKey?: RequirementMissingKey,
) {
	const missing =
		editingKey ?? requirement?.missingKeys[0] ?? "CONSUMPTION_GOAL";
	if (missing === "CONSUMPTION_GOAL") {
		return {
			key: missing,
			label: "这次想解决什么消费问题？",
			placeholder: "例如：购买一台更适合长期编程的显示器",
			hint: "先说目标，不需要一次写完整。",
			action: editingKey === undefined ? "发送并记录目标" : "更新消费目标",
		} as const;
	}
	if (missing === "PRIMARY_SCENARIO") {
		return {
			key: missing,
			label: "主要使用场景",
			placeholder: "例如：每天长时间编程和办公",
			hint: "写最常见、最影响判断的场景。",
			action: editingKey === undefined ? "发送并记录场景" : "更新主要场景",
		} as const;
	}
	if (missing === "HARD_CONSTRAINTS") {
		return {
			key: missing,
			label: "硬性条件（每行一项）",
			placeholder: "至少 4K\n支持 USB-C 供电",
			hint: "没有硬性条件时，输入“没有额外硬性条件”。",
			action: editingKey === undefined ? "发送并记录硬性条件" : "更新硬性条件",
		} as const;
	}
	return {
		key: "ADDITIONAL_CONTEXT" as const,
		label: "继续补充",
		placeholder: "补充预算、偏好或其他背景；未确认内容不会被猜测。",
		hint: "普通消息会保存，但只有明确需求变化才形成新 Revision。",
		action: "发送补充",
	};
}

function buildRequirementUpdate(
	key: ReturnType<typeof composerPrompt>["key"],
	text: string,
) {
	if (key === "CONSUMPTION_GOAL") return { consumptionGoal: text };
	if (key === "PRIMARY_SCENARIO") return { primaryScenario: text };
	if (key === "HARD_CONSTRAINTS") {
		const noConstraints =
			text === "没有额外硬性条件" || text === "没有硬性条件";
		return {
			hardConstraints: noConstraints
				? []
				: text
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter((line) => line.length > 0),
		};
	}
	return {};
}

function upsertSummary(
	summaries: SessionSummary[],
	session: ConversationSession,
): SessionSummary[] {
	const summary = {
		sessionId: session.sessionId,
		title: session.title,
		latestMessage: session.messages.at(-1)?.text ?? "",
		readiness: session.currentRequirement?.readiness ?? null,
		updatedAt: session.updatedAt,
	};
	return [
		summary,
		...summaries.filter((item) => item.sessionId !== session.sessionId),
	];
}

async function readError(
	response: Response,
	fallback: string,
): Promise<string> {
	try {
		const body = (await response.json()) as { error?: { message?: string } };
		return body.error?.message ?? fallback;
	} catch {
		return fallback;
	}
}
