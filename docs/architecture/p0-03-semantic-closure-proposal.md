# P0-03 Decision 语义闭包提案

## 1. 状态

- 状态：既有 Constraint/Critical Gap 语义闭包仍为 `accepted`；第 11.1 节 `NOT_SELECTED` 与旧 Decision Risk 形状已由 [`p0-03-evidence-bound-decision-contract-proposal.md`](p0-03-evidence-bound-decision-contract-proposal.md) 和 [ADR-0004](../adr/0004-fail-closed-without-decision-basis.md) 部分替代。
- 实现状态：既有 Constraint/Critical Gap 与证据绑定闭包已完成过 TDD；后续复审发现 Claim/Evidence 双重权威。ADR-0006 的新领域决定已经确认，替代性 Codebase Design [`p0-03-claim-evidence-authority-module-design.md`](p0-03-claim-evidence-authority-module-design.md) 已于 2026-08-14 定为 `accepted` 并完成其范围内的受控 TDD 迁移；P0-03 产品验收仍待独立审查与产品负责人确认。
- 对应 Issue：<https://github.com/Eclipseic1848/ChoiceMind/issues/3>。
- 审查基线：`53a972b042bb48473c0f697de51186ca85fc1651` 上的未提交 P0-03 WIP。
- 本文件保留已确认的 Constraint/Critical Gap 历史设计；发生冲突时，以证据绑定重构提案和 ADR-0004 为准。

既有决定已同步到 [`p0-03-decision-contract-v1.md`](../specs/p0-03-decision-contract-v1.md)、[`p0-03-first-decision-design.md`](p0-03-first-decision-design.md) 和 [`ADR-0002`](../adr/0002-derive-constraint-assessment.md)；最新补充不改变公开解码 Interface 或 ADR，只修订未发布 v1 的领域文档形状与私有不变量。

## 2. 要解决的问题

最新双轴审查已用反例证明，当前合同可以把以下自相矛盾的结果认证为 `ok=true`：

1. Requirement 要求内存不少于 64 GiB，Decision 仍选择配置标明 32 GiB 的 Candidate；
2. 硬预算为 8000 元，`MAX_PRICE` Decision Condition 却允许 9000 元；
3. Decision 选择 Candidate A，但 Condition 指向已被淘汰的 Candidate B；
4. Candidate B 明确超预算，Elimination Record 却使用不存在的 `unrelated.constraint`；
5. 预算未知时，`nextSteps` 只要有任意非空文案即可，不必真的要求用户补充预算。

根因不是引用图缺失，而是引用图只证明“对象存在”，没有证明 Requirement、Claim、Condition、Elimination Record 和 next step 的业务含义一致。

## 3. 范围与非目标

本次只补齐 P0-03 已有合同的语义闭包：

- 保持 ChoiceMind 核心品类无关；
- 保持 `DecisionTaskExecutor.execute`、HTTP 路由和 Agent Runtime Seam 不变；
- 不解析 Candidate 的 `identity.configuration` 展示文本；
- 不在核心硬编码 `memory.capacity`、`storage.capacity` 或笔记本规则；
- 不实现单位换算、自然语言需求解析、真实商品数据或生产 Agent Runtime；
- 不新增数据库、任务句柄、队列、SSE 或外部副作用。

Category Package 负责把品类事实规范化为稳定 predicate、数值和单位。P0-03 合同 Module 只对相同 predicate、相同值类型和相同单位进行确定性比较。

## 4. 领域关系

### 4.1 Constraint Assessment

提议将 **Constraint Assessment** 定义为：根据一个 Candidate 的 Claim/Evidence，判断它对一项结构化 Hard Constraint 是 `SATISFIED`、`VIOLATED` 还是 `INDETERMINATE` 的派生结果。

Constraint Assessment 不作为新的跨进程文档序列化，避免复制一份可以与 Requirement、Claim 或 Evidence 冲突的“结论数据”。它由 Decision Contract Module 在解码成功结果时内部计算。

### 4.2 must-have 的派生规则

