# P0-03 Claim / Evidence 冲突语义与成熟方案研究

## 1. 文档状态

- 核验时间：`2026-08-14T09:55:40-07:00`（America/Los_Angeles）。
- 研究问题：ChoiceMind P0-03 如何从根因上消除 Claim、Evidence、Decision Risk、Constraint 与 Elimination 对证据状态的重复解释和语义漂移。
- 资料范围：公开论文、W3C/Schema.org 规范、官方项目仓库，以及 npm/PyPI 官方元数据。
- 本文性质：只读研究与设计建议，不是 ADR，不代表产品负责人已确认，也不构成代码实现或验收证据。
- 本文未做：未修改 ChoiceMind 实现，未安装候选包，未做数据库/RDF 服务设计，未评估生产事实核验模型。

本文使用以下事实等级：

- **已验证事实**：可由本地代码或所列一手外部来源直接复核。
- **基于现代码推断**：由当前实现和已验证资料推导出的根因判断。
- **尚未验证建议**：需要产品负责人确认，并在 TDD 中验证后才能成为项目决定。

## 2. 结论先行

### 2.1 已验证事实

成熟事实核验和论证表示方案的共同点不是某个现成“规则引擎”，而是把以下对象分开：

1. 命题本身；
2. 来源和可定位的证据；
3. 证据对命题的支持或反驳关系；
4. 根据当前证据集合产生的判定；
5. 判定的来源、推导活动和责任主体。

FEVER 将 Claim、`SUPPORTS / REFUTES / NOT ENOUGH INFO` 标签和 Evidence Set 分开；标签正确但证据集合不完整，不能获得完整 FEVER 分数。SciFact 更明确地避免给科学 Claim 写入“全局真值”，而是对具体文献中的 rationale 标注 `SUPPORT` 或 `CONTRADICT`。W3C PROV-O 负责溯源，Web Annotation 负责定位和注释，Schema.org ClaimReview 负责发布一项评审，AIF 负责表示命题之间的推理与冲突关系；它们都没有替应用定义 ChoiceMind 的购买决策真值规则。

### 2.2 基于现代码推断

P0-03 反复出现漏洞的根因不是单个条件漏写，而是 **Claim 的 Runtime 自报状态和 Evidence 方向形成两个真相来源，并且不同消费者各自重新解释它们**：

- 当前 [`ClaimV1`](../../packages/contracts/src/decision/v1/index.ts) 第 88 行允许 Runtime 写入 `SUPPORTED / REFUTED / CONFLICTED / UNKNOWN`；[`schemas.ts`](../../packages/contracts/src/decision/v1/schemas.ts) 第 114 行只验证该值属于枚举，不能证明它与 Evidence 一致。
- 当前 [`collectTrustedClaimValues`](../../packages/contracts/src/decision/v1/decision-basis.ts) 第 518 行附近会在发现 `REFUTES` Evidence 时失败关闭；但 [`validateRiskClaimBasis`](../../packages/contracts/src/decision/v1/decision-basis.ts) 第 384—394 行只要求 Claim 自报 `SUPPORTED` 且存在一条 `SUPPORTS` Evidence。因此相同图在 Constraint 与 Risk 中会得出不同结论。
- 权威 V1.2 的 [`FR-009`](../../ChoiceMind_星枢智购_产品与研发规格书_v1.2.md) 第 330 行把 `VERIFIED_FACT / SOURCE_OPINION / SYSTEM_INFERENCE`（内容或来源性质）与 `CONFLICTED / UNKNOWN`（证据判定状态）放进同一个枚举；第 334 行又要求冲突证据并存且不能只选支持方。这两个轴混在一起后，无法形成唯一、可穷举的派生规则。

只在 Risk 再补一个 `REFUTES` 判断会关闭当前反例，却保留两个真相来源和多个解释入口；未来增加 Preference、Fit、TCO 或新的 Decision 状态时，同类问题还会出现。

### 2.3 尚未验证建议

P0-03 应采用成熟领域模式，但 **不引入运行时规则引擎、RDF 存储或通用图框架**：

- Claim 只保存命题和内容类型，不保存 Runtime 可写的证据判定状态。
- Evidence 与“支持/反驳某 Claim”的关系分开。
- 由一个小型、同步、无副作用的内部 `DecisionBasis` Module 唯一派生 `EvidenceState`。
- Risk、Hard Constraint、Elimination 和 Decision Evidence Closure 只消费同一份派生结果，禁止直接读 `Claim.status` 或自行扫描 Evidence。
- 继续复用现有 Zod 做不可信输入的形状校验；只评估把 `fast-check` 作为测试依赖，用性质测试穷举和扰动证据组合。

