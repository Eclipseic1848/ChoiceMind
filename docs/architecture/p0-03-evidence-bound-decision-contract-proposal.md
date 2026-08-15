# P0-03 证据绑定 Decision 合同重构提案

## 1. 状态

- 状态：`accepted`；产品负责人于 2026-08-14 确认本提案的三个整体决策。
- 阶段：本文证据绑定设计已确认并完成过受控 TDD；后续复审发现 `Claim.status` 与 Evidence 方向仍是双重权威。新的 Claim/Evidence 领域决定已由 ADR-0006 接受，替代性 Codebase Design [`p0-03-claim-evidence-authority-module-design.md`](p0-03-claim-evidence-authority-module-design.md) 已于 2026-08-14 定为 `accepted` 并完成其范围内的受控 TDD 迁移。
- 对应 Issue：<https://github.com/Eclipseic1848/ChoiceMind/issues/3>。
- 基线：`53a972b042bb48473c0f697de51186ca85fc1651` 上的未提交 P0-03 WIP。
- 本提案只修复 Decision Risk、Candidate Disposition、偏好比较和用户可见文本的根因，不修改 HTTP、运行框架、持久化、真实数据或其他 Decision 状态。

## 2. 问题定性

当前问题由三类缺陷叠加产生：

1. **普通输入校验 Bug**：`z.string().min(1)` 接受只含空白的 `reason`、`question` 等用户可见文本。
2. **领域合同缺口**：Decision Risk 没有 Claim 引用；`NOT_SELECTED` 只有自由文本理由和该 Candidate 的任意 Evidence，合同无法证明风险或比较结论具有对应依据。
3. **阶段能力越界**：Requirement 的 `niceToHaves` 仍是自由文本，P0-03 还没有结构化 Preference Criterion、User Fit 或效用比较，却已经允许 `NOT_SELECTED` 表达“综合适配度较低”。

因此，继续为具体文案增加条件判断只能关闭单个反例，不能建立一般正确性。合同必须先表达可验证关系，再由不变量验证这些关系。

## 3. 核心领域规则

### 3.1 Decision Basis

任何会影响选择、淘汰、风险或购买条件的 Decision 断言，都必须拥有结构化 **Decision Basis**：

```text
Requirement ──约束/偏好──┐
                         ├── Decision Basis ── Decision 断言
Candidate ← Claim ← Evidence ┘
```

`reason`、`summary`、`impact`、`question` 和 `instruction` 只用于用户展示，不是 Decision Basis。核心不得通过中文关键词、展示文案相似度或模型自报布尔值判断断言是否成立。

### 3.2 P0-03 采用失败关闭

P0-03 只证明确定性合成数据合同，不冒充已经实现完整 User Fit：

- `ELIMINATED` 保留，因为现有结构化 Hard Constraint、Claim 和 Evidence 可以确定性证明违规；
- `NOT_SELECTED` 从 P0-03 未发布的 v1 合同中移除并失败关闭；
- 多个 Candidate 均满足 Hard Constraint 时，P0-03 不得凭自由文本选择其中一个；应由 Runtime 形成 `NEED_MORE_INFO`，询问会改变取舍的具体偏好；
- 后续阶段只有在结构化 Preference Criterion 和 Candidate Comparison 完成合同、反例和真实验证后，才能重新开放 `NOT_SELECTED`。

例：A、B 都不超过 8000 元且都满足 32 GiB 内存。若 User 没有确认更看重续航还是重量，系统应问“续航和重量哪个优先？”，不能输出“综合来看 A 更合适”。

## 4. P0-03 新版数据结构

### 4.1 `DecisionRiskV1`

P0-03 不再接受 Runtime 自由编写的风险事实。Risk 只引用一个已经存在的 Claim，Web 从该 Claim 及其 Evidence 展示“需要权衡的已验证事实”。

```ts
type DecisionRiskV1 = Readonly<{
  riskId: string;
  candidateId: string;
  statementClaimId: string;
  verification: string;
}>;
```

`statementClaimId` 必须满足：

- Claim 属于被选 Candidate；
- Claim 状态为 `SUPPORTED`；
- Claim 至少有一条双向闭合且 `direction=SUPPORTS` 的 Evidence；
- 该 Evidence 被当前 Decision 的 `evidenceIds` 引用；
- 对应 `VERIFY_RISK` next step 引用该 `riskId`。

P0-03 删除权威合同中的自由文本 `summary` 和 `impact`。原因是合同无法在不引入自然语言蕴含判断的前提下证明“电池会爆炸”是否由“内存不可升级”支持。Web 可显示 Claim 的结构化 predicate/value、Evidence 摘录和核验步骤；后续 Category Package 可以为稳定 predicate 提供用户友好的本地化标签。

示例：

```json
{
  "riskId": "risk-memory-upgrade",
  "candidateId": "candidate-synth-a",
  "statementClaimId": "claim-a-memory-upgradeable",
  "verification": "确认未来三年是否需要扩容内存"
}
```

