# P1-58 Source Access、Source Research 与 Source Worker 规格

## 目标

建立可恢复、用户隔离的来源研究骨架。它证明独立 Worker、登录挑战、短时凭据租约、持久批次和幂等结果能够协同工作，但不宣称任何真实平台 Adapter 已经可用。

## 模块边界

- Source Access Module 的 Interface 只暴露登录命令、来源状态查询、短时凭据回调和用户数据清理。Cookie/Token 只经 Credential Vault 加密保存。
- Source Research Module 的 Interface 只暴露批次命令/查询、Job 领取、检查点和结构化 Outcome。Postgres 隐藏 Job、租约、幂等和 Outbox 细节。
- Source Worker 只领取 Job、选择 Adapter、使用短时 Credential Lease 并报告 Outcome；它不拥有业务事实。
- Fixture Adapter 是受控测试 Adapter。后续真实平台 Adapter 必须复用相同内部 seam，并在对应 Issue 中单独认证。

## 状态与恢复

- Job 状态：`QUEUED`、`RUNNING`、`WAITING_SOURCE_LOGIN`、`COMPLETED`、`NO_RESULT`、`FAILED_RETRYABLE`、`FAILED_FINAL`。
- `QR_CODE`、`SMS`、`CAPTCHA` 是等待用户的挑战，不是失败或零结果。
- `RUNNING` 期间 Worker 周期续租；进程失联且租约过期后，其他 Worker 才可领取同一 Job，并读到最近持久检查点。
- 可重试失败使用持久退避时间，最多尝试 5 次；达到上限转为 `FAILED_FINAL`，不会形成热循环。
- `(job_id, result_key)` 唯一约束阻止重复 Evidence 和重复成本。
- 同一 User 的提交幂等键绑定请求指纹；并发同语义请求返回同一批次，不同语义返回冲突。
- 登录成功后按 User、来源、平台账号恢复等待 Job。
- Adapter 在短时凭据回调中可返回结构化 `AUTH_REQUIRED`；Worker 随即使旧凭据失效并创建新的登录挑战，不把它误报为普通研究失败。
- Vault 存储、读取或解密故障属于可重试基础设施失败，不得据此删除凭据或要求用户重新登录。
- Redis 只能作为通知优化；连接或发布失败不得阻止 Worker 轮询 Postgres。Postgres Job、检查点、租约、结果和 Outbox 是事实源。

## 隐私与隔离

- 所有 Source Credential、登录会话、批次、Job 和结果都绑定服务端解析的 User。
- User A 的查询不能观察 User B 的对象；客户端 Owner 字段不参与授权。
- 普通 actor 必须在任何 Source Access SQL 前匹配 Owner；Source Worker 的 `SYSTEM` 权限由 Vault 实例持有的对象身份能力授予，只允许 `SOURCE_CREDENTIAL` 的使用和删除，不能存储或访问 Provider 凭据。
- Cookie/Token/密码不得进入 Web 状态、模型上下文、普通来源表、日志、错误或 Evidence。
- 本地一键启动的共同父进程、Web 与 Orchestrator 不继承 Vault 主密钥；启动包装器只向 API、Identity Lifecycle Worker 与 Source Worker 的子进程注入密钥。
- 用户主动撤销、运行期失效或重新登录替换凭据时，旧加密密文同步清理。
- 账号到期删除按 Research Batch、Source Access 元数据、Credential Vault 私密记录、Conversation 的顺序协调清理；失败由生命周期事件重试。

## P1-58 验收证据

- Source Access 真实 Postgres：用户/来源/账号隔离，普通表不含 Cookie，租约结束后秘密不可读取，失效与撤销阻止使用。
- Source Research 真实 Postgres：并发只领取一次，续租阻止重复执行，过期租约从检查点恢复，挑战暂停/登录恢复，持久退避与上限生效，重复完成不重复结果或成本。
- Source Worker 单元：未登录报告挑战；已登录只在短时回调中执行 Adapter；运行期凭据失效返回新的登录挑战。
- API：服务端 Principal 强制 Owner 并校验 Decision Task 所有权；Fixture 登录完成后恢复等待 Job；用户可主动撤销凭据。
- Web：Session 同页显示来源连接、研究排队和恢复状态；刷新或切换回来按 Decision Task 恢复批次；独立 Fixture 登录页明确不代表真实平台。
- Web 状态查询或批次恢复暂时失败时，原位置提供显式重试，不要求用户刷新整页，也不会把恢复失败误判为后台任务停止。
- `start_all.bat`：生成本机 Credential Vault 密钥并启动 Source Worker；前端继续热更新。
