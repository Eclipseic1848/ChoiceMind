# P0-03 首个 Decision：领域合同 v1

## 1. 状态与目的

- 状态：证据绑定重构、Claim/Evidence 权威模型的产品语义及最新 Codebase Design 已由产品负责人于 2026-08-14 确认；Codebase Design 状态为 `accepted`。
- 实现状态：Claim Kind、独立 Link、派生 Claim Assessment、因果时间门禁及对应 Runtime、Executor、Web 严格迁移已完成受控 TDD；根级 `pnpm verify` 与 Windows 四进程纵向链路已通过。四轮独立双轴 `code-review` 的全部 finding（Decision Evidence 闭包、Locale 无关排序、Web 真实时点比较、fixture 谓词对齐、文档状态一致性）均已修复，第四轮结论为双轴 PASS。**P0-03 产品验收已于 2026-08-14 由产品负责人确认通过。** 提交、推送、Issue 更新与进入 P0-07A 仍需分别授权。
- 对应 Issue：<https://github.com/Eclipseic1848/ChoiceMind/issues/3>。
- 合同版本：`1.0`。
- 目的：用完全确定、明确标记为合成的数据，证明一条消费需求可以经过 API、Orchestrator 和 `FakeAgentRuntimeAdapter`，形成可显示、可审查且不会伪成功的 Decision。

本文件冻结领域含义和跨进程必须校验的文档合同，不决定 HTTP 路径、同步或异步交互、目录布局、验证库或生产 Agent Runtime。

## 2. 本阶段边界

### 2.1 包含

- Requirement Revision、Candidate、Claim、Evidence、Claim-Evidence Link、Claim Assessment、Decision Revision、RunEvent、Decision Task Status、错误和任务结果的 v1 合同。
- 一个固定的虚构笔记本正例。
- 一个 `NEED_MORE_INFO` 业务反例。
- 非法合同、版本不兼容和 Fake Runtime 失败语义。
- Web 必须显示的最小 Decision 内容及合成数据提示。

### 2.2 不包含

- CoreMind 或其他生产 Agent Runtime 的安装、选型和 Adapter 实现。
- 真实模型、真实商品、真实价格、真实渠道或真实数据源。
- 数据库、队列、SSE、后台恢复、用户画像、长期记忆和多用户权限。
- 品类专用规则引擎；“笔记本”只是一份 fixture，核心合同不得出现品类条件分支。
- 购物车、订单、支付、物流或代用户交易。

## 3. 已确认的业务场景

用户提交一条开发用笔记本需求：预算不超过 8000 元，至少 32 GiB 内存和 1 TiB 存储。

系统只比较两个完全虚构的 SKU：

| Candidate | 合成事实 | 处理 |
| --- | --- | --- |
| `CM-SYNTH-LAPTOP-A-32` | 32 GiB、1 TiB、合成观测价 7699 元、内存板载不可升级 | 保留，并暴露扩展性风险 |
| `CM-SYNTH-LAPTOP-B-32` | 32 GiB、1 TiB、合成观测价 8399 元 | 因违反 8000 元硬预算淘汰 |

固定 Decision 状态为 `BUY_IF_PRICE`：只有当候选 A 的用户实际核验价格不高于 7800 元，且销售渠道提供官方保修时，结论才成立。Decision 有效期为固定生成时间起 7 天。

所有名称、SKU、价格、来源、摘录和时间均为测试 fixture。Web 必须显示“合成测试数据，不代表真实商品、价格或购买建议”。

## 4. 领域不变量

以下规则不能由 Fake Runtime、未来生产 Runtime、Provider 或 UI 绕过：

