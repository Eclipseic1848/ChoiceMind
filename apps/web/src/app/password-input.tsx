"use client";

import { type InputHTMLAttributes, useState } from "react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> &
	Readonly<{ revealLabel: string }>;

export function PasswordInput({
	disabled,
	id,
	revealLabel,
	...inputProps
}: PasswordInputProps) {
	const [revealed, setRevealed] = useState(false);

	return (
		<div className="password-input">
			<input
				{...inputProps}
				disabled={disabled}
				id={id}
				type={revealed ? "text" : "password"}
			/>
			<button
				aria-controls={id}
				aria-label={`${revealed ? "隐藏" : "显示"}${revealLabel}`}
				aria-pressed={revealed}
				className="password-visibility-toggle"
				disabled={disabled}
				type="button"
				onClick={() => setRevealed((current) => !current)}
			>
				{revealed ? "隐藏" : "显示"}
			</button>
		</div>
	);
}
