"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { PasswordInput } from "./password-input";
import { PasswordStrengthHint } from "./password-strength-hint";

export function TemporaryPasswordForm() {
	const router = useRouter();
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const [newPassword, setNewPassword] = useState("");
	const errorRef = useRef<HTMLParagraphElement>(null);

	useEffect(() => {
		if (error.length > 0) errorRef.current?.focus();
	}, [error]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError("");
		const form = new FormData(event.currentTarget);
		const newPassword = String(form.get("newPassword") ?? "");
		const confirmation = String(form.get("passwordConfirmation") ?? "");
		if (!/^[\x21-\x7e]{6,}$/u.test(newPassword)) {
			return setError(
				"新密码至少 6 位，只能使用英文、数字和常见符号，不能包含空格。",
			);
		}
		if (newPassword !== confirmation)
			return setError("两次输入的新密码不一致。");

		setPending(true);
		try {
			const response = await fetch("/api/identity/password/temporary", {
				body: JSON.stringify({ newPassword }),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			if (!response.ok) {
				setError("临时密码会话已失效，请重新登录或联系管理员重置密码。");
				return;
			}
			router.replace("/");
			router.refresh();
		} catch {
			setError("暂时无法连接身份服务，请稍后重试。");
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="auth-panel">
			<p className="eyebrow">首次登录</p>
			<h2>设置新密码</h2>
			<p className="lede">
				管理员提供的临时密码只能使用一次。设置成功后，其他会话会立即失效。
			</p>
			<form className="auth-form" noValidate onSubmit={submit}>
				{error.length > 0 ? (
					<p ref={errorRef} className="form-message" role="alert" tabIndex={-1}>
						{error}
					</p>
				) : null}
				<div className="field">
					<label htmlFor="temporary-new-password">新密码</label>
					<PasswordInput
						id="temporary-new-password"
						name="newPassword"
						revealLabel="新密码"
						autoComplete="new-password"
						onChange={(event) => setNewPassword(event.currentTarget.value)}
					/>
					<PasswordStrengthHint password={newPassword} />
				</div>
				<div className="field">
					<label htmlFor="temporary-password-confirmation">确认新密码</label>
					<PasswordInput
						id="temporary-password-confirmation"
						name="passwordConfirmation"
						revealLabel="确认新密码"
						autoComplete="new-password"
					/>
				</div>
				<button className="primary-action" disabled={pending} type="submit">
					{pending ? "正在保存…" : "保存新密码"}
				</button>
			</form>
		</div>
	);
}

type SessionState = Readonly<{
	access: "DELETION_PENDING" | "FULL" | "PASSWORD_CHANGE_REQUIRED";
	account: Readonly<{ username: string }>;
	deletionDueAt?: string;
}>;

export function DeletionPendingPanel() {
	const router = useRouter();
	const [session, setSession] = useState<SessionState>();
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const errorRef = useRef<HTMLParagraphElement>(null);

	useEffect(() => {
		void fetch("/api/identity/me", { cache: "no-store" })
			.then(async (response) => ({
				ok: response.ok,
				value: (await response.json()) as SessionState,
			}))
			.then(({ ok, value }) => {
				if (!ok || value.access !== "DELETION_PENDING")
					router.replace("/login");
				else setSession(value);
			})
			.catch(() => setError("暂时无法读取账号删除状态。"));
	}, [router]);
	useEffect(() => {
		if (error.length > 0) errorRef.current?.focus();
	}, [error]);

	async function cancelDeletion() {
		setPending(true);
		setError("");
		try {
			const response = await fetch("/api/identity/deletion/cancel", {
				method: "POST",
			});
			if (!response.ok) {
				setError("取消失败，会话可能已经失效，请重新登录后再试。");
				return;
			}
			router.replace("/");
			router.refresh();
		} catch {
			setError("暂时无法连接身份服务，请稍后重试。");
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="auth-panel">
			<p className="eyebrow">受限账号</p>
			<h2>账号正在等待删除</h2>
			<p className="lede">
				等待期内，所有登录和进行中的任务已停止。你只能取消删除或退出，不能进入工作台。
			</p>
			<div className="recovery-result">
				<p>账号：{session?.account.username ?? "正在读取…"}</p>
				<p>
					预计删除时间：
					<time dateTime={session?.deletionDueAt}>
						{formatDateTime(session?.deletionDueAt)}
					</time>
				</p>
			</div>
			{error.length > 0 ? (
				<p ref={errorRef} className="form-message" role="alert" tabIndex={-1}>
					{error}
				</p>
			) : null}
			<button
				className="primary-action"
				disabled={pending || session === undefined}
				type="button"
				onClick={cancelDeletion}
			>
				{pending ? "正在取消…" : "取消删除"}
			</button>
		</div>
	);
}

function formatDateTime(value: string | undefined): string {
	if (value === undefined) return "正在读取…";
	return new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "long",
		timeStyle: "short",
	}).format(new Date(value));
}