1. `Decision` 必须引用且只引用同一 Decision Task 下的 Requirement Revision、Candidate、Claim、Evidence 和 Claim-Evidence Link。
2. 独立 `ClaimEvidenceLink` 是 Claim 与 Evidence 关系及方向的唯一权威；同一组合至多一条 Link，Link 两端存在且同属一个 Decision Task。
3. Claim 可以没有 Link 并派生 `INSUFFICIENT`；每份 Evidence 至少关联一个 Claim。孤立 Evidence、断链、跨 Task、重复或相反方向 Link 均为 `CONTRACT_INVALID`。
4. Claim Kind 与 Evidence State 是两个独立概念；Runtime 不提交权威 State 或 Assessment，最终 Result 的 Claim Assessment 由 Decision Basis 生成并由每个跨进程 decoder 重新派生核验。
5. Evidence Eligibility 固定按 `Decision.validFrom` 判断；过期 Evidence 保留追溯但不参与 Assessment，未来 Evidence 或倒置有效期为 `CONTRACT_INVALID`。
6. 同一结果内的 Candidate、Claim、Evidence、Link 和 RunEvent ID 各自必须唯一，不能依赖 Map、Set 或 UI key 静默合并重复实体。
7. `Synthetic Evidence` 必须携带 `synthetic=true` 和 `sourceKind=SYNTHETIC`；真实 Decision 禁止引用 Synthetic Evidence。
8. `BUY_IF_PRICE` 必须至少包含一个可核验的 Decision Condition；每个 Critical Gap 必须通过 `VERIFY_CONDITION` resolution 指向被选 Candidate 的 Condition，并由对应 next step 闭合，无法映射时必须改为 `NEED_MORE_INFO`。
9. 同一 Requirement Revision 的 `mustHaves[].key` 必须唯一；稳定判断不能依赖展示文案。
10. Hard Constraint、Elimination 和最终选择只能使用 `FACT_ASSERTION + SUPPORTED`；被选 Candidate 的每项 must-have 必须派生为 `SATISFIED`，`VIOLATED` 或 `INDETERMINATE` 均禁止选择。
11. P0-03 形成最终取舍时，每个未选 Candidate 必须恰有一个 `ELIMINATED` Candidate Disposition；被选 Candidate 不得有 Disposition。`NEED_MORE_INFO` 尚未形成最终取舍，Disposition 必须为空。
12. `ELIMINATED` 必须证明 Candidate 违反真实 must-have 或 `budget.maxAmountMinor`；P0-03 不接受 `NOT_SELECTED`。若仍有多个 Candidate 满足全部 Hard Constraint，必须追问会改变取舍的偏好，不能形成购买 Decision。
13. 被选 Candidate 的观测价格不得超过已确认硬预算；`MAX_PRICE` Decision Condition 也不得高于该硬预算，不能用未来价格条件覆盖当前约束冲突。
14. Decision Condition 必须指向被选 Candidate，不能指向未选或已淘汰 Candidate。
15. `NEED_MORE_INFO` 不得选择 Candidate，必须至少有一个带明确问题的 Critical Gap；每个 Gap 必须通过 `PROVIDE_REQUIREMENT` resolution 与同 key 的 next step 闭合，并且不得携带 Candidate Disposition 或 Decision Risk。
16. 预算缺失、未确认或被列入关键 `unknowns` 时，Decision 必须为 `NEED_MORE_INFO`，并保留 `budget.maxAmountMinor` Critical Gap 及补充步骤。
17. Decision Risk 只能关联被选 Candidate，并必须通过 `statementClaimId` 引用该 Candidate 的 `SUPPORTED` Claim Assessment；不存在被选 Candidate时 risks 必须为空。
18. 每个 next step 必须通过结构化 action 和目标 key/ID 表达含义；合同判断不得匹配用户可见文案。
19. 有 Critical Gap 时禁止 `BUY_NOW`；P0-03 不建立任何例外。
20. Decision Revision 一经形成不可修改；需求或证据变化必须产生新 revision。
21. `COMPLETED` 必须有且只有一个成功 Decision Revision。
22. `FAILED`、`CANCELLED` 或请求被拒绝时不得携带 Decision，也不得返回 `ok=true`。
23. RunEvent 只能表达已经发生的运行事实和用户可理解阶段，不包含模型私有思维链。
24. 同一 `executionRequestId` 的重试结果必须逐字段一致；不同显式提交的业务归一化内容必须一致，但 Execution Request、Decision Task、Agent Run、Requirement Revision、Decision Revision 和 RunEvent 的实例 ID 及其引用可以变化。
25. Result 与 HTTP 状态使用一份冻结映射；每个跨进程接收方必须独立校验结构、版本、Assessment 和精确状态，不得只根据 HTTP 成功类别或 `ok` 布尔值推断结果。
26. `Decision.evidenceIds` 必须包含被选 Candidate 的硬预算与每项 must-have 实际消费的合格 Evidence；只引用其他 Evidence（例如仅淘汰 Candidate 的价格 Evidence）不足以支撑最终选择，必须失败关闭。
27. 规范化 Claim Assessment 顺序使用固定、与运行环境 Locale 无关的码元升序；时间比较必须解析为真实时点，同一 UTC 时点的不同合法 ISO 精度不得改变任何结论。

## 5. 版本与通用约定

### 5.1 合同头

每个跨进程顶层文档都必须包含：

| 字段 | 含义 |
| --- | --- |
| `contractType` | 稳定的文档种类；不能由传输路由隐式推断。 |
| `contractVersion` | 当前固定为字符串 `1.0`。 |

P0-03 只接受明确列入支持清单的精确版本。缺少版本或收到非 `1.0` 版本时必须拒绝，不得猜测、降级或静默转换。

P0-03 已验收（2026-08-14）但合同未对外发布，因此继续直接修订 `1.0`：删除旧 `Claim.status`、`Claim.evidenceIds`、`Evidence.claimId` 与 `Evidence.direction`，增加独立 Link 和派生 Assessment；既有 `nextSteps` 判别联合保持。所有旧字段和旧字符串数组均被 strict Schema 拒绝，不建立兼容层。

当一个结果文档嵌套 Task Status、Decision 或 Error 时，被嵌套文档仍保留自己的合同头并独立校验；外层版本不能替代内层版本。

### 5.2 标量约定

- ID 是不透明字符串；fixture 使用可读的任务级示例 ID，调用方不得解析其前缀。每次显式提交必须获得新的 Execution Request、Decision Task、Agent Run、Requirement Revision 和 Decision Revision 身份；同一次网络重试复用全部原身份。
- 时间采用带 `Z` 的 ISO 8601 UTC 字符串。
- 金额使用人民币分的整数 `amountMinor`，并显式携带 `currency=CNY`；禁止浮点金额。
- 数量必须带单位，例如 `32 GiB`，不能把展示文本当作可比较数值。
- 枚举值使用大写下划线形式。
- 未知业务事实使用显式 Unknown 或 Evidence Gap 表达，不能用空字符串、零或模型猜测代替。
- 面向用户的文本为简体中文；稳定判断依赖结构化字段，不依赖文案匹配。
- 必需的用户可见文本去除首尾空白后必须至少包含一个字符；解码器只校验，不擅自转换原文。

## 6. v1 文档合同

字段表中的“必需”表示跨进程校验必须拒绝缺失或类型错误的文档。JSON Schema、TypeScript 类型和领域不变量实现必须共同遵守本节业务含义。当前生产实现已迁移 `ClaimKind`、`ClaimEvidenceLink`、`ClaimAssessment` 与证据时间门禁，并通过公开 Seam、根级验证和真实 Windows 纵向链路验证；四轮独立双轴 `code-review` 的最新结论为双轴 PASS，产品验收仍待产品负责人单独授权。

