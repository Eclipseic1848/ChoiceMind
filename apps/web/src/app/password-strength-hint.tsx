export function PasswordStrengthHint({
	password,
}: Readonly<{ password: string }>) {
	const strength = evaluatePasswordStrength(password);
	return (
		<p className="field-hint" aria-live="polite">
			{strength === undefined
				? "至少 6 位英文、数字或符号；弱密码不会被阻止。"
				: `密码强度：${strength}`}
		</p>
	);
}

function evaluatePasswordStrength(
	password: string,
): "一般" | "弱" | "较强" | undefined {
	if (password.length === 0) return undefined;
	let score = 0;
	if (/[a-z]/.test(password)) score += 1;
	if (/[A-Z]/.test(password)) score += 1;
	if (/\d/.test(password)) score += 1;
	if (/[^A-Za-z0-9]/.test(password)) score += 1;
	if (password.length >= 10) score += 1;
	if (score >= 5) return "较强";
	if (score >= 3) return "一般";
	return "弱";
}
