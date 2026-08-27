import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
	title: "Alpha 界面原型 — ChoiceMind",
	description: "ChoiceMind P1 Alpha 的对话工作台与证据路线图原型",
};

export default function AlphaPrototypeLayout({
	children,
}: Readonly<{ children: ReactNode }>) {
	return children;
}