### 6.1 Execute Decision Task Command

`contractType=execute-decision-task-command`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `executionRequestId` | 是 | 用户每次明确提交生成的幂等执行标识；同一次网络重试必须复用原值。 |
| `requirementRevision` | 是 | 本次执行使用的不可变 Requirement Revision。 |

同一 `executionRequestId` 只能绑定同一份规范化命令。进程存活期间，同 ID、同命令必须合并为同一次执行或返回原结果；同 ID、不同命令必须以 `CONTRACT_INVALID` 拒绝。P0-03 不据此承诺跨重启或多实例恢复。

Web 每次显式提交生成新的 `executionRequestId`、Decision Task ID 和 Requirement Revision ID。Orchestrator 为该执行形成唯一 Agent Run ID；Fake Runtime 为该任务形成唯一 Decision Revision ID。业务事实的确定性不能通过跨任务复用这些实例身份来实现。

### 6.2 Requirement Revision

`contractType=requirement-revision`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `requirementRevisionId` | 是 | 不可变需求版本 ID。 |
| `decisionTaskId` | 是 | 所属 Decision Task。 |
| `revision` | 是 | 从 1 开始递增的整数。 |
| `submittedText` | 是 | 用户提交的原始合成需求。 |
| `market` | 是 | 本场景固定为 `CN`、`zh-CN`、`CNY`。 |
| `intendedUses` | 是 | 至少一个已确认用途；正例为软件开发。 |
| `budget` | 否 | `maxAmountMinor`、`currency`、`hard` 和确认状态。缺失可以是业务未知，不一定是合同非法。 |
| `mustHaves` | 是 | key 唯一的结构化硬约束；正例为内存不少于 32 GiB、存储不少于 1 TiB。 |
| `niceToHaves` | 是 | 可为空数组；P0-03 只记录原始软偏好，不能作为选择或 `NOT_SELECTED` 的权威依据。 |
| `mustNotHaves` | 是 | 可为空数组。 |
| `unknowns` | 是 | 尚待用户确认且可能影响 Decision 的问题。 |

合同完整与需求充分是两件事：字段结构正确但存在关键 `unknowns` 时，系统应形成 `NEED_MORE_INFO`，而不是返回校验错误。

### 6.3 Candidate

`contractType=candidate`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `candidateId` | 是 | Candidate ID。 |
| `decisionTaskId` | 是 | 所属 Decision Task。 |
| `displayName` | 是 | 用户可见名称。 |
| `synthetic` | 是 | 本 fixture 必须为 `true`。 |
| `identity` | 是 | 至少包含虚构型号、SKU、市场和配置标识，足以区分 A/B。 |
| `observedPrice` | 是 | 合成价格、币种和观测时间；不是现实价格。 |

Candidate 不因总分低而消失。P0-03 只在每个未选 Candidate 均有 Hard Constraint 违规证据并形成 `ELIMINATED` 时允许最终取舍；若多个 Candidate 均可行且缺少结构化取舍依据，必须形成 `NEED_MORE_INFO`。此时 Candidate 可以暂时既不被选中也不具有 Disposition，不得为了形式闭包虚构 Elimination Record。

### 6.4 Claim

`contractType=claim`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `claimId` | 是 | Claim ID。 |
| `decisionTaskId` | 是 | 所属 Decision Task。 |
| `subject` | 是 | 被描述对象类型和 ID；本场景为 Candidate。 |
| `predicate` | 是 | 稳定事实键，例如 `memory.capacity`、`price.observed`。 |
| `value` | 是 | 带类型和单位的 Candidate 事实值。 |
| `claimKind` | 是 | `FACT_ASSERTION`、`SOURCE_OPINION` 或 `SYSTEM_INFERENCE`；不表示证据状态。 |

旧 `status` 和 `evidenceIds` 不再属于 Claim，出现时必须被 strict Schema 拒绝。

### 6.5 Evidence

`contractType=evidence`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `evidenceId` | 是 | Evidence ID。 |
| `decisionTaskId` | 是 | 所属 Decision Task。 |
| `synthetic` | 是 | 本 fixture 必须为 `true`。 |
| `source` | 是 | `sourceKind=SYNTHETIC`、固定标题和固定 source ID；不得伪造真实 URL、作者或平台。 |
| `capturedAt` | 是 | 固定合成采集时间。 |
| `locator` | 是 | 固定章节或字段定位，用于证明证据可定位合同。 |
| `excerpt` | 是 | 明确带“合成”的简短摘录。 |
| `validUntil` | 是 | 合成证据的固定有效期。 |

旧 `claimId` 和 `direction` 不再属于 Evidence，出现时必须被 strict Schema 拒绝。

### 6.5.1 Claim-Evidence Link

`contractType=claim-evidence-link`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `linkId` | 是 | 关系文档 ID，在结果中唯一。 |
| `decisionTaskId` | 是 | 所属 Decision Task。 |
| `claimId` | 是 | 存在且同任务的 Claim。 |
| `evidenceId` | 是 | 存在且同任务的 Evidence。 |
| `direction` | 是 | `SUPPORTS` 或 `REFUTES`。 |

同一 `claimId + evidenceId` 组合至多一条 Link。复合片段由上游拆分 Evidence 或细化 Claim；合同不从自由文本猜测方向。

### 6.5.2 Claim Assessment

`contractType=claim-assessment`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `claimId` | 是 | 对应 Claim；每个 Claim 恰有一份 Assessment。 |
| `evidenceState` | 是 | `SUPPORTED`、`REFUTED`、`CONFLICTED` 或 `INSUFFICIENT`。 |
| `supportingEvidenceIds` | 是 | 在 `Decision.validFrom` 时合格的 SUPPORTS Evidence，去重并按固定码元升序。 |
| `refutingEvidenceIds` | 是 | 在 `Decision.validFrom` 时合格的 REFUTES Evidence，去重并按固定码元升序。 |

