<div align="center">

# ChoiceMind（星枢智购）

**把消费问题转化为可审查、可验证、可恢复的个人决策。**

[![status](https://img.shields.io/badge/status-P0%20complete-2da44e)](#phase-路线) [![phase](https://img.shields.io/badge/phase-P1%20not%20started-6e7781)](#phase-路线) [![Node.js](https://img.shields.io/badge/Node.js-22.22.1-339933?logo=nodedotjs&logoColor=white)](#本地开发) [![pnpm](https://img.shields.io/badge/pnpm-11.21.0-f69220?logo=pnpm&logoColor=white)](#本地开发) [![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-8250df)](#本地开发) [![license](https://img.shields.io/badge/license-MIT-2da44e)](LICENSE)

Requirement · Claim/Evidence · Decision · Persistent Task · Safe Recovery · Category Package · Gold Gate

[项目定位](#项目定位) · [已验证能力](#已验证能力) · [Phase 路线](#phase-路线) · [本地开发](#本地开发) · [参与贡献](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)

</div>

## 项目定位

ChoiceMind 是面向单个消费者的智能消费决策 Agent。它把需求、候选方案、可定位证据、约束、风险和未决信息组织成可审查的 Decision；目标不是生成商品榜单，也不代替用户下单。

> **P0：合同、边界、安全、持久化、恢复和可验证底座已完成。** P0-01 至 P0-12 均已完成产品验收、代码合并和 Issue 关闭。项目当前停止在 P0/P1 决策边界，P1 尚未启动；该状态不代表 V1.0 完成、生产认证或正式发布。

本仓库公开代码与工程配置；内部 ADR、规格书、验收证据和 handoff 按仓库策略保留在本地，不随公开仓库发布。

## 已验证能力

- 版本化 Requirement、Candidate、Claim、Evidence、Decision、RunEvent 与错误合同，以及失败关闭的 Decision Basis 校验。
- Web、API、Orchestrator、Data Worker 四服务健康链和确定性合成决策纵向。
- ChoiceMind 持有业务语义，CoreMind 通过薄 Runtime Adapter 接入；精确候选的隔离兼容门禁已完成产品验收。
- Postgres/pgvector 权威任务状态、同事务 Outbox、Redis Streams Publisher、租约 Worker、幂等完成和故障恢复。
- P0-04 根级工程验证、真实 Postgres/Redis 集成与 Compose 故障验收通过；[Issue #4](https://github.com/Eclipseic1848/ChoiceMind/issues/4) 已完成产品验收并关闭。
- Postgres 持久化公开 RunEvent 与单调游标；Redis 只发送实时通知，通知不可用时 SSE 仍从 Postgres 轮询恢复。
- Web 支持按 `Last-Event-ID` 补发、重复事件去重和乱序排序；刷新、断线与 API 短暂不可用后可恢复权威任务状态和已有事件。
- P0-05 根级工程验证、真实八服务 Compose 与 Chrome 产品验收通过；[PR #33](https://github.com/Eclipseic1848/ChoiceMind/pull/33) 已合并。
- API 从受信任服务端配置派生 Principal，任务与 RunEvent 按 User 所有权过滤；`USER`、`ADMIN` 与 `SUPERADMIN` 角色均不能据角色本身读取其他 User 的私有对象。
- CredentialVault 为每条 Secret 生成独立数据密钥并使用信封加密，主密钥不进入数据库密文；Secret 无法序列化或从受控使用回调逸出，凭据访问先写审计再释放明文。
- RiskPolicy 区分 `ALLOW`、`DENY` 与 `REQUIRE_CONFIRMATION`；CoreMind Provider 调用缺少绑定用户与操作的确认或 EgressGuard 时失败关闭，获准调用只留下不含正文、响应或 Secret 的最小 EgressRecord。
- P0-06 根级验证、真实 Postgres/Redis、Compose 隔离与故障矩阵、独立双轴复审和产品验收通过；[PR #35](https://github.com/Eclipseic1848/ChoiceMind/pull/35) 已合并，[Issue #6](https://github.com/Eclipseic1848/ChoiceMind/issues/6) 已关闭。
- RuntimeSnapshot、EffectReceipt、Checkpoint 和恢复许可共同约束暂停、恢复、取消与副作用结果复用；started/unknown 副作用保持人工核验或拒绝自动恢复。[Issue #17](https://github.com/Eclipseic1848/ChoiceMind/issues/17) 与 [Issue #9](https://github.com/Eclipseic1848/ChoiceMind/issues/9) 已关闭。
- Qwen、Embedding、Reranker、PaddleOCR-VL 与 MinerU 的统一版本化合同和固定样本 smoke 已通过产品验收；[PR #39](https://github.com/Eclipseic1848/ChoiceMind/pull/39) 已合并。
- 受控公开网页可经 Egress/SSRF/MIME/大小门禁、本地 HTML parser、内容寻址对象、pgvector 与本地 Reranker 形成可定位 Evidence；[PR #40](https://github.com/Eclipseic1848/ChoiceMind/pull/40) 已合并，[Issue #11](https://github.com/Eclipseic1848/ChoiceMind/issues/11) 已关闭。

这些是当前代码与验收范围内的证据，不等于真实消费数据质量、完整 Provider 认证、生产安全或发布资格。

## 系统基线

```text
Web（仅转发服务端持有的身份）
  → API（Principal / User 所有权 / Audit Record）
    → Postgres / pgvector（权威状态）
      → Transactional Outbox
        → Redis Streams（可重建传输）
          → Orchestrator Worker
            → AgentRuntimePort / CoreMind Adapter
              → RiskPolicy / EgressGuard
                → Provider（尚未完成真实认证）
```

Redis 只承担可恢复的传输职责，不能覆盖 Postgres 权威事实；Provider 与 Runtime 输出均视为不可信输入，必须经过 ChoiceMind 合同校验。

```text
Postgres（权威任务状态与持久 RunEvent）
  → Redis 实时通知（非权威，可降级）
    → API SSE（Last-Event-ID 补发）
      → Web 刷新与断线恢复
```

## Phase 路线

| 切片 | 状态 | 公开结果 |
| --- | --- | --- |
| P0-01 / P0-02 / P0-03 | 已完成 | 领域边界、四服务基线、首个合成 Decision 纵向 |
| P0-07A | 已完成 | 最小 Runtime Adapter、候选兼容门禁、本地合成模型冒烟 |
| [P0-04](https://github.com/Eclipseic1848/ChoiceMind/issues/4) | 已完成 | 持久任务、同事务 Outbox、Redis Streams、幂等 Worker |
| [P0-05](https://github.com/Eclipseic1848/ChoiceMind/issues/5) | 已完成 | 持久 RunEvent、单调游标、SSE `Last-Event-ID` 回放与 Web 恢复 |
| [P0-06](https://github.com/Eclipseic1848/ChoiceMind/issues/6) | 已完成 | 服务端身份与 User 隔离、CredentialVault、RiskPolicy、EgressRecord 与审计路径 |
| [P0-07B](https://github.com/Eclipseic1848/ChoiceMind/issues/17) / [P0-09](https://github.com/Eclipseic1848/ChoiceMind/issues/9) | 已完成 | Runtime 事件、快照、收据、恢复许可与副作用安全 |
| [P0-10](https://github.com/Eclipseic1848/ChoiceMind/issues/10) | 已完成 | 五个本地模型/解析服务的版本化合同与真实固定样本 smoke |
| [P0-11](https://github.com/Eclipseic1848/ChoiceMind/issues/11) | 已完成 | 受控公开来源、本地 HTML 解析、对象引用、可定位 Evidence 与本地检索 |
| [P0-12](https://github.com/Eclipseic1848/ChoiceMind/issues/12) | 已完成 | 合成 Category Package、core 零差异、统一 Gold Gate、EvaluationReport、证据索引与固定六服务 smoke；[PR #41](https://github.com/Eclipseic1848/ChoiceMind/pull/41) 已合并 |

每个 Phase 切片只有在工程证据、独立审查、产品验收、代码合并和 Issue 证据同步分别完成后，才能标记为“已完成”。Phase 完成时必须同步更新本表、上方状态说明、已验证能力、必要的社区文档和 GitHub About；详细清单见[贡献指南](CONTRIBUTING.md#phase-完成同步门禁)。

## 本地开发

### 环境

- Node.js `22.22.1`
- pnpm `11.21.0`
- Python `3.14.6`
- uv `0.11.19`
- Docker（运行 Linux Compose 或真实 Postgres/Redis 集成时需要）

### 安装与启动

```powershell
corepack pnpm install --frozen-lockfile
uv sync --frozen --project services/data-worker --group dev
corepack pnpm --filter @choicemind/web exec playwright install chromium
corepack pnpm dev
```

Windows 本地开发也可以在仓库根目录双击 `start_all.bat`，或在 CMD/Windows Terminal 中执行：

```bat
start_all.bat
```

脚本会检查仓库声明的 Node.js/pnpm 版本、uv、Docker Engine/Compose、已安装依赖和固定端口，然后启动 PostgreSQL、Redis 以及现有 `pnpm dev` 全部应用服务。所有应用日志保留在同一窗口并带服务名前缀；修改 Web 源码后由 Next.js 开发服务器热更新。按 `Ctrl+C` 会终止脚本创建的应用进程树并停止本次基础容器，PostgreSQL 与 Redis 命名数据卷不会删除。

本地数据库密码首次启动时随机生成，只保存在当前 Windows 用户的 `%LOCALAPPDATA%\ChoiceMind\development`，不会写入仓库或输出到终端。首次打开前端后，按照页面提示创建第一个 SUPERADMIN；后续账号与登录状态持久保存在本地 PostgreSQL。依赖或端口不满足时，脚本会用中文指出具体修复动作并返回失败。只做启动前检查而不启动服务，可执行 `start_all.bat --preflight-only`。

启动后可访问：

- Web 合成决策页面：<http://127.0.0.1:3000>
- API 健康汇总：<http://127.0.0.1:3100/api/v1/system/health>
- Web、API、Orchestrator、Data Worker 的存活端点分别位于 `3000`、`3100`、`3200`、`3300` 端口的 `/health/live`

页面使用固定合成需求与证据，不访问真实商品、价格或用户凭据。

### Evidence 采集链路（P0-11，已完成）

Evidence ingestion 入口不改变现有 synthetic Decision Runtime。链路为：精确批准的 HTTPS URL → SSRF/DNS/MIME/大小/Egress 门禁 → SHA-256 内容寻址对象存储 → data-worker 本地 HTML 解析 → 可定位 Public Web Evidence → 本地 Embedding → pgvector → 本地 Reranker。Postgres 只保存来源、locator、哈希、对象引用和向量元数据，不保存网页原始正文。

仓库内固定 HTML 快照用于离线测试。P0-11 已对获批的 `https://example.com/` 完成一次真实闭环并通过产品验收；再次访问或更换来源仍必须明确目标 URL 并单独取得授权，历史验收不自动授权新的外传。

```powershell
$env:CHOICEMIND_DATABASE_URL = "postgresql://..."
$env:CHOICEMIND_EVIDENCE_SOURCE_URL = "https://已批准的精确地址/"
fnm exec --using=22.22.1 -- pnpm.cmd --filter @choicemind/evidence-ingestion smoke
```

Compose 按需入口使用 `evidence-smoke` profile，默认不会随基础服务启动：

```bash
docker compose --profile evidence-smoke -f deploy/compose/compose.yaml run --rm evidence-smoke
```

冒烟报告只输出状态、ID、URL、哈希、parser 版本和检索结果，不输出网页正文或凭据。对象文件保存在独立 `evidence-objects` 卷中。

### P0 Gold Gate（P0-12，已完成）

统一入口使用合成折叠露营桌 Category Package 经过现有 `DecisionTaskExecutor` 生成合法 Decision，并把合同正反例、失败语义、用户隔离、秘密脱敏、事件重放/恢复、core 零差异及当前六服务合同结果汇总为机器可读 `evaluation-report.json` 与 `evidence-index.json`。任一阻断门禁失败时整体返回 `P0_FAILED`。

```powershell
$env:CHOICEMIND_LOCAL_SMOKE_REPORT_PATH = ".artifacts/p0-12-local-services-smoke.json"
fnm exec --using=22.22.1 -- pnpm.cmd smoke:local-services
fnm exec --using=22.22.1 -- pnpm.cmd p0:gold `
  --local-service-report ".artifacts/p0-12-local-services-smoke.json"
```

当前六项为 Qwen 模型、Embedding、Reranker、PaddleOCR-VL、MinerU 和 ChoiceMind HTML parser。2026-08-26 已在获批范围内各执行一次固定合成样本 smoke，六项均通过；随后统一 Gold Gate 返回 `P0_PASSED` 且无阻断项，Issue #12 已完成产品验收并通过 PR #41 合入。该结果不等于生产能力认证、V1.0 完成或正式发布。再次运行真实 smoke 仍必须单独确认精确端点；旧五服务报告会被明确拒绝。

### 完整工程检查

```powershell
fnm exec --using=22.22.1 -- pnpm.cmd verify
```

该命令覆盖 lint、typecheck、测试、UTF-8 检查和构建。单项通过不能替代真实依赖验收、产品验收或生产认证。

### Linux Compose 基线

```bash
docker compose -f deploy/compose/compose.yaml config --quiet
docker compose -f deploy/compose/compose.yaml up --build
```

Compose 用于开发与故障恢复验证，不代表生产部署已经完成。

## 参与与安全

- 提交 Issue 或 PR 前请阅读[贡献指南](CONTRIBUTING.md)与[社区行为准则](CODE_OF_CONDUCT.md)。
- 安全问题不要公开披露，请按[安全策略](SECURITY.md)私下报告。
- 项目采用 [MIT License](LICENSE)。
