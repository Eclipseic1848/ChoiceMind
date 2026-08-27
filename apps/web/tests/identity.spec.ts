import { createServer, type IncomingMessage, type Server } from "node:http";

import { expect, test } from "@playwright/test";

let apiServer: Server;
let bootstrapRequired = true;
let receivedCookies: Array<string | undefined> = [];
const receivedLocalBrowserHeaders: Array<string | undefined> = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
	apiServer = createServer(async (request, response) => {
		receivedCookies.push(request.headers.cookie);
		receivedLocalBrowserHeaders.push(
			request.headers["x-choicemind-local-browser"] as string | undefined,
		);

		if (
			request.url === "/api/v1/identity/bootstrap" &&
			request.method === "GET"
		) {
			return sendJson(response, 200, { required: bootstrapRequired });
		}

		if (
			request.url === "/api/v1/identity/bootstrap" &&
			request.method === "POST"
		) {
			bootstrapRequired = false;
			response.setHeader(
				"set-cookie",
				"choicemind_session=bootstrap-session; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
			);
			return sendJson(response, 201, {
				access: "FULL",
				account: {
					accountId: "account-super",
					role: "SUPERADMIN",
					username: "root",
				},
				recoveryCode: "AAAA-BBBB-CCCC-DDDD",
			});
		}

		if (request.url === "/api/v1/identity/login" && request.method === "POST") {
			const body = JSON.parse(await readBody(request)) as { username?: string };
			const session =
				body.username === "temp_user"
					? "temporary-session"
					: body.username === "pending_user"
						? "pending-session"
						: "user-session";
			response.setHeader(
				"set-cookie",
				`choicemind_session=${session}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`,
			);
			return sendJson(response, 200, {
				access:
					session === "temporary-session"
						? "PASSWORD_CHANGE_REQUIRED"
						: session === "pending-session"
							? "DELETION_PENDING"
							: "FULL",
				account: {
					accountId: "account-user",
					role: "USER",
					username: body.username ?? "mira",
				},
				...(session === "pending-session"
					? { deletionDueAt: "2026-09-03T18:00:00.000Z" }
					: {}),
			});
		}

		if (
			request.url === "/api/v1/identity/password/temporary" &&
			request.method === "POST"
		) {
			response.setHeader(
				"set-cookie",
				"choicemind_session=full-temp-user-session; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
			);
			return sendJson(response, 200, {
				access: "FULL",
				account: {
					accountId: "account-temp",
					role: "USER",
					username: "temp_user",
				},
			});
		}

		if (
			request.url === "/api/v1/identity/password" &&
			request.method === "POST"
		) {
			response.statusCode = 204;
			response.setHeader(
				"set-cookie",
				"choicemind_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
			);
			return response.end();
		}

		if (
			request.url === "/api/v1/identity/deletion" &&
			request.method === "POST"
		) {
			response.setHeader(
				"set-cookie",
				"choicemind_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
			);
			return sendJson(response, 202, {
				accountId: "account-user",
				deletionDueAt: "2026-09-03T18:00:00.000Z",
				ok: true,
			});
		}

		if (
			request.url === "/api/v1/identity/deletion/cancel" &&
			request.method === "POST"
		) {
			response.setHeader(
				"set-cookie",
				"choicemind_session=restored-session; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
			);
			return sendJson(response, 200, {
				access: "FULL",
				account: {
					accountId: "account-pending",
					role: "USER",
					username: "pending_user",
				},
			});
		}

		if (
			request.url === "/api/v1/identity/registrations" &&
			request.method === "POST"
		) {
			const body = JSON.parse(await readBody(request)) as Record<
				string,
				unknown
			>;
			if (body.invitationCode !== "invite-123") {
				return sendJson(response, 404, {
					code: "INVITATION_INVALID",
					ok: false,
				});
			}
			response.setHeader(
				"set-cookie",
				"choicemind_session=registered-session; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
			);
			return sendJson(response, 201, {
				access: "FULL",
				account: { accountId: "account-new", role: "USER", username: "xiaoyu" },
			});
		}

		if (request.url === "/api/v1/identity/me" && request.method === "GET") {
			const session = request.headers.cookie?.match(
				/choicemind_session=([^;]+)/,
			)?.[1];
			if (session === undefined) {
				return sendJson(response, 401, { authenticated: false });
			}
			const account =
				session === "bootstrap-session"
					? { accountId: "account-super", role: "SUPERADMIN", username: "root" }
					: session === "admin-session"
						? { accountId: "account-admin", role: "ADMIN", username: "admin" }
						: session === "registered-session"
							? { accountId: "account-new", role: "USER", username: "xiaoyu" }
							: session === "full-temp-user-session"
								? {
										accountId: "account-temp",
										role: "USER",
										username: "temp_user",
									}
								: session === "pending-session"
									? {
											accountId: "account-pending",
											role: "USER",
											username: "pending_user",
										}
									: session === "restored-session"
										? {
												accountId: "account-pending",
												role: "USER",
												username: "pending_user",
											}
										: {
												accountId: "account-user",
												role: "USER",
												username: "mira",
											};
			const access =
				session === "temporary-session"
					? "PASSWORD_CHANGE_REQUIRED"
					: session === "pending-session"
						? "DELETION_PENDING"
						: "FULL";
			return sendJson(response, 200, {
				access,
				account,
				authenticated: true,
				...(access === "DELETION_PENDING"
					? { deletionDueAt: "2026-09-03T18:00:00.000Z" }
					: {}),
				principal: { role: account.role, userId: account.accountId },
			});
		}

		if (
			request.url === "/api/v1/identity/accounts" &&
			request.method === "GET"
		) {
			if (
				!request.headers.cookie?.includes("bootstrap-session") &&
				!request.headers.cookie?.includes("admin-session")
			) {
				return sendJson(response, 403, { code: "UNAUTHORIZED" });
			}
			return sendJson(response, 200, {
				authorized: true,
				accounts: [
					{
						accountId: "account-user",
						createdAt: "2026-08-27T18:00:00.000Z",
						deletionDueAt: null,
						role: "USER",
						status: "ACTIVE",
						username: "普通用户",
					},
				],
			});
		}

		if (
			request.url === "/api/v1/identity/accounts" &&
			request.method === "POST"
		) {
			return sendJson(response, 201, {
				account: {
					accountId: "account-created",
					role: "USER",
					username: "新用户",
				},
				ok: true,
				temporaryPassword: "temporary-123",
			});
		}

		if (
			request.url === "/api/v1/identity/accounts/account-user/password-reset" &&
			request.method === "POST"
		) {
			return sendJson(response, 200, {
				accountId: "account-user",
				ok: true,
				temporaryPassword: "reset-password-123",
			});
		}

		if (
			request.url === "/api/v1/identity/accounts/account-user/status" &&
			request.method === "PATCH"
		) {
			return sendJson(response, 200, {
				account: { accountId: "account-user", status: "DISABLED" },
				ok: true,
			});
		}

		if (
			request.url === "/api/v1/identity/accounts/account-user/role" &&
			request.method === "PATCH"
		) {
			return sendJson(response, 200, {
				account: { accountId: "account-user", role: "ADMIN" },
				ok: true,
			});
		}

		if (
			request.url === "/api/v1/identity/accounts/account-user/deletion" &&
			request.method === "POST"
		) {
			return sendJson(response, 202, {
				accountId: "account-user",
				deletionDueAt: "2026-09-03T18:00:00.000Z",
				ok: true,
			});
		}

		if (
			request.url === "/api/v1/identity/invitations" &&
			request.method === "GET"
		) {
			return sendJson(response, 200, {
				authorized: true,
				invitations: [
					{
						createdAt: "2026-08-27T18:00:00.000Z",
						expiresAt: "2026-09-03T18:00:00.000Z",
						invitationId: "invitation-one",
						status: "ACTIVE",
					},
				],
			});
		}

		if (
			request.url === "/api/v1/identity/invitations" &&
			request.method === "POST"
		) {
			return sendJson(response, 201, {
				expiresAt: "2026-09-03T18:00:00.000Z",
				invitationCode: "INVITE-CODE-123",
				invitationId: "invitation-one",
				ok: true,
			});
		}

		if (
			request.url === "/api/v1/identity/invitations/invitation-one" &&
			request.method === "DELETE"
		) {
			response.statusCode = 204;
			return response.end();
		}

		if (
			request.url === "/api/v1/identity/audit-records" &&
			request.method === "GET"
		) {
			return sendJson(response, 200, {
				authorized: true,
				records: [
					{
						action: "LOGIN",
						actorAccountId: "account-super",
						auditId: "audit-one",
						correlationId: "correlation-one",
						object: { id: "account-super", type: "ACCOUNT" },
						occurredAt: "2026-08-27T18:00:00.000Z",
						result: "ALLOWED",
					},
				],
			});
		}

		if (
			request.url === "/api/v1/identity/recovery" &&
			request.method === "POST"
		) {
			response.setHeader(
				"set-cookie",
				"choicemind_session=recovered-super-session; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
			);
			return sendJson(response, 200, {
				access: "FULL",
				account: {
					accountId: "account-super",
					role: "SUPERADMIN",
					username: "root",
				},
				recoveryCode: "NEW-RECOVERY-CODE-123",
			});
		}

		return sendJson(response, 404, { code: "NOT_FOUND" });
	});

	await new Promise<void>((resolve, reject) => {
		apiServer.once("error", reject);
		apiServer.listen(3199, "127.0.0.1", resolve);
	});
});

