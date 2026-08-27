"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { PasswordInput } from "../password-input";
import { PasswordStrengthHint } from "../password-strength-hint";

export function RecoveryForm() {
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const [newRecoveryCode, setNewRecoveryCode] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const errorRef = useRef<HTMLParagraphElement>(null);
	const resultRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (error.length > 0) errorRef.current?.focus();
	}, [error]);
	useEffect(() => {
		if (newRecoveryCode.length > 0) resultRef.current?.focus();
	}, [newRecoveryCode]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError("");
		const form = new FormData(event.currentTarget);
		const recoveryCode = String(form.get("recoveryCode") ?? "");
		const newPassword = String(form.get("newPassword") ?? "");
		const confirmation = String(form.get("confirmation") ?? "");
		if (!/^[\x21-\x7e]{6,}$/u.test(newPassword))
			return setError("新密码格式不符合要求。");
		if (newPassword !== confirmation)
			return setError("两次输入的新密码不一致。");
		setPending(true);
		try {
			const response = await fetch("/api/identity/recovery", {
				body: JSON.stringify({ newPassword, recoveryCode }),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			const result = (await response.json()) as { recoveryCode?: string };
			if (!response.ok || result.recoveryCode === undefined) {
				setError(
					"恢复失败。只有本机且没有其他可用超级管理员时才能使用有效恢复码。",
				);
				return;
			}
			setNewRecoveryCode(result.recoveryCode);
		} catch {
			setError("暂时无法连接身份服务，请稍后重试。");
		} finally {
			setPending(false);
		}
	}

	if (newRecoveryCode.length > 0) {
		return (
			<div className="auth-panel">
				<p className="eyebrow">恢复完成</p>
				<h2>保存新的恢复码</h2>
				<p className="lede">旧恢复码已经失效；新码同样只显示这一次。</p>
				<div ref={resultRef} className="recovery-result" tabIndex={-1}>
					<code className="recovery-code">{newRecoveryCode}</code>
				</div>
			</div>
		);
	}

	return (
		<div className="auth-panel">
			<p className="eyebrow">本机离线恢复</p>
			<h2>恢复超级管理员</h2>
			<p className="lede">
				此入口只用于所有超级管理员均不可用的紧急情况，不依赖邮箱或网络。
			</p>
			<form className="auth-form" noValidate onSubmit={submit}>
				{error.length > 0 ? (
					<p ref={errorRef} className="form-message" role="alert" tabIndex={-1}>
						{error}
					</p>
				) : null}
				<div className="field">
					<label htmlFor="recovery-code">现有恢复码</label>
					<input id="recovery-code" name="recoveryCode" autoComplete="off" />
				</div>
				<div className="field">
					<label htmlFor="recovery-password">新密码</label>
					<PasswordInput
						id="recovery-password"
						name="newPassword"
						revealLabel="新密码"
						autoComplete="new-password"
						onChange={(event) => setNewPassword(event.currentTarget.value)}
					/>
					<PasswordStrengthHint password={newPassword} />
				</div>
				<div className="field">
					<label htmlFor="recovery-confirmation">确认新密码</label>
					<PasswordInput
						id="recovery-confirmation"
						name="confirmation"
						revealLabel="确认新密码"
						autoComplete="new-password"
					/>
				</div>
				<button className="primary-action" disabled={pending} type="submit">
					{pending ? "正在恢复…" : "恢复超级管理员"}
				</button>
			</form>
		</div>
	);
}
