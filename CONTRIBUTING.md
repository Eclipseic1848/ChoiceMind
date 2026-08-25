# 参与 ChoiceMind

感谢你帮助 ChoiceMind 建立可信、可审查的消费决策能力。项目当前仍处于 P0 基础阶段，贡献必须保持范围清晰、证据可复核，并遵守[社区行为准则](CODE_OF_CONDUCT.md)。

## 开始之前

1. 检查是否已有对应 [Issue](https://github.com/Eclipseic1848/ChoiceMind/issues)。较大的功能、公共合同、权限、安全、数据外传或依赖变更必须先在 Issue 中达成范围共识。
2. 不要提交真实 API Key、Cookie、访问令牌、个人消费数据、模型原始响应或未经脱敏的运行日志。
3. 区分工程检查、真实服务验证、产品验收和生产认证；不要把其中一种结果表述为另一种。
4. 安全漏洞请按[安全策略](SECURITY.md)私下报告，不要创建公开 Issue。

## 开发环境

- Node.js `22.22.1`
- pnpm `11.21.0`
- Python `3.14.6`
- uv `0.11.19`

```powershell
corepack pnpm install --frozen-lockfile
uv sync --frozen --project services/data-worker --group dev
corepack pnpm --filter @choicemind/web exec playwright install chromium
```

## 工作方式

1. 从最新 `main` 创建聚焦单一 Issue 或切片的分支。
2. 先写出可验证的成功标准；修复缺陷或新增行为时优先以测试复现预期。
3. 只修改与当前范围直接相关的文件，不顺手重构无关代码。
4. 合同、错误语义、持久化权威、安全或外部副作用发生变化时，在 PR 中明确说明兼容性和失败行为。
5. 提交前运行与风险相称的检查；完整根级门禁为：

```powershell
fnm exec --using=22.22.1 -- pnpm.cmd verify
```

6. PR 必须列出范围、验证证据、未验证边界和后续独立门禁。绿色测试不自动构成产品验收、合并、发布或部署授权。

## 提交与 PR

- 提交信息应简洁说明行为变化，例如 `feat(tasks): ...`、`fix(api): ...`、`docs: ...`。
- PR 应尽量小而完整；不要混入 `.artifacts/`、本地 handoff、真实凭据或与目标无关的用户文件。
- 如有真实 Provider、外部模型或收费服务调用，必须在执行前说明目标、连接、出站数据和费用边界，并取得明确授权。
- 对公共合同或安全边界的变更，应提供失败样例和回归证据。
- 受保护路由必须使用服务端派生的 Principal 和对象所有权检查；不得信任请求正文、查询参数或浏览器自报的 User ID 与角色。
- 凭据只能通过 CredentialVault 的受控接口保存和使用；访问或变更必须先形成审计事实，Secret 不得进入返回值、异常、RunEvent 或日志。
- 外部访问必须先经过 RiskPolicy 与 EgressGuard；EgressRecord 只记录必要元数据，不得保存请求正文、响应内容或 Secret。

## Phase 完成同步门禁

一个 Phase 切片只有在产品验收通过且代码合并后，才可以在公开材料中标记为“已完成”。每次 Phase 完成必须在同一关闭流程中核对并更新：

- `README.md`：顶部 Phase badge、当前状态、已验证能力与 Phase 路线；
- `CODE_OF_CONDUCT.md`、`CONTRIBUTING.md`、`SECURITY.md`：仅在协作、安全或支持边界发生变化时更新，但必须逐项核对；
- `LICENSE`：仅在版权所有者、年份策略或许可证经明确批准发生变化时更新；
- GitHub About：描述、主页和 Topics 必须与当前公开能力一致，不能提前宣传未完成阶段；
- 当前 Phase 的 Issue：写入脱敏的工程证据、独立审查、产品验收和 merge commit，再关闭；
- 本地权威交接与 Evidence Matrix：记录已证明、未证明、保留资源和下一授权门禁。

PR 模板包含相同检查项。若某项无需修改，应在 PR 中写明“已核对，无变化”，而不是跳过。

## 许可证

提交贡献即表示你有权按本仓库的 [MIT License](LICENSE) 提供该贡献。
