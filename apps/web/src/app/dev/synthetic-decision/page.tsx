import { notFound } from "next/navigation";

import { DecisionFlow } from "../../decision-flow";
import { IdentityGate } from "../../identity-gate";
import { SystemHealthPanel } from "../../system-health-panel";
import { isSyntheticDevelopmentPageEnabled } from "./access";

export default function SyntheticDecisionPage() {
	if (!isSyntheticDevelopmentPageEnabled(process.env)) notFound();
	return (
		<IdentityGate>
			<main>
				<p>ChoiceMind 星枢智购 / 开发验证</p>
				<DecisionFlow />
				<SystemHealthPanel />
			</main>
		</IdentityGate>
	);
}
