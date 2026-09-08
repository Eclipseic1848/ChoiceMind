export type PublicWebSourceDefinition = Readonly<{
	sourceId: string;
	title: string;
	allowedOrigins: readonly string[];
	entryUrls: readonly string[];
	renderMode: "STATIC" | "DYNAMIC" | "AUTO";
	sourceRole: "OFFICIAL" | "INDEPENDENT";
}>;

export function createPublicWebSourceCatalog(
	definitions: readonly PublicWebSourceDefinition[],
): ReadonlyMap<string, PublicWebSourceDefinition> {
	if (!Array.isArray(definitions)) invalidCatalog();
	const catalog = new Map<string, PublicWebSourceDefinition>();
	for (const definition of definitions) {
		if (
			!isDefinitionShape(definition) ||
			!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(definition.sourceId) ||
			definition.title.trim() !== definition.title ||
			definition.title.length === 0 ||
			definition.title.length > 200 ||
			definition.allowedOrigins.length === 0 ||
			definition.allowedOrigins.length > 10 ||
			definition.entryUrls.length === 0 ||
			definition.entryUrls.length > 20 ||
			!["STATIC", "DYNAMIC", "AUTO"].includes(definition.renderMode) ||
			!["OFFICIAL", "INDEPENDENT"].includes(definition.sourceRole) ||
			catalog.has(definition.sourceId)
		) {
			invalidCatalog();
		}

		const allowedOrigins = definition.allowedOrigins.map((value) => {
			const url = parseHttpsUrl(value);
			if (value !== url.origin) invalidCatalog();
			return url.origin;
		});
		if (new Set(allowedOrigins).size !== allowedOrigins.length)
			invalidCatalog();

		const entryUrls = definition.entryUrls.map((value) => {
			const url = parseHttpsUrl(value);
			if (!allowedOrigins.includes(url.origin)) invalidCatalog();
			return url.href;
		});
		if (new Set(entryUrls).size !== entryUrls.length) invalidCatalog();

		catalog.set(definition.sourceId, {
			...definition,
			allowedOrigins,
			entryUrls,
		});
	}
	return catalog;
}

function parseHttpsUrl(value: string): URL {
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.hash !== ""
		) {
			invalidCatalog();
		}
		return url;
	} catch {
		return invalidCatalog();
	}
}

function invalidCatalog(): never {
	throw new Error("PUBLIC_WEB_SOURCE_CATALOG_INVALID");
}

function isDefinitionShape(value: unknown): value is PublicWebSourceDefinition {
	if (typeof value !== "object" || value === null) return false;
	const definition = value as Record<string, unknown>;
	return (
		typeof definition.sourceId === "string" &&
		typeof definition.title === "string" &&
		Array.isArray(definition.allowedOrigins) &&
		definition.allowedOrigins.every((origin) => typeof origin === "string") &&
		Array.isArray(definition.entryUrls) &&
		definition.entryUrls.every((url) => typeof url === "string") &&
		typeof definition.renderMode === "string" &&
		typeof definition.sourceRole === "string"
	);
}
