"use client";

import {
	type FormEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { useManagementRole } from "../management-frame";
import { PasswordInput } from "../password-input";

type Account = Readonly<{
	accountId: string;
	createdAt: string;
	deletionDueAt: string | null;
	role: "ADMIN" | "SUPERADMIN" | "USER";
	status: "ACTIVE" | "DELETED" | "DISABLED" | "PENDING_DELETION";
	username: string;
}>;

type LoadState<T> =
	| { kind: "denied" }
	| { kind: "error" }
	| { kind: "loading" }
	| { kind: "ready"; value: T };

export function AccountsAdmin() {
	const managementRole = useManagementRole();
	const [state, setState] = useState<LoadState<Account[]>>({ kind: "loading" });
	const [temporaryPassword, setTemporaryPassword] = useState("");
	const [error, setError] = useState("");
	const [actionMessage, setActionMessage] = useState("");
	const [pendingOperation, setPendingOperation] = useState("");
	const [pendingAction, setPendingAction] = useState<{
		action: "password-reset" | "status";
		account: Account;
	}>();
	const feedbackRef = useRef<HTMLParagraphElement>(null);

	const load = useCallback(async () => {
		const response = await fetch("/api/identity/accounts", {
			cache: "no-store",
		}).catch(() => undefined);
		if (response?.status === 403) return setState({ kind: "denied" });
		if (!response?.ok) return setState({ kind: "error" });
		const result = (await response.json()) as { accounts: Account[] };
		setState({ kind: "ready", value: result.accounts });
	}, []);

	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		if (
			temporaryPassword.length > 0 ||
			actionMessage.length > 0 ||
			error.length > 0
		) {
			feedbackRef.current?.focus();
		}
	}, [actionMessage, error, temporaryPassword]);

	async function createAccount(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const formElement = event.currentTarget;
		const form = new FormData(formElement);
		setTemporaryPassword("");
		setActionMessage("");
		setError("");
		setPendingOperation("create");
		try {
			const response = await fetch("/api/identity/accounts", {
				body: JSON.stringify({
					role: form.get("role"),
					username: form.get("username"),
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}).catch(() => undefined);
			if (!response?.ok) {
				setError("账号创建失败，请检查用户名或当前权限。");
				return;
			}
			const result = (await response.json()) as { temporaryPassword: string };
			setTemporaryPassword(result.temporaryPassword);
			formElement.reset();
			await load();
		} finally {
			setPendingOperation("");
		}
	}

	async function runAccountAction(
		account: Account,
		action: "password-reset" | "status",
		currentPassword?: FormDataEntryValue | null,
	) {
		setError("");
		setActionMessage("");
		const operation = `${action}:${account.accountId}`;
		setPendingOperation(operation);
		try {
			const response = await fetch(
				`/api/identity/accounts/${account.accountId}/${action}`,
				{
					...(action === "status"
						? {
								body: JSON.stringify({
									...(typeof currentPassword === "string" &&
									currentPassword.length > 0
										? { currentPassword }
										: {}),
									status: account.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
								}),
								headers: { "content-type": "application/json" },
								method: "PATCH",
							}
						: { method: "POST" }),
				},
			).catch(() => undefined);
			if (!response?.ok) {
				setError("账号操作失败，当前角色可能没有权限。");
				return;
			}
			if (action === "password-reset") {
				const result = (await response.json()) as { temporaryPassword: string };
				setTemporaryPassword(result.temporaryPassword);
				setActionMessage("密码已重置，全部旧会话已经失效。");
			} else {
				setActionMessage("账号状态已更新");
			}
			await load();
			setPendingAction(undefined);
		} finally {
			setPendingOperation("");
		}
	}

	async function updateRole(
		event: FormEvent<HTMLFormElement>,
		account: Account,
	) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const operation = `role:${account.accountId}`;
		setPendingOperation(operation);
		try {
			const response = await fetch(
				`/api/identity/accounts/${account.accountId}/role`,
				{
					body: JSON.stringify({
						currentPassword: form.get("currentPassword"),
						role: form.get("role"),
					}),
					headers: { "content-type": "application/json" },
					method: "PATCH",
				},
			).catch(() => undefined);
			if (!response?.ok) {
				setError("角色更新失败，请确认超级管理员密码和 Last SUPERADMIN 保护。");
				return;
			}
			setActionMessage("账号角色已更新");
			await load();
		} finally {
			setPendingOperation("");
		}
	}

	async function requestAccountDeletion(
		event: FormEvent<HTMLFormElement>,
		account: Account,
	) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const operation = `deletion:${account.accountId}`;
		setPendingOperation(operation);
		try {
			const response = await fetch(
				`/api/identity/accounts/${account.accountId}/deletion`,
				{
					body: JSON.stringify({
						currentPassword: form.get("deletionPassword"),
					}),
					headers: { "content-type": "application/json" },
					method: "POST",
				},
			).catch(() => undefined);
			if (!response?.ok) {
				setError("删除申请失败；只有超级管理员可对普通用户执行此操作。");
				return;
			}
			setActionMessage("账号已进入七天等待删除期");
			await load();
		} finally {
			setPendingOperation("");
		}
	}

	if (state.kind === "denied") return <Denied />;
	if (state.kind === "loading")
		return <p className="loading-copy">正在读取账号元数据…</p>;
	if (state.kind === "error") return <LoadError />;
	return (
		<div className="management-stack">
			<section className="ledger-section">
				<h2>创建账号</h2>
				<form className="compact-form" noValidate onSubmit={createAccount}>
					<div className="field">
						<label htmlFor="new-account-username">用户名</label>
						<input id="new-account-username" name="username" />
					</div>
					<div className="field">
						<label htmlFor="new-account-role">角色</label>
						<select id="new-account-role" name="role">
							<option value="USER">普通用户</option>
							{managementRole === "SUPERADMIN" ? (
								<option value="ADMIN">管理员</option>
							) : null}
						</select>
					</div>
					<button
						className="primary-action"
						disabled={pendingOperation === "create"}
						type="submit"
					>
						{pendingOperation === "create" ? "正在创建…" : "创建账号"}
					</button>
				</form>
				{temporaryPassword.length > 0 ? (
					<p ref={feedbackRef} className="one-time-secret" tabIndex={-1}>
						一次性临时密码：<code>{temporaryPassword}</code>
					</p>
				) : null}
				{actionMessage.length > 0 ? (
					<p
						ref={feedbackRef}
						className="success-message"
						role="status"
						tabIndex={-1}
					>
						{actionMessage}
					</p>
				) : null}
				{error.length > 0 ? (
					<p
						ref={feedbackRef}
						className="form-message"
						role="alert"
						tabIndex={-1}
					>
						{error}
					</p>
				) : null}
			</section>
			<section className="ledger-section">
				<h2>账号元数据</h2>
				<div className="table-scroll">
					<table>
						<thead>
							<tr>
								<th>用户名</th>
								<th>角色</th>
								<th>状态</th>
								<th>创建时间</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{state.value.map((account) => (
								<tr key={account.accountId}>
									<th scope="row">{account.username}</th>
									<td>{account.role}</td>
									<td>{account.status}</td>
									<td>
										<time dateTime={account.createdAt}>
											{formatDate(account.createdAt)}
										</time>
									</td>
									<td className="account-actions">
										{canResetAccountPassword(managementRole, account) ? (
											<button
												type="button"
												disabled={pendingOperation.length > 0}
												onClick={() =>
													setPendingAction({
														action: "password-reset",
														account,
													})
												}
												aria-label={`重置 ${account.username} 的密码`}
											>
												重置密码
											</button>
										) : null}
										{canSetAccountStatus(managementRole, account) ? (
											<button
												type="button"
												disabled={pendingOperation.length > 0}
												onClick={() =>
													setPendingAction({ action: "status", account })
												}
												aria-label={`${account.status === "ACTIVE" ? "停用" : "启用"} ${account.username}`}
											>
												{account.status === "ACTIVE" ? "停用" : "启用"}
											</button>
										) : null}
										{pendingAction?.account.accountId === account.accountId ? (
											<form
												className="action-confirmation"
												noValidate
												role="alertdialog"
												aria-label={`${pendingAction.action === "password-reset" ? "重置密码" : account.status === "ACTIVE" ? "停用账号" : "启用账号"}确认`}
												onSubmit={(event) => {
													event.preventDefault();
													const form = new FormData(event.currentTarget);
													void runAccountAction(
														account,
														pendingAction.action,
														form.get("currentPassword"),
													);
												}}
											>
												<p>
													{pendingAction.action === "password-reset"
														? "将撤销该用户全部登录状态，并签发仅展示一次的临时密码。"
														: account.status === "ACTIVE"
															? "将立即退出该用户并取消进行中的任务；私人数据仍会保留。"
															: "将允许该用户重新登录，原有私人数据继续保留。"}
												</p>
												{pendingAction.action === "status" &&
												account.role === "SUPERADMIN" ? (
													<div className="field">
														<label
															htmlFor={`status-password-${account.accountId}`}
														>
															{account.status === "ACTIVE" ? "停用" : "启用"}
															超级管理员确认密码
														</label>
														<PasswordInput
															autoComplete="current-password"
															disabled={
																pendingOperation ===
																`${pendingAction.action}:${account.accountId}`
															}
															id={`status-password-${account.accountId}`}
															name="currentPassword"
															required
															revealLabel={`${account.status === "ACTIVE" ? "停用" : "启用"}超级管理员确认密码`}
														/>
													</div>
												) : null}
												<button
													className={
														account.status === "ACTIVE"
															? "danger-action"
															: "secondary-action"
													}
													disabled={
														pendingOperation ===
														`${pendingAction.action}:${account.accountId}`
													}
													type="submit"
												>
													{pendingOperation ===
													`${pendingAction.action}:${account.accountId}`
														? pendingAction.action === "password-reset"
															? "正在重置…"
															: account.status === "ACTIVE"
																? "正在停用…"
																: "正在启用…"
														: pendingAction.action === "password-reset"
															? "确认重置密码"
															: account.status === "ACTIVE"
																? "确认停用"
																: "确认启用"}
												</button>
												<button
													type="button"
													disabled={
														pendingOperation ===
														`${pendingAction.action}:${account.accountId}`
													}
													onClick={() => setPendingAction(undefined)}
												>
													取消
												</button>
											</form>
										) : null}
										{canManageAccountRole(managementRole, account) ? (
											<details>
												<summary>角色与删除</summary>
												<form
													className="row-action-form"
													noValidate
													onSubmit={(event) => updateRole(event, account)}
												>
													<div className="field">
														<label htmlFor={`role-${account.accountId}`}>
															目标角色
														</label>
														<select
															id={`role-${account.accountId}`}
															name="role"
															defaultValue={account.role}
															disabled={
																pendingOperation === `role:${account.accountId}`
															}
														>
															<option value="USER">USER</option>
															<option value="ADMIN">ADMIN</option>
															<option value="SUPERADMIN">SUPERADMIN</option>
														</select>
													</div>
													<div className="field">
														<label
															htmlFor={`role-password-${account.accountId}`}
														>
															超级管理员当前密码
														</label>
														<PasswordInput
															id={`role-password-${account.accountId}`}
															name="currentPassword"
															revealLabel="超级管理员当前密码"
															autoComplete="current-password"
															disabled={
																pendingOperation === `role:${account.accountId}`
															}
														/>
													</div>
													<button
														className="secondary-action"
														disabled={
															pendingOperation === `role:${account.accountId}`
														}
														type="submit"
													>
														{pendingOperation === `role:${account.accountId}`
															? "正在更新…"
															: "更新角色"}
													</button>
												</form>
												{canRequestAccountDeletion(managementRole, account) ? (
													<form
														className="row-action-form"
														noValidate
														onSubmit={(event) =>
															requestAccountDeletion(event, account)
														}
													>
														<div className="field">
															<label
																htmlFor={`delete-password-${account.accountId}`}
															>
																删除操作确认密码
															</label>
															<PasswordInput
																id={`delete-password-${account.accountId}`}
																name="deletionPassword"
																revealLabel="删除操作确认密码"
																autoComplete="current-password"
																disabled={
																	pendingOperation ===
																	`deletion:${account.accountId}`
																}
															/>
														</div>
														<button
															className="danger-action"
															disabled={
																pendingOperation ===
																`deletion:${account.accountId}`
															}
															type="submit"
														>
															{pendingOperation ===
															`deletion:${account.accountId}`
																? "正在提交删除申请…"
																: "进入等待删除"}
														</button>
													</form>
												) : null}
											</details>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
}

type Invitation = Readonly<{
	createdAt: string;
	expiresAt: string;
	invitationId: string;
	status: string;
}>;

export function InvitationsAdmin() {
	const [state, setState] = useState<LoadState<Invitation[]>>({
		kind: "loading",
	});
	const [created, setCreated] = useState<{ code: string; link: string }>();
	const [actionMessage, setActionMessage] = useState("");
	const [error, setError] = useState("");
	const [pendingOperation, setPendingOperation] = useState("");
	const [pendingRevocation, setPendingRevocation] = useState<string>();
	const resultRef = useRef<HTMLDivElement>(null);
	const feedbackRef = useRef<HTMLParagraphElement>(null);

	const load = useCallback(async () => {
		const response = await fetch("/api/identity/invitations", {
			cache: "no-store",
		}).catch(() => undefined);
		if (response?.status === 403) return setState({ kind: "denied" });
		if (!response?.ok) return setState({ kind: "error" });
		const result = (await response.json()) as { invitations: Invitation[] };
		setState({ kind: "ready", value: result.invitations });
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		if (created !== undefined) resultRef.current?.focus();
	}, [created]);
	useEffect(() => {
		if (actionMessage.length > 0 || error.length > 0) {
			feedbackRef.current?.focus();
		}
	}, [actionMessage, error]);

	async function createInvitation() {
		setCreated(undefined);
		setActionMessage("");
		setError("");
		setPendingOperation("create");
		try {
			const response = await fetch("/api/identity/invitations", {
				method: "POST",
			}).catch(() => undefined);
			if (!response?.ok) {
				setError("邀请创建失败，请检查当前权限或稍后重试。");
				return;
			}
			const result = (await response.json()) as { invitationCode: string };
			setCreated({
				code: result.invitationCode,
				link: `${window.location.origin}/register?code=${result.invitationCode}`,
			});
			await load();
		} finally {
			setPendingOperation("");
		}
	}

	async function revokeInvitation(invitationId: string) {
		setActionMessage("");
		setError("");
		const operation = `revoke:${invitationId}`;
		setPendingOperation(operation);
		try {
			const response = await fetch(
				`/api/identity/invitations/${invitationId}`,
				{
					method: "DELETE",
				},
			).catch(() => undefined);
			if (!response?.ok) {
				setError("邀请撤销失败，请保留当前页面并稍后重试。");
				return;
			}
			setActionMessage("邀请已撤销");
			await load();
			setPendingRevocation(undefined);
		} finally {
			setPendingOperation("");
		}
	}

	if (state.kind === "denied") return <Denied />;
	if (state.kind === "loading")
		return <p className="loading-copy">正在读取邀请…</p>;
	if (state.kind === "error") return <LoadError />;
	return (
		<div className="management-stack">
			<section className="ledger-section">
				<h2>签发邀请</h2>
				<p>
					邀请码七天有效且只能使用一次，由管理员通过 ChoiceMind 之外的渠道发送。
				</p>
				<button
					className="primary-action"
					disabled={pendingOperation === "create"}
					type="button"
					onClick={createInvitation}
				>
					{pendingOperation === "create" ? "正在创建…" : "创建邀请"}
				</button>
				{created === undefined ? null : (
					<div ref={resultRef} className="one-time-secret" tabIndex={-1}>
						<p>
							邀请码：<code>{created.code}</code>
						</p>
						<p>
							注册链接：<code>{created.link}</code>
						</p>
						<p>邀请码不会再次显示，请现在复制。</p>
					</div>
				)}
				{actionMessage.length > 0 ? (
					<p
						ref={feedbackRef}
						className="success-message"
						role="status"
						tabIndex={-1}
					>
						{actionMessage}
					</p>
				) : null}
				{error.length > 0 ? (
					<p
						ref={feedbackRef}
						className="form-message"
						role="alert"
						tabIndex={-1}
					>
						{error}
					</p>
				) : null}
			</section>
			<section className="ledger-section">
				<h2>邀请记录</h2>
				{state.value.length === 0 ? (
					<p>还没有邀请记录。</p>
				) : (
					<div className="table-scroll">
						<table>
							<thead>
								<tr>
									<th>编号</th>
									<th>状态</th>
									<th>到期时间</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{state.value.map((item) => (
									<tr key={item.invitationId}>
										<th scope="row">
											<code>{item.invitationId}</code>
										</th>
										<td>{item.status}</td>
										<td>{formatDate(item.expiresAt)}</td>
										<td>
											{item.status === "ACTIVE" ? (
												pendingRevocation === item.invitationId ? (
													<div
														className="action-confirmation"
														role="alertdialog"
														aria-label="撤销邀请确认"
													>
														<p>撤销后该邀请码将立即失效，且不能恢复。</p>
														<button
															className="danger-action"
															disabled={
																pendingOperation ===
																`revoke:${item.invitationId}`
															}
															type="button"
															onClick={() =>
																revokeInvitation(item.invitationId)
															}
														>
															{pendingOperation ===
															`revoke:${item.invitationId}`
																? "正在撤销…"
																: "确认撤销"}
														</button>
														<button
															disabled={
																pendingOperation ===
																`revoke:${item.invitationId}`
															}
															type="button"
															onClick={() => setPendingRevocation(undefined)}
														>
															取消
														</button>
													</div>
												) : (
													<button
														className="secondary-action"
														disabled={pendingOperation.length > 0}
														type="button"
														aria-label={`撤销邀请 ${item.invitationId}`}
														onClick={() =>
															setPendingRevocation(item.invitationId)
														}
													>
														撤销
													</button>
												)
											) : (
												"—"
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}

type AuditRecord = Readonly<{
	action: string;
	auditId: string;
	occurredAt: string;
	result: string;
	object: { id: string; type: string };
}>;

export function AuditAdmin() {
	const [state, setState] = useState<LoadState<AuditRecord[]>>({
		kind: "loading",
	});
	useEffect(() => {
		void fetch("/api/identity/audit-records", { cache: "no-store" })
			.then(async (response) => {
				if (response.status === 403) return setState({ kind: "denied" });
				if (!response.ok) return setState({ kind: "error" });
				const result = (await response.json()) as { records: AuditRecord[] };
				setState({ kind: "ready", value: result.records });
			})
			.catch(() => setState({ kind: "error" }));
	}, []);
	if (state.kind === "denied") return <Denied />;
	if (state.kind === "loading")
		return <p className="loading-copy">正在读取审计记录…</p>;
	if (state.kind === "error") return <LoadError />;
	return (
		<section className="ledger-section">
			<p>记录保留 180 天，不包含密码、Cookie、API Key 或用户私人内容。</p>
			<div className="table-scroll">
				<table>
					<thead>
						<tr>
							<th>动作</th>
							<th>结果</th>
							<th>对象</th>
							<th>时间</th>
						</tr>
					</thead>
					<tbody>
						{state.value.map((record) => (
							<tr key={record.auditId}>
								<th scope="row">
									<code>{record.action}</code>
								</th>
								<td>{record.result}</td>
								<td>
									<code>
										{record.object.type}/{record.object.id}
									</code>
								</td>
								<td>{formatDate(record.occurredAt)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function Denied() {
	return (
		<div className="permission-state">
			<h2>没有管理权限</h2>
			<p>当前账号不能查看或操作这部分账号元数据。</p>
		</div>
	);
}
function LoadError() {
	return (
		<div className="permission-state">
			<h2>管理数据暂时不可用</h2>
			<p>请确认本地服务仍在运行，然后刷新页面。</p>
		</div>
	);
}
function formatDate(value: string) {
	return new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

function hasMutableStatus(account: Account): boolean {
	return account.status === "ACTIVE" || account.status === "DISABLED";
}

function canResetAccountPassword(
	managementRole: Account["role"],
	account: Account,
): boolean {
	return (
		hasMutableStatus(account) &&
		account.role !== "SUPERADMIN" &&
		(managementRole === "SUPERADMIN" || account.role === "USER")
	);
}

function canSetAccountStatus(
	managementRole: Account["role"],
	account: Account,
): boolean {
	return (
		hasMutableStatus(account) &&
		(managementRole === "SUPERADMIN" || account.role === "USER")
	);
}

function canManageAccountRole(
	managementRole: Account["role"],
	account: Account,
): boolean {
	return managementRole === "SUPERADMIN" && hasMutableStatus(account);
}

function canRequestAccountDeletion(
	managementRole: Account["role"],
	account: Account,
): boolean {
	return (
		managementRole === "SUPERADMIN" &&
		account.role === "USER" &&
		account.status === "ACTIVE"
	);
}
