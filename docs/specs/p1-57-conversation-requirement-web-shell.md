# P1：Issue #57 Conversation、Requirement 与 Web 产品壳

> 状态：实现完成，等待 PR 验证与合并
> 日期：2026-08-27
> Issue：<https://github.com/Eclipseic1848/ChoiceMind/issues/57>
> 上游：#44、#45、#50、#51、#52、#55、#56

## 1. 交付结论

ChoiceMind 首页已经从 P0 固定合成表单升级为移动端优先的对话决策工作台。登录 User 可以创建和继续 Session，通过连续澄清形成不可变 Requirement Revision，并在同一页面观察关联 Decision Task 的权威进度、暂停、恢复、取消、失败与 SSE 重连状态。

P0 合成纵向保留在 `/dev/synthetic-decision`，只承担工程回归，不再冒充产品首页。真实来源 Adapter、Provider 认证和最终 Decision 结果页仍属于后续 P1 Issue。

## 2. 稳定 Seam 与所有权

`packages/conversation` 暴露单一 `Conversation` Interface：

- `execute`：创建 Session、追加 User Turn、链接已存在的 Decision Task；
- `read`：读取一个 Session、当前 User 的 Session 列表、不可变 Requirement Revision 历史；
- `purgePrivateDataForOwner`：账号到期删除时按 User 物理清理 Conversation 私有数据；
- `close`：释放持久化连接。

Conversation 拥有用户可见 Session、消息、Requirement Revision 与 Decision Task 链接。Decision Task 状态、事件和控制继续由 Task Persistence 拥有；Web 不复制或推导第二份业务状态。API 从真实 Cookie/Authorization 解析 Principal，并在服务端注入 `ownerUserId`，任何客户端自报 User 身份都不可信。

## 3. Minimum Viable Requirement

开始有界研究前只要求三项已明确事实：

1. `consumptionGoal`：这次要解决的消费问题；
2. `primaryScenario`：最常见、最影响判断的使用场景；
3. `hardConstraints`：硬性条件列表，允许明确为空。

预算和软偏好可以随后作为普通补充；它们不阻塞初次研究。每次明确字段变化生成新的不可变 Revision；只发送普通消息时保存消息但不伪造 Revision。

## 4. 持久化与恢复

PostgreSQL 是唯一权威来源，分别保存 Session、Message、Requirement Revision 和 Decision Task Link。外键级联只在所属 Session 内生效，所有读取和写入同时带 User 所有权。

- 相同客户端请求 ID 和相同内容幂等返回；相同 ID 不同内容失败关闭为冲突。
- 页面刷新从 Session URL 和 API 投影恢复。
- Conversation 模块或 API 进程重启后从 PostgreSQL 恢复消息与 Revision。
- SSE 断线按最后权威游标重连并去重排序；Redis 或浏览器连接不成为业务真相。
- Identity Lifecycle Worker 在真正删除账号前依次取消任务、清理任务私有数据、清理 Conversation 私有数据；失败时事件重试，不能先删除账号后遗留孤儿数据。

## 5. Web 产品壳

视觉论点延续 `DESIGN.md` 的“决策航图”：桌面为非对称 Session、对话、需求/任务三栏，移动端按决策顺序折叠为单列。界面复用墨蓝、铜橙、纸白、航迹线和现有字体 Token，不使用通用 SaaS 卡片网格、渐变或装饰图标。

交互包含：

- Session 空态、创建、列表、切换和 URL 恢复；
- 明确标签的 MVR 输入与服务端错误焦点；
- 当前 Requirement 摘要和 Revision 编号；
- 任务权威状态、持久事件、断线重连、暂停原因、安全恢复、取消与失败下一步；
- 360px 无水平滚动、键盘提交、可见焦点和 `prefers-reduced-motion`。

隐藏 Runtime 消息、Tool 参数、Cookie、User ID 和内部错误原文不会进入产品 UI。

## 6. 验证证据

- Conversation 真实 PostgreSQL 集成：创建、MVR Revision、幂等、User 隔离、任务链接、模块重启和账号删除级联。
- API：真实 Cookie Principal、A/B User 交叉读取拒绝、Conversation 重启恢复、账号生命周期跨模块清理。
- Web：Session/MVR/刷新、任务暂停恢复、失败可见、移动端键盘/焦点/reduced motion，以及既有身份和 P0 开发纵向完整回归。
- Windows 启动：根 `start_all.bat` 构建并 watch Conversation，Next.js 保持热更新。

这些证据不证明真实来源、真实模型、最终 Decision 或外部发布；对应能力必须由后续 P1 Issue 分别闭环。
