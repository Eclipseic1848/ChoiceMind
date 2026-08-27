"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { PasswordInput } from "../password-input";
import { PasswordStrengthHint } from "../password-strength-hint";

export function SecurityPanel() {
	const router = useRouter();
	const [ready, setReady] = useState(false);
	const [message, setMessage] = useState("");
	const [pendingOperation, setPendingOperation] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const messageRef = useRef<HTMLParagraphElement>(null);

	useEffect(() => {
		void fetch("/api/identity/me", { cache: "no-store" }).then(
			async (response) => {
				if (!response.ok) return router.replace("/login");
				const result = (await response.json()) as { access: string };
				if (result.access === "PASSWORD_CHANGE_REQUIRED")
					return router.replace("/password-change");
				if (result.access === "DELETION_PENDING")
					return router.replace("/deletion-pending");
				setReady(true);
			},
		);
	}, [router]);
	useEffect(() => {
		if (message.length > 0) messageRef.current?.focus();
	}, [message]);

	async function changePassword(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const currentPassword = String(form.get("currentPassword") ?? "");
		const newPassword = String(form.get("newPassword") ?? "");
		const confirmation = String(form.get("passwordConfirmation") ?? "");
		if (!/^[\x21-\x7e]{6,}$/u.test(newPassword))
			return setMessage("新密码格式不符合要求。");
		if (newPassword !== confirmation)
			return setMessage("两次输入的新密码不一致。");
		setPendingOperation("change-password");
		try {
			const response = await fetch("/api/identity/password", {
				body: JSON.stringify({ currentPassword, newPassword }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}).catch(() => undefined);
			if (response?.ok) {
				router.replace("/login");
				router.refresh();
			} else {
				setMessage("密码修改失败，请检查当前密码后重试。");
			}
		} finally {
			setPendingOperation("");
		}
	}

	async function logout(scope: "ALL" | "CURRENT") {
		const operation = scope === "CURRENT" ? "logout-current" : "logout-all";
		setPendingOperation(operation);
		try {
			const response = await fetch("/api/identity/logout", {
				body: JSON.stringify({ scope }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}).catch(() => undefined);
			if (response?.ok) router.replace("/login");
			else setMessage("退出失败，请稍后重试。");
		} finally {
			setPendingOperation("");
		}
	}

	async function requestDeletion(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const currentPassword = String(form.get("deletionPassword") ?? "");
		setPendingOperation("delete-account");
		try {
			const response = await fetch("/api/identity/deletion", {
				body: JSON.stringify({ currentPassword }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}).catch(() => undefined);
			if (response?.ok) {
				router.replace("/login?deletion=requested");
				router.refresh();
			} else {
				setMessage("删除申请失败，请检查确认密码后重试。");
			}
		} finally {
			setPendingOperation("");
		}
	}

	if (!ready) return <p className="loading-copy">正在确认账号状态…</p>;

	return (
		<div className="management-stack">
			<section
				className="ledger-section"
				aria-labelledby="change-password-title"
			>
				<h2 id="change-password-title">修改密码</h2>
				<p>修改后所有设备都会退出，需要使用新密码重新登录。</p>
				<form className="inline-form" noValidate onSubmit={changePassword}>
					<div className="field">
						<label htmlFor="current-password">当前密码</label>
						<PasswordInput
							id="current-password"
							name="currentPassword"
							revealLabel="当前密码"
							autoComplete="current-password"
						/>
					</div>
					<div className="field">
						<label htmlFor="security-new-password">新密码</label>
						<PasswordInput
							id="security-new-password"
							name="newPassword"
							revealLabel="新密码"
							autoComplete="new-password"
							onChange={(event) => setNewPassword(event.currentTarget.value)}
						/>
						<PasswordStrengthHint password={newPassword} />
					</div>
					<div className="field">
						<label htmlFor="security-confirmation">确认新密码</label>
						<PasswordInput
							id="security-confirmation"
							name="passwordConfirmation"
							revealLabel="确认新密码"
							autoComplete="new-password"
						/>
					</div>
					<button
						className="primary-action"
						disabled={pendingOperation.length > 0}
						type="submit"
					>
						{pendingOperation === "change-password" ? "正在修改…" : "修改密码"}
					</button>
				</form>
			</section>
			<section className="ledger-section" aria-labelledby="sessions-title">
				<h2 id="sessions-title">登录设备</h2>
				<p>
					当前会话固定有效七天。你可以只退出当前设备，也可以终止全部设备会话。
				</p>
				<div className="button-row">
					<button
						className="secondary-action"
						disabled={pendingOperation.length > 0}
						type="button"
						onClick={() => logout("CURRENT")}
					>
						{pendingOperation === "logout-current"
							? "正在退出当前设备…"
							: "退出当前设备"}
					</button>
					<button
						className="secondary-action"
						disabled={pendingOperation.length > 0}
						type="button"
						onClick={() => logout("ALL")}
					>
						{pendingOperation === "logout-all"
							? "正在退出全部设备…"
							: "退出全部设备"}
					</button>
				</div>
			</section>
			<section
				className="ledger-section danger-section"
				aria-labelledby="delete-account-title"
			>
				<h2 id="delete-account-title">删除账号</h2>
				<p>
					申请后立即退出全部设备并停止进行中的任务，七天内重新登录可以取消。
				</p>
				<form className="inline-form" noValidate onSubmit={requestDeletion}>
					<div className="field">
						<label htmlFor="deletion-password">删除确认密码</label>
						<PasswordInput
							id="deletion-password"
							name="deletionPassword"
							revealLabel="删除确认密码"
							autoComplete="current-password"
						/>
					</div>
					<button
						className="danger-action"
						disabled={pendingOperation.length > 0}
						type="submit"
					>
						{pendingOperation === "delete-account"
							? "正在提交删除申请…"
							: "申请删除账号"}
					</button>
				</form>
			</section>
			{message.length > 0 ? (
				<p ref={messageRef} className="form-message" role="alert" tabIndex={-1}>
					{message}
				</p>
			) : null}
		</div>
	);
}