`claimAssessments` 按 `claimId` 的固定码元升序排列；该顺序不依赖运行环境 Locale，保证 Windows 与 Linux 逐字段一致。Runtime 不提交该数组；最终 Result 生产者调用 Decision Basis 生成，所有跨进程 decoder 重新派生并逐字段核验。

### 6.5.3 Constraint Assessment

Constraint Assessment 是合同 Module 从 Requirement、Claim 和规范化 Claim Assessment 派生的内部领域结论，不作为 Runtime 可写的跨进程文档：

- `RequirementConstraint.key` 必须等于 Claim 的 `predicate`；
- Claim 必须经 `subject` 指向被评估 Candidate，`claimKind=FACT_ASSERTION` 且派生 `evidenceState=SUPPORTED`；
- P0-03 must-have 只比较 `QUANTITY`；Claim 与 Requirement 的单位必须完全相同；
- `AT_LEAST`、`AT_MOST`、`EQUALS` 分别执行确定性数值比较；
- 缺少可信 Claim、值类型或单位不同、事实冲突或无法确定时，Assessment 为 `INDETERMINATE`；核心不得解析 `identity.configuration` 或执行单位换算。

Runtime 不能提交或覆盖 `SATISFIED`、`VIOLATED`、`INDETERMINATE`。这些状态只描述合同 Module 的派生判断。

### 6.6 Decision Revision

`contractType=decision-revision`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `decisionRevisionId` | 是 | 不可变 Decision 版本 ID。 |
| `decisionTaskId` | 是 | 所属 Decision Task。 |
| `requirementRevisionId` | 是 | 使用的需求版本。 |
| `revision` | 是 | 从 1 开始递增的整数。 |
| `status` | 是 | V1.0 产品共有七种权威状态；P0-03 当前合同只开放 `BUY_IF_PRICE` 和 `NEED_MORE_INFO`，其余状态仍锁定。 |
| `summary` | 是 | 结论先行的简体中文摘要。 |
| `selectedCandidateId` | 否 | 有最适合 Candidate 时提供；`NEED_MORE_INFO` 等状态可以没有。 |
| `conditions` | 是 | Decision Condition 列表；`BUY_IF_PRICE` 不得为空。 |
| `candidateDispositions` | 是 | P0-03 只接受有 Hard Constraint 违规依据的 `ELIMINATED`；`NEED_MORE_INFO` 固定为空。 |
| `risks` | 是 | 被选 Candidate 需要用户权衡或核验的可信 Claim 引用；正例引用板载内存不可升级 Claim。 |
| `evidenceIds` | 是 | 支撑 Decision 的 Evidence；正例至少一条。被选 Candidate 的硬预算与每项决定性 must-have 实际消费的合格 Evidence 必须进入该闭包，其他 Evidence 不能替代。 |
| `criticalGaps` | 是 | Critical Gap 与结构化关闭方式列表；正例为空。 |
| `assumptions` | 是 | 未经确认但被保留的假设；正例为空。 |
| `validFrom` | 是 | 固定生成时间。 |
| `validUntil` | 是 | 正例为 `validFrom` 后 7 天。 |
| `nextSteps` | 是 | 结构化 next step 判别联合；稳定判断依赖 action 和目标 key/ID，用户可见文案只用于展示。 |
| `synthetic` | 是 | P0-03 固定为 `true`。 |

P0-03 Candidate Disposition 只保留能够确定性证明的 `ELIMINATED`：

```ts
type CandidateDispositionV1 = Readonly<{
  dispositionId: string;
  dispositionType: "ELIMINATED";
  candidateId: string;
  requirementKey: string;
  reason: string;
  evidenceIds: readonly string[];
}>;
```

`ELIMINATED` 必须引用至少一条属于该 Candidate 的 Evidence，并由现有 Constraint Assessment 证明对应 Hard Constraint 为 `VIOLATED`。同一 Decision 中 `dispositionId` 和 `candidateId` 分别唯一。V1.0 完成态仍保留 Not-selected Record，但 P0-03 在结构化 Preference/Fit 完备前失败关闭该能力。

Decision Risk 不再携带可被 Runtime 当成新事实的自由文本 `summary/impact`：

```ts
type DecisionRiskV1 = Readonly<{
  riskId: string;
  candidateId: string;
  statementClaimId: string;
  verification: string;
}>;
```

`statementClaimId` 必须指向被选 Candidate 且规范化 `evidenceState=SUPPORTED` 的 Claim；其 `supportingEvidenceIds` 至少一条进入当前 Decision 的 `evidenceIds`。Web 从 Claim、Claim Assessment、独立 Link 和 Evidence 展示 Claim Kind、结构化 predicate/value、两侧证据、摘录和核验步骤，不接受 Runtime 另写一条无法验证的风险事实。

Critical Gap 必须声明如何关闭，避免从中文问题或说明文字推断业务含义：

```ts
type CriticalGapResolutionV1 =
  | Readonly<{
      resolutionType: "VERIFY_CONDITION";
      conditionId: string;
    }>
  | Readonly<{
      resolutionType: "PROVIDE_REQUIREMENT";
      requirementKey: string;
    }>;

type CriticalGapV1 = Readonly<{
  gapId: string;
  key: string;
  question: string;
  resolution: CriticalGapResolutionV1;
}>;
```

