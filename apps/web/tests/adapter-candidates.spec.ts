import { expect, type Page, test } from "@playwright/test";

const id = `adapter-candidate-${"a".repeat(64)}`;
const keys = [
	"dependencies",
	"entrypoints",
	"network",
	"secrets",
	"basicCollection",
	"loginExpiry",
	"rateLimit",
	"emptyResult",
	"failureHandling",
];
const fixture = () => ({
	candidate: {
		candidateId: id,
		source: {
			kind: "PYPI",
			packageName: "community-reader",
			version: "1.2.0",
			artifactSha256: "b".repeat(64),
		},
		review: {
			reviewedAt: "2026-09-08T12:00:00Z",
			reportSha256: "c".repeat(64),
			checks: Object.fromEntries(
				keys.map((key) => [
					key,
					{ status: "PASSED", checkCount: 1, findingCount: 0 },
				]),
			),
		},
	},
	lifecycle: {
		state: "AWAITING_APPROVAL",
		reviewBindingSha256: "d".repeat(64),
	},
});
async function identity(page: Page, role = "ADMIN") {
	await page.route("**/api/identity/me", (route) =>
		route.fulfill({ json: { access: "FULL", principal: { role } } }),
	);
}

test("畸形来源字段显示可恢复错误，不崩溃或允许启用", async ({ page }) => {
	await identity(page);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let invalid = true;
	await page.route("**/api/adapter-candidates**", (route) => {
		const item = fixture();
		return route.fulfill({
			json: invalid
				? {
						...item,
						candidate: {
							...item.candidate,
							source: { ...item.candidate.source, packageName: {} },
						},
					}
				: item,
		});
	});
	await page.goto(`/admin/adapter-candidates?candidate=${id}`);
	await expect(
		page.getByRole("alert").filter({ hasText: "返回内容无法确认" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "确认启用", exact: true }),
	).toHaveCount(0);
	invalid = false;
	await page.getByRole("button", { name: "刷新" }).click();
	await expect(
		page.getByRole("heading", { name: "community-reader" }),
	).toBeVisible();
	expect(errors).toEqual([]);
});

test("旧列表迟到的401不能覆盖新详情", async ({ page }) => {
	await identity(page);
	await page.addInitScript(() => {
		const original = window.fetch.bind(window);
		let first = true;
		window.fetch = (input, init) => {
			if (first && String(input).startsWith("/api/adapter-candidates?")) {
				first = false;
				return new Promise<Response>((resolve) => {
					(window as unknown as { releaseOld: () => void }).releaseOld = () =>
						resolve(new Response("{}", { status: 401 }));
				});
			}
			return original(input, init);
		};
	});
	await page.route(`**/api/adapter-candidates/${id}`, (route) =>
		route.fulfill({ json: fixture() }),
	);
	await page.goto("/admin/adapter-candidates");
	await page.waitForFunction(
		() =>
			typeof (window as unknown as { releaseOld?: unknown }).releaseOld ===
			"function",
	);
	await page.evaluate(
		(candidateId) =>
			history.pushState(
				null,
				"",
				`/admin/adapter-candidates?candidate=${candidateId}`,
			),
		id,
	);
	await expect(
		page.getByRole("heading", { name: "community-reader" }),
	).toBeVisible();
	await page.evaluate(() =>
		(window as unknown as { releaseOld: () => void }).releaseOld(),
	);
	await page.waitForTimeout(200);
	await expect(page).toHaveURL(new RegExp(`candidate=${id}`));
	await expect(
		page.getByRole("heading", { name: "community-reader" }),
	).toBeVisible();
});

