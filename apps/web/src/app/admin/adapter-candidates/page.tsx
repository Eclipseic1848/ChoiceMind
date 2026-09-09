import type { Metadata } from "next";
import { Suspense } from "react";
import { ManagementFrame } from "../../management-frame";
import { CandidatePanel } from "./candidate-panel";

export const metadata: Metadata = { title: "来源工具 — ChoiceMind" };

export default function CandidatePage() {
	return (
		<ManagementFrame eyebrow="来源管理" requiredRole="ADMIN" title="来源工具">
			<Suspense fallback={<p role="status">正在读取来源工具…</p>}>
				<CandidatePanel />
			</Suspense>
		</ManagementFrame>
	);
}