- `BUY_IF_PRICE` 的每个 Gap 只能使用 `VERIFY_CONDITION`，目标 Condition 必须属于被选 Candidate，且该 Condition 必须有 `VERIFY_CONDITION` next step；
- `NEED_MORE_INFO` 的每个 Gap 只能使用 `PROVIDE_REQUIREMENT`，`requirementKey` 必须等于 Gap 的 `key`，且必须存在同 key 的 `PROVIDE_REQUIREMENT` next step；
- 无法满足上述映射的 Gap 不得进入成功 Result。

#### 6.6.1 P0-03 状态开放门禁

完整七状态语义以根目录 V1.2 产品与研发规格为准。本期只证明固定合成购买决策和需求澄清两条纵向链路：

| 状态 | P0-03 处理 | 原因 |
| --- | --- | --- |
| `BUY_IF_PRICE` | 允许 | 固定正例只有一个可行 Candidate；Risk 引用可信 Claim，未选 Candidate 有可信 `ELIMINATED`。 |
| `NEED_MORE_INFO` | 允许 | 已有预算未知追问、Requirement Revision 更新前门禁和端到端反例。 |
| `BUY_NOW` | 拒绝 | 尚无“全部购买前条件已满足”的独立真实场景与反例矩阵。 |
| `WAIT` | 拒绝 | 尚无 Reassessment Trigger 合同。 |
| `KEEP_CURRENT` | 拒绝 | 尚无 `CURRENT_ASSET` Candidate 合同。 |
| `NO_MATCH` | 拒绝 | 尚无“全部候选均有可信 Elimination”场景、反例矩阵和真实纵向验证。 |
| `REFUSE_RISK` | 拒绝 | 尚无零 Candidate 的请求级结构化拒绝原因合同。 |

Runtime 在 P0-03 返回锁定状态时，公开 Result 解码必须拒绝该成功产物；Executor 必须将其归一为现有结构化 Runtime 失败，禁止 Decision 或 `ok=true` 逃逸。未来开放任一状态前，必须先补齐所需领域结构、正反例、跨进程校验、Web 展示和真实纵向验证，并由产品负责人确认阶段转换。

`nextSteps` 只允许以下三种结构：

```ts
type DecisionNextStepV1 =
  | Readonly<{
      actionType: "PROVIDE_REQUIREMENT";
      requirementKey: string;
      instruction: string;
    }>
  | Readonly<{
      actionType: "VERIFY_CONDITION";
      conditionId: string;
      instruction: string;
    }>
  | Readonly<{
      actionType: "VERIFY_RISK";
      riskId: string;
      instruction: string;
    }>;
```

`VERIFY_CONDITION` 和 `VERIFY_RISK` 必须分别引用同一 Decision 中存在的 Condition 和 Risk；每个 Decision Condition 至少有一个对应的 `VERIFY_CONDITION` next step。

### 6.7 RunEvent

`contractType=run-event`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `eventId` | 是 | RunEvent ID。 |
| `decisionTaskId` | 是 | 所属 Decision Task。 |
| `agentRunId` | 是 | 所属 Agent Run。 |
| `sequence` | 是 | 从 1 开始严格递增，不能重复或倒退。 |
| `occurredAt` | 是 | 已发生事实的时间。 |
| `eventType` | 是 | `TASK_STATE_CHANGED`、`RUNTIME_SUCCEEDED` 或 `RUNTIME_FAILED`。 |
| `taskState` | 是 | 事件发生后的权威任务状态。 |
| `summary` | 是 | 用户可理解的简短状态，例如“正在核验合成证据”。 |
| `synthetic` | 是 | P0-03 固定为 `true`。 |

正例必须按固定顺序产生：`CREATED → UNDERSTANDING → PLANNING → RESEARCHING → VERIFYING → COMPARING → CRITIQUING → GENERATING → COMPLETED`。

### 6.8 Decision Task Status

`contractType=decision-task-status`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `decisionTaskId` | 是 | Decision Task ID。 |
| `agentRunId` | 否 | Runtime 尚未启动时可以没有。 |
| `state` | 是 | 当前权威状态。 |
| `terminal` | 是 | 是否为终态。 |
| `latestEventSequence` | 是 | 已接受的最后事件序号；没有事件时为 0。 |
| `decisionRevisionId` | 否 | 只允许在 `COMPLETED` 时存在。 |
| `errorId` | 否 | `FAILED` 时必须存在，其他状态禁止存在。 |
| `updatedAt` | 是 | 最后状态变化时间。 |

v1 状态全集沿用权威规格：

- 运行态：`CREATED`、`UNDERSTANDING`、`PLANNING`、`RESEARCHING`、`VERIFYING`、`GAP_RESEARCH`、`COMPARING`、`CRITIQUING`、`GENERATING`；
- 暂停态：`PAUSED_USER`、`PAUSED_PERMISSION`、`PAUSED_SOURCE_LOGIN`、`PAUSED_LIMIT`；
- 终态：`COMPLETED`、`FAILED`、`CANCELLED`。

P0-03 Fake Runtime 只实现正例序列和 `FAILED` 分支，不据此冒充已经实现暂停、恢复或取消。

### 6.9 ChoiceMind Error

`contractType=choice-mind-error`

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `errorId` | 是 | 可关联任务和事件的错误 ID。 |
| `code` | 是 | 稳定机器码。 |
| `category` | 是 | `VALIDATION`、`VERSION`、`RUNTIME` 或 `TRANSPORT`。 |
| `message` | 是 | 不泄露堆栈、秘密或模型私有内容的简体中文说明。 |
| `retryMode` | 是 | `NONE`、`SAME_EXECUTION_ONLY` 或 `NEW_EXECUTION_ALLOWED`；不能根据 HTTP 状态猜测。 |
| `issues` | 是 | 可为空；校验错误时包含字段路径和原因。 |
| `occurredAt` | 是 | 错误形成时间。 |