test.beforeEach(async ({ context }) => {
	bootstrapRequired = true;
	receivedCookies = [];
	await context.clearCookies();
});

test.afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		apiServer.close((error) =>
			error === undefined ? resolve() : reject(error),
		);
	});
});

test("首次运行可创建超级管理员并只显示一次恢复码", async ({ page }) => {
	await page.goto("/setup");
	await expect.poll(() => receivedLocalBrowserHeaders.includes("1")).toBe(true);

	await expect(
		page.getByRole("heading", { name: "建立第一个管理员" }),
	).toBeVisible();
	await page.getByLabel("用户名").fill("root");
	await page.getByLabel("密码", { exact: true }).fill("abc123!");
	await page.getByLabel("确认密码", { exact: true }).fill("abc123!");
	await page.getByRole("button", { name: "完成初始化" }).click();

	await expect(page.getByRole("heading", { name: "保存恢复码" })).toBeVisible();
	await expect(page.getByText("AAAA-BBBB-CCCC-DDDD")).toBeVisible();
	await expect(page.locator(".recovery-result")).toBeFocused();
	const cookies = await page.context().cookies();
	expect(
		cookies.find((cookie) => cookie.name === "choicemind_session")?.httpOnly,
	).toBe(true);
	expect(await page.content()).not.toContain("bootstrap-session");
});