对每个 `RequirementConstraintV1` 和 Candidate：

1. 用 `RequirementConstraint.key === Claim.predicate` 找到该 Candidate 的相关 Claim；
2. Claim 必须属于该 Candidate，状态必须为 `SUPPORTED`，并至少有一条双向闭合且 `direction=SUPPORTS` 的 Evidence；
3. Claim value 必须是 `QUANTITY`，且单位与 Requirement value 完全相同；
4. `AT_LEAST`、`AT_MOST`、`EQUALS` 分别执行数值比较；
5. 缺少可信 Claim、单位不同、值类型不同、Claim 冲突或事实不唯一时，结果为 `INDETERMINATE`，不能猜测或解析展示文案。

同一 Requirement Revision 的 `mustHaves[].key` 必须唯一，否则无法形成无歧义 Assessment。

### 4.3 Hard budget 的派生规则

预算仍使用专用结构，不伪装成品类 Requirement：

- 被选 Candidate 的 `observedPrice` 不得超过已确认硬预算；
- `MAX_PRICE` Condition 的阈值不得超过已确认硬预算；
- 以预算为依据淘汰 Candidate 时，`requirementKey` 必须为 `budget.maxAmountMinor`；
- Elimination Evidence 必须经 `price.observed` Claim 指向该 Candidate，Claim 金额必须与 `observedPrice` 一致且确实超过硬预算。

## 5. 最小合同变更

### 5.1 保留现有结构

以下字段无需新增：

- `RequirementConstraint.key/operator/value`；
- `Claim.subject/predicate/value/status/evidenceIds`；
- `EliminationRecord.requirementKey/evidenceIds`；
- `DecisionCondition.candidateId`。

语义闭包通过现有字段和内部派生 Assessment 完成，不增加公开的 `CandidateAssessment` 文档。

### 5.2 将 `nextSteps` 从文案数组改为判别联合

建议把 `DecisionRevisionV1.nextSteps: readonly string[]` 改为：

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

只让稳定判断依赖 `actionType` 和目标 ID/key；`instruction` 仍是面向用户的简体中文文案。

结构化规则：

- 预算未知时，必须存在 `PROVIDE_REQUIREMENT + budget.maxAmountMinor`；
- `VERIFY_CONDITION.conditionId` 必须引用同一 Decision 中存在的 Condition；
- `VERIFY_RISK.riskId` 必须引用同一 Decision 中存在的 Risk；
- 每个 Decision Condition 至少有一个对应的 `VERIFY_CONDITION` next step；
- 不通过匹配“预算”“价格”“保修”等中文关键词判断含义。

P0-03 尚未发布或验收，建议直接修订未发布的 `1.0` 合同，不新增 `1.1` 兼容层；旧的字符串数组应被严格 Schema 拒绝。

## 6. 成功 Decision 的不变量

| 对象 | 必须满足的闭包 |
| --- | --- |
| 被选 Candidate | 必须存在、不得被淘汰，并对每项 `mustHaves` 得到 `SATISFIED`。 |
| 非确定 Assessment | 不能被当成满足；Runtime 若仍返回购买结论，合同拒绝该产物。 |
| Elimination Record | `requirementKey` 必须指向 `mustHaves[].key` 或 `budget.maxAmountMinor`，且 Evidence/Claim 必须证明该 Candidate 确实违反对应约束。 |
| Decision Condition | 必须指向被选 Candidate；不得指向未选或已淘汰 Candidate。 |
| `MAX_PRICE` Condition | 币种必须一致；存在已确认硬预算时，阈值不得超过硬预算。 |
| `NEED_MORE_INFO` 预算分支 | 必须无被选 Candidate，同时包含预算 Critical Gap 和结构化补充预算 next step；由于尚未形成最终取舍，Candidate 可以暂时没有 Elimination Record。 |
| Result → HTTP | 所有路由先形成 `DecisionTaskResultV1`，再调用现有共享映射函数；不再手写 `422/400` 分支。 |