P0-03 固定错误码：

| 错误码 | 场景 | `retryMode` |
| --- | --- | --- |
| `CONTRACT_INVALID` | 字段缺失、类型错误、同一执行 ID 绑定不同命令、交叉引用失效或不变量被破坏 | `NONE` |
| `CONTRACT_VERSION_UNSUPPORTED` | 版本缺失或不是 `1.0` | `NONE` |
| `FAKE_RUNTIME_FAILED` | 测试显式触发 Fake Runtime 故障 | `NEW_EXECUTION_ALLOWED` |
| `DECISION_EXECUTION_STATUS_UNKNOWN` | 传输中断导致 API 无法确认 Orchestrator 是否接受或完成执行 | `SAME_EXECUTION_ONLY` |

`SAME_EXECUTION_ONLY` 表示调用方只能携带原 `executionRequestId` 和完全相同的命令重试，不能自动生成新 ID。P0-03 的执行回执仅保存在 Orchestrator 进程内，不能宣称具备跨重启或多实例恢复能力。

### 6.10 Decision Task Result

`contractType=decision-task-result`

结果是判别联合，不允许含糊组合：

| 结果 | 必须存在 | 明确禁止 |
| --- | --- | --- |
| 成功 | `ok=true`、`taskStatus.state=COMPLETED`、一个 `decision`、完整 Link 与规范化 Assessment | `error`、Runtime 自报 Assessment |
| 已创建任务失败 | `ok=false`、`taskStatus.state=FAILED`、一个 `error` | `decision`、成功文案 |
| 请求在建任务前被拒绝 | `ok=false`、一个 `error` | `taskStatus`、`decision`、伪造 task ID |
| 执行状态无法确认 | `ok=false`、`error.code=DECISION_EXECUTION_STATUS_UNKNOWN` | `taskStatus`、`decision`、伪造执行结论 |

部分运行产物可以留在审计中，但不能塞进失败结果冒充可用 Decision。

成功 `bundle` 必须同时包含 `claimEvidenceLinks` 和 `claimAssessments`。生产者 finalizer 从不含 Assessment 的 Runtime 草稿生成标准 Result；标准 decoder 不接受缺失、伪造或非规范顺序的 Assessment，也不会静默补写。

## 7. 固定正例 fixture

以下是合同测试中的一组稳定示例值；Web 的另一次显式提交必须形成另一组任务级身份：

| 项 | 固定值 |
| --- | --- |
| Execution Request | `exec-synth-laptop-001` |
| Decision Task | `task-synth-laptop-001` |
| Agent Run | `agent-run-exec-synth-laptop-001` |
| Requirement Revision | `req-synth-laptop-001-r1` |
| Candidate A | `candidate-synth-a` / `CM-SYNTH-LAPTOP-A-32` |
| Candidate B | `candidate-synth-b` / `CM-SYNTH-LAPTOP-B-32` |
| Decision Revision | `decision-task-synth-laptop-001-r1` |
| `validFrom` | `2026-08-12T12:00:00.000Z` |
| `validUntil` | `2026-08-19T12:00:00.000Z` |
| Decision 状态 | `BUY_IF_PRICE` |
| 价格条件 | 候选 A 的用户核验价 `≤ 780000` 分人民币 |
| 渠道条件 | 用户自行核验渠道提供官方保修 |
| 淘汰记录 | Candidate B 的 839900 分合成价违反 800000 分 Hard Constraint |
| 风险 | Candidate A 的 Risk 通过 `statementClaimId` 引用 `memory.upgradeable=false` Claim 及其 Synthetic Evidence |
| must-have Evidence | A/B 的内存与存储容量均使用结构化 Claim 和 Synthetic Evidence，不从配置文案推断 |
| Claim Kind | 固定事实 Claim 使用 `FACT_ASSERTION`；fixture 不使用来源观点或系统推断决定取舍 |
| Link / Assessment | Runtime 生成独立 Link；finalizer 为每个 Claim 生成规范化 Assessment |
| next steps | 两个 Condition 分别由 `VERIFY_CONDITION` 引用；板载内存风险由 `VERIFY_RISK` 引用 |

同一 `executionRequestId` 重放时，完整结果必须逐字段一致。使用新 ID 进行另一次显式提交时，归一化比较排除任务级实例 ID 及其引用，Requirement 约束、Candidate 事实、Claim/Evidence 内容、Decision 状态/条件/淘汰/风险以及 RunEvent 阶段必须一致。请求接收时间和实际延迟可以作为合同外运行元数据记录。

## 8. 反例与错误样例

### 8.1 合法但信息不足

输入结构合法，但预算缺失、`confirmed=false`，或预算上限处于 `unknowns` 且会改变 A/B 的选择。预期：

- 任务可以 `COMPLETED`；
- Decision 状态为 `NEED_MORE_INFO`；
- `selectedCandidateId` 不存在；
- `criticalGaps` 至少包含预算上限；
- `nextSteps` 至少包含 `actionType=PROVIDE_REQUIREMENT` 且 `requirementKey=budget.maxAmountMinor`；
- Candidate 可以保留为待后续评估对象，不要求被选中或拥有 Elimination Record；RunEvent 进入 `COMPARING` 只表示执行过比较阶段，不代表已经形成最终取舍；
- 这不是系统错误，结果仍为 `ok=true`。

### 8.2 非法合同

把 `budget.maxAmountMinor` 设为字符串。预期在运行前拒绝：

- `ok=false`；
- 错误码 `CONTRACT_INVALID`；
- `issues` 定位到预算字段；
- 不创建任务、不调用 Fake Runtime、不产生 Decision。