test("初始化完成后再次访问首次设置页会回到登录页", async ({ page }) => {
	bootstrapRequired = false;
	await page.goto("/setup");
	await expect(page).toHaveURL(/\/login$/);
});

test("远程 Host 不能穿过 Web 代理调用本机初始化和恢复", async ({ request }) => {
	const bootstrapStatus = await request.get("/api/identity/bootstrap", {
		headers: { host: "example.com" },
	});
	expect(bootstrapStatus.status()).toBe(403);
	for (const path of ["bootstrap", "recovery"]) {
		const response = await request.post(`/api/identity/${path}`, {
			data:
				path === "bootstrap"
					? { password: "abc123!", username: "root" }
					: { newPassword: "abc123!", recoveryCode: "RECOVERY-CODE" },
			headers: { host: "example.com" },
		});
		expect(response.status()).toBe(403);
	}
});

test("首次设置资格被拒绝时不显示初始化表单", async ({ page }) => {
	await page.route("**/api/identity/bootstrap", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			status: 403,
			body: JSON.stringify({ code: "LOCAL_ONLY" }),
		});
	});
	await page.goto("/setup");
	await expect(
		page.getByRole("heading", { name: "首次设置仅限本机" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "完成初始化" }),
	).not.toBeVisible();
});

test("设置密码时只提示强度，不阻止符合格式的弱密码", async ({ page }) => {
	await page.goto("/setup");
	await page.getByLabel("密码", { exact: true }).fill("123456");
	await expect(page.getByText("密码强度：弱")).toBeVisible();
	await page.getByLabel("密码", { exact: true }).fill("Abc123!xyz");
	await expect(page.getByText("密码强度：较强")).toBeVisible();
});