其中 `claim-a-memory-upgradeable` 表达 `memory.upgradeable=false`，并由对应 Synthetic Evidence 支持。若 Runtime 改写为“电池会爆炸”，合同中没有承载该新事实的自由文本字段；它必须先提供相应 Claim/Evidence，否则无法形成 Risk。

### 4.2 `CandidateDispositionV1`

P0-03 v1 暂时只保留可确定性证明的 `ELIMINATED`：

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

现有 Constraint Assessment 继续负责证明 Candidate 对 `requirementKey` 的结果为 `VIOLATED`，并证明 `evidenceIds` 至少包含该 Assessment 使用的支持证据。`reason` 只用于解释，不参与真假判断。

### 4.3 用户可见文本

所有必需的用户可见文本使用同一条非转换规则：

```ts
const meaningfulTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0);
```

该规则拒绝 `"   "`，但不擅自修改合法原文，避免解码后文本与签名、幂等规范化或用户输入不一致。

### 4.4 类型与 Schema 的权威关系

保留 ADR-0002 已确认的“Zod 是内部运行时校验实现，不向调用方暴露 Zod 类型”。因此：

- 公开只读 TypeScript 类型继续独立声明；
- Zod Schema 负责运行时输入解码；
- 使用编译期双向精确类型守卫证明两者字段和联合一致；
- 架构文档不得再把 Zod 描述为唯一公开类型源。

这样避免在公开 `.d.ts` 中泄漏 Zod，同时把双份声明的漂移变成编译失败。

## 5. 后续完整 Preference / Fit 模型边界

以下结构属于 V1.0 最终目标，但不是 P0-03 本次实现范围：

```ts
type PreferenceCriterion = Readonly<{
  preferenceId: string;
  key: string;
  objective: "MAXIMIZE" | "MINIMIZE" | "TARGET" | "MATCH";
  target?: ClaimValueV1;
  priority: "LOW" | "MEDIUM" | "HIGH";
  confirmed: boolean;
}>;

type CandidateComparisonBasis = Readonly<{
  comparisonId: string;
  preferenceId: string;
  selectedCandidateId: string;
  alternativeCandidateId: string;
  selectedClaimIds: readonly string[];
  alternativeClaimIds: readonly string[];
}>;
```

未来 `NOT_SELECTED` 必须引用一个或多个 `CandidateComparisonBasis`。核心只比较同 predicate、同值类型、同单位的 Claim，并以已确认的 Preference Criterion 决定比较方向；缺少任一侧 Claim、事实冲突、单位不同或偏好未确认时，比较为 `INDETERMINATE`，不得形成 `NOT_SELECTED`。

在完整 User Fit、权重/优先级冲突、定性偏好和多准则取舍尚未建模前，不引入“总分”或 Runtime 自报的 `selectedIsBetter=true`。

## 6. P0-03 可执行规则矩阵

| 场景 | 合同判定 | 示例 |
| --- | --- | --- |
| `reason/question/instruction` 只有空格 | 拒绝 | `question="   "` 返回 `CONTRACT_INVALID`。 |
| Risk 引用被选 Candidate 的可信 Claim | 接受 | A 的 `memory.upgradeable=false` 有 SUPPORTS Evidence。 |
| Risk 缺少 `statementClaimId` | 拒绝 | 只有“电池会爆炸”的文案不能进入合同。 |
| Risk Claim 属于未选 Candidate | 拒绝 | 选择 A，Risk 引用 B 的 Claim。 |
| Risk Claim 为 `UNKNOWN/CONFLICTED/REFUTED` | 拒绝 | 冲突事实不能包装成已确认风险。 |
| Risk Claim 没有 SUPPORTS Evidence | 拒绝 | Claim 存在但证据为空或只有 REFUTES。 |
| Risk Evidence 未进入 Decision 证据集合 | 拒绝 | 页面无法沿 Decision 证据链回查。 |
| `ELIMINATED` 有真实 Hard Constraint 违规及对应 Evidence | 接受 | B 的可信价格 8399 元超过 8000 元硬预算。 |
| `ELIMINATED` 只写理由、无违规 Assessment | 拒绝 | B 满足预算，却写“价格太高”。 |
| P0-03 出现 `NOT_SELECTED` | 拒绝 | 当前没有结构化 Preference/Fit，不能认证综合比较。 |
| 多个 Candidate 均可行但 Runtime 仍选择一个 | 拒绝该 Runtime 成功产物 | A、B 都满足硬约束，却没有可验证比较依据。 |
| 多个 Candidate 均可行且缺少取舍偏好 | 可形成 `NEED_MORE_INFO` | 询问“续航和重量哪个优先？”。 |
| 展示文案变化但结构化 Basis 不变 | 业务判定不变 | 修改核验提示不会改变 Claim 或约束结果。 |

## 7. 迁移测试清单

### 7.1 合同红灯

