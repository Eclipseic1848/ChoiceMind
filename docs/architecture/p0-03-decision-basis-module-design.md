# P0-03 DecisionBasis / EvidenceGraph Codebase Design

## 1. 状态与范围

- 状态：`accepted` 的历史实施基线；产品负责人于 2026-08-14 确认后，已按本设计完成过受控 TDD。
- 当前替代关系：本文关于 `Claim.status`、双向 Claim/Evidence 引用和消费者自行扫描 Evidence 的内容已被 [ADR-0006](../adr/0006-decision-basis-owns-evidence-state.md) 的领域决定取代；目标 Implementation 见 [`p0-03-claim-evidence-authority-module-design.md`](p0-03-claim-evidence-authority-module-design.md)。该新设计已于 2026-08-14 定为 `accepted` 并完成其范围内的受控 TDD 迁移；本文其余内容保留为历史实施基线。
- 对应领域决定：[`p0-03-evidence-bound-decision-contract-proposal.md`](p0-03-evidence-bound-decision-contract-proposal.md) 和 [ADR-0004](../adr/0004-fail-closed-without-decision-basis.md)。
- 对应 Issue：<https://github.com/Eclipseic1848/ChoiceMind/issues/3>。
- 本设计只决定 `@choicemind/contracts` 内部 Decision Basis Module、EvidenceGraph Implementation、未发布 v1 的迁移范围及文件级实施顺序。
- 本设计不修改生产 Agent Runtime、HTTP Interface、持久化、真实数据、自然语言解析、Preference/Fit 实现或其他锁定 Decision 状态。

## 2. 已验证事实、代码推断与建议

### 2.1 已验证事实

- 公开合同 Seam 已经是 `decodeDecisionTaskResultV1(input: unknown)`；API、Orchestrator 和 Web 都通过该 Interface 校验结果。
- `invariants.ts` 当前同时负责任务状态、RunEvent、错误语义、引用闭包、预算、must-have、Condition、Critical Gap、Candidate Disposition、Decision Risk 和 Decision Evidence。
- Candidate、Claim 和 Evidence 的 Map/Set 建立、双向引用检查及 Constraint Assessment 都位于同一个近千行文件中。
- 预算和普通 must-have Assessment 分别遍历 Claim/Evidence，并存在相似的可信证据收集逻辑。
- Decision Risk 当前只有 Candidate 归属校验；`NOT_SELECTED` 当前只检查 Candidate 满足 Hard Constraint 和 Evidence 属于该 Candidate。
- Fake Runtime fixture 仍输出旧 Risk 的 `summary/impact`；Web 直接渲染这两个字段，并保留 `NOT_SELECTED` 展示分支。
- P0-03 没有数据库、网络数据源或第三方依赖参与 Decision Basis 判断；相关依赖属于纯进程内计算。

### 2.2 基于代码的推断

- 如果只新增 `getClaim()`、`getEvidence()` 等查询函数，调用方仍需组合引用、判断 Claim 状态和 Evidence 方向，复杂度不会从 `invariants.ts` 消失；该 Interface 会很浅。
- 如果继续在 `checkDecisionTaskResultInvariants` 中追加 Risk 和 `NOT_SELECTED` 条件，同一个 Module 会继续混合运行状态与消费证据两个变化方向，后续 Preference/Fit 会再次放大该问题。
- EvidenceGraph 在重复 ID 或断链时不能安全构建 Map；若继续用最后写入值进行语义判断，可能产生静默覆盖。因此结构图无效时必须停止后续 Decision Basis Assessment。

### 2.3 当时采用并已实施的建议

建立一个内部深 Module：**DecisionBasis Module**。它对调用方只提供一个检查 Interface；不可变 EvidenceGraph、索引、Constraint Assessment、Elimination 和 Risk Claim 校验全部隐藏在 Implementation 中。该历史 Module 已实施；其中 Claim/Evidence 权威部分当时等待新 Codebase Design 确认后严格迁移，该迁移已由 `p0-03-claim-evidence-authority-module-design.md` 于 2026-08-14 完成。