test("密码输入可显示和重新隐藏且不丢失内容", async ({ page }) => {
	bootstrapRequired = false;
	await page.goto("/login");
	const password = page.getByLabel("密码", { exact: true });
	await password.fill("abc123!");
	await expect(password).toHaveAttribute("type", "password");
	await page.getByRole("button", { name: "显示密码" }).click();
	await expect(password).toHaveAttribute("type", "text");
	await expect(password).toHaveValue("abc123!");
	await page.getByRole("button", { name: "隐藏密码" }).click();
	await expect(password).toHaveAttribute("type", "password");
});

test("已有用户可登录并由服务端 Cookie 恢复工作台身份", async ({ page }) => {
	bootstrapRequired = false;
	await page.goto("/login");

	await page.getByLabel("用户名").fill("mira");
	await page.getByLabel("密码", { exact: true }).fill("abc123!");
	await page.getByRole("button", { name: "登录 ChoiceMind" }).click();

	await expect(page.getByText("你好，mira")).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
	await expect
		.poll(() =>
			receivedCookies.some((cookie) => cookie?.includes("user-session")),
		)
		.toBe(true);
	expect(await page.content()).not.toContain("user-session");
});

test("邀请链接带入邀请码并创建普通用户", async ({ page }) => {
	bootstrapRequired = false;
	await page.goto("/register?code=invite-123");

	await expect(page.getByRole("heading", { name: "接受邀请" })).toBeVisible();
	await page.getByLabel("用户名").fill("xiaoyu");
	await page.getByLabel("密码", { exact: true }).fill("abc123!");
	await page.getByLabel("确认密码", { exact: true }).fill("abc123!");
	await page.getByRole("button", { name: "创建账号" }).click();

	await expect(page.getByText("你好，xiaoyu")).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
});

test("临时密码登录后只能先设置新密码", async ({ page }) => {
	bootstrapRequired = false;
	await page.goto("/login");
	await page.getByLabel("用户名").fill("temp_user");
	await page.getByLabel("密码", { exact: true }).fill("temporary-123");
	await page.getByRole("button", { name: "登录 ChoiceMind" }).click();

	await expect(page).toHaveURL(/\/password-change$/);
	await expect(page.getByRole("heading", { name: "设置新密码" })).toBeVisible();
	await page.getByLabel("新密码", { exact: true }).fill("new-user-123");
	await page.getByLabel("确认新密码", { exact: true }).fill("new-user-123");
	await page.getByRole("button", { name: "保存新密码" }).click();
	await expect(page.getByText("你好，temp_user")).toBeVisible();
});

test("临时密码会话刷新工作台仍被送回强制改密", async ({ page, context }) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "temporary-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/");
	await expect(page).toHaveURL(/\/password-change$/);
	await expect(page.getByText("你好，temp_user")).not.toBeVisible();
});

test("待删除用户只能查看截止时间并取消删除", async ({ page }) => {
	bootstrapRequired = false;
	await page.goto("/login");
	await page.getByLabel("用户名").fill("pending_user");
	await page.getByLabel("密码", { exact: true }).fill("pending-123");
	await page.getByRole("button", { name: "登录 ChoiceMind" }).click();

	await expect(page).toHaveURL(/\/deletion-pending$/);
	await expect(
		page.getByRole("heading", { name: "账号正在等待删除" }),
	).toBeVisible();
	await expect(page.getByText(/2026/)).toBeVisible();
	await page.getByRole("button", { name: "取消删除" }).click();
	await expect(page.getByText("你好，pending_user")).toBeVisible();
});

test("待删除会话刷新工作台仍只能进入删除状态页", async ({ page, context }) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "pending-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/");
	await expect(page).toHaveURL(/\/deletion-pending$/);
	await expect(page.getByText("你好，pending_user")).not.toBeVisible();
});

test("用户可在安全页面改密，成功后回到登录页", async ({ page, context }) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "user-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/security");

	await expect(page.getByRole("heading", { name: "账号安全" })).toBeVisible();
	await page.getByLabel("当前密码", { exact: true }).fill("abc123!");
	await page.getByLabel("新密码", { exact: true }).fill("abc456!");
	await page.getByLabel("确认新密码", { exact: true }).fill("abc456!");
	await page.getByRole("button", { name: "修改密码" }).click();
	await expect(page).toHaveURL(/\/login$/);
});