- [x] 空白 `reason`、Critical Gap `question`、Risk `verification` 和 next-step `instruction` 均被公开解码器拒绝。
- [x] 旧 Risk 形状中的 `summary/impact` 被严格 Schema 拒绝。
- [x] Risk 缺失或引用不存在的 `statementClaimId` 被拒绝。
- [x] Risk Claim 属于未选 Candidate、状态不可信、无 SUPPORTS Evidence 或未进入 Decision Evidence 时被拒绝。
- [x] P0-03 出现 `NOT_SELECTED` 时被拒绝。
- [x] 两个 Candidate 均满足 Hard Constraint、Runtime 仍选择 A 并把 B 伪装成 `ELIMINATED` 时被拒绝。
- [x] 两个 Candidate 均满足 Hard Constraint、Runtime 省略 B 去向仍返回购买 Decision 时被拒绝。
- [x] 两个 Candidate 均满足 Hard Constraint且缺少确认偏好时，合法 `NEED_MORE_INFO` 可询问具体偏好并保持无选择、无 Disposition、无 Risk。

### 7.2 合同绿灯

- [x] 固定正例中 B 继续以超预算 `ELIMINATED`，A 的板载内存 Risk 改为引用可信 Claim。
- [x] Risk → Claim → Evidence → Candidate 与 Decision Evidence 引用双向闭合。
- [x] 修改合法展示文案不改变结构化结果；只含空白的文本仍失败。
- [x] 同一 `executionRequestId` 重放逐字段一致，不因新结构破坏幂等语义。

### 7.3 纵向迁移

- [x] Fake Runtime fixture 使用新 Risk 结构，不再生成 `NOT_SELECTED`。
- [x] Executor 收到旧 Risk、无依据 Risk 或 `NOT_SELECTED` 时归一为 `FAILED + FAKE_RUNTIME_FAILED`，无 bundle。
- [x] Web 从 Risk 的 Claim/Evidence 显示结构化事实、来源摘录和核验步骤，不渲染 Runtime 自由编写的风险事实。
- [x] Web、API、Orchestrator 对旧形状和新反例使用相同版本化错误语义。
- [x] contracts、Orchestrator、Web 完成定向红绿验证，API 完成共享合同回归；随后运行根级 `pnpm verify`。
- [x] Windows 四进程真实链路验证 `BUY_IF_PRICE` 和偏好不足的 `NEED_MORE_INFO`；停止服务后确认端口释放。
- [x] 独立双轴 `code-review` 已执行多轮，其 finding 均已修复；测试通过不替代产品验收。

### 7.4 性质测试候选

优先用 Vitest 参数化测试覆盖上述有限矩阵；若手工变体仍持续遗漏，再引入成熟的 `fast-check` 生成以下性质：

- 删除任一 Decision Basis 引用后，成功 Decision 必须失败；
- 把 Claim/Evidence 换到另一 Candidate 后，成功 Decision 必须失败；
- 把 Claim 状态改为 `UNKNOWN/CONFLICTED/REFUTED` 后，相关 Risk 或选择必须失败；
- 任意修改展示文案都不能创造新的结构化事实。

不为 P0-03 自研通用规则引擎、自然语言蕴含模型或随机测试框架。

## 8. 迁移顺序与人工门禁

1. **已确认：** P0-03 暂停 `NOT_SELECTED`、Risk 改为 Claim 引用、结构化 Preference/Fit 延后但保留为 V1.0 目标。
2. **已完成：** 经产品负责人授权，已使用 `codebase-design` 形成并接受 [`p0-03-decision-basis-module-design.md`](p0-03-decision-basis-module-design.md)，确定内部 DecisionBasis/EvidenceGraph Module、文件职责和迁移顺序。
3. **已完成：** 再次取得确认后，使用 TDD 按第 7 节建立红灯并修改合同、fixture 和 Web。
4. **历史门禁已结束：** 本文对应实施与复审已经发生；其后的门禁是确认 [`p0-03-claim-evidence-authority-module-design.md`](p0-03-claim-evidence-authority-module-design.md)，该设计已于 2026-08-14 获接受并完成其范围内的受控 TDD。
5. 产品验收、提交、推送、PR、合并和发布均保持独立授权。

## 9. 已确认决策与下一门禁

产品负责人已确认：P0-03 接受“宁可在多个可行 Candidate 间追问，也不在缺少结构化 Preference/Fit 时输出 `NOT_SELECTED` 和最终选择”。

示例：A 续航 9 小时、B 续航 5 小时，但 User 没说续航是否重要；系统先追问偏好。只有未来 Requirement 明确 `battery.runtime + MAXIMIZE`，且 A/B 两侧 Claim/Evidence 都可信时，才允许记录“B 满足硬约束但未入选”。

当时的下一门禁是产品负责人是否接受新的 Claim/Evidence Codebase Design；该设计已于 2026-08-14 获接受并完成其范围内的受控 TDD，复审、提交或推送仍分别授权。