## 3. 依赖分类与 Seam

依赖分类为 **in-process**：

- 输入是已经通过 Zod 结构校验的 `DecisionBundleV1` 和权威 `decisionTaskId`；
- 输出是确定性的 `ContractIssueV1[]`；
- 无 I/O、无全局状态、无异步、无外部副作用；
- 不需要 Port 或 Adapter，也不增加依赖包。

公开 Seam 保持不变：

```ts
decodeDecisionTaskResultV1(input: unknown): ContractDecodeResult<DecisionTaskResultV1>
```

新增 Seam 只存在于 `@choicemind/contracts` 的私有 Implementation 内，不从 `packages/contracts/src/decision/v1/index.ts` 或 `package.json#exports` 导出。

## 4. Interface 方案比较

### 4.1 方案 A：公开 EvidenceGraph 查询 Interface

```ts
interface EvidenceGraph {
  getCandidate(candidateId: string): CandidateV1 | undefined;
  getClaim(claimId: string): ClaimV1 | undefined;
  getEvidence(evidenceId: string): EvidenceV1 | undefined;
  assessConstraint(...): ConstraintAssessment;
}
```

优点是查询灵活；缺点是调用方必须学习图结构、缺失值、Claim 状态、Evidence 方向和查询顺序。它把 Map 隐藏了，却没有隐藏业务复杂度，Leverage 低，拒绝采用。

### 4.2 方案 B：单一 DecisionBasis 检查 Interface

```ts
type DecisionBasisCheckInputV1 = Readonly<{
  decisionTaskId: string;
  bundle: DecisionBundleV1;
}>;

function checkDecisionBasisV1(
  input: DecisionBasisCheckInputV1
): readonly ContractIssueV1[];
```

调用方只提供完整 bundle 和权威 Task ID，不知道 EvidenceGraph、索引、Assessment 或验证顺序。该方案把结构闭包和业务依据集中在一个 Module，Leverage 与 Locality 最高，推荐采用。

### 4.3 方案 C：继续扩展 `invariants.ts`

该方案没有新增 Interface，但运行状态和 Decision Basis 的知识继续混在同一 Implementation。删除任何局部 helper 后复杂度不会离开原文件，也不能为未来 Preference/Fit 提供清晰位置，拒绝采用。

## 5. 推荐 Interface

内部调用方式固定为：

```ts
const decisionBasisIssues = checkDecisionBasisV1({
  decisionTaskId: result.taskStatus.decisionTaskId,
  bundle: result.bundle
});

issues.push(...decisionBasisIssues);
```

完整 Interface 语义：

- 输入必须已经通过 v1 Zod Schema；Module 不接收 `unknown`，也不重复字段类型校验。
- 对相同输入逐字段确定性返回相同 Issues；不修改输入。
- 对合法类型输入不抛异常；发现无效图或 Decision Basis 时返回带稳定 path/message 的 Issues。
- EvidenceGraph 构建为 `O(Candidate + Claim + Evidence)`；后续查询使用索引，只扫描相关 Candidate/predicate 的 Claim。
- 图的身份或双向引用无效时，返回图结构 Issues 并停止后续语义 Assessment，禁止用有歧义的 Map 继续判断。
- 该函数只在 contracts 私有文件间导入，不成为调用方或 Adapter 的公开 Interface。

## 6. 隐藏的 EvidenceGraph Implementation

推荐内部结构：

```text
checkDecisionBasisV1
  ├─ buildEvidenceGraph
  │   ├─ Candidate / Claim / Evidence ID 唯一性
  │   ├─ Decision Task 归属
  │   ├─ Claim → Candidate
  │   ├─ Claim ↔ Evidence 双向闭包
  │   └─ 建立不可变索引
  ├─ assessMustHave
  ├─ assessHardBudget
  ├─ validateSelectedCandidateBasis
  ├─ validateEliminations
  ├─ validateRiskClaimBasis
  └─ validateDecisionEvidenceClosure
```