这不是“继续手搓框架”。它是保留 ChoiceMind 独有且很小的领域判定，同时复用成熟的 Schema 和测试基础设施；现有候选库没有一个拥有 ChoiceMind 的 Risk、Constraint、Elimination 和失败关闭语义。

## 3. 事实核验基准提供的模式

### 3.1 FEVER

#### 已验证事实

- FEVER 论文将 Claim 标为 `SUPPORTED`、`REFUTED` 或 `NOT ENOUGH INFO`；前两类同时记录作出判断所需的证据句。[ACL Anthology 论文](https://aclanthology.org/N18-1074/)
- FEVER 任务的数据格式把 `claim`、`label` 和 `evidence` 分开；Evidence 是“证据集合的列表”。一个集合内的句子共同构成完整依据，不同集合是可替代的充分依据。评分要求至少返回一个完整 Evidence Set，不能用一条碰巧支持的句子冒充完整证据链。[FEVER 2018 官方任务说明](https://fever.ai/2018/task.html)
- `NOT ENOUGH INFO` 不是一条反驳证据，而是没有足够证据作出支持或反驳判定。原始论文也说明该类没有人工标注 Evidence。[论文 PDF](https://aclanthology.org/N18-1074.pdf)
- AWS 官方仓库保存了 FEVER 标注平台、基线与 scorer 的入口，许可证为 Apache-2.0；它是研究数据/基线，不是可嵌入 ChoiceMind 的 TypeScript 领域引擎。[官方仓库](https://github.com/awslabs/fever)

#### 对 ChoiceMind 的可采用模式

- 命题、判定和证据集合必须是不同概念。
- “有一条支持 Evidence”不等于“依据完整”。
- 证据不足必须是一个独立结果，不能等同于反驳或合同结构错误。

#### 不能直接照搬的边界

FEVER 是固定 Wikipedia 语料上的评测基准，单个 gold label 由标注流程给出；ChoiceMind 面对时效、SKU、卖家、来源偏见和真实冲突，不能把 FEVER 标签当成运行时可写字段，也不能假设语料闭世界。

### 3.2 SciFact

#### 已验证事实

- SciFact 的任务是检索包含证据的论文摘要，并标注它对 Claim 的 `SUPPORTS` 或 `REFUTES` 关系及 rationale。[ACL Anthology 论文](https://aclanthology.org/2020.emnlp-main.609/)
- 论文明确说明：在固定科学语料上给 Claim 一个全局真值需要专家系统综述，因此 SciFact 选择更窄的任务——判断具体摘要支持还是反驳 Claim。[论文 PDF，第 3 节](https://aclanthology.org/2020.emnlp-main.609.pdf)
- 官方数据 Schema 把每个文档的 rationale 保存为 `label: SUPPORT | CONTRADICT` 加句子编号；同一 Claim 可以关联多个文档和多个 rationale。官方还特意为每个 rationale 保留 label，以容纳未来同一摘要中出现冲突 rationale 的可能。[AllenAI 官方数据说明](https://github.com/allenai/scifact/blob/master/doc/data.md)
- 没有找到 Evidence 的被引用文档仍保留在 `cited_doc_ids`，但不会被伪造成支持或反驳 Evidence。[AllenAI 官方数据说明](https://github.com/allenai/scifact/blob/master/doc/data.md)

#### 对 ChoiceMind 的可采用模式

- 不把“命题真值”写在 Claim 上；先保存每个来源对命题的 stance，再由应用策略聚合。
- 来源没有提供可定位依据时，应保持“无依据/不足”，不能由 Runtime 的自信标签补齐。
- 对消费信息而言，“某测评者认为风扇吵”首先是可定位的来源观点；它不自动等于“所有设备都很吵”的已验证事实。

#### 不能直接照搬的边界

SciFact 是数据集和 Python 研究代码，官方仓库依赖旧研究环境；它的 per-abstract 标签不是 ChoiceMind 的商品适配、时效或来源独立性策略。因此应采用数据分层模式，不复用其模型或运行时。

## 4. 溯源、注释、评审与论证标准

| 方案 | 已验证事实 | 对 P0-03 的最小借鉴 | 不承担的职责 |
|---|---|---|---|
| W3C PROV-O | 以 `Entity / Activity / Agent` 和 `wasDerivedFrom / wasGeneratedBy / wasAttributedTo / hadPrimarySource` 等关系表达产物、推导、责任和一手来源。[W3C Recommendation](https://www.w3.org/TR/prov-o/) | 保留 `sourceId`、生成/抓取活动、归属和派生来源的概念边界 | 不定义某 Evidence 是支持还是反驳，也不计算 Claim 真值 |
| W3C Web Annotation | Annotation 连接 Body 与 Target；Selector 能定位文本片段、媒体时间段，Time State 能记录适用版本或缓存副本。[Data Model](https://www.w3.org/TR/annotation-model/)、[Text Quote Selector](https://www.w3.org/TR/annotation-model/#text-quote-selector)、[Time State](https://www.w3.org/TR/annotation-model/#time-state) | Evidence 的 `locator` 应是结构化目标定位，而不是只有自由文本摘录 | 不定义 Claim、支持/反驳或决策门禁 |
| Schema.org Claim / ClaimReview | `Claim` 表示可被评审的事实性命题；`ClaimReview` 通过 `itemReviewed`、`claimReviewed` 和 `reviewRating` 发布一项事实核验评审。Schema.org 当前还明确说未定义 Claim 之间的关系。[Claim](https://schema.org/Claim)、[ClaimReview](https://schema.org/ClaimReview) | 可作为未来对外导出/SEO 映射的参考；Claim 与 Review 不是同一对象 | 不能表示完整 Evidence Graph，也没有冲突聚合算法 |
| AIF / Argument Web | AIF 把信息命题表示为 I-node，把推理、冲突、偏好分别表示为 RA、CA、PA scheme application node；Scheme node 必须有前驱和后继，命题之间不能用无语义裸边直接相连。[AIF Specification](https://www.arg-tech.org/wp-content/uploads/2011/09/aif-spec.pdf) | `SUPPORTS / REFUTES` 应是显式、可校验的关系；系统推断应有 premises/derivation，而不是改写 Claim 状态 | AIF 面向通用论证交换，结构远大于 P0-03，也不含消费决策门禁 |

### 基于证据的推断

这些标准互补而非互相替代：PROV-O 回答“谁在何时由什么生成”，Web Annotation 回答“证据定位到哪里”，ClaimReview 回答“谁发布了什么评审”，AIF 回答“命题间是什么论证关系”。ChoiceMind 仍必须拥有“哪些证据可参与判定、冲突如何失败关闭、Risk/Constraint/Elimination 如何消费判定”的领域语义。

### 尚未验证建议

P0-03 只借用概念，不采用 RDF/JSON-LD 序列化，不启动三元组数据库，不建立 AIF 服务。当前 TypeScript 对象和 Zod Schema 足以表达最小关系；以后确有跨系统交换需求，再单独做 Adapter/ADR。

## 5. 开源候选核验

### 5.1 核验口径

以下“维护信号”只表示在核验时仓库未归档、存在近期 push 或近期包发布，不等于安全、正确或 ChoiceMind 适配认证。版本以 npm `latest` 或 PyPI 当前版本为准；GitHub Release 与包发布不一致时明确列出。

| 候选 | 版本、许可证与维护事实 | 真实能力边界 | P0-03 结论 | 最小采用范围 |
|---|---|---|---|---|
| 现有 `zod` | npm `4.4.3`，2026-05-04 发布，MIT，内置类型；ChoiceMind 已固定同版本。[npm metadata](https://registry.npmjs.org/zod/latest)、[GitHub v4.4.3](https://github.com/colinhacks/zod/releases/tag/v4.4.3) | 负责不可信数据形状、判别联合和字段级 refinement；不会自动推导跨对象 Evidence 语义 | **推荐继续使用** | 只作为输入 Schema 与公开 decoder 第一层 |
| `fast-check` | npm `4.9.0`，2026-07-08 发布，MIT，内置 TypeScript 声明；仓库未归档并在核验日仍有 push。[npm metadata](https://registry.npmjs.org/fast-check/latest)、[GitHub v4.9.0](https://github.com/dubzzz/fast-check/releases/tag/v4.9.0)、[仓库 metadata](https://api.github.com/repos/dubzzz/fast-check) | JavaScript/TypeScript 性质测试、生成测试和 counterexample shrinking；不是运行时规则或图引擎。[官方仓库](https://github.com/dubzzz/fast-check) | **推荐做有界原型后作为 devDependency** | 只为证据组合、排列和单调性性质测试；不进入生产 bundle |
| `json-rules-engine` | npm `7.3.1`，2025-02-20 发布，ISC，内置类型，Node `>=18`；仓库未归档，最近 push 为 2026-02-16。GitHub 最新正式 Release 仍为 `v6.5.0`，晚于它的 npm 包没有对应 Release，发布面存在不一致。[npm metadata](https://registry.npmjs.org/json-rules-engine/latest)、[仓库 metadata](https://api.github.com/repos/CacheControl/json-rules-engine)、[Releases](https://github.com/CacheControl/json-rules-engine/releases) | 擅长 JSON 条件的 `ALL / ANY`、priority、fact/almanac 和 event；它不知道 Evidence Graph 闭包、证据时效或 ChoiceMind 结果语义。[官方仓库](https://github.com/CacheControl/json-rules-engine) | **不推荐** | 无；将四格真值表放进外部 DSL 只会增加第二套 Schema 和错误语义 |
| `json-logic-engine` | npm `5.0.7`，2026-04-01 发布，MIT，内置类型，Node `>=12.22.7`；仓库未归档，最近 push 与该发布同日。GitHub 最新 Release 页面为 `5.0.0`，低于 npm `latest`。[npm metadata](https://registry.npmjs.org/json-logic-engine/latest)、[仓库 metadata](https://api.github.com/repos/json-logic/json-logic-engine)、[Releases](https://github.com/json-logic/json-logic-engine/releases) | 适合可持久化 JSON Logic、异步操作和自定义运算；它执行调用者提供的表达式，但不拥有 Claim/Evidence 领域含义。[官方仓库](https://github.com/json-logic/json-logic-engine) | **不推荐** | 无；P0-03 规则固定且很小，不需要用户可配置规则语言 |
| `@dagrejs/graphlib` | npm `4.0.5`，2026-08-03 发布，MIT，ESM/CJS 与内置类型；仓库未归档并在发布日有 push。GitHub 最新 Release 页面仍停在 `v2.1.3`，包与 Release 流程不一致。[npm metadata](https://registry.npmjs.org/%40dagrejs%2Fgraphlib/latest)、[仓库 metadata](https://api.github.com/repos/dagrejs/graphlib)、[Releases](https://github.com/dagrejs/graphlib/releases) | 提供有向/无向、多重图和通用图算法，不验证边的业务类型。[官方仓库](https://github.com/dagrejs/graphlib) | **不推荐** | 当前 `Map` 索引已足够；只有出现通用路径/环算法的真实需求才重评 |
| `graphology` | npm `0.26.0`，2025-01-26 发布，MIT，内置类型；仓库未归档，最近 push 为 2026-07-21，GitHub Release 为 `0.26.0`。[npm metadata](https://registry.npmjs.org/graphology/latest)、[仓库 metadata](https://api.github.com/repos/graphology/graphology)、[Release](https://github.com/graphology/graphology/releases/tag/0.26.0) | 成熟的 JS/TS 通用 Graph 对象及算法/可视化生态，但不会提供 Claim truth、闭包或失败关闭。[官方仓库](https://github.com/graphology/graphology) | **不推荐** | P0 无；若未来单独做大型证据网络可视化，再从只读投影层评估 |
| `n3`（N3.js） | npm `2.2.0`，2026-08-05 发布，MIT，Node `>=12`；仓库未归档，最近 push 为 2026-08-10。当前包 metadata 没有内置 `types/typings` 字段，TypeScript 需另依赖 `@types/n3`。[npm metadata](https://registry.npmjs.org/n3/latest)、[仓库 metadata](https://api.github.com/repos/rdfjs/N3.js)、[v2.2.0](https://github.com/rdfjs/N3.js/releases/tag/v2.2.0)、[@types/n3 metadata](https://registry.npmjs.org/%40types%2Fn3/latest) | RDF.js 的 Turtle/TriG/N-Triples/N-Quads parser、writer 和内存 store；不执行 PROV/AIF 业务推理。[官方仓库](https://github.com/rdfjs/N3.js) | **不推荐** | P0 无；引入会同时带来 RDF 数据模型、序列化和类型版本协调成本 |
| PyPI `xaif` | PyPI `0.3.6`，2025-03-26 发布，声明 Python `>=3.8` 和 MIT；GitHub 最近 push 为 2025-03-27。PyPI 的项目/许可证详情未验证，仓库 README 指向的 LICENSE 文件实际缺失，GitHub API 也未识别许可证。[PyPI](https://pypi.org/project/xaif/)、[PyPI JSON](https://pypi.org/pypi/xaif/json)、[仓库](https://github.com/arg-tech/xaif)、[仓库 metadata](https://api.github.com/repos/arg-tech/xaif) | 管理 xAIF 的 Python node/edge/locution/participant 结构；不是 TypeScript/Zod 组件，也不提供消费决策真值 | **不推荐，且不通过许可证清晰度门禁** | 无；只把 AIF 的命题/关系分离思想用于领域设计 |

`json-logic-js` 也做了筛查：npm 最新 `2.0.5` 发布于 2024-07-09且无内置 TypeScript 声明，仓库最近 push 同日；它不符合本次“仍维护且 TypeScript 适配明确”的短名单门槛。[npm metadata](https://registry.npmjs.org/json-logic-js/latest)、[仓库 metadata](https://api.github.com/repos/jwadhams/json-logic-js)

### 5.2 推荐结论

#### 已验证事实

没有候选同时提供：

- ChoiceMind 的 Claim/Evidence 双向闭包；
- 支持、反驳、冲突和不足的唯一派生；
- Hard Constraint 的 `SATISFIED / VIOLATED / INDETERMINATE`；
- Risk 仅属于被选 Candidate；
- Elimination 必须由违反 Hard Constraint 的同一依据支撑；
- 成功 Decision 缺少依据时失败关闭。

#### 基于证据的推断

把上述规则放进 JSON Rule DSL 仍需 ChoiceMind 自己定义全部领域词汇、输入投影、错误路径、规则版本和结果闭包，代码不会减少，反而多出规则 Schema、解释器和调试面。通用 Graph/RDF 库只替换当前少量 `Map`，不能替换判定算法。

#### 尚未验证建议

运行时只保留一个小型确定性内部 Module；继续用 Zod，单独原型验证 `fast-check`。这是本研究的最小采用范围。

## 6. 建议的数据模型

以下均为 **尚未验证建议**，字段名需要产品负责人确认。示意类型只表达边界，不是待粘贴实现：

```ts
type ClaimKind = "FACT_ASSERTION" | "SOURCE_OPINION" | "SYSTEM_INFERENCE";

type Claim = Readonly<{
  claimId: string;
  kind: ClaimKind;
  subject: ClaimSubject;
  predicate: string;
  value: ClaimValue;
  premiseClaimIds?: readonly string[];
}>;

type Evidence = Readonly<{
  evidenceId: string;
  source: EvidenceSource;
  locator: EvidenceLocator;
  excerpt: string;
  capturedAt: string;
  validUntil: string;
}>;

type ClaimEvidenceLink = Readonly<{
  linkId: string;
  claimId: string;
  evidenceId: string;
  direction: "SUPPORTS" | "REFUTES";
}>;

type EvidenceState = "SUPPORTED" | "REFUTED" | "CONFLICTED" | "INSUFFICIENT";

type ClaimAssessment = Readonly<{
  claimId: string;
  state: EvidenceState;
  supportingEvidenceIds: readonly string[];
  refutingEvidenceIds: readonly string[];
}>;
```

### 6.1 两个轴的映射

| V1.2 现有词 | 建议归属 | 用户可见含义 |
|---|---|---|
| `VERIFIED_FACT` | 派生展示标签，不是 ClaimKind | `FACT_ASSERTION + SUPPORTED` 且通过来源/时效/适用范围策略 |
| `SOURCE_OPINION` | `ClaimKind` | 来源确实表达了该观点；不表示观点已成为普遍事实 |
| `SYSTEM_INFERENCE` | `ClaimKind` | 系统基于 `premiseClaimIds` 和明确规则派生；不能伪装成原始来源事实 |
| `CONFLICTED` | `EvidenceState` | 同一 Claim 同时存在合格的支持和反驳依据 |
| `UNKNOWN` | 对外展示词 | 内部使用更精确的 `INSUFFICIENT`：当前无足够合格依据 |

### 6.2 权威边界

- Runtime 可以提出 Claim、Evidence 和 Link，但不能提交权威 `EvidenceState`。
- `DecisionBasis` 在严格 Schema 通过后构建不可变图并派生 `ClaimAssessment`。
- 如果最终 Result 需要向 Web 暴露 Assessment，应由 decoder 返回派生视图，或把它作为带 `algorithmVersion + inputDigest` 的可校验投影；不得把 Runtime 提交的 Assessment 原样透传。
- 图结构非法（重复 ID、断链、跨 Task、Evidence 反向关系错误）不是 `INSUFFICIENT`，而是 `CONTRACT_INVALID`。未知事实和坏合同必须分开。
- P0-03 不做多数投票或数值置信度；五条转载支持不能覆盖一条有效反证。来源独立簇和置信策略留在后续 Evidence Policy，不改变四格状态的基本含义。

### 6.3 P0 最小范围

- 每个 Claim 保持原子化；P0 中每条合格 Evidence Link 可独立构成支持或反驳输入。
- 不在 P0 引入通用复合 Evidence Set。以后出现“多片段缺一不可”的真实样本时，再采用 FEVER 的“组内 AND、组间 OR”结构，不用隐含数组顺序表达。
- `SYSTEM_INFERENCE` 在没有明确 premise 与 derivation 规则前，不能作为 Hard Constraint、Elimination 或 Decision Risk 的决定性依据。

## 7. 唯一派生算法与真值表

以下为 **尚未验证建议**。

### 7.1 先筛选合格关系

对一个 Claim，只读取通过以下门禁的 `ClaimEvidenceLink`：

1. Claim、Evidence、Link ID 唯一且属于同一 Decision Task；
2. Link 两端存在；
3. Evidence 的来源、定位和正文满足 Schema；
4. Evidence 未超过 `validUntil`，且适用于当前 Candidate/SKU/市场；
5. P0 Synthetic Evidence 明确标识，不能混入真实 Decision。

任一结构门禁失败时停止语义计算并返回合同问题，不用剩余“好数据”继续认证 Decision。

### 7.2 两比特派生

```text
hasSupport = 存在至少一条合格 SUPPORTS Link
hasRefute  = 存在至少一条合格 REFUTES Link

EvidenceState = table[hasSupport][hasRefute]
```

| `hasSupport` | `hasRefute` | 唯一 `EvidenceState` | 语义 |
|---:|---:|---|---|
| false | false | `INSUFFICIENT` | 当前没有足够证据；不是反驳 |
| true | false | `SUPPORTED` | 当前合格证据只支持该 Claim |
| false | true | `REFUTED` | 当前合格证据只反驳该 Claim |
| true | true | `CONFLICTED` | 支持与反驳并存，必须同时保留两侧 Evidence |

该算法不读取 Runtime 状态，不依赖数组顺序，不按 Evidence 数量投票，并同时返回双方 Evidence ID 以供证据链展示。

### 7.3 同一派生结果的消费者规则

| 消费者 | `SUPPORTED` | `REFUTED` | `CONFLICTED` | `INSUFFICIENT` |
|---|---|---|---|---|
| Hard Constraint | 可以按 Claim value 形成 `SATISFIED` 或 `VIOLATED` | 该 Claim 自身不能证明相反 value；形成 `INDETERMINATE`，除非存在另一个明确的反命题 Claim | `INDETERMINATE` | `INDETERMINATE` |
| Elimination | 只能消费同一 `ConstraintAssessment=VIOLATED` 的依据 | 禁止直接淘汰 | 禁止直接淘汰 | 禁止直接淘汰 |
| Decision Risk | 仅可把被选 Candidate 的、语义为负面/限制的 Supported Claim 作为 Risk statement | 禁止认证 Risk statement | 禁止认证 Risk statement | 禁止认证 Risk statement |
| Decision Evidence | 收录实际被 Constraint/Risk/Elimination 消费的 Evidence | 仅在解释反证或未知时展示，不能伪装成支持依据 | 两侧都收录并显式展示冲突 | 展示缺口，不生成当前事实断言 |

成功 Result 的处理规则必须区分两个阶段：

- Decision Engine 在生成结果前遇到可回答的冲突/不足，应产生 `NEED_MORE_INFO` 和结构化 Gap/下一步。
- Runtime 已提交 `BUY_IF_PRICE`，但任何决定性 Risk/Constraint/Elimination Basis 不是允许状态时，公开 decoder 必须拒绝；Executor 失败关闭且不得返回 bundle。Decoder 不应静默改写 Runtime 结论。

## 8. 迁移方案

以下为 **尚未验证建议**。由于 P0-03 的 v1 尚未发布，建议一次严格迁移，不保留双读或兼容 shim：

1. **先确认语义 ADR**：确认 `ClaimKind`、四态 `EvidenceState`、冲突失败关闭和 Runtime 无权写 Assessment。
2. **先写公开 Seam 红灯**：通过 `decodeDecisionTaskResultV1` 复现 Runtime 自报 `SUPPORTED` 但证据为双向时仍 `ok=true`；通过 `DecisionTaskExecutor.execute` 复现伪成功 bundle。
3. **迁移合同**：从 Claim 删除 `status`；增加 `kind`；把 Evidence 内容与 Claim-Evidence Link 分开。strict Schema 拒绝旧 `status` 和旧内嵌关系，避免双语义长期共存。
4. **建立唯一派生入口**：`DecisionBasis` 一次构图，产生 `ClaimAssessment` 与 `ConstraintAssessment`；删除 Risk、Constraint、Elimination 中各自扫描 Evidence 的实现。
5. **迁移消费者**：Risk、Hard Constraint、Elimination、Decision Evidence Closure 只接收派生 Assessment；不提供绕过入口。
6. **迁移 Synthetic Runtime 与 Web**：fixture 只输出原始 Claim/Evidence/Link；Web 同时显示 ClaimKind、EvidenceState 和支持/反驳两侧依据。
7. **同步规格和状态文档**：V1.2 把五项混合枚举拆成两轴；同步 ADR、P0-03 规格、Codebase Design 和 handoff，避免文档再次成为互斥基线。
8. **完整验证后再复审**：先跑合同/Executor/Web 定向测试，再跑根级 `pnpm verify`；真实四进程冒烟只验证 wire/展示未回归，不替代语义性质测试。

### 明确不做

- 不引入数据库迁移、RDF store、SPARQL、JSON-LD 或 AIF 服务。
- 不引入可配置规则后台、规则 DSL 或规则热更新。
- 不使用 LLM/NLI 输出直接决定 `EvidenceState`；模型只能生成候选关系，确定性合同负责失败关闭。
- 不在该迁移中实现 Preference/Fit/TCO、新 Decision 状态或真实采集策略。
- 不顺手重构无关错误映射、HTTP Adapter 或 UI 样式。

## 9. TDD 与性质测试门禁

### 9.1 示例测试

至少覆盖四格真值表的四个组合，以及：

- Runtime 继续提交旧 `status` 时 strict Schema 拒绝；
- Risk Claim 同时有 `SUPPORTS` 与 `REFUTES` 时，成功 Result 被拒绝；
- Constraint、Elimination 和 Risk 对同一 ClaimAssessment 不再出现不同判定；
- 冲突两侧 Evidence 都进入用户可展开的证据链；
- 图断链/重复 ID 返回 `CONTRACT_INVALID`，不能降级为 `INSUFFICIENT`；
- Executor 对畸形 Runtime 产物返回 `FAILED` 且无 bundle。

### 9.2 `fast-check` 有界原型

先在单独测试文件做一个小原型；只有可读性、运行时间和 shrink 后的反例都满足项目门禁，才加入 devDependency。性质应通过公开 decoder/Executor Seam 验证，不测试私有 `Map` 或 helper：

1. **全组合性**：任意 `hasSupport / hasRefute` 组合只映射到真值表中的唯一状态。
2. **排列不变性**：Claim、Evidence、Link 数组重新排序不改变是否接受及派生状态。
3. **冲突单调性**：`SUPPORTED + 任一合格 REFUTES -> CONFLICTED`；`REFUTED + 任一合格 SUPPORTS -> CONFLICTED`。
4. **无关证据不变性**：增加属于其他 Claim/Candidate 的合法 Evidence 不改变当前 ClaimAssessment。
5. **过期证据不变性**：增加过期或不适用 Evidence 不能把 `INSUFFICIENT` 提升为 `SUPPORTED`。
6. **失败关闭**：任意被 Decision 消费的 ClaimAssessment 不满足消费者规则时，不可能得到成功 bundle。
7. **双向闭包**：删除任一 Link 端点、跨 Task 或制造重复 ID，必须失败而不是使用 Map 的后写值。

官方 `fast-check` 将自身定位为 TypeScript 编写的 JavaScript 性质测试框架，支持生成、shrinking 和 model-based testing；这正适合验证组合不变量，但不能替代固定业务示例和真实纵向冒烟。[官方仓库](https://github.com/dubzzz/fast-check)、[官方文档](https://fast-check.dev/)

## 10. 风险与产品确认结果

### 已验证风险

- 当前 Risk 与 Constraint 对同一 Evidence Graph 的解释已经不同；继续逐点补条件会扩大漂移面。
- V1.2 的 Claim 枚举混合两种数据含义；不先拆轴，Schema 无法表达真实不变量。
- 通用规则/图/RDF 候选都不拥有 ChoiceMind 决策语义；引入后仍需项目自行实现核心算法。

### 产品确认结果（2026-08-14）

1. **已确认：**把 V1.2 的混合枚举拆成 `ClaimKind = FACT_ASSERTION | SOURCE_OPINION | SYSTEM_INFERENCE` 与派生 `EvidenceState = SUPPORTED | REFUTED | CONFLICTED | INSUFFICIENT`。
2. **已确认：**Runtime 无权写权威 Evidence State；所有 Decision 消费者只能读取 Decision Basis 的派生 Assessment。
3. **已确认：**`BUY_NOW`、`BUY_IF_PRICE`、`WAIT`、`KEEP_CURRENT` 与 `NO_MATCH` 不得依赖 `CONFLICTED` 或 `INSUFFICIENT` Claim；排除该依据后无法重新决策时改走 `NEED_MORE_INFO`。请求级安全拒绝 `REFUSE_RISK` 不依赖商品 Claim，不受该门禁限制。
4. **已确认：**未发布 v1 直接严格迁移，不保留旧 `Claim.status` 双读兼容。
5. **已确认：**生产 Runtime 不引入规则引擎、RDF 或通用图依赖；后续 TDD 只把 `fast-check` 作为开发期性质测试候选，安装仍需单独授权。
6. **已确认：**P0-03 的 Hard Constraint 满足/违反判定、Elimination 和最终选择只能依赖 `FACT_ASSERTION + SUPPORTED`；`SOURCE_OPINION` 与 `SYSTEM_INFERENCE` 可保存和展示，但在来源聚类与样本范围、推断前提具备明确合同前，不得单独决定选择或淘汰。
7. **已确认：**最终版本化 Result 携带 Decision Basis 生成的规范化 `ClaimAssessment`；Runtime 不提交权威 Assessment，所有跨进程解码入口都根据 Claim、Evidence 及其关系重新派生并精确核验，不一致时返回 `CONTRACT_INVALID`，Web 只读取而不自行计算。
8. **已确认：**用独立 `ClaimEvidenceLink` 作为 Claim 与 Evidence 关系及方向的唯一权威；删除 `Claim.evidenceIds` 和 `Evidence.claimId`、`Evidence.direction`，不保留双向副本。同一 Evidence 可通过不同 Link 关联多个 Claim。
9. **已确认：**同一 `claimId + evidenceId` 组合至多一条 Link；重复或相反方向 Link 返回 `CONTRACT_INVALID`。复合片段由上游拆分 Evidence 或细化 Claim，合同不通过自由文本推断方向。
10. **已确认：**无 Link 的 Claim 合法并派生 `INSUFFICIENT`；每份 Evidence 至少关联一个 Claim，Link 两端必须存在且同属一个 Decision Task。孤立 Evidence、断链或跨 Task Link 返回 `CONTRACT_INVALID`，不与 Evidence Gap 混淆。
11. **已确认：**Evidence Eligibility 固定按 `Decision.validFrom` 计算；当时已过期的 Evidence 保留追溯但不参与 Assessment，历史回看不得使用当前时间改写状态，Decision 是否已过期由界面单独提示。
12. **已确认：**`Evidence.capturedAt > Decision.validFrom` 或 `Evidence.validUntil < Evidence.capturedAt` 属于因果时间错误并返回 `CONTRACT_INVALID`；最终生成器必须在证据采集完成后确定 `Decision.validFrom`。

上述决定由 [ADR-0006](../adr/0006-decision-basis-owns-evidence-state.md) 记录；确认不等于已修改代码或通过 P0-03 验收。

## 11. 研究结论

ChoiceMind 不缺一个更大的框架，缺的是一条不可绕过的权威语义路径：

```text
Claim（命题与类型）
  + Evidence（来源与定位）
  + ClaimEvidenceLink（SUPPORTS / REFUTES）
  -> DecisionBasis 唯一派生 ClaimAssessment
  -> Constraint / Risk / Elimination 统一消费
  -> Decision 成功或失败关闭
```

这条路径与 FEVER/SciFact 的“命题—证据—判定分离”、PROV/Web Annotation 的“来源—定位分离”和 AIF 的“命题—关系分离”一致，同时保持 P0-03、一人全栈和现有 TypeScript/Zod 栈所需的最小复杂度。
