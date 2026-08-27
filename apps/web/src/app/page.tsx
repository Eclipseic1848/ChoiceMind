import { ConversationWorkbench } from "./conversation-workbench";
import { IdentityGate } from "./identity-gate";

type ComponentHealth = {
	service: "web" | "api" | "orchestrator" | "data-worker";
	status: "healthy" | "unhealthy";
	latencyMs: number;
	error?: string;
};

type SystemHealth = {
	checkedAt: string;
	components: ComponentHealth[];
	status: "healthy" | "unhealthy";
};

export default async function HomePage() {
	const health = await loadSystemHealth();

	return (
		<IdentityGate>
			<ConversationWorkbench
				systemHealth={health === null ? "unavailable" : health.status}
			/>
		</IdentityGate>
	);
}

async function loadSystemHealth(): Promise<SystemHealth | null> {
	const apiUrl = process.env.CHOICEMIND_API_URL ?? "http://127.0.0.1:3100";

	try {
		const response = await fetch(`${apiUrl}/api/v1/system/health`, {
			cache: "no-store",
		});
		if (!response.ok) return null;
		const result = (await response.json()) as Partial<SystemHealth>;
		if (
			(result.status !== "healthy" && result.status !== "unhealthy") ||
			typeof result.checkedAt !== "string" ||
			!Array.isArray(result.components)
		) {
			return null;
		}
		return result as SystemHealth;
	} catch {
		return null;
	}
}
