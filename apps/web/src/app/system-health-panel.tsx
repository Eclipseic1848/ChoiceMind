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

const serviceNames: Record<ComponentHealth["service"], string> = {
	web: "Web",
	api: "API",
	orchestrator: "Orchestrator",
	"data-worker": "Data Worker",
};

export async function SystemHealthPanel() {
	const health = await loadSystemHealth();
	return (
		<section aria-labelledby="system-health-heading">
			<h2 id="system-health-heading">系统健康</h2>
			{health === null ? (
				<p>健康状态不可用</p>
			) : (
				<>
					<p>{health.status === "healthy" ? "全部正常" : "存在异常"}</p>
					<ul>
						{health.components.map((component) => (
							<li key={component.service}>
								<strong>{serviceNames[component.service]}</strong>
								{`：${component.status === "healthy" ? "正常" : "异常"}（${component.latencyMs} ms）`}
							</li>
						))}
					</ul>
					<time dateTime={health.checkedAt}>{health.checkedAt}</time>
				</>
			)}
		</section>
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
