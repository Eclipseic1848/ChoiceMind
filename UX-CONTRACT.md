# ChoiceMind P1 UX 契约

## 权威来源

- GitHub Issue #46：账号、邀请、角色与生命周期冻结决策。
- GitHub Issue #51：Identity & Access 模块归属和服务端 Principal 隔离。
- GitHub Issue #52：P1 验收矩阵。
- GitHub Issue #56：身份完整纵向范围与验收标准。
- `CONTEXT.md`：ChoiceMind Account、Role、Login Session 与 Private User Data。
- `DESIGN.md`：Web 视觉与交互规范源。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | 业务表单状态契约与共享 `PasswordInput` | 本文件“表单契约” | 身份、账号安全、管理 | `apps/web/tests/identity.spec.ts` |
| Select/Listbox | 浏览器原生 `select` | 本文件“表单契约” | 账号创建、角色变更 | 浏览器键盘操作与 `identity.spec.ts` |
| Scrollbar | `apps/web/src/app/globals.css` | `DESIGN.md` Token | 表格横向滚动 | 严格静态审计与浏览器窄屏检查 |
| CRUD | `admin-pages.tsx` + Identity BFF/API | GitHub Issue #56 | 账号、邀请 | `identity.spec.ts` 与真实 Postgres 集成测试 |

## 路由与可见性

| 路由 | 可见用户 | 目标 | 核心状态 |
| --- | --- | --- | --- |
| `/setup` | 仅本机且尚未初始化 | 创建首个 SUPERADMIN | 检查、表单、提交、一次性恢复码、已完成 |
| `/login` | 未登录用户 | 用户名密码登录 | 默认、提交、错误、节流、强制改密、删除待定 |
| `/register?code=` | 持有效邀请者 | 创建 USER 账号 | 缺码、有效表单、无效/过期/已使用、成功 |
| `/` | 已登录用户 | 决策工作台 | 身份检查、可用、服务降级、会话失效 |
| `/security` | 已登录用户 | 密码与会话管理 | 改密、退出当前、退出全部、删除等待期 |
| `/admin/accounts` | ADMIN、SUPERADMIN | 账号管理 | 表格、创建、重置、停用、删除、空态、失败与权限拒绝 |
| `/admin/invitations` | ADMIN、SUPERADMIN | 邀请管理 | 列表、创建、复制一次、撤销 |
| `/admin/audit` | SUPERADMIN | 审计查阅 | 只读列表、空态、不可用与权限拒绝 |

## 身份状态机

1. Web 首先请求服务端 `/identity/me`，只信任服务端返回的 Principal。
2. 未登录时请求 bootstrap 状态：需要初始化则进入 `/setup`，否则进入 `/login`。
3. 登录、注册和初始化成功后，API 通过 `HttpOnly; SameSite=Lax` Cookie 建立固定七天会话；页面不得读取令牌。
4. Temporary Password 用户只能进入强制改密路径；完成后重新签发会话。
5. Pending Deletion 用户只能取消删除、退出或查看删除截止时间。
6. Disabled、Deleted、过期或已撤销会话统一回到登录页，不展示私人内容。

## 表单契约

- 用户名：2–32 个汉字、ASCII 字母、数字或下划线；ASCII 大小写不敏感，创建后不可修改。
- 密码：至少 6 个可打印 ASCII 字符且不含空格。弱密码允许提交，但界面提示强度。
- 登录失败不区分用户名不存在或密码错误；连续 5 次失败后显示约 30 秒节流状态。
- 客户端校验只用于即时反馈，服务端必须重复校验并拥有最终决定权。
- 网络失败保留用户已输入内容，提供原地重试，不静默吞错。
- 密码字段统一使用共享 `PasswordInput`，默认隐藏并提供键盘可操作的显示/隐藏按钮。
- 账号角色选择接受 Windows 与浏览器原生下拉弹层，统一使用原生 `select`；ChoiceMind 不拥有弹层几何外观。
- 远程提交使用服务端确认后的悲观更新；等待期间按钮显示具体动作并禁用，确认框在失败时保留上下文和重试路径。

## 权限与隐私

- USER 只能读写自己的对象、事件、会话与私人数据。
- ADMIN 可创建 USER、停用 USER、重置 USER 临时密码；不能读取任何用户私人内容或秘密，不能管理 ADMIN/SUPERADMIN。
- SUPERADMIN 可管理角色和普通账号；高权限动作必须重新输入自己的密码。
- 始终保留至少一个可用 SUPERADMIN。
- 审计记录不包含密码、恢复码、邀请原码、会话令牌、Cookie 或私人内容。

## 破坏性操作

- 停用立即撤销目标会话与进行中任务，但保留数据。
- 自助删除需重新认证，进入 7 天等待期并可取消。
- 真正物理删除属于不可逆操作；开发和测试只能在隔离数据中证明协调逻辑，真实数据执行仍受人工门禁。

## 响应式与键盘验收

- 360px 宽度无水平滚动；桌面宽屏内容最大宽度受控。
- Tab 顺序与视觉顺序一致，焦点始终可见；提交后焦点进入错误摘要或成功结果。
- 200% 缩放可完成全部身份操作。
- `prefers-reduced-motion: reduce` 下无位移动画。
