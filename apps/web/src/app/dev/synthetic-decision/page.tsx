import { DecisionFlow } from "../../decision-flow";
import { IdentityGate } from "../../identity-gate";
import { SystemHealthPanel } from "../../system-health-panel";

export default function SyntheticDecisionPage() {
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