test("用户重新输入密码后可发起七天等待删除", async ({ page, context }) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "user-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/security");
	await page.getByLabel("删除确认密码", { exact: true }).fill("abc123!");
	await page.getByRole("button", { name: "申请删除账号" }).click();

	await expect(page).toHaveURL(/\/login\?deletion=requested$/);
});

test("退出设备等待响应时显示忙碌状态并阻止重复提交", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "user-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	let releaseRequest = () => undefined;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await page.route("**/api/identity/logout", async (route) => {
		await requestGate;
		await route.fulfill({ status: 204 });
	});
	await page.goto("/security");
	await page.getByRole("button", { name: "退出当前设备" }).click();
	await expect(
		page.getByRole("button", { name: "正在退出当前设备…" }),
	).toBeDisabled();
	releaseRequest();
	await expect(page).toHaveURL(/\/login$/);
});

test("自助删除等待响应时显示忙碌状态并阻止重复提交", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "user-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	let releaseRequest = () => undefined;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await page.route("**/api/identity/deletion", async (route) => {
		await requestGate;
		await route.continue();
	});
	await page.goto("/security");
	await page.getByLabel("删除确认密码", { exact: true }).fill("abc123!");
	await page.getByRole("button", { name: "申请删除账号" }).click();
	await expect(
		page.getByRole("button", { name: "正在提交删除申请…" }),
	).toBeDisabled();
	releaseRequest();
	await expect(page).toHaveURL(/\/login\?deletion=requested$/);
});

test("超级管理员可查看账号账册、签发邀请和审计，普通用户被拒绝", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/admin/accounts");
	await expect(page.getByRole("heading", { name: "账号账册" })).toBeVisible();
	await expect(page.getByRole("rowheader", { name: "普通用户" })).toBeVisible();
	await page.getByRole("button", { name: "重置 普通用户 的密码" }).click();
	await expect(
		page.getByText("将撤销该用户全部登录状态，并签发仅展示一次的临时密码。"),
	).toBeVisible();
	await page.getByRole("button", { name: "确认重置密码" }).click();
	await expect(
		page.getByText("reset-password-123", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "停用 普通用户" }).click();
	await expect(
		page.getByText("将立即退出该用户并取消进行中的任务；私人数据仍会保留。"),
	).toBeVisible();
	await page.getByRole("button", { name: "确认停用" }).click();
	await expect(page.getByText("账号状态已更新")).toBeVisible();
	await page.getByText("角色与删除").click();
	await page
		.getByLabel("超级管理员当前密码", { exact: true })
		.fill("super123!");
	await page.getByLabel("目标角色").selectOption("ADMIN");
	await page.getByRole("button", { name: "更新角色" }).click();
	await expect(page.getByText("账号角色已更新")).toBeVisible();

	await page.goto("/admin/invitations");
	await page.getByRole("button", { name: "创建邀请" }).click();
	await expect(
		page.getByText("INVITE-CODE-123", { exact: true }),
	).toBeVisible();
	await expect(page.getByText(/register\?code=INVITE-CODE-123/)).toBeVisible();
	await page.getByRole("button", { name: "撤销邀请 invitation-one" }).click();
	await expect(
		page.getByText("撤销后该邀请码将立即失效，且不能恢复。"),
	).toBeVisible();
	await page.getByRole("button", { name: "确认撤销" }).click();
	await expect(page.getByText("邀请已撤销")).toBeVisible();

	await page.goto("/admin/audit");
	await expect(page.getByRole("heading", { name: "安全审计" })).toBeVisible();
	await expect(page.getByText("LOGIN", { exact: true })).toBeVisible();

	await context.clearCookies();
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "user-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/admin/accounts");
	await expect(
		page.getByRole("heading", { name: "没有管理权限" }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "账号账册" })).not.toBeVisible();

	await context.clearCookies();
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "admin-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/admin/audit");
	await expect(
		page.getByRole("heading", { name: "没有管理权限" }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "安全审计" })).not.toBeVisible();
});