EvidenceGraph 是私有数据结构，不拥有可被其他目录调用的 Interface：

```ts
type EvidenceGraph = Readonly<{
  candidatesById: ReadonlyMap<string, CandidateV1>;
  claimsById: ReadonlyMap<string, ClaimV1>;
  evidenceById: ReadonlyMap<string, EvidenceV1>;
  claimsByCandidateAndPredicate: ReadonlyMap<string, readonly ClaimV1[]>;
}>;
```

### 6.1 图构建

`buildEvidenceGraph` 先收集全部重复 ID、跨任务归属和断链问题。只有以下条件全部成立时才返回 graph：

- Candidate、Claim、Evidence ID 各自唯一；
- 每个 Claim 指向存在的 Candidate；
- 每个 Claim Evidence ID 指向存在且反向关联该 Claim 的 Evidence；
- 每个 Evidence 指向存在且反向包含该 Evidence 的 Claim；
- Candidate、Claim、Evidence 全部属于权威 Decision Task。

失败结果只包含图结构 Issues，不执行预算、约束、Elimination 或 Risk 判断。例：两个 Claim 共用同一 ID 时，不允许 Map 后写覆盖前写后继续认证购买结论。

### 6.2 Constraint Assessment

预算和普通 must-have 共用一个私有可信 Claim 收集流程：

```text
按 Candidate + predicate 取相关 Claim
→ 要求事实状态一致且为 SUPPORTED
→ 要求值类型、币种或单位匹配
→ 要求至少一条双向闭合 SUPPORTS Evidence
→ 发现 REFUTES、冲突值或缺证据则 INDETERMINATE
→ 比较结构化值，得到 SATISFIED / VIOLATED
```

`assessMustHave` 和 `assessHardBudget` 可以保留两个窄私有函数，但证据收集只实现一次。Runtime 不提交 Assessment，核心不解析 Candidate 展示文案或执行单位换算。

### 6.3 Elimination

P0-03 Schema 只允许 `ELIMINATED`。每条记录必须：

- 指向存在且未被选中的 Candidate；
- `requirementKey` 指向真实 must-have 或已确认硬预算；
- 对应 Assessment 为 `VIOLATED`；
- `evidenceIds` 至少包含该 Assessment 使用的 SUPPORTS Evidence；
- 同一 Candidate 只有一条 Elimination，且每个最终未选 Candidate 恰有一条。

因此，当 A、B 都满足 Hard Constraint 时，Runtime 不能把 B 伪造成淘汰，也不能省略 B 后继续选择 A；购买产物会失败关闭。合法路径是 Runtime 返回 `NEED_MORE_INFO` 并提出偏好问题。

### 6.4 Decision Risk

每个 Risk 的 `statementClaimId` 必须解析为一个 Supported Claim Basis：

- Claim 存在且属于被选 Candidate；
- Claim 状态为 `SUPPORTED`；
- 至少有一条双向闭合且 `direction=SUPPORTS` 的 Evidence；
- 至少一条上述 Evidence 被当前 Decision 的 `evidenceIds` 引用；
- `invariants.ts` 另行保证 Risk 有对应 `VERIFY_RISK` next step。

`statementClaimId` 是 Risk 的事实入口。P0-03 不再接收 `summary/impact`，也不对 `verification` 做自然语言蕴含判断。

### 6.5 Meaningful Text

`meaningfulTextSchema` 保持在 `schemas.ts` 内部，不单独建立 Module。它只替换用户可见文本字段的 `z.string().min(1)`：

- Requirement：`submittedText`、`intendedUses[]`、非空的 `niceToHaves[]/mustNotHaves[]/unknowns[]`；
- Candidate/Claim/Evidence：`displayName`、`configuration`、TEXT Claim value、source title、locator、excerpt；
- Decision：summary、Condition verification、Elimination reason、Risk verification、Gap question、assumptions[]、next-step instruction；
- Run/Error：RunEvent summary、Error message。