### 8.3 版本不兼容

把 Requirement Revision 的 `contractVersion` 设为 `2.0`。预期在运行前拒绝：

- `ok=false`；
- 错误码 `CONTRACT_VERSION_UNSUPPORTED`；
- 不猜测兼容、不静默降级、不创建任务。

### 8.4 Fake Runtime 失败

使用测试专用故障触发器。预期：

- 已创建任务进入 `FAILED`；
- 最后一个 RunEvent 为 `RUNTIME_FAILED`；
- 结果 `ok=false`，错误码 `FAKE_RUNTIME_FAILED`；
- `decision` 字段不存在；
- Web 显示“决策任务失败”，不能显示购买结论或“已完成”。

### 8.5 Runtime 语义冲突

以下任一 Runtime 产物都必须被合同拒绝：

- 要求内存不少于 64 GiB，却选择只有 32 GiB 可信 Claim 的 Candidate；
- 已确认硬预算为 8000 元，却生成 `MAX_PRICE=900000`；
- 选择 Candidate A，但 Condition 指向 Candidate B；
- Candidate B 超预算，但 Elimination Record 使用 `unrelated.constraint`；
- `BUY_IF_PRICE` 新增一个未映射到 Condition 和 next step 的 Critical Gap；
- Decision Risk 指向未选或已淘汰 Candidate，或者缺少被选 Candidate 的可信 `statementClaimId`；
- `NEED_MORE_INFO` 保留 `selectedCandidateId`，或没有 Gap、问题和补充信息步骤；
- 满足全部 Hard Constraint 的未选 Candidate 被伪造成 `ELIMINATED`，或者 Runtime 在缺少结构化 Preference/Fit 时仍生成 `NOT_SELECTED` 或最终选择；
- 预算未知，但 next step 只要求核验保修。

直接调用共享 Result 解码 Interface 时，上述产物返回 `CONTRACT_INVALID`；经 Decision Task Executor 接收的不可信 Runtime 产物必须形成现有的结构化 `FAILED + FAKE_RUNTIME_FAILED`，不得携带 bundle 或 Decision。

## 9. Web 最小展示合同

正例结果页必须展示：

- 只读的固定合成需求，并明确说明 P0 不解析任意自然语言需求；
- “合成测试数据，不代表真实商品、价格或购买建议”；
- `BUY_IF_PRICE` 的中文结论；
- Candidate A 的虚构 SKU；
- 价格条件和官方保修渠道条件；
- Candidate B 的 `ELIMINATED` 预算淘汰原因；P0-03 不渲染 `NOT_SELECTED`；
- 从 `statementClaimId` 对应 Claim/Evidence 展示的板载内存风险事实；
- Claim Kind、Evidence State，以及 Claim Assessment 的支持/反驳两侧 Evidence；
- 结构化 next step 的 `instruction` 文案；
- 至少一条可展开的 Synthetic Evidence，含来源种类、摘录、定位和有效期；
- Decision 有效期；
- 过期提示按真实时点比较：`Evidence.validUntil` 与 `Decision.validFrom` 表示同一 UTC 时点时，即使 ISO 精度不同也不得显示“已过期”。

失败结果页只展示结构化错误摘要和任务失败状态，不渲染上一次成功 Decision，也不根据缺失字段补写结论。

## 10. 合同验收矩阵