test("管理入口只依据服务端 Principal 而不信任账号元数据角色", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.route("**/api/identity/me", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			status: 200,
			body: JSON.stringify({
				access: "FULL",
				account: {
					accountId: "account-user",
					role: "SUPERADMIN",
					username: "普通用户",
				},
				authenticated: true,
				principal: { role: "USER", userId: "account-user" },
			}),
		});
	});
	await page.goto("/admin/accounts");
	await expect(
		page.getByRole("heading", { name: "没有管理权限" }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "安全审计" })).not.toBeVisible();
});

test("管理员只能管理普通用户且看不到超级管理员操作", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "admin-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/admin/accounts");
	await expect(page.getByRole("heading", { name: "账号账册" })).toBeVisible();
	await expect(
		page.locator('#new-account-role option[value="ADMIN"]'),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "重置 普通用户 的密码" }),
	).toBeVisible();
	await expect(page.getByText("角色与删除")).not.toBeVisible();
	await expect(
		page.getByLabel("删除操作确认密码", { exact: true }),
	).not.toBeVisible();
});

test("超级管理员账号操作与后端权限矩阵一致", async ({ page, context }) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.route("**/api/identity/accounts", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		await route.fulfill({
			body: JSON.stringify({
				accounts: [
					{
						accountId: "account-user",
						createdAt: "2026-08-27T18:00:00.000Z",
						deletionDueAt: null,
						role: "USER",
						status: "ACTIVE",
						username: "普通用户",
					},
					{
						accountId: "account-admin",
						createdAt: "2026-08-27T18:00:00.000Z",
						deletionDueAt: null,
						role: "ADMIN",
						status: "ACTIVE",
						username: "二级管理员",
					},
					{
						accountId: "account-super",
						createdAt: "2026-08-27T18:00:00.000Z",
						deletionDueAt: null,
						role: "SUPERADMIN",
						status: "ACTIVE",
						username: "超级管理员",
					},
					{
						accountId: "account-pending",
						createdAt: "2026-08-27T18:00:00.000Z",
						deletionDueAt: "2026-09-03T18:00:00.000Z",
						role: "USER",
						status: "PENDING_DELETION",
						username: "等待删除用户",
					},
					{
						accountId: "account-deleted",
						createdAt: "2026-08-27T18:00:00.000Z",
						deletionDueAt: null,
						role: "USER",
						status: "DELETED",
						username: "已删除用户",
					},
				],
			}),
			contentType: "application/json",
			status: 200,
		});
	});
	let statusRequest: Record<string, unknown> | undefined;
	await page.route(
		"**/api/identity/accounts/account-super/status",
		async (route) => {
			statusRequest = route.request().postDataJSON() as Record<string, unknown>;
			await route.fulfill({
				body: JSON.stringify({
					account: { accountId: "account-super", status: "DISABLED" },
					ok: true,
				}),
				contentType: "application/json",
				status: 200,
			});
		},
	);
	await page.goto("/admin/accounts");

	const userRow = page.getByRole("row").filter({ hasText: "普通用户" });
	const adminRow = page.getByRole("row").filter({ hasText: "二级管理员" });
	const superadminRow = page.getByRole("row").filter({ hasText: "超级管理员" });
	const pendingRow = page.getByRole("row").filter({ hasText: "等待删除用户" });
	const deletedRow = page.getByRole("row").filter({ hasText: "已删除用户" });

	await expect(
		userRow.getByRole("button", { name: "重置 普通用户 的密码" }),
	).toBeVisible();
	await expect(
		adminRow.getByRole("button", { name: "重置 二级管理员 的密码" }),
	).toBeVisible();
	await expect(
		superadminRow.getByRole("button", { name: "重置 超级管理员 的密码" }),
	).toHaveCount(0);
	await expect(pendingRow.getByRole("button")).toHaveCount(0);
	await expect(deletedRow.getByRole("button")).toHaveCount(0);

	await userRow.getByText("角色与删除").click();
	await expect(
		userRow.getByLabel("删除操作确认密码", { exact: true }),
	).toBeVisible();
	await adminRow.getByText("角色与删除").click();
	await expect(
		adminRow.getByLabel("删除操作确认密码", { exact: true }),
	).toHaveCount(0);

	await superadminRow.getByRole("button", { name: "停用 超级管理员" }).click();
	await expect(
		superadminRow.getByLabel("停用超级管理员确认密码", { exact: true }),
	).toBeVisible();
	await superadminRow
		.getByLabel("停用超级管理员确认密码", { exact: true })
		.fill("super123!");
	await superadminRow.getByRole("button", { name: "确认停用" }).click();
	await expect
		.poll(() => statusRequest)
		.toMatchObject({
			currentPassword: "super123!",
			status: "DISABLED",
		});
});