ID、predicate 和 unit 仍使用现有标量规则；本轮不扩大到 ID 格式或单位规范化。校验使用 `trim().length > 0`，但不 transform 输入。

## 7. 与现有 `invariants.ts` 的职责切分

`invariants.ts` 保留：

- Result 判别联合后的成功/失败终态规则；
- Error code/category/retryMode；
- RunEvent ID、顺序、Task/Run 归属和固定成功阶段；
- Decision Revision 与 Requirement Revision 的直接引用；
- P0-03 状态开放门禁；
- Critical Gap、Condition、Risk 与 next-step 的状态闭包；
- 调用 `checkDecisionBasisV1` 并合并 Issues。

`decision-basis.ts` 接管：

- Candidate、Claim、Evidence 唯一性、任务归属和引用图；
- Candidate/Claim/Evidence 索引；
- must-have 与预算 Assessment；
- 被选 Candidate 的 Hard Constraint Basis；
- Elimination、Risk Claim 和 Decision Evidence Basis。

不创建 `EvidenceGraphPort`、`ConstraintEvaluatorPort` 或 Adapter。只有一个纯计算 Implementation 时，额外 Port 是假想 Seam。

## 8. 合同迁移范围

- P0-03 尚未发布，直接修订 `contractVersion="1.0"`；不增加 `1.1`、兼容字段或转换 Adapter。
- 旧 `NOT_SELECTED` 联合分支和旧 Risk `summary/impact` 由 strict Schema 拒绝。
- `DecisionTaskExecutor.execute`、HTTP 路径、Result 联合、错误码、HTTP 映射和 Agent Runtime Port 均不变。
- `AgentRuntimeRunOutputV1` 通过引用共享 `DecisionRevisionV1` 自动获得新形状，不增加 Runtime 私有类型。
- Monorepo 中 contracts、Fake Runtime 和 Web 必须在同一次本地变更中迁移；不得让任一进程继续接受旧合同。
- P0-03 无持久化 Decision 数据，无需数据库迁移或历史文档转换。
- `dist` 继续由现有 build/dev 流程生成，不提交生成物。

## 9. 文件级实施顺序

| 顺序 | 文件 | 变更 | 验证 |
| --- | --- | --- | --- |
| 1 | `packages/contracts/src/decision/v1/result.test.ts` | 先加入空白文本、旧 Risk、新 Risk 断链、`NOT_SELECTED`、多个可行 Candidate 的红灯 | 定向 Vitest 必须失败且原因正确 |
| 2 | `packages/contracts/src/decision/v1/index.ts` | 删除 `NOT_SELECTED` 联合；Risk 改为 `statementClaimId + verification` | contracts typecheck 显示所有未迁移调用点 |
| 3 | `packages/contracts/src/decision/v1/schemas.ts` | 增加 `meaningfulTextSchema`；严格迁移 Disposition/Risk | Schema 正反例转绿，旧形状保持失败 |
| 4 | `packages/contracts/src/decision/v1/decision-basis.ts` | 新建单 Interface 深 Module及私有 EvidenceGraph | 仍只通过公开 decoder 测试 |
| 5 | `packages/contracts/src/decision/v1/invariants.ts` | 调用新 Module，删除已迁移的 Map、Assessment 和 Risk/Elimination 逻辑 | 既有合同测试与新性质矩阵通过 |
| 6 | `apps/orchestrator/src/runtime/synthetic-laptop-fixture.ts` | Risk 引用 soldered-memory Claim；预算足以保留 A/B 时形成偏好 `NEED_MORE_INFO` | Fake Runtime 定向测试 |
| 7 | `apps/orchestrator/src/decision-tasks/executor.test.ts` | 增加旧 Risk、无依据 Risk、`NOT_SELECTED` 和多可行候选失败关闭测试 | 均归一为 `FAILED + FAKE_RUNTIME_FAILED`，无 bundle |
| 8 | `apps/web/src/app/decision-flow.tsx` | 删除 `NOT_SELECTED` 分支；按 `statementClaimId` 查找 Claim 并显示 predicate/value、Evidence 和核验步骤 | Web 单测/类型检查 |
| 9 | `apps/web/tests/system-health.spec.ts` | 删除旧 `NOT_SELECTED` fixture；验证 Risk Claim 展示及 preference Gap | Playwright 定向测试 |
| 10 | 当前规格、设计、`handoff.md` | 写入真实实现与验证证据 | UTF-8 与文档一致性检查 |

