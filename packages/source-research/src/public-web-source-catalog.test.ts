import { describe, expect, it } from "vitest";

import { createPublicWebSourceCatalog } from "./public-web-source-catalog.js";

describe("Public Web Source Catalog", () => {
	it("只接受入口位于批准 HTTPS origin 的来源", () => {
		const catalog = createPublicWebSourceCatalog([
			{
				sourceId: "asus-official",
				title: "ASUS 官方网站",
				allowedOrigins: ["https://www.asus.com"],
				entryUrls: ["https://www.asus.com/displays-desktops/monitors/"],
				renderMode: "AUTO",
				sourceRole: "OFFICIAL",
			},
		]);

		expect(catalog.get("asus-official")).toEqual({
			sourceId: "asus-official",
			title: "ASUS 官方网站",
			allowedOrigins: ["https://www.asus.com"],
			entryUrls: ["https://www.asus.com/displays-desktops/monitors/"],
			renderMode: "AUTO",
			sourceRole: "OFFICIAL",
		});
	});

	it.each([
		["重复来源 ID", [validDefinition(), validDefinition()]],
		[
			"非 HTTPS origin",
			[{ ...validDefinition(), allowedOrigins: ["http://example.com"] }],
		],
		[
			"入口不属于批准 origin",
			[{ ...validDefinition(), entryUrls: ["https://other.example/product"] }],
		],
		[
			"带路径的 origin",
			[
				{
					...validDefinition(),
					allowedOrigins: ["https://example.com/products"],
				},
			],
		],
	])("拒绝%s", (_label, definitions) => {
		expect(() => createPublicWebSourceCatalog(definitions)).toThrow(
			"PUBLIC_WEB_SOURCE_CATALOG_INVALID",
		);
	});
});

function validDefinition() {
	return {
		sourceId: "brand-official",
		title: "品牌官网",
		allowedOrigins: ["https://example.com"],
		entryUrls: ["https://example.com/products"],
		renderMode: "STATIC" as const,
		sourceRole: "OFFICIAL" as const,
	};
}
