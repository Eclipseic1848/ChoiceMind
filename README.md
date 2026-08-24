<div align="center">

# ChoiceMind（星枢智购）

**把消费问题转化为可审查、可验证、可恢复的个人决策。**

[![status](https://img.shields.io/badge/status-P0%20foundation-1f6feb)](#phase-路线) [![phase](https://img.shields.io/badge/phase-P0--04%20complete-2da44e)](#phase-路线) [![Node.js](https://img.shields.io/badge/Node.js-22.22.1-339933?logo=nodedotjs&logoColor=white)](#本地开发) [![pnpm](https://img.shields.io/badge/pnpm-11.21.0-f69220?logo=pnpm&logoColor=white)](#本地开发) [![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-8250df)](#本地开发) [![license](https://img.shields.io/badge/license-MIT-2da44e)](LICENSE)

Requirement · Candidate · Claim/Evidence · Decision · Persistent Task · Runtime Adapter

[项目定位](#项目定位) · [已验证能力](#已验证能力) · [Phase 路线](#phase-路线) · [本地开发](#本地开发) · [参与贡献](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)

</div>

## 项目定位

ChoiceMind 是面向单个消费者的智能消费决策 Agent。它把需求、候选方案、可定位证据、约束、风险和未决信息组织成可审查的 Decision；目标不是生成商品榜单，也不代替用户下单。

> 当前处于 **P0：合同、边界、安全、持久化、恢复和可验证底座**。P0-01/02/03、P0-07A 与 P0-04 已闭环，下一切片 P0-05 正在规划。该状态不代表 P0 整体完成、P1 已开始、生产认证或正式发布。

本仓库公开代码与工程配置；内部 ADR、规格书、验收证据和 handoff 按仓库策略保留在本地，不随公开仓库发布。

## 已验证能力

- 版本化 Requirement、Candidate、Claim、Evidence、Decision、RunEvent 与错误合同，以及失败关闭的 Decision Basis 校验。
- Web、API、Orchestrator、Data Worker 四服务健康链和确定性合成决策纵向。
- ChoiceMind 持有业务语义，CoreMind 通过薄 Runtime Adapter 接入；精确候选的隔离兼容门禁已完成产品验收。
- Postgres/pgvector 权威任务状态、同事务 Outbox、Redis Streams Publisher、租约 Worker、幂等完成和故障恢复。
- P0-04 根级工程验证、真实 Postgres/Redis 集成与 Compose 故障验收通过；[Issue #4](https://github.com/Eclipseic1848/ChoiceMind/issues/4) 已完成产品验收并关闭。

这些是当前代码与验收范围内的证据，不等于真实消费数据质量、完整 Provider 认证、生产安全或发布资格。

## 系统基线

```text
Web
  → API
    → Postgres / pgvector（权威状态）
      → Transactional Outbox
        → Redis Streams（可重建传输）
          → Orchestrator Worker
            → AgentRuntimePort / CoreMind Adapter
```

Redis 只承担可恢复的传输职责，不能覆盖 Postgres 权威事实；Provider 与 Runtime 输出均视为不可信输入，必须经过 ChoiceMind 合同校验。

## Phase 路线

| 切片 | 状态 | 公开结果 |
| --- | --- | --- |
| P0-01 / P0-02 / P0-03 | 已完成 | 领域边界、四服务基线、首个合成 Decision 纵向 |
| P0-07A | 已完成 | 最小 Runtime Adapter、候选兼容门禁、本地合成模型冒烟 |
| [P0-04](https://github.com/Eclipseic1848/ChoiceMind/issues/4) | 已完成 | 持久任务、同事务 Outbox、Redis Streams、幂等 Worker |
| [P0-05](https://github.com/Eclipseic1848/ChoiceMind/issues/5) | 规划中 | 持久 RunEvent、单调游标、SSE `Last-Event-ID` 回放 |
| [P0-06](https://github.com/Eclipseic1848/ChoiceMind/issues/6) 及后续 P0 | 未开始或待裁决 | 用户隔离、安全恢复、服务合同、Evidence 最小链路与 Gold Gate |

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

启动后可访问：

- Web 合成决策页面：<http://127.0.0.1:3000>
- API 健康汇总：<http://127.0.0.1:3100/api/v1/system/health>
- Web、API、Orchestrator、Data Worker 的存活端点分别位于 `3000`、`3100`、`3200`、`3300` 端口的 `/health/live`

页面使用固定合成需求与证据，不访问真实商品、价格或用户凭据。

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