该顺序已经落实；实现与验证证据记录于 `handoff.md`。本次没有增加公开 Port、Adapter、依赖包或合同版本。

## 10. TDD 观察面

所有业务验证继续穿过已存在的 Interface：

```text
decodeDecisionTaskResultV1
DecisionTaskExecutor.execute
Web 用户可见结果
```

不直接测试私有 EvidenceGraph 的 Map 或 helper。测试必须覆盖：

- 新 Risk 正例；缺失 Claim、错 Candidate、非 SUPPORTED、无 SUPPORTS Evidence、未进入 Decision Evidence 的反例；
- 旧 Risk `summary/impact` 和所有 `NOT_SELECTED` 产物严格失败；
- A、B 均满足 Hard Constraint 时购买产物失败，偏好 Gap 的 `NEED_MORE_INFO` 成功；
- 空白 `reason/question/verification/instruction` 失败；
- 删除、换 Candidate、冲突化任一 Decision Basis 后成功 Decision 失败；
- 固定 B 超预算正例继续为 `BUY_IF_PRICE + ELIMINATED`；
- Executor 对不可信 Runtime 产物失败关闭；Web 不显示 Runtime 自由风险事实。

优先使用 Vitest 参数化测试。只有定向矩阵再次证明难以覆盖组合空间时，才另行提议 `fast-check`；本期不预先增加依赖。

## 11. 完成门禁

未来 TDD 完成必须提供：

1. contracts 红灯与绿灯证据；
2. contracts、Orchestrator、API、Web 定向测试；
3. 根级 `pnpm verify`，使用声明的 Node 22.22.1；
4. Windows 四进程真实链路：固定 8000 元需求返回 `BUY_IF_PRICE`，9000 元使两个 Candidate 均可行时返回偏好 `NEED_MORE_INFO`；
5. 服务停止后 3000/3100/3200/3300 端口释放；
6. 变更文件 allowlist 和无范围扩张检查；
7. 产品负责人确认后，才能启动一次独立双轴 `code-review`。

测试通过不等于产品验收，不授权提交、推送、PR、合并或发布。

## 12. 删除测试与深度判断

如果删除 DecisionBasis Module，以下知识会重新散回 `invariants.ts` 或调用方：

- 图构建和重复 ID 处理顺序；
- Claim/Evidence 双向闭包；
- 可信 Claim 与 SUPPORTS Evidence 的统一定义；
- must-have、预算、Elimination 和 Risk 对同一图的查询规则；
- 图无效时禁止继续语义认证。

因此该 Module 具有 Depth。调用方只学习一个检查 Interface，获得完整 Decision Basis 校验；未来 Preference/Fit 可在同一 Implementation 内增加 Assessment，而不扩大公开 Interface。

## 13. 历史确认项

本设计当年曾等待产品负责人确认是否采用并进入下一阶段 TDD；该确认与 TDD 均已于 2026-08-14 完成，本文保留为历史实施基线。当时要求的示例：当预算改为 9000 元后 A、B 都合格，Fake Runtime 必须返回“你更看重续航还是重量？”的 `NEED_MORE_INFO`，不能再制造 `NOT_SELECTED` 或把 B 伪装成超预算淘汰。