P0-03 不把无可信 Claim 自动改写成 `NEED_MORE_INFO`。Runtime 必须自己形成合法的 Decision；若它给出与输入 Requirement 或证据不一致的成功产物，Decision Contract Module 将其作为不可信 Runtime 产物拒绝，Executor 继续使用现有结构化失败语义。

## 7. 深 Module 与 Seam

公开 Interface 保持不变：

```ts
decodeDecisionTaskResultV1(input: unknown): ContractDecodeResult<DecisionTaskResultV1>
```

语义比较集中在 Decision Contract Module 的私有实现中，建议内部职责为：

```text
checkDecisionTaskResultInvariants
  └─ checkDecisionSemanticClosureV1
       ├─ assessCandidateConstraint
       ├─ validateSelectedCandidate
       ├─ validateCandidateDispositions
       ├─ validateConditions
       └─ validateNextSteps
```

这些名称描述内部职责，不增加公开 Interface。删除该内部 Module 会让同一语义散到 Executor、Fake Runtime、API 和 Web，因此集中实现能够提供 locality；测试仍只通过公开解码 Interface 观察结果。

本期不新增 `CategoryConstraintEvaluatorPort`。当前只有相同单位的通用数值比较，没有第二个真实 Adapter；为假想变化建立 Seam 只会增加浅层抽象。未来出现已经确认的单位换算或品类专属操作符时，再由 Category Package 先规范化，或在新合同版本中设计真实 Seam。

## 8. fixture 与验证矩阵

设计确认后，固定合成 fixture 必须补充：

- Candidate A、B 的 `memory.capacity` Claim 与 Synthetic Evidence；
- Candidate A、B 的 `storage.capacity` Claim 与 Synthetic Evidence；
- 与两个 Decision Condition 对应的结构化 `VERIFY_CONDITION` next step；
- 与板载内存 Risk 对应的结构化 `VERIFY_RISK` next step；
- 预算未知时的 `PROVIDE_REQUIREMENT + budget.maxAmountMinor` next step。

TDD 必须先加入以下失败测试：

| 反例 | 预期 |
| --- | --- |
| 要求内存 ≥64 GiB，A/B 只有 32 GiB 可信 Claim | 不得返回成功购买 Decision。 |
| 硬预算 8000 元，`MAX_PRICE=900000` | 合同拒绝。 |
| 选择 A，Condition 指向 B | 合同拒绝。 |
| B 超预算但 `requirementKey=unrelated.constraint` | 合同拒绝。 |
| 预算未知，next step 只要求核验保修 | 合同拒绝。 |
| Claim 单位为 GB、Requirement 单位为 GiB | `INDETERMINATE`，不得在核心换算。 |
| 补齐 Claim/Evidence 和结构化 next step 的固定正例 | 继续得到确定的 `BUY_IF_PRICE`。 |
| API、Orchestrator、Web 的合同拒绝结果 | 全部通过共享 Result → HTTP 映射得到精确状态。 |

验证仍须包含 contracts、API、Orchestrator、Web 的定向测试、根级 `pnpm verify` 和真实四进程纵向冒烟；测试通过不替代最终独立 `code-review`。

## 9. 明确拒绝的替代方案

- **解析 `identity.configuration` 文案**：展示字符串不是可比较事实，会把品类、语言和格式知识泄漏进核心。
- **由 Runtime 直接返回 `SATISFIED` 布尔值并信任它**：重复 Requirement/Claim 的结论且仍可伪造，不能形成安全门禁。
- **用中文关键词检查 next step**：文案变化会改变业务判断，也不适用于多语言。
- **立即增加通用规则引擎或单位换算库**：P0-03 只有三个比较操作和规范化单位，没有证据证明需要该复杂度。

## 10. 已确认决策

产品负责人已确认以下合同含义：

1. Constraint Assessment 由合同 Module 从 Requirement、Claim 和 Evidence 内部派生，不新增可被 Runtime 伪造的公开 Assessment 文档；
2. `nextSteps` 在尚未发布的 v1 内直接由字符串数组改为结构化判别联合，不建立旧格式兼容层；
3. 核心只比较相同 predicate、相同值类型、相同单位的规范化值，不解析展示文本，也不做单位换算；
4. 只有结构化闭包全部成立的 Runtime 产物才能形成成功 Decision。