test("创建账号提交期间显示忙碌状态并阻止重复提交", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	let releaseRequest = () => undefined;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await page.route("**/api/identity/accounts", async (route) => {
		if (route.request().method() === "POST") await requestGate;
		await route.continue();
	});
	await page.goto("/admin/accounts");
	await page.getByLabel("用户名").fill("新用户");
	await page.getByRole("button", { name: "创建账号" }).click();
	await expect(page.getByRole("button", { name: "正在创建…" })).toBeDisabled();
	releaseRequest();
	await expect(page.getByText(/一次性临时密码/)).toBeFocused();
});

test("创建账号失败前清除上次的一次性临时密码", async ({ page, context }) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/admin/accounts");
	await page.getByLabel("用户名").fill("第一个用户");
	await page.getByRole("button", { name: "创建账号" }).click();
	await expect(page.getByText(/一次性临时密码/)).toContainText("temporary-123");

	await page.route("**/api/identity/accounts", async (route) => {
		if (route.request().method() === "POST") {
			await route.fulfill({
				body: JSON.stringify({ code: "FORBIDDEN" }),
				contentType: "application/json",
				status: 403,
			});
			return;
		}
		await route.continue();
	});
	await page.getByLabel("用户名").fill("第二个用户");
	await page.getByRole("button", { name: "创建账号" }).click();
	await expect(
		page.getByText("账号创建失败，请检查用户名或当前权限。"),
	).toBeFocused();
	await expect(page.getByText(/一次性临时密码/)).not.toBeVisible();
});

test("账号确认操作等待响应时保留确认框并阻止重复提交", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	let releaseRequest = () => undefined;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await page.route(
		"**/api/identity/accounts/account-user/password-reset",
		async (route) => {
			await requestGate;
			await route.continue();
		},
	);
	await page.goto("/admin/accounts");
	await page.getByRole("button", { name: "重置 普通用户 的密码" }).click();
	await page.getByRole("button", { name: "确认重置密码" }).click();
	await expect(page.getByRole("button", { name: "正在重置…" })).toBeDisabled();
	await expect(
		page.getByText("将撤销该用户全部登录状态，并签发仅展示一次的临时密码。"),
	).toBeVisible();
	releaseRequest();
	await expect(
		page.getByText("密码已重置，全部旧会话已经失效。"),
	).toBeVisible();
});

test("角色变更提交期间显示忙碌状态并阻止重复提交", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	let releaseRequest = () => undefined;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await page.route(
		"**/api/identity/accounts/account-user/role",
		async (route) => {
			await requestGate;
			await route.continue();
		},
	);
	await page.goto("/admin/accounts");
	await page.getByText("角色与删除").click();
	await page
		.getByLabel("超级管理员当前密码", { exact: true })
		.fill("super123!");
	await page.getByRole("button", { name: "更新角色" }).click();
	await expect(page.getByRole("button", { name: "正在更新…" })).toBeDisabled();
	releaseRequest();
	await expect(page.getByText("账号角色已更新")).toBeVisible();
});

test("账号删除申请提交期间显示忙碌状态并阻止重复提交", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	let releaseRequest = () => undefined;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await page.route(
		"**/api/identity/accounts/account-user/deletion",
		async (route) => {
			await requestGate;
			await route.continue();
		},
	);
	await page.goto("/admin/accounts");
	await page.getByText("角色与删除").click();
	await page.getByLabel("删除操作确认密码", { exact: true }).fill("super123!");
	await page.getByRole("button", { name: "进入等待删除" }).click();
	await expect(
		page.getByRole("button", { name: "正在提交删除申请…" }),
	).toBeDisabled();
	releaseRequest();
	await expect(page.getByText("账号已进入七天等待删除期")).toBeVisible();
});

