# ChoiceMind 星枢智购：零上下文开发交接

> 最后更新：2026-08-14
> 当前仓库：`F:\new branch\ChoiceMind`
> 当前分支：`p0-03-first-decision`
> 当前 HEAD：`1cf3ad7`（P0-03 实现提交，已推送 origin；历史基线 `53a972b` 为 P0-02 合并提交）
> 当前 Issue：[#3 P0-03 — 用 Fake AgentRuntime 跑通首个 Decision](https://github.com/Eclipseic1848/ChoiceMind/issues/3)，**已验收并关闭**（2026-08-14）
> 当前结论：**P0-03 已通过四轮独立双轴审查与产品验收，代码已提交（`1cf3ad7`）并推送、Issue #3 已关闭。PR 创建与进入 P0-07A 仍需分别授权。**

## 1. 新会话先做什么

开始任何工作前，按以下顺序完整读取：

1. `AGENTS.md`；
2. 本文件；
3. `CONTEXT.md`；
4. `ChoiceMind_星枢智购_产品与研发规格书_v1.2.md`；
5. `docs/agents/domain.md`；
6. `docs/adr/0001` 至 `0006`；
7. `docs/specs/p0-03-decision-contract-v1.md`；
8. `docs/architecture/p0-03-claim-evidence-authority-module-design.md`；
9. 当前 Issue #3 及本地工作树状态。

使用 Node `22.22.1`，不要用机器上偶然激活的其他版本：

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use 22.22.1
git status --short
git rev-parse HEAD
```

本仓库在 Windows 上可能出现 `rg.exe: Access Denied`。遇到时使用 `Get-ChildItem`、`Select-String` 和 `git ls-files`，不要因此改变任务或工具链。

## 2. 产品是什么，不是什么

ChoiceMind 星枢智购是一个面向小范围测试消费者的 Web 智能消费决策智能体。它通过对话澄清需求，采集多源信息，形成可验证的 Candidate、Claim、Evidence、Risk、Gap 和 Decision，并让用户能够回到证据来源核验。

它不是购物网站，也不是“工作台”。永久不做：

- 购物车、订单、支付、分期、贷款、保险；
- 收货地址、仓储、物流、安装、售后代办；
- 代购、自动下单或代表用户执行交易；
- 家庭、多成员或共享画像模型。

允许提供渠道链接、价格提醒和人工核验清单。一个账号就是一个相互隔离的用户；Session 和 Decision 可以由用户主动分享。

核心必须品类无关。IT、智能家居、擦窗机器人、电动沙发等差异进入 Category Package、Skill 或 Tool Adapter，不能在通用 Decision Engine 中写品类分支。

## 3. 当前正在做的任务

P0-03 已完成并验收（2026-08-14，提交 `1cf3ad7`、Issue #3 已关闭）：用确定性 `FakeAgentRuntimeAdapter` 跑通了第一条合成消费决策纵向链路：

```text
Web → API → Orchestrator → AgentRuntimePort → Fake Runtime
    → Claim/Evidence/Link → Decision Basis → Decision Result → Web 展示
```

P0-03 冻结并验证了以下最难改变的语义：

- Requirement、Candidate、Claim、Evidence、Decision、RunEvent、错误和任务状态的版本化合同；
- 失败不能生成 Decision 或 `ok=true`；
- Hard Constraint、选择、淘汰、Risk 和下一步必须由结构化证据闭包支撑；
- 每个跨进程边界独立校验版本、结构和 HTTP/Result 一致性；
- 同一执行重放可确定，不因进程、数组顺序或平台差异改变结果。

下一任务按第 6.2 节依赖顺序为 P0-07A（CoreMind 最小 run Adapter），仍需单独授权后才开始。

## 4. 已经完成了什么

### 4.1 P0-02 基础链路

- Issue #2 已关闭；实现提交 `39b31cdcc943361360ae4f8754f41ebc22007c0f`，合并提交 `53a972b042bb48473c0f697de51186ca85fc1651`。
- Web、API、Orchestrator、Data Worker 四进程健康链路已经在 Windows 实际启动验证。
- `deploy/compose/compose.yaml` 和 Dockerfile 形成 Linux Compose 基线；只通过配置/构建检查，不等于 Linux 实机或生产部署已完成。
- 根级 `dev`、`test`、`verify` 已形成统一入口。

### 4.2 P0-03 合同与纵向链路

当前工作树已经实现：

- `packages/contracts`：Zod 4.4.3 内部 Schema、公开只读 TypeScript 合同、错误工厂、Result→HTTP 映射和领域不变量；
- `DecisionTaskExecutor`：创建 Task/Run、消费不可信 Runtime 产物、形成版本化成功或结构化失败；
- API/Orchestrator/Web 三层合同校验和错误归一化；
- 固定 9 阶段 RunEvent；
- `BUY_IF_PRICE` 与 `NEED_MORE_INFO` 两个 P0-03 开放状态；其他 V1.0 状态继续失败关闭；
- Requirement 预算与 must-have、Candidate、Elimination、Condition、Critical Gap、结构化 next step、Risk 的闭包校验；
- Windows 四进程真实纵向链路和 Playwright 页面验证。

### 4.3 Claim/Evidence 根因重构

反复漏洞的根因曾是：Runtime 可以写 `Claim.status`，Evidence 又可以写方向，Risk、Constraint、Elimination 各自解释，形成多个真相来源。

已经完成的根因修正：

- `ClaimKind = FACT_ASSERTION | SOURCE_OPINION | SYSTEM_INFERENCE`；
- `EvidenceState = SUPPORTED | REFUTED | CONFLICTED | INSUFFICIENT`；
- 独立 `ClaimEvidenceLink` 是 Claim 与 Evidence 关系和方向的唯一权威；
- Runtime 只能输出 Claim、Evidence 和 Link，不能写权威 Assessment；
- 私有 Decision Basis evaluator 统一派生规范化 `ClaimAssessment`；
- 生产者使用 `finalizeSuccessfulDecisionTaskResultV1` 形成成功 Result；
- 所有消费者使用 `decodeDecisionTaskResultV1` 重新派生并精确核验，伪造投影失败关闭；
- Hard Constraint、选择和淘汰只能依赖 `FACT_ASSERTION + SUPPORTED`；
- 同时存在支持与反证时派生 `CONFLICTED`，不能据此形成购买结论；
- Evidence 是否可用于 Decision 固定以 `Decision.validFrom` 为准；当时过期的 Evidence 保留追溯但不参与判定，未来 Evidence 和倒置有效期失败关闭；
- Web 只展示 Claim Kind、派生 Evidence State 和支持/反证来源，不自行派生权威状态。

相关权威产物：

- `docs/research/p0-03-claim-evidence-conflict-patterns.md`；
- `docs/adr/0004-fail-closed-without-decision-basis.md`；
- `docs/adr/0006-decision-basis-owns-evidence-state.md`；
- `docs/architecture/p0-03-claim-evidence-authority-module-design.md`；
- `docs/specs/p0-03-decision-contract-v1.md`。

### 4.4 审查 finding 的最小 TDD 修复

产品负责人于 2026-08-14 授权按第 6.1 节修复首轮独立双轴 `code-review` 的 3 个代码 finding。已按公开 Seam(finalizer/decoder/Executor/Web 可见结果)先写红灯再修复:

- Decision Evidence 闭包:`validateDecisionEvidenceClosure` 现在要求被选 Candidate 的硬预算与每项 must-have 实际消费的合格 Evidence 全部进入 `Decision.evidenceIds`;仅引用其他 Evidence 的 Decision 在 finalizer/decoder 均失败关闭,Executor 归一为 `FAILED + FAKE_RUNTIME_FAILED` 且不带 bundle。红灯曾实测复现 `ok=true + BUY_IF_PRICE`。
- 规范化排序:`claimAssessments` 改用固定码元升序比较,不再使用默认 Locale 的 `localeCompare`。红灯曾实测 `claim-ä`/`claim-z` 在本机按 Locale 排到错误位置;Claim 数组重排不改变派生 Assessment。
- Web 时间比较:[decision-flow.tsx](apps/web/src/app/decision-flow.tsx) 过期提示改用 `Date.parse` 解析真实时点后比较。红灯曾实测同一 UTC 时点、不同 ISO 精度被误标“形成 Decision 时已过期”。

修复后新增定向测试:contracts 3 项闭包 + 2 项排序、Orchestrator 1 项 Executor 失败关闭、Web 1 项过期精度边界。一个既有 contracts 测试因新增的合法 issue 放宽为 `arrayContaining`。

第二轮审查（Standards PASS / Spec FAIL 2 项）后，经产品负责人授权又完成:

- **旧文档状态标记**:`p0-03-decision-basis-module-design.md`、`p0-03-evidence-bound-decision-contract-proposal.md`、`p0-03-semantic-closure-proposal.md` 三份历史设计文档的"新设计仍为 proposed/尚未迁移"过时表述全部更新为"新设计已 `accepted` 并完成迁移"，历史内容保留。
- **fixture 谓词对齐规格 §7**:`memory.soldered=true` → `memory.upgradeable=false`，关联 Claim/Evidence/Link/Risk ID、Web 展示文案、Orchestrator/Web 测试同步重命名；Web 测试 stub 的 Assessment 顺序同步为规范码元序（改名后 `claim-synth-a-memory-upgradeable` 排在 `claim-synth-a-price` 之前，曾真实触发 decoder 规范顺序拒绝，恰好验证了切片 2 的强制力）。
- **localeCompare 残留统一**:`executor.ts` 幂等指纹 `canonicalize` 与 contracts 测试 helper `refreshClaimAssessment` 改用固定码元比较，与生产规范化规则一致。

第三轮双轴审查（Standards FAIL 1 项硬违规 / Spec FAIL 1 项 P3）后，经授权修正全部文档残留（只改状态性门禁句，历史决定与获准保留的历史表未动）:

- `p0-03-decision-basis-module-design.md` §2.3 与 §13:两处"等待确认/只需确认"改为历史时态并注明迁移已于 2026-08-14 完成;
- `p0-03-first-decision-design.md` §14:原"当前未完成门禁"改为"当时的下一个门禁",并注明新设计已接受、TDD 已完成;
- `p0-03-claim-evidence-authority-module-design.md` §16:门禁表述更新为三轮独立复审及其 finding 修复已授权完成,当前未授权项(fast-check/P0-07A/产品验收/提交/发布)与现状一致;
- `p0-03-evidence-bound-decision-contract-proposal.md` §7.3/§8/§9:未勾选项"code-review 只执行一次"改为"已执行多轮、finding 均已修复",两处"当前门禁"改为历史时态;
- 全局扫描确认 docs/ 下不再存在与实际状态互斥的门禁表述。

### 4.5 最近一次通过的工程证据

在 Node 22.22.1 下，审查 finding 最小 TDD 修复后的根级 `pnpm verify`（2026-08-14）完整通过：

- contracts：122 项（含 3 项 Evidence 闭包 + 2 项规范排序新增测试）；
- Orchestrator：35 项（含 1 项 Executor 闭包失败关闭新增测试）；
- API：16 项；
- Web：13 项（含 1 项 ISO 精度过期边界新增测试）；
- Python：1 项；
- 合计：187 项测试；
- Biome、Ruff、四项 TypeScript typecheck、86 个 UTF-8 文本检查及 contracts/API/Orchestrator/Web 四项生产构建均通过。

修复前的历史工程证据（Claim/Evidence 迁移后、审查前的 180 项全绿）仍为历史记录，不等同于本轮验收。

修复后的 Windows 四进程真实纵向验证（2026-08-14，Node 22.22.1）得到：

- 四个 `/health/live` 均为 `healthy`；
- 已确认 8000 元预算（经 API 3100）：HTTP 200、`COMPLETED + BUY_IF_PRICE`、选中 `candidate-synth-a`；
- 经 Web 路由 3000 的真实链：同样 `COMPLETED + BUY_IF_PRICE`，7 条 Link、7 条派生 Assessment、7 条 Decision Evidence；
- 预算缺失且未知：`COMPLETED + NEED_MORE_INFO`，无被选 Candidate，保留 `budget.maxAmountMinor` Gap；
- 9000 元预算（两候选均满足硬约束）：`NEED_MORE_INFO + preference.primary` 偏好追问；
- 非法 JSON：HTTP 400 + `CONTRACT_INVALID`；合同版本 2.0：HTTP 422 + `CONTRACT_VERSION_UNSUPPORTED`；
- 同一 `executionRequestId` 重放：响应逐字节一致；
- 测试结束后 3000/3100/3200/3300 端口全部释放。

坏 Runtime 与 Evidence 闭包反例按规格不暴露 HTTP 注入开关（spec §11.5，故障只经测试组合根注入），由本轮 Executor/合同定向测试覆盖。

**重要：187 项测试全绿与纵向链路通过是工程证据，不等于 P0-03 验收。是否修复到位仍需新一轮独立双轴 `code-review` 复核。**

## 5. 当前卡在哪里

首轮独立双轴 `code-review` 的 3 个代码 finding 已按第 6.1 节完成最小 TDD 修复并通过定向测试与根级 `pnpm verify`（见第 4.4 与 4.5 节）。本轮修复只读历史 ADR，未重写；没有提交、推送或进入 P0-07A。

### 5.1 Standards 轴：FAIL，3 项 → 已按最小 TDD 修复

1. **高严重度：Decision Evidence 闭包不完整。** ✅ 已修复  
   `packages/contracts/src/decision/v1/decision-basis.ts` 的 `validateDecisionEvidenceClosure` 原本只检查 `Decision.evidenceIds` 非空且 ID 存在。现在要求被选 Candidate 的硬预算与每项 must-have 实际消费的合格 Evidence 全部进入 `Decision.evidenceIds`；finalizer 与 decoder 均失败关闭，Executor 归一为 `FAILED + FAKE_RUNTIME_FAILED`。

2. **中严重度：规范化排序受系统 Locale 影响。** ✅ 已修复  
   `claimAssessments` 改用固定码元升序比较（`compareCanonicalIds`），不再使用默认 Locale 的 `localeCompare`。

3. **中严重度：Web 用字符串比较 UTC 时间。** ✅ 已修复  
   `apps/web/src/app/decision-flow.tsx` 改为 `Date.parse` 解析真实时点后比较。

12 项固定代码异味基线没有形成独立 finding，未改动。

### 5.2 Spec 轴：FAIL，3 项 → 代码项已修复，待复审确认

1. **P1，已验证：**删除被选 Candidate A 的价格、内存、存储 Evidence 后，公开 Executor 仍可返回 `ok=true + BUY_IF_PRICE`。✅ 已修复并有 Executor 红灯复现。
2. **P2，已验证：**相同时点使用不同 ISO 精度时，Web 会错误显示 Evidence 已过期。✅ 已修复并有 Playwright 红灯复现。
3. **P2，文档状态冲突：**旧交接曾写“生产实现仍未迁移”。本次重写已经删除该过时描述；本次修复同步更新了规格、设计和本交接，不再存在互斥描述。

未发现 CoreMind/P0-07A 范围扩张。

### 5.3 当前真正的阻塞

P0-03 本身已无阻塞：四轮独立双轴 `code-review` 全部闭环、产品验收已通过、代码已提交推送、Issue #3 已关闭。当前处于阶段门禁之间：PR 创建（如需）与进入 P0-07A 仍需分别授权；在取得对应授权前只能报告和交接。

## 6. 下一步计划

### 6.1 下一任务：P0-03 审查 finding 的最小 TDD 修复

产品负责人已于 2026-08-14 授权，执行状态如下（✅ 已完成；⏳ 当前等待）：

1. ✅ 固定当前工作树和 Node 22.22.1 基线，不清理、不重置现有 WIP。
2. ✅ 先通过公开 Seam 写失败测试（红灯均已逐个复现原反例）：
   - finalizer/decoder/Executor：Decision 只引用无关 Evidence 必须失败；
   - 被选 Candidate 的预算和所有决定性 must-have 支持 Evidence 缺一不可；
   - Assessment 的规范顺序不依赖系统 Locale 或输入排列；
   - Web：同一 UTC 时点的不同合法 ISO 精度不得显示过期。
3. ✅ 做最小生产修复：
   - Decision Basis 校验被选 Candidate 的预算和 must-have 实际消费的合格 Evidence 均进入 Decision Evidence closure（P0-03 的 Condition 是用户核验条件，不消费 Evidence，无需进入闭包）；
   - 使用固定、Locale 无关的规范化 ID 比较规则；
   - Web 将 UTC 字符串解析成真实时点后比较。
4. ✅ 更新合同/设计/本交接的真实状态，不重写历史 ADR。
5. ✅ 在 Node 22.22.1 下运行定向测试和根级 `pnpm verify`（187 项全绿，见第 4.5 节）。
6. ✅ 再运行 Windows 四进程真实纵向验证：正常预算、预算未知、偏好追问、Web 真实链、非法 JSON、版本不兼容、重放一致均通过，四端口释放。坏 Runtime 与 Evidence closure 反例按规格不暴露 HTTP 注入开关，由定向测试覆盖。
7. ✅ 展示红灯、绿灯、根级验证和真实链路证据；已获授权启动新一轮独立双轴 `code-review`。结论：Standards PASS（0 硬违规、5 判断性意见）；Spec FAIL（2 项：三个旧设计文档的过时状态、fixture 谓词与规格 §7 固定值表不一致）。已获授权修复这 2 项 finding 及 2 处 localeCompare 残留，修复后根级 `pnpm verify` 与 Windows 四进程纵向重跑再次通过，`memory.upgradeable=false` 风险 Claim 已在真实链路确认。第三轮独立双轴 `code-review` 的双轴 FAIL 均收敛为文档正文过时门禁表述残留（代码零问题），已获授权修正全部残留并完成全局扫描。
8. ✅ 第四轮独立双轴 `code-review` 已授权执行，结论为双轴 PASS；P0-03 产品验收已于 2026-08-14 由产品负责人确认**通过**。验收通过不自动授权后续动作：Git 提交与推送、Issue #3 更新和进入 P0-07A 继续分别授权。

### 6.2 P0-03 之后的推荐依赖顺序

由于产品负责人明确要求尽早验证 CoreMind，而不是长期维护 Fake Runtime，P0 的实际推荐顺序为：

```text
P0-03 合同闭环并验收
→ P0-07A CoreMind 最小 run Adapter
→ P0-04 Postgres + Outbox + Redis 持久任务
→ P0-05 可回放 RunEvent + SSE
→ P0-06 用户隔离 + CredentialVault + RiskPolicy
→ P0-07B 完整 Runtime（事件流/暂停/恢复/取消/快照/收据）
→ P0-08 百炼真实模型认证
→ P0-09 RuntimeSnapshot + EffectReceipt 安全恢复
→ P0-10 五个本地服务合同测试
→ P0-11 通用来源 + 本地解析生成可定位 Evidence
→ P0-12 合成 Category + P0 Gold Gate
```

这只是依赖顺序，不自动授权任何 Issue。P0-07A 必须使用薄 CoreMind Adapter 和确定性测试 Provider，不得跳过 ChoiceMind 的 Decision Basis 或把 CoreMind 私有类型扩散到领域合同。P0-07B 不能因为 P0-07A 跑通就被宣称完成。

## 7. 整个工程 Roadmap 与版本计划

权威 Roadmap 位于 `ChoiceMind_星枢智购_产品与研发规格书_v1.2.md` 第 11 章。项目不按时间承诺开发周期，而按 P0-P4 证据门禁推进。只有 P4 通过 V1.0 全部门禁并经产品负责人单独批准，才允许称为 V1.0 发布版。

### P0：合同、边界与可验证底座（当前）

目标：冻结 V1.0 不可绕过的领域、接口、安全、恢复和发布语义。

范围：Monorepo、CONTEXT/ADR/handoff、核心合同、CoreMind 两阶段接入、Postgres/Redis/对象存储基线、RBAC/RiskPolicy/秘密/隔离骨架、本地服务合同、合成 Category 和 Gold Gate。

退出门禁：合同版本化；合成 Category 不修改 core；失败伪成功为 0；五个本地服务完成合同测试。P0 完成不等于对外版本发布。

GitHub Issue 状态：

- #1 P0-01：开放，框架研究暂缓；最终 ADR/认证尚未完成；
- #2 P0-02：已关闭；
- #3 P0-03：已验收并关闭（2026-08-14，提交 `1cf3ad7`）；
- #4（P0-04）至 #12（P0-12）：开放，均未因规划而自动开始。

### P1：可用智能体 Alpha

目标：让受邀用户通过 Web 完成一次真实、带证据的消费决策。

范围：邀请登录、对话澄清、后台任务、SSE、暂停/恢复/取消；CoreMind + 外部主模型 + 本地 Qwen 备用；通用网页、小红书、抖音最小真实采集；管理员 Cookie 更新和用户扫码；MinerU/OCR/云本地 ASR/关键帧；Requirement 到 Decision 的真实纵向闭环。

退出门禁：任务链完整可运行，失败可见，关键证据可展开。状态名称是 Alpha，不是 V1.0。

### P2：可信研究 Beta

目标：从“能跑”升级为“结论可验证，冲突、时效和缺口诚实”。

范围：SKU/实体归一、Evidence Graph、转载聚类、冲突、freshness；评论树、UGC、Negative Research、Decision Critic；价格/库存/卖家/历史/TCO；京东、淘宝/天猫、拼多多、B站、知乎等 MUST 来源；跨类别 Gold 回归。

退出门禁：关键事实覆盖、错误 SKU 绑定、负面研究和数据源失败语义达到 V1.0 门禁。状态名称是 Beta，不自动发布。

### P3：个性化与运营闭环

目标：支持长期使用，同时防止管理员越权。

范围：长期 Memory 总授权、敏感逐项确认、自动低敏更新、查看/修改/导出/删除；用户 BYOK、平台 Key 启停；管理员/超级管理员；Cookie/ASR/本地服务配置；点赞点踩和反馈；Session/Decision 分享；大文件 7 天、长期保留和外链失效。

退出门禁：跨用户隔离和用户控制全部通过；管理员不能读取私人会话、画像或明文秘密。

### P4：Linux V1.0 稳定发布

目标：把 P0-P3 组合为可运营、可恢复的 V1.0 完成态。

范围：Linux Compose、TLS、网络分区、秘密注入、备份恢复和回滚；OpenTelemetry、Prometheus/Grafana、日志告警；浏览器 Worker 隔离、并发、限流和故障注入；百炼/DeepSeek/本地 Qwen、全部 MUST 数据源和双 ASR 真实认证；全量 Gold、安全红队、发布清单和运维手册。

V1.0 必须同时满足：

- Hard Constraint 违规为 0；关键事实 Evidence 覆盖和来源定位 100%；
- 当前价格/库存/型号全部绑定 SKU、来源和抓取时间；
- Standard/Deep Top Candidate 的 Negative Research 和 Critic 执行率 100%；
- Critical Gap 下 `BUY_NOW` 为 0，RiskPolicy 绕过为 0；
- Session、Memory、文件、Cookie、API Key、缓存和分享跨用户隔离测试全部通过；
- 明文秘密进入日志、模型上下文、报告、后台或反馈次数为 0；
- 超时、限流、登录失效、验证码、模型失败、源失效和重启无伪成功；
- 100 注册用户、20 同时在线、10 个并行 Deep 任务压测通过；
- Windows 和 Linux 主流程通过；
- 百炼与 DeepSeek 各至少一个真实模型、本地 Qwen、全部 MUST 数据源、多模态和双 ASR 完成真实认证；
- Memory、BYOK、登录态、分享、文件和账号的查看/修改/删除通过；
- 备份恢复、监控告警、配置审计、紧急停用和恢复演练通过。

在这些门禁全部通过前，不创建或宣称 V1.0 Release、Tag 或生产发布。

## 8. CoreMind 和 Runtime 边界

- CoreMind 是优先验证的候选框架，不是不可替换的宗教，也不是可以绕过 ChoiceMind 合同的业务内核。
- ChoiceMind 持有 Requirement、Candidate、Claim、Evidence、Decision、业务状态、安全门禁、恢复许可和结果语义。
- CoreMind/其他 Runtime 持有模型循环、工具调度、框架内部事件和 Checkpoint 实现。
- `AgentRuntimePort` 是唯一框架 Seam；框架私有命令、事件、错误和类型必须留在薄 Adapter 内。
- Fake Adapter 永远只是确定性合同替身，不得演化为第二套自研 Agent 框架。
- P0-07A 只验证最小 `run`；P0-07B 才验证事件流、暂停恢复、取消、RuntimeSnapshot、EffectReceipt 和安全恢复。
- Checkpoint 只是执行位置，不是恢复许可。副作用为 `started` 或 `unknown` 时禁止自动重放，必须暂停并人工核验。

## 9. 本地环境与 Provider 边界

已知本地服务：

| 能力 | 地址 | 当前状态 |
| --- | --- | --- |
| Qwen3.6-35B-A3B | `192.168.121.32:6012` | 文本/结构化/工具/图片/SSE 最小样本通过；测试和备用，未完整认证 |
| Qwen3-Embedding-4B | `192.168.121.33:8008` | 2560 维最小样本通过 |
| Qwen3-Reranker-4B | `192.168.121.33:8012` | 最小排序通过；服务报告最大长度 1024，必须验证截断 |
| PaddleOCR-VL-1.6-0.9B | `192.168.121.33:18080` | 这是 OCR/Vision 服务，不是 MinerU |
| MinerU 3.4.4 | `192.168.121.33:8000` | 文档/图片解析最小样本通过 |

主模型策略是外部 Provider 优先，平台 Key 可由管理员启停，用户后期可 BYOK；本地模型是免费测试和备用。百炼、DeepSeek 各至少一个真实模型以及本地 Qwen 的集成认证是 V1.0 发布门禁。密钥、费用和真实网络调用必须取得单独授权，不要向用户索取或回显明文 Key。

## 10. 绝对不要再踩的坑

### 10.1 不要用补丁堆积代替根因修复

P0-03 曾因每次只补一个 if，连续出现硬约束、预算、淘汰、Risk、Gap 和 Evidence 互相漂移。正确模式是一个私有 Decision Basis 拥有派生规则，所有消费者只读取其产物。发现新反例时先问“权威真相在哪里”，不要先在 Web、Route 或 Runtime 各补一套判断。

### 10.2 不要把“引用存在”误当“语义闭包”

ID 存在、数组非空、类型正确都不足以证明 Decision 合法。必须验证 Evidence 的主体、Claim、方向、有效期、决定用途以及它是否真正进入最终 Decision。当前最高优先级 finding 正是“无关 Evidence 也能冒充 Decision 依据”。

### 10.3 不要让 Runtime 和合同同时拥有 Evidence 状态

严禁恢复 `Claim.status`、`Claim.evidenceIds`、`Evidence.claimId` 或 `Evidence.direction` 双读兼容。Runtime 不写 Assessment；Link 是关系唯一权威；Decision Basis 唯一派生 Evidence State。

### 10.4 不要使用环境相关的排序和字符串时间比较

- 规范化输出不得依赖默认 Locale；Windows 与 Linux 必须逐字段一致。
- ISO 字符串格式合法不代表字典序等于时点顺序；合法精度不同或时区表示不同必须按真实时间比较。
- 历史 Decision 回看不能使用当前时间重算 Evidence State。

### 10.5 不要信任跨进程或 Runtime 对象

每个跨进程边界都必须独立解码。不要：

- 只看正文不看 HTTP 状态；
- 把 `500 + 合法成功正文` 提升为成功；
- 在保护边界外访问 getter、数组 `map/at` 等可覆盖方法；
- 递归扫描任意深 JSON；
- 泄漏 Fastify/Zod/框架私有错误码或 Error 文案；
- 用 Map/Set 静默吞掉重复 ID。

所有失败都必须形成版本化、框架中立、用户可见的结构化错误；失败任务不能携带 Decision。

### 10.6 不要把测试通过写成验收或认证

单元测试、`pnpm verify`、本地冒烟、Docker 配置检查、模型最小调用、用户验收、生产认证、V1.0 发布是不同门禁。必须分别陈述。测试全绿后仍要用公开 Seam 做违反不变量的反例，并进行独立 Standards/Spec 双轴审查。

### 10.7 不要把 Fake Runtime 做成自研框架

产品负责人已经明确：有必要时优先使用 CoreMind，不要从零手搓模型循环、工具调度、checkpoint 和恢复系统。Fake Adapter 只保留最小确定性 fixture。框架接入也不能替代 ChoiceMind 的业务合同和安全恢复规则。

### 10.8 不要在 P0-03 冒充自然语言或真实数据能力

当前 Web 使用固定、只读、明确标为 Synthetic 的需求。它证明合同，不证明任意自然语言理解、真实商品搜索、爬虫、模型质量或 Linux 部署。缺少真实数据必须形成 Gap，不得由 LLM 猜测。

### 10.9 不要越过产品和安全边界

- 不做交易、支付、物流、代购或自动下单。
- 不破解验证码、不绕过登录、不对抗网站访问控制。
- 管理员 Cookie 可配置、检查和更新；失效时可让用户自行扫码，但不能承诺“绝不封号”或虚假宣称“不会获取任何信息”。应准确说明最小访问范围、加密、隔离、撤销和风险。
- 只有用户明确授权后才能写长期 Memory；用户必须可查看、修改、导出和删除。
- 管理员/超级管理员不能查看私人 Session、画像、文件、Cookie、API Key 或明文秘密。

### 10.10 不要未经确认改变依赖、来源或工程路线

GitHub/npm/PyPI 有成熟组件时优先研究和复用，但必须用真实样本和合同验证。下载慢、网络失败或构建卡住不授权更换版本、镜像、URL、来源、框架或实现路径。`fast-check` 目前未安装；若要加入仍需单独依赖授权。

### 10.11 不要破坏工作树或越过提交门禁

P0-03 实现已提交（`1cf3ad7`）并推送 origin；工作树正常时只有交接文档的收尾增量。无论工作树状态如何，都不要使用：

- `git reset --hard`、`git checkout --`；
- `git clean`；
- `git add .`；
- 删除或覆盖 `packages/`、`docs/`、`CONTEXT.md`、`handoff.md` 等仓库内容。

每次提交前必须显式列出 allowlist，并再次确认提交、推送、PR、Issue、Tag 和部署授权。Git 远程是 `origin = https://github.com/Eclipseic1848/ChoiceMind.git`。

### 10.12 不要忽略 Windows/UTF-8 细节

所有中文文件必须显式 UTF-8 读写，完成后检查乱码、替换字符、冲突标记、本地链接和 `git diff --check`。LF→CRLF 警告不等于内容错误，但不得用全仓格式化制造无关 diff。

## 11. 常用验证命令

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use 22.22.1

pnpm verify
pnpm dev
```

服务端口：

- Web：3000
- API：3100
- Orchestrator：3200
- Data Worker：3300

真实启动前先确认端口空闲；测试结束后停止全部子进程并再次确认端口释放。`pnpm dev` 会先构建 contracts，再同时运行 contracts watch 和四个服务。

## 12. 权限和阶段门禁

当前已授权并完成：Claim/Evidence Codebase Design、受控 TDD 实施、首轮独立双轴 `code-review`（结论 FAIL）、按第 6.1 节的最小 TDD 修复、第二轮独立双轴 `code-review`（Standards PASS / Spec FAIL 2 项）及其修复、第三轮独立双轴 `code-review`（双轴 FAIL 均收敛为文档门禁表述残留）及其修复、第四轮独立双轴 `code-review`（双轴 PASS）（均为 2026-08-14 授权）、P0-03 产品验收（2026-08-14 确认**通过**）、Git 提交（`1cf3ad7`）+ 推送 origin、Issue #3 验收评论并关闭、本次 `handoff.md` 更新。

当前未授权：

- 创建 PR / merge（当前 `p0-03-first-decision` 已推送但未开 PR）；
- 安装 `fast-check` 或其他新依赖；
- 进入 P0-07A/P0-07B；
- 调用带费用或凭据的真实 Provider；
- Git Tag；
- Linux 或生产部署。

新会话的第一步不是直接改代码，而是向产品负责人说明：

> 当前 P0-03 已验收（2026-08-14）、已提交 `1cf3ad7` 并推送、Issue #3 已关闭。下一步等待分别授权：是否创建 PR 合并到 main、是否进入 P0-07A；每个动作都要单独授权，不自动执行。

一次只问这一个问题，并带上这个例子。得到明确同意后再开始。