| 测试 | 必须证明 |
| --- | --- |
| 正例重放 | 同一执行 ID 两次结果逐字段一致；不同显式提交排除任务级实例身份后业务内容一致；状态为 `BUY_IF_PRICE`。 |
| Candidate 淘汰 | B 有明确 Hard Constraint Elimination Record；观测价超过已确认硬预算的 Candidate 不能被选中。 |
| Candidate Disposition | 每个最终未选 Candidate 恰有一条有违规证据的 `ELIMINATED`；P0-03 拒绝 `NOT_SELECTED`；被选 Candidate 和 `NEED_MORE_INFO` Candidate 没有 Disposition。 |
| must-have 语义 | 被选 Candidate 的每项 must-have 均由同 predicate、同单位的可信 Claim/Evidence 证明满足；64 GiB 需求不得选择 32 GiB Candidate。 |
| 条件闭包 | Condition 只指向被选 Candidate；`MAX_PRICE` 不突破已确认硬预算。 |
| 淘汰语义 | Elimination 的 requirementKey 真实存在，Evidence/Claim 证明该 Candidate 违反对应约束。 |
| Evidence 链 | Decision → Evidence ← Link → Claim → Candidate 可解析且同属一个任务；孤立 Evidence、断链和重复/相反 Link 失败。 |
| Decision Evidence 闭包 | 被选 Candidate 的预算与每项 must-have 实际消费的合格 Evidence 必须进入 `Decision.evidenceIds`；只引用无关 Evidence 失败。 |
| 规范化排序 | `claimAssessments` 顺序使用固定码元比较，不依赖系统 Locale；Claim 输入排列不改变派生 Assessment。 |
| Web 过期边界 | 同一 UTC 时点、不同合法 ISO 精度不显示 Evidence 已过期。 |
| Claim Assessment | Runtime 草稿无 Assessment；finalizer 唯一生成；所有 decoder 重新派生并拒绝缺失、伪造、重复或乱序投影。 |
| Evidence 真值 | 四格真值表、零 Link Claim、有效反证、过期 Evidence 和数组重排都得到确定结果。 |
| 因果时间 | 未来 Evidence、倒置 Evidence/Decision 区间失败；过期 Evidence 保留但不参与 Assessment。 |
| 决定性资格 | Hard Constraint、Elimination、最终选择只接受 `FACT_ASSERTION + SUPPORTED`；来源观点和系统推断只能展示。 |
| ID 唯一性 | 同一结果内 Candidate、Claim、Evidence、Link 和 RunEvent 不存在重复 ID。 |
| 身份隔离 | 不同显式提交的 Agent Run 与 Decision Revision ID 不相同。 |
| 合成隔离 | 所有 fixture 对象有合成标记；页面有醒目提示。 |
| 信息不足 | 合法不完整需求产生 `NEED_MORE_INFO`，无被选 Candidate，并保留预算 Critical Gap 和 `PROVIDE_REQUIREMENT + budget.maxAmountMinor`；无关 next step 不能替代。 |
| Critical Gap 关闭 | `BUY_IF_PRICE` 的每个 Gap 映射到被选 Candidate 的 Condition 及核验步骤；无法映射时合同拒绝。 |
| Decision Risk 依据 | 每个 Risk 只关联被选 Candidate，并引用该 Candidate 的可信 Claim/Evidence；`NEED_MORE_INFO` 不携带 Risk。 |
| 状态开放门禁 | `BUY_NOW`、`WAIT`、`KEEP_CURRENT`、`NO_MATCH`、`REFUSE_RISK` 均被公开 Result 解码器拒绝；Runtime 提前返回锁定状态时 Executor 形成结构化失败且不返回 Decision。 |
| next step 引用 | `VERIFY_CONDITION` 与 `VERIFY_RISK` 分别引用存在的 Condition/Risk；用户文案不参与稳定判断。 |
| 非法字段 | `CONTRACT_INVALID`，Runtime 调用次数为 0。 |
| 不支持版本 | `CONTRACT_VERSION_UNSUPPORTED`，Runtime 调用次数为 0。 |
| Runtime 故障 | `FAILED + ok=false + FAKE_RUNTIME_FAILED`，Decision 数量为 0。 |
| 幂等并发 | 同一执行 ID、同一命令的并发调用只执行一次 Runtime，并返回同一规范化结果。 |
| 幂等冲突 | 同一执行 ID、不同命令返回 `CONTRACT_INVALID`，不产生第二次 Runtime 调用。 |
| 状态未知 | 返回 `DECISION_EXECUTION_STATUS_UNKNOWN + SAME_EXECUTION_ONLY`，无 Task Status 和 Decision。 |
| 终态不变量 | `COMPLETED` 只有一个 Decision；其他终态没有 Decision；Task Status 指向最后事件和对应 Decision/Error。 |
| RunEvent | 序号严格递增，Task/Run 归属、末事件类型、阶段与任务状态一致，不含私有思维链。 |
| UTF-8 | 合同、fixture、错误和页面中文无乱码。 |

## 11. 后续设计决策跟踪

以下 `codebase-design` 问题均已在实现前确认，不改变本文件冻结的领域含义；具体结论以架构设计文档为准：

1. **已确认：** 共享合同使用 `@choicemind/contracts`；Zod 仅作为内部校验实现，不向调用方暴露 Zod 类型或原生错误对象。
2. **已确认：** API 采用单次同步返回，本期不创建任务句柄、不提供轮询或 SSE。
3. **已确认：** 使用 `executionRequestId` 提供进程内幂等回执；状态未知时只能复用同一 ID 重试。
4. **已确认：** Web 调用 `POST /api/v1/decision-tasks:execute`；API 通过 HTTP Adapter 调用 Orchestrator 的 `POST /internal/v1/decision-tasks:execute`，双方独立校验合同。
5. **已确认：** Fake Runtime 故障只通过测试组合根注入失败型 Adapter，不暴露 HTTP 字段、Header、查询参数或环境开关。
6. **已确认：** fixture 位于 Orchestrator 私有 Runtime 目录；测试通过公开解码 Interface 比较规范化结果。
7. **已确认：** Constraint Assessment 由合同 Module 从 Requirement、Claim 和 Evidence 内部派生，不新增 Runtime 可写的 Assessment 文档。
8. **已确认：** `nextSteps` 在未发布的 v1 内直接改为结构化判别联合，不兼容旧字符串数组。
9. **已确认：** 核心只比较相同 predicate、值类型和单位的规范化值，不解析展示文本、不做单位换算。
10. **已确认：** P0-03 关闭 `NOT_SELECTED`；多个 Candidate 均满足 Hard Constraint 且缺少结构化偏好时形成 `NEED_MORE_INFO`。
11. **已确认：** Decision Risk 通过 `statementClaimId` 引用被选 Candidate 的可信 Claim，不以自由文本 `summary/impact` 承载新事实。
12. **已确认：** Preference Criterion、Candidate Comparison 和完整 User Fit 保留为 V1.0 目标，但不在 P0-03 冒充已实现。
13. **已确认：** ClaimKind 与 EvidenceState 分轴；独立 Link 是关系唯一权威；最终 Result 携带 Decision Basis 生成且由 decoder 重算核验的规范化 Claim Assessment。
14. **已确认：** Evidence Eligibility 固定按 `Decision.validFrom`；过期证据只追溯，未来证据和倒置有效期失败关闭。
15. **已确认并实施 Codebase Design：** 采用 [`p0-03-claim-evidence-authority-module-design.md`](../architecture/p0-03-claim-evidence-authority-module-design.md) 的“生产者 finalizer + 标准 decoder + 私有 evaluator” Interface；TDD 已在产品负责人另行授权后完成，四轮独立双轴 `code-review` 亦已授权执行且最新结论为双轴 PASS；P0-07A、提交或发布仍须单独授权。

任何答案都必须保持本文件的不变量和 CoreMind 优先原则：Fake Adapter 只证明 ChoiceMind 的合同 seam，不承担生产 Agent Runtime 的职责。