## 11. 最新复审后的开放状态补充

最新独立双轴复审通过公开解码与 Executor 反例确认：`BUY_IF_PRICE` 可携带未闭合 Critical Gap，Decision Risk 可指向未选 Candidate，`NEED_MORE_INFO` 可保留选择或没有可回答问题；同时现有 `eliminations` 数组无法表达满足 Hard Constraint 但综合未入选的 Candidate。补充规格采用以下最小修订。

### 11.1 Candidate Disposition

> **已部分替代：** 以下 `NOT_SELECTED` 结构曾被确认并实现，但复审证明它缺少结构化 Preference/Fit，无法验证比较理由。P0-03 现只保留 `ELIMINATED`；`NOT_SELECTED` 等未来 Candidate Comparison 完备后再开放。

将 `DecisionRevisionV1.eliminations` 替换为 `candidateDispositions` 判别联合：

- `ELIMINATED`：使用统一 `dispositionId`，保留 `candidateId`、`requirementKey`、`reason` 和 `evidenceIds`；现有 Constraint Assessment 必须证明 Candidate 违反对应 Hard Constraint；
- `NOT_SELECTED`：使用统一 `dispositionId`，携带 `candidateId`、`reason` 和 `evidenceIds`；Candidate 必须满足全部 must-have 和已确认硬预算，Evidence 必须属于该 Candidate；
- 最终取舍的每个未选 Candidate 恰有一条 Disposition，被选 Candidate 不得有 Disposition；`NEED_MORE_INFO` 的 Disposition 固定为空；
- `dispositionId` 与被处置的 `candidateId` 在同一 Decision 中分别唯一。

该修订直接修改未发布的 `1.0`，不保留 `eliminations` 兼容字段，也不新增第二个并行数组；否则调用方仍需自行合并两类去向，且同一 Candidate 可能同时被“淘汰”和“未入选”。

### 11.2 Critical Gap 关闭方式

`CriticalGapV1` 增加必需的 `resolution` 判别联合：

- `VERIFY_CONDITION + conditionId`：只用于 `BUY_IF_PRICE`，必须指向被选 Candidate 的 Condition，并存在引用该 Condition 的 `VERIFY_CONDITION` next step；
- `PROVIDE_REQUIREMENT + requirementKey`：只用于 `NEED_MORE_INFO`，必须与 Gap 的 `key` 相同，并存在同 key 的 `PROVIDE_REQUIREMENT` next step。

合同不匹配 `question` 或 `instruction` 文案。无法映射到购买前核验条件的 Gap 不得留在 `BUY_IF_PRICE`，必须由 Runtime 形成 `NEED_MORE_INFO`。

### 11.3 两个开放状态的完整门禁

`BUY_IF_PRICE` 必须选择一个 Candidate、至少有一个 Condition，每个 Critical Gap 均按 11.2 闭合，每个 Risk 只指向被选 Candidate，每个最终未选 Candidate 均按 11.1 处置。

`NEED_MORE_INFO` 必须没有 `selectedCandidateId`，至少有一个非空问题的 Critical Gap，每个 Gap 均有同 key 的补充信息步骤，并且 `candidateDispositions` 与 `risks` 均为空。P0-03 仍只验证“已达到 Minimum Viable Requirement、研究中发现预算缺口”的既有场景，不借此扩张到自然语言解析或零 Candidate 的前置澄清流程。

### 11.4 TDD 与迁移边界

实施只修改 `@choicemind/contracts` 的未发布 v1 类型、Schema、私有不变量，随后同步 Fake fixture、Executor/Web 测试和展示；公开入口仍是 `decodeDecisionTaskResultV1` 和 `DecisionTaskExecutor.execute`。必须先用四项复审反例及 Candidate Disposition 正反例建立红灯，再实施最小代码并完成统一门禁、真实四进程验证和新一轮独立复审。
