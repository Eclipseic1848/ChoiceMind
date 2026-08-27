"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { PasswordInput } from "./password-input";
import { PasswordStrengthHint } from "./password-strength-hint";

type FormMode = "login" | "register" | "setup";
type SetupAccess = "allowed" | "checking" | "denied" | "error";

const content: Record<
	FormMode,
	{ eyebrow: string; heading: string; intro: string; submit: string }
> = {
	login: {
		eyebrow: "继续你的决策",
		heading: "登录 ChoiceMind",
		intro: "使用管理员为你创建或邀请注册的账号。ChoiceMind 不开放公共注册。",
		submit: "登录 ChoiceMind",
	},
	register: {
		eyebrow: "受邀加入",
		heading: "接受邀请",
		intro: "设置你的用户名和密码。邀请只能使用一次，账号创建后用户名不可修改。",
		submit: "创建账号",
	},
	setup: {
		eyebrow: "本机初始化",
		heading: "建立第一个管理员",
		intro: "这是仅限本机执行的一次性步骤。完成后请立即保存恢复码。",
		submit: "完成初始化",
	},
};

export function CredentialForm({
	invitationCode,
	mode,
}: Readonly<{ invitationCode?: string; mode: FormMode }>) {
	const router = useRouter();
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const [password, setPassword] = useState("");
	const [recoveryCode, setRecoveryCode] = useState<string>();
	const [setupAccess, setSetupAccess] = useState<SetupAccess>(
		mode === "setup" ? "checking" : "allowed",
	);
	const errorRef = useRef<HTMLParagraphElement>(null);
	const recoveryRef = useRef<HTMLDivElement>(null);
	const copy = content[mode];

	useEffect(() => {
		if (error.length > 0) errorRef.current?.focus();
	}, [error]);
	useEffect(() => {
		if (recoveryCode !== undefined) recoveryRef.current?.focus();
	}, [recoveryCode]);

	useEffect(() => {
		if (mode !== "setup") return;
		void fetch("/api/identity/bootstrap", { cache: "no-store" })
			.then(async (response) => {
				if (response.status === 403) return setSetupAccess("denied");
				if (!response.ok) return setSetupAccess("error");
				const result = (await response.json()) as { required?: boolean };
				if (result.required === false) {
					router.replace("/login");
					return;
				}
				setSetupAccess("allowed");
			})
			.catch(() => setSetupAccess("error"));
	}, [mode, router]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError("");
		const form = new FormData(event.currentTarget);
		const username = String(form.get("username") ?? "");
		const password = String(form.get("password") ?? "");
		const confirmation = String(form.get("passwordConfirmation") ?? "");

		if (!/^[A-Za-z0-9_\u3400-\u9fff]{2,32}$/u.test(username)) {
			return setError("用户名需要 2–32 个汉字、英文字母、数字或下划线。");
		}
		if (!/^[\x21-\x7e]{6,}$/u.test(password)) {
			return setError(
				"密码至少 6 位，只能使用英文、数字和常见符号，不能包含空格。",
			);
		}
		if (mode !== "login" && password !== confirmation) {
			return setError("两次输入的密码不一致。");
		}
		if (mode === "register" && invitationCode === undefined) {
			return setError("邀请链接缺少邀请码，请向管理员重新获取。");
		}

		setPending(true);
		try {
			const endpoint =
				mode === "setup"
					? "bootstrap"
					: mode === "register"
						? "registrations"
						: "login";
			const response = await fetch(`/api/identity/${endpoint}`, {
				body: JSON.stringify({
					...(mode === "register" ? { invitationCode } : {}),
					password,
					username,
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			const result = (await response.json().catch(() => ({}))) as Record<
				string,
				unknown
			>;
			if (!response.ok) {
				setError(messageForFailure(result.code, response.status));
				return;
			}
			if (mode === "setup") {
				setRecoveryCode(String(result.recoveryCode ?? ""));
				return;
			}
			router.replace(
				result.access === "PASSWORD_CHANGE_REQUIRED"
					? "/password-change"
					: result.access === "DELETION_PENDING"
						? "/deletion-pending"
						: "/",
			);
			router.refresh();
		} catch {
			setError("暂时无法连接身份服务。你的输入已保留，请稍后重试。");
		} finally {
			setPending(false);
		}
	}

	if (recoveryCode !== undefined) {
		return (
			<div className="auth-panel">
				<p className="eyebrow">初始化完成</p>
				<h2>保存恢复码</h2>
				<p className="lede">
					它只显示这一次。请存放在密码管理器或其他安全位置。
				</p>
				<div ref={recoveryRef} className="recovery-result" tabIndex={-1}>
					<code className="recovery-code">{recoveryCode}</code>
					<p className="field-hint">
						恢复码可在所有超级管理员不可用时从本机恢复访问。
					</p>
				</div>
				<button
					className="primary-action"
					type="button"
					onClick={() => router.replace("/")}
				>
					我已安全保存，进入工作台
				</button>
			</div>
		);
	}

	if (setupAccess === "checking") {
		return (
			<div className="auth-panel" aria-live="polite">
				<p className="eyebrow">本机初始化</p>
				<h2>正在确认本机设置状态…</h2>
			</div>
		);
	}

	if (setupAccess === "denied") {
		return (
			<div className="auth-panel permission-state">
				<p className="eyebrow">访问受限</p>
				<h2>首次设置仅限本机</h2>
				<p>请在运行 ChoiceMind 的 Windows 电脑上打开此页面。</p>
			</div>
		);
	}

	if (setupAccess === "error") {
		return (
			<div className="auth-panel permission-state">
				<p className="eyebrow">服务不可用</p>
				<h2>暂时无法确认设置状态</h2>
				<p>请确认本地服务仍在运行，然后重试。</p>
				<button type="button" onClick={() => window.location.reload()}>
					重新检查
				</button>
			</div>
		);
	}

	return (
		<div className="auth-panel">
			<p className="eyebrow">{copy.eyebrow}</p>
			<h2>{copy.heading}</h2>
			<p className="lede">{copy.intro}</p>
			<form className="auth-form" noValidate onSubmit={submit}>
				{error.length > 0 ? (
					<p ref={errorRef} className="form-message" role="alert" tabIndex={-1}>
						{error}
					</p>
				) : null}
				<div className="field">
					<label htmlFor={`${mode}-username`}>用户名</label>
					<input
						autoComplete="username"
						id={`${mode}-username`}
						name="username"
						required
						spellCheck={false}
					/>
					<p className="field-hint">2–32 个汉字、英文字母、数字或下划线。</p>
				</div>
				<div className="field">
					<label htmlFor={`${mode}-password`}>密码</label>
					<PasswordInput
						autoComplete={
							mode === "login" ? "current-password" : "new-password"
						}
						id={`${mode}-password`}
						name="password"
						onChange={(event) => setPassword(event.currentTarget.value)}
						required
						revealLabel="密码"
					/>
					{mode === "login" ? (
						<p className="field-hint">至少 6 位英文、数字或符号。</p>
					) : (
						<PasswordStrengthHint password={password} />
					)}
				</div>
				{mode === "login" ? null : (
					<div className="field">
						<label htmlFor={`${mode}-password-confirmation`}>确认密码</label>
						<PasswordInput
							autoComplete="new-password"
							id={`${mode}-password-confirmation`}
							name="passwordConfirmation"
							required
							revealLabel="确认密码"
						/>
					</div>
				)}
				<button className="primary-action" disabled={pending} type="submit">
					{pending ? "正在处理…" : copy.submit}
				</button>
			</form>
		</div>
	);
}

function messageForFailure(code: unknown, status: number): string {
	switch (code) {
		case "INVALID_CREDENTIALS":
			return "用户名或密码不正确。";
		case "LOGIN_THROTTLED":
			return "尝试次数过多，请约 30 秒后再试。";
		case "INVITATION_INVALID":
			return "邀请已失效、已被撤销或已经使用，请向管理员重新获取。";
		case "BOOTSTRAP_ALREADY_COMPLETE":
			return "初始化已经完成，请直接登录。";
		case "BOOTSTRAP_LOCAL_ONLY":
			return "首次初始化只能在运行 ChoiceMind 的本机完成。";
		default:
			return status >= 500
				? "身份服务暂时不可用，请稍后重试。"
				: "提交内容未通过校验。";
	}
}