test("创建邀请提交期间显示忙碌状态并阻止重复提交", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	let releaseRequest = () => undefined;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await page.route("**/api/identity/invitations", async (route) => {
		if (route.request().method() === "POST") await requestGate;
		await route.continue();
	});
	await page.goto("/admin/invitations");
	await page.getByRole("button", { name: "创建邀请" }).click();
	await expect(page.getByRole("button", { name: "正在创建…" })).toBeDisabled();
	releaseRequest();
	await expect(
		page.getByText("INVITE-CODE-123", { exact: true }),
	).toBeVisible();
	await expect(page.locator(".one-time-secret")).toBeFocused();
});

test("创建邀请失败前清除上次的一次性邀请码", async ({ page, context }) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/admin/invitations");
	await page.getByRole("button", { name: "创建邀请" }).click();
	await expect(
		page.getByText("INVITE-CODE-123", { exact: true }),
	).toBeVisible();

	await page.route("**/api/identity/invitations", async (route) => {
		if (route.request().method() === "POST") {
			await route.fulfill({
				body: JSON.stringify({ code: "FORBIDDEN" }),
				contentType: "application/json",
				status: 403,
			});
			return;
		}
		await route.continue();
	});
	await page.getByRole("button", { name: "创建邀请" }).click();
	await expect(
		page.getByText("邀请创建失败，请检查当前权限或稍后重试。"),
	).toBeFocused();
	await expect(
		page.getByText("INVITE-CODE-123", { exact: true }),
	).not.toBeVisible();
});

test("撤销邀请等待响应时保留确认框并阻止重复提交", async ({
	page,
	context,
}) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "bootstrap-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	let releaseRequest = () => undefined;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await page.route(
		"**/api/identity/invitations/invitation-one",
		async (route) => {
			await requestGate;
			await route.continue();
		},
	);
	await page.goto("/admin/invitations");
	await page.getByRole("button", { name: "撤销邀请 invitation-one" }).click();
	await page.getByRole("button", { name: "确认撤销" }).click();
	await expect(page.getByRole("button", { name: "正在撤销…" })).toBeDisabled();
	await expect(
		page.getByText("撤销后该邀请码将立即失效，且不能恢复。"),
	).toBeVisible();
	releaseRequest();
	await expect(page.getByText("邀请已撤销")).toBeVisible();
});

test("安全与受限账号表单失败后焦点进入错误摘要", async ({ page, context }) => {
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "registered-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/security");
	await page.getByLabel("新密码", { exact: true }).fill("x");
	await page.getByLabel("确认新密码", { exact: true }).fill("x");
	await page.getByRole("button", { name: "修改密码" }).click();
	await expect(page.locator(".form-message[role='alert']")).toBeFocused();

	await context.clearCookies();
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "temporary-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/password-change");
	await page.getByLabel("新密码", { exact: true }).fill("x");
	await page.getByLabel("确认新密码", { exact: true }).fill("x");
	await page.getByRole("button", { name: "保存新密码" }).click();
	await expect(page.locator(".form-message[role='alert']")).toBeFocused();

	await page.route("**/api/identity/deletion/cancel", async (route) => {
		await route.fulfill({
			body: JSON.stringify({ code: "SESSION_EXPIRED" }),
			contentType: "application/json",
			status: 401,
		});
	});
	await context.clearCookies();
	await context.addCookies([
		{
			name: "choicemind_session",
			value: "pending-session",
			url: "http://127.0.0.1:3000",
		},
	]);
	await page.goto("/deletion-pending");
	await page.getByRole("button", { name: "取消删除" }).click();
	await expect(page.locator(".form-message[role='alert']")).toBeFocused();
});

test("本机恢复成功后只显示一次新的恢复码", async ({ page }) => {
	await page.goto("/recovery");
	await page.getByLabel("现有恢复码").fill("OLD-RECOVERY-CODE-123");
	await page.getByLabel("新密码", { exact: true }).fill("new-super-123");
	await page.getByLabel("确认新密码", { exact: true }).fill("new-super-123");
	await page.getByRole("button", { name: "恢复超级管理员" }).click();

	await expect(
		page.getByRole("heading", { name: "保存新的恢复码" }),
	).toBeVisible();
	await expect(
		page.getByText("NEW-RECOVERY-CODE-123", { exact: true }),
	).toBeVisible();
	await expect(page.locator(".recovery-result")).toBeFocused();
});

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
	response: import("node:http").ServerResponse,
	status: number,
	body: unknown,
): void {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(body));
}