test("桌面列表、详情、键盘确认与单次启用", async ({ page }, testInfo) => {
	await identity(page);
	const item = fixture();
	let writes = 0;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/adapter-candidates**", async (route) => {
		if (route.request().method() === "POST") {
			writes++;
			expect(route.request().postDataJSON()).toMatchObject({
				type: "ENABLE",
				reviewBindingSha256: "d".repeat(64),
			});
			await new Promise((resolve) => setTimeout(resolve, 150));
			item.lifecycle.state = "ENABLED";
			return route.fulfill({ json: item.lifecycle });
		}
		return route.fulfill({
			json: route.request().url().includes(id)
				? item
				: { items: [item], nextCursor: null },
		});
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/admin/adapter-candidates");
	await expect(page).toHaveTitle("来源工具 — ChoiceMind");
	await expect(page.getByRole("table")).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("candidate-list.png"),
	});
	await page
		.getByRole("link", { name: "查看 community-reader 的检查结果" })
		.click();
	await page.getByRole("button", { name: "确认启用", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "取消", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "确认启用", exact: true }),
	).toBeFocused();
	await page.getByRole("button", { name: "确认启用", exact: true }).click();
	await page.screenshot({
		path: testInfo.outputPath("candidate-confirmation.png"),
	});
	await page.getByRole("button", { name: "确认启用此版本" }).click();
	await expect(page.getByRole("button", { name: "停用工具" })).toBeVisible();
	expect(writes).toBe(1);
	expect(errors).toEqual([]);
});

test("普通用户无法进入，候选请求不会发出", async ({ page }) => {
	await identity(page, "USER");
	let reads = 0;
	await page.route("**/api/adapter-candidates**", (route) => {
		reads++;
		return route.fulfill({ status: 403, json: {} });
	});
	await page.goto("/admin/adapter-candidates");
	await expect(
		page.getByRole("heading", { name: "没有管理权限" }),
	).toBeVisible();
	expect(reads).toBe(0);
});

test("未完成检查禁用启用，空态与失败可恢复", async ({ page }) => {
	await identity(page);
	let unavailable = true;
	await page.route("**/api/adapter-candidates**", (route) =>
		route.fulfill({
			status: unavailable ? 503 : 200,
			json: unavailable ? {} : { items: [], nextCursor: null },
		}),
	);
	await page.goto("/admin/adapter-candidates");
	await expect(
		page.getByRole("alert").filter({ hasText: "暂时无法读取" }),
	).toBeVisible();
	unavailable = false;
	await page.getByRole("button", { name: "刷新" }).click();
	await expect(
		page.getByRole("heading", { name: "暂无候选工具" }),
	).toBeVisible();
	const item = fixture();
	item.candidate.review.checks.network = {
		status: "NOT_RUN",
		checkCount: 0,
		findingCount: 0,
	};
	item.lifecycle.state = "REVIEW_FAILED";
	await page.route(`**/api/adapter-candidates/${id}`, (route) =>
		route.fulfill({ json: item }),
	);
	await page.goto(`/admin/adapter-candidates?candidate=${id}`);
	await expect(
		page.getByRole("button", { name: "确认启用", exact: true }),
	).toBeDisabled();
	await page.emulateMedia({ reducedMotion: "reduce" });
	for (const [width, height] of [
		[1280, 800],
		[1366, 768],
		[1487, 1058],
		[1920, 1080],
	]) {
		await page.setViewportSize({ width, height });
		await expect(
			page.getByRole("heading", { name: "community-reader" }),
		).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	}
});

test("报告冲突不盲目重发，重新读取后再确认", async ({ page }) => {
	await identity(page);
	let writes = 0;
	await page.route("**/api/adapter-candidates**", (route) => {
		if (route.request().method() === "POST") {
			writes++;
			return route.fulfill({
				status: 409,
				json: { error: { code: "ADAPTER_CANDIDATE_REVIEW_STALE" } },
			});
		}
		return route.fulfill({ json: fixture() });
	});
	await page.goto(`/admin/adapter-candidates?candidate=${id}`);
	await page.getByRole("button", { name: "确认启用", exact: true }).click();
	await page.getByRole("button", { name: "确认启用此版本" }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "报告或状态已变化" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "确认启用此版本" }),
	).toBeDisabled();
	expect(writes).toBe(1);
	await page.getByRole("button", { name: "重新读取状态" }).click();
	await expect(
		page.getByRole("button", { name: "确认启用", exact: true }),
	).toBeEnabled();
});
