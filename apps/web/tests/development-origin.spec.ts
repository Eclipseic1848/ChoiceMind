import { expect, test } from "@playwright/test";
import nextConfig from "../next.config";

test.describe("Next 开发来源", () => {
	test("允许指定的局域网地址加载开发资源", () => {
		expect(nextConfig.allowedDevOrigins).toContain("192.168.50.123");
	});

	test("隐藏不属于产品界面的 Next 开发浮标", () => {
		expect(nextConfig.devIndicators).toBe(false);
	});
});
