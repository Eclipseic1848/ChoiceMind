# P0-03 首个 Decision：Codebase Design

## 1. 状态与范围

- 状态：既有同步 Interface、幂等重试和 Constraint/Critical Gap 设计仍有效；Candidate Disposition 与 Decision Risk 的旧设计已由已接受的证据绑定合同提案、ADR-0004 和 DecisionBasis Module 设计替代，相关受控 TDD 实现已经完成。P0-03 是否最终闭环仍以独立复审、产品验收和发布门禁为准。
- 对应 Issue：<https://github.com/Eclipseic1848/ChoiceMind/issues/3>。
- 领域合同：[`../specs/p0-03-decision-contract-v1.md`](../specs/p0-03-decision-contract-v1.md)。
- 最新领域决定：[`p0-03-evidence-bound-decision-contract-proposal.md`](p0-03-evidence-bound-decision-contract-proposal.md)，已由产品负责人确认。
- 最新 Implementation 设计：[`p0-03-decision-basis-module-design.md`](p0-03-decision-basis-module-design.md)；它不改变本文件的 HTTP、Runtime Seam 或同步执行 Interface。
- 分支基线：`p0-03-first-decision`，基于合并提交 `53a972b042bb48473c0f697de51186ca85fc1651`。

本文件冻结 Module、Interface、Seam、Adapter、依赖方向、公开交互语义和测试表面；后续 TDD 实现不得改变这些含义。它不选择生产 Agent Runtime，也不引入数据库、队列、SSE 或真实模型。

## 2. 事实、推断与建议

### 2.1 初始设计时的已验证事实（历史快照）

- Web、API、Orchestrator 是三个独立 Node 进程；Data Worker 与 P0-03 无业务调用关系。
- API 和 Orchestrator 当前都使用 Fastify，只有健康路由，没有 Decision 代码。
- `pnpm-workspace.yaml` 已包含 `packages/*`，但当前不存在共享 package。
- Issue #3 要求 Web → API → Orchestrator → Fake Runtime 的真实纵向链路，并要求每个跨进程边界校验合同版本和结构。
- ADR-0001 已确定 ChoiceMind 持有框架中立的 Agent Runtime 合同；Runtime Adapter 不能改变 Decision、Evidence 或错误语义。
- 生产 Runtime 研究仍暂停；P0-03 只允许 Fake Adapter 作为确定性合同替身。

### 2.2 基于代码和合同的推断

- API → Orchestrator 是“远程但自有”依赖：需要一个 Port，HTTP 与内存实现作为两个 Adapter。
- Orchestrator → Agent Runtime 是独立 Seam：P0-03 使用 Fake Adapter，未来优先用薄 CoreMind Adapter。
- 没有权威持久化时返回任务句柄会暗示不存在的后台存活、查询和恢复能力。
- Web 若要展示 Evidence，成功结果必须携带一份完整的、经校验的 Decision Bundle，不能只返回 `decisionRevisionId`。
- Runtime 产物不能直接成为对外结果；Orchestrator 必须验证引用图、RunEvent 顺序和终态不变量后才能形成 Decision Task Result。

### 2.3 已确认并实装的设计决定

- P0-03 采用同步执行、任务语义的单一入口。
- 共享合同使用独立 `@choicemind/contracts` Module；内部采用固定版本 Zod 4 Schema 作为运行时校验与 TypeScript 类型的单一来源，但不向调用方暴露 Zod 类型或原生错误对象。
- API 对无法确认 Orchestrator 执行结果的情况使用 `SAME_EXECUTION_ONLY` 语义。
- Constraint Assessment 由 Decision Contract Module 从 Requirement、Claim 和 Evidence 内部派生，Runtime 不提供可写的满足标记。
- `nextSteps` 在未发布的 v1 内直接采用结构化判别联合，不兼容旧字符串数组。
- 核心只比较相同 predicate、值类型和单位的规范化值，不解析展示文案，也不做单位换算。

## 3. Design It Twice 比较

### 3.1 方案 A：最小同步 Interface

```ts
interface DecisionOrchestratorPort {
  execute(command: ExecuteDecisionTaskCommandV1): Promise<DecisionTaskResultV1>;
}
```

Web 调用一个同步 HTTP action，API 调用一个 Orchestrator Port，Orchestrator 调用一个 Runtime `run` Interface，最终一次返回完整结果和 RunEvent。

- **Depth**：高。一个 `execute` 隐藏版本校验、任务状态、Runtime、引用图和错误映射。
- **Locality**：高。Decision 不变量集中在 Orchestrator 的 Decision Task Executor。
- **Leverage**：高。API、测试和未来调用方只理解一个判别联合结果。
- 缺点：请求期间占用连接；本期没有实时 RunEvent。

### 3.2 方案 B：立即采用任务创建、查询和事件 Interface

```ts
interface DecisionTaskPort {
  create(command: CreateDecisionTaskCommandV1): Promise<DecisionTaskHandleV1>;
  get(query: GetDecisionTaskQueryV1): Promise<DecisionTaskSnapshotV1>;
  stream(query: StreamDecisionTaskQueryV1): AsyncIterable<RunEventV1>;
}
```

该方案表面接近 P1 的后台任务，但 P0-03 没有数据库、队列或恢复机制，只能依赖进程内 Map。

- **Depth**：低。调用方需要学习创建、轮询、事件和丢失语义。
- **Locality**：差。临时状态会散在 API、Orchestrator 和 Web。
- **Leverage**：低。增加三个入口却没有提供耐久执行能力。
- 风险：刷新、重启或多实例后句柄不可用，会制造伪耐久语义。

结论：P0-03 拒绝。

### 3.3 方案 C：同步默认入口，未来内部 submit + wait

当前外部 Interface 与方案 A 相同；P1 引入权威存储后，可以新增真正的任务创建、查询和事件 Module。当前 `execute` 可以保留为 Quick/测试入口，也可以在内部通过持久任务的 submit + wait 实现。

- **Depth**：当前与方案 A 相同。
- **Locality**：未来耐久任务知识进入新 Module，不污染现有调用方。
- **Leverage**：当前调用最简单，同时不阻止未来后台任务。
- 缺点：未来会存在同步执行和后台任务两种明确的用户体验，必须由产品策略决定何时使用。

结论：推荐采用方案 C 的演进策略，并在 P0-03 只实现方案 A 的最小同步形态。

## 4. 推荐的 Module 与 Seam

| Module | Interface | 隐藏的 Implementation | Seam / Adapter |
| --- | --- | --- | --- |
| Decision Contract v1 | 命令/结果解码器、只读类型和错误结果工厂 | Zod Schema、严格字段规则、版本错误、字段问题路径、引用闭包、Constraint Assessment、Decision 语义闭包和终态不变量 | 进程内共享 Module；不是网络 Adapter |
| API Decision Execution | HTTP action + `DecisionOrchestratorPort.execute` | 请求/响应解码、HTTP 状态映射、传输错误清洗 | API → Orchestrator Seam；HTTP 与内存 Adapter |
| Decision Task Executor | `execute(command)` | Decision Task/Agent Run 生命周期、Runtime 调用、引用图、状态机、终态和错误不变量 | Orchestrator 内部深 Module |
| Agent Runtime | `run(command)` 的窄消费 Interface | 模型循环、工具调用、原生事件和框架错误映射 | Runtime Seam；P0 Fake、未来薄 CoreMind Adapter |
| Web Decision Flow | 提交合成需求并渲染 Result | 表单状态、成功/失败互斥渲染、合成数据提示 | 只调用 API，不接触 Orchestrator 或 Runtime |

删除 Decision Contract v1 会让版本和数据校验散到三个进程；删除 Decision Task Executor 会让状态、引用和伪成功门禁散到路由、Runtime 和 Web。二者都能通过删除测试，属于有实际 Depth 的 Module。

HTTP Adapter 和 Fake Runtime Adapter 可以较浅，因为 Adapter 的价值是占据 Seam、隔离传输或框架知识，不以自身业务深度衡量。

## 5. 依赖方向

```text
apps/web
  └─ @choicemind/contracts
       └─ HTTP → apps/api

apps/api
  ├─ @choicemind/contracts
  └─ DecisionOrchestratorPort
       ├─ HttpDecisionOrchestratorAdapter → HTTP → apps/orchestrator
       └─ InMemoryDecisionOrchestratorAdapter（测试）

apps/orchestrator
  ├─ @choicemind/contracts
  ├─ DecisionTaskExecutor
  └─ AgentRuntimeRunPort
       ├─ FakeAgentRuntimeAdapter（P0-03）
       └─ CoreMindAgentRuntimeAdapter（未来，尚未实现）
```

禁止的依赖：

- `@choicemind/contracts` 依赖 Fastify、fetch、React、Orchestrator 或 Runtime。
- Web 直接调用 Orchestrator。
- API 了解 Fake 或 CoreMind 类型。
- Runtime Adapter 直接形成对外成功结果或绕过 Decision Task Executor。
- `core` 或合同按 `category` 写笔记本分支；笔记本只存在于 Orchestrator 私有 fixture。

## 6. 推荐 Interface

### 6.1 公开同步 action

建议路由：

```text
POST /api/v1/decision-tasks:execute
```

请求：

```ts
type ExecuteDecisionTaskCommandV1 = {
  contractType: "execute-decision-task-command";
  contractVersion: "1.0";
  executionRequestId: string;
  requirementRevision: RequirementRevisionV1;
};
```

`executionRequestId` 由 Web 在用户每次明确提交时生成，同一次提交的网络重试必须复用原值。该 action 明确表达“一次同步执行”，不暗示存在可查询、可恢复的持久任务资源。未来真正的后台任务建议使用独立的 `POST /api/v1/decision-tasks`。

同一次显式提交使用同一组 Execution Request、Decision Task 和 Requirement Revision 身份；不同显式提交必须生成新身份。Orchestrator 以 `executionRequestId` 形成任务级唯一且可重放的 Agent Run ID，Fake Runtime 以 Decision Task ID 形成任务级唯一 Decision Revision ID。确定性比较排除这些实例 ID 后验证业务内容，不允许不同任务共享同一 Run 或 Decision Revision ID。

### 6.2 API → Orchestrator Port

```ts
interface DecisionOrchestratorPort {
  execute(command: ExecuteDecisionTaskCommandV1): Promise<DecisionTaskResultV1>;
}
```

生产 Adapter：

```text
HttpDecisionOrchestratorAdapter
  → POST /internal/v1/decision-tasks:execute
```

测试 Adapter：

```text
InMemoryDecisionOrchestratorAdapter
  → 直接调用 DecisionTaskExecutor.execute
```

API 在接收 Web 请求时校验一次，在发送到 Orchestrator 前只使用已解码值；Orchestrator 入站时再次独立校验。Orchestrator 出站和 API 入站也分别校验，不信任网络另一端已经正确处理。

### 6.3 Decision Task Executor

```ts
interface DecisionTaskExecutor {
  execute(command: ExecuteDecisionTaskCommandV1): Promise<DecisionTaskResultV1>;
}
```

调用顺序是 Interface 的一部分：

1. 接受已经通过入站 Schema 的命令，但仍执行领域不变量检查。
2. 以 `executionRequestId` 和规范化命令摘要查询进程内执行回执。
3. 同 ID、同摘要命中时等待同一执行或返回原结果；同 ID、不同摘要时以 `CONTRACT_INVALID` 拒绝，不能复用旧结果。
4. 未命中时先登记执行中回执，再建立 `CREATED` Decision Task 和 Agent Run。
5. 调用注入的 Runtime `run` Interface。
6. 校验 Runtime 产物、RunEvent 序号和状态迁移。
7. 校验 Requirement、Candidate、Claim、Evidence、Decision、RunEvent 和 Task Status 的同任务引用闭包与反向引用。
8. 从 Requirement、Claim 和 Evidence 派生 Constraint Assessment，并校验 Synthetic Evidence、Decision Condition、Candidate Disposition、Critical Gap resolution、Decision Risk、结构化 next step，以及 Requirement 与 Decision 之间的预算和 Hard Constraint 语义闭包。
9. 形成并再次解码 Decision Task Result，将终态结果写入执行回执。
10. 只返回成功或失败判别联合，不抛出框架私有错误。

进程内回执只提供 P0-03 进程存活期间的并发合并与结果重放，不提供任务查询、跨重启恢复或多实例一致性。未来持久化回执必须保持同一公开 `executionRequestId` 语义。

### 6.4 Runtime 消费 Interface

现有架构文档定义完整 `AgentRuntimePort`。P0-03 Executor 只消费它的 `run` 能力，不要求 Fake 实现尚未进入本期的空壳方法：

```ts
type AgentRuntimeRunPort = Pick<AgentRuntimePort, "run">;
```

`run` 输入只携带合同版本、Decision Task ID、Agent Run ID 和 Requirement Revision。Runtime 选择只能发生在 Orchestrator 组合根；Web 和 API 不能指定 `fake`、`coremind` 或其他 Adapter。

Fake 故障通过测试构造时注入失败型 Adapter，不通过 HTTP 字段、Header、查询参数或环境开关暴露给用户。

### 6.5 Decision 语义闭包

公开 Interface 保持为 `decodeDecisionTaskResultV1(input)`；Constraint Assessment 和语义闭包只属于 Decision Contract Module 的私有 Implementation：

```text
checkDecisionTaskResultInvariants
  └─ checkDecisionSemanticClosureV1
       ├─ assessCandidateConstraint
       ├─ validateSelectedCandidate
       ├─ validateCandidateDispositions
       ├─ validateConditions
       ├─ validateCriticalGaps
       ├─ validateRisks
       └─ validateNextSteps
```

内部命名可以在 TDD 中按现有代码风格收敛，但不得增加新的公开 Interface。测试只通过公开解码 Interface 观察以下行为：

- 被选 Candidate 对每项 must-have 都有 `SATISFIED` Assessment；
- `ELIMINATED` Disposition 的 Requirement、Claim、Evidence 和 Candidate 语义一致；`NOT_SELECTED` Disposition 只用于满足 Hard Constraint 但综合未入选的 Candidate；
- Condition 只属于被选 Candidate，`MAX_PRICE` 不突破已确认硬预算；
- `BUY_IF_PRICE` Critical Gap 由 Condition 与核验步骤闭合；`NEED_MORE_INFO` Critical Gap 由同 key 的 `PROVIDE_REQUIREMENT` next step 闭合；
- Decision Risk 只属于被选 Candidate；`NEED_MORE_INFO` 无选择、至少一个明确 Gap，且不携带 Disposition 或 Risk；
- Condition 与 Risk 由结构化 next step 引用，不依赖用户文案。

本期不创建 `CategoryConstraintEvaluatorPort`。Category Package 在进入核心前规范化 predicate、数值和单位；P0-03 只做相同单位的通用数值比较。没有第二个真实 Adapter 时增加 Port 会形成假想 Seam。

## 7. Result 形状

### 7.1 成功

```ts
type SuccessfulDecisionTaskResultV1 = {
  contractType: "decision-task-result";
  contractVersion: "1.0";
  ok: true;
  taskStatus: CompletedDecisionTaskStatusV1;
  runEvents: readonly RunEventV1[];
  bundle: {
    requirementRevision: RequirementRevisionV1;
    candidates: readonly CandidateV1[];
    claims: readonly ClaimV1[];
    evidence: readonly EvidenceV1[];
    decision: DecisionRevisionV1;
  };
};
```

`NEED_MORE_INFO` 仍属于成功形成的 Decision，因此使用 `HTTP 200 + ok=true + COMPLETED`。

### 7.2 已创建任务失败

```ts
type FailedDecisionTaskResultV1 = {
  contractType: "decision-task-result";
  contractVersion: "1.0";
  ok: false;
  taskStatus: FailedDecisionTaskStatusV1;
  runEvents: readonly RunEventV1[];
  error: ChoiceMindErrorV1;
};
```

明确禁止 `bundle` 和 `decision`。

### 7.3 运行前拒绝

```ts
type RejectedDecisionTaskResultV1 = {
  contractType: "decision-task-result";
  contractVersion: "1.0";
  ok: false;
  error: ChoiceMindErrorV1;
};
```

明确禁止伪造 Decision Task ID、Task Status、RunEvent 或 Decision。

每个嵌套领域文档保留自己的合同头，由 Result Schema 递归校验。

## 8. HTTP 语义

| 场景 | HTTP | 结果语义 |
| --- | --- | --- |
| `BUY_IF_PRICE` 等正常 Decision | 200 | `ok=true + COMPLETED + bundle` |
| `NEED_MORE_INFO` | 200 | `ok=true + COMPLETED + bundle.decision.status=NEED_MORE_INFO` |
| 字段或不变量非法 | 400 | `ok=false + CONTRACT_INVALID`，无任务 |
| 合同版本缺失或不支持 | 422 | `ok=false + CONTRACT_VERSION_UNSUPPORTED`，无任务 |
| Fake Runtime 失败 | 502 | `ok=false + FAILED + FAKE_RUNTIME_FAILED`，无 bundle |
| 无法确认 Orchestrator 是否接受或完成请求 | 503 | `ok=false + DECISION_EXECUTION_STATUS_UNKNOWN`，无 Decision；只能复用同一 `executionRequestId` 重试 |

最后一行不能被伪装成 `FAKE_RUNTIME_FAILED`，也不能声称任务一定没有创建。已确认新增：

```text
code=DECISION_EXECUTION_STATUS_UNKNOWN
category=TRANSPORT
retryMode=SAME_EXECUTION_ONLY
```

API 可以在有界次数内复用原 `executionRequestId` 自动重试；不得生成新 ID 自动重放。若仍无法取得回执，则前端明确显示“本次执行状态暂时无法确认”。P0-03 的进程内回执在 Orchestrator 重启后会丢失；因为本期只有无外部副作用的确定性 Fake Runtime，可以重新执行，但不能据此宣称已经具备生产级幂等或恢复能力。

## 9. 推荐目录

只在实现时按需创建实际使用的文件：

```text
packages/contracts/
  package.json
  tsconfig.json
  src/decision/v1/
    schemas.ts
    invariants.ts
    errors.ts
    index.ts

apps/api/src/decision-tasks/
  orchestrator-port.ts
  http-orchestrator-adapter.ts
  routes.ts

apps/orchestrator/src/decision-tasks/
  executor.ts
  routes.ts

apps/orchestrator/src/runtime/
  port.ts
  fake-agent-runtime-adapter.ts
  synthetic-laptop-fixture.ts
```

不创建空 Repository、Queue、Event Bus、Category Package、CoreMind Adapter、Data Worker handler 或数据库目录。

Web 在现有 `src/app` 下增加一个最小合成需求提交与结果渲染流，不提前搭建通用聊天 UI。

## 10. 组合根

- `buildApiApp` 接受 `DecisionOrchestratorPort`，测试注入内存 Adapter，`server.ts` 注入 HTTP Adapter。
- `buildOrchestratorApp` 接受 `AgentRuntimeRunPort`，测试可以注入成功或失败 Fake。
- P0-03 的 `server.ts` 只组合确定性 Fake Adapter；这是合成演示运行方式，不是生产默认 Runtime。
- 未来启用 CoreMind 时，只修改 Orchestrator 组合根和薄 Adapter，不修改 Web、API、Decision Contract 或 Decision Task Executor。

## 11. 测试表面

Interface 就是测试表面，不跨过去断言内部函数或 Zod 实例：

### 11.1 Decision Contract v1

- 每种文档的正例和反例。
- 缺少/不支持版本。
- 嵌套文档独立版本。
- Result 三种判别联合互斥。
- 金额整数、单位、枚举和严格未知字段。
- `nextSteps` 只接受结构化判别联合，拒绝旧字符串数组和失效目标引用。
- must-have key 唯一；Constraint Assessment 不解析 Candidate 展示文案或换算单位。

### 11.2 Decision Task Executor

- 固定正例重放两次，规范化 bundle 和 RunEvent 完全一致。
- `NEED_MORE_INFO` 是成功 Decision；它尚未形成最终取舍，必须无被选 Candidate、至少有一个明确 Gap 及同 key 补充步骤，Candidate 可以暂时没有 Disposition。
- 预算缺失、未确认或属于关键 Unknown 时，`NEED_MORE_INFO` 保留预算 Critical Gap 与补充步骤，并且不携带 Decision Risk。
- 被选 Candidate 的观测价格不得超过已确认硬预算，即使 Runtime 同时提出更低的未来价格条件。
- 被选 Candidate 的 must-have Claim/Evidence 必须以相同 predicate、值类型和单位证明满足；64 GiB 需求不能选择 32 GiB Candidate。
- Decision Condition 只能指向被选 Candidate，`MAX_PRICE` 不得超过已确认硬预算。
- `ELIMINATED` 只能引用真实 must-have 或预算，并由该 Candidate 的 Claim/Evidence 证明违反；`NOT_SELECTED` 的 Candidate 必须满足 Hard Constraint，且 Evidence 属于该 Candidate。
- 最终取舍的每个未选 Candidate 恰有一条 Candidate Disposition，被选 Candidate 与 `NEED_MORE_INFO` Candidate 没有 Disposition。
- `BUY_IF_PRICE` 的每个 Critical Gap 必须映射到被选 Candidate 的 Condition 和核验 next step。
- Decision Risk 只能关联被选 Candidate。
- 预算未知时必须存在 `PROVIDE_REQUIREMENT + budget.maxAmountMinor`，无关 next step 不能替代。
- Candidate B 有 Hard Constraint Elimination Record。
- Decision → Evidence → Claim → Candidate 引用闭合。
- 同一结果内 Candidate、Claim、Evidence 和 RunEvent ID 各自唯一。
- Requirement、Candidate、Claim、Evidence、Decision 和 RunEvent 均属于 Task Status 指向的同一任务。
- RunEvent 序号严格递增，末事件类型、Task/Run 身份、Task Status 序号/时间以及 Decision/Error 指针一致。
- Fake Runtime 失败时 Decision 数量为 0。
- Runtime 返回空事件或畸形引用时形成结构化 `FAILED`，不抛出私有异常。

### 11.3 API 与 Orchestrator Seam

- API 配内存 Adapter 的路由测试。
- HTTP Adapter 对真实 Fastify Orchestrator 的合同测试。
- API 与 Orchestrator 各自拒绝非法请求和错误版本。
- API 拒绝 Orchestrator 的畸形或错误版本响应。
- 同一 `executionRequestId` 的并发请求只调用 Runtime 一次并取得同一结果。
- 同一 `executionRequestId` 携带不同规范化命令时拒绝，且不调用第二次 Runtime。
- Orchestrator 响应状态无法确认时只复用同一 ID 重试；最终失败返回 `SAME_EXECUTION_ONLY` 且无 Decision。

### 11.4 Web

- 用户能提交只读的固定合成需求，页面明确说明 P0 不解析任意自然语言需求。
- 显示 `BUY_IF_PRICE`、两个 Decision Condition、淘汰记录、板载内存风险、Synthetic Evidence 和 7 天有效期。
- 显示合成数据提示。
- API 失败时不显示旧 Decision 或成功状态。
- 浏览器独立解码完整 Result，并按共享冻结映射校验精确 HTTP 状态；畸形 JSON、错误版本、状态不一致或网络异常均显示状态未知。

### 11.5 真实纵向链路

- Windows 启动 Web、API、Orchestrator 和 Data Worker。
- Web → API → HTTP Adapter → Orchestrator → Fake Runtime → 完整 Result → Web。
- Data Worker 仅维持健康，不参与本期 Decision。

## 12. 被拒绝的设计

- P0-03 使用内存任务表模拟可查询后台任务：无法跨刷新、重启和多实例保证语义。进程内执行回执只承担同 ID 并发合并与结果重放，不对外冒充任务资源。
- Web 直接携带 Fake 故障开关：把测试控制面暴露给用户。
- API 直接 import Orchestrator Implementation：绕开真实跨进程合同验证。
- Runtime 直接返回 HTTP Result：让框架错误和私有类型扩散到 API。
- 解析 Candidate 的 `identity.configuration` 文案：把品类、语言和展示格式泄漏进核心，并把不可审计文本当作事实。
- 接受 Runtime 自报的 Constraint Assessment：复制 Requirement/Claim 结论且仍可伪造，不能建立安全门禁。
- 用中文关键词识别 next step：文案变化会改变业务判断，无法形成稳定合同。
- 为 P0-03 立即增加单位换算引擎或 `CategoryConstraintEvaluatorPort`：当前没有第二个真实 Adapter，也没有超出规范化同单位数值比较的已确认需求。
- 在共享合同中导出 Zod 私有 Schema 供调用方拼接：扩大 Interface 并耦合实现库。
- 为笔记本建立 Category Package：P0-03 只有固定 fixture，没有真实品类行为需要封装。

## 13. 已完成的 TDD 实施顺序

1. Decision Contract v1 解码 Interface：正例、非法、版本、`executionRequestId`、`retryMode` 和 Result 联合。
2. Decision Task Executor：正例、`NEED_MORE_INFO`、引用图、同 ID 并发合并、冲突请求和 Runtime 失败。
3. Orchestrator HTTP 路由。
4. API Port、HTTP Adapter 和公开 action。
5. Web 合成提交与成功/失败渲染。
6. 四进程真实联调与统一门禁。

每一步执行一条失败测试 → 最小 Implementation → 验证，不创建下一步尚未使用的空模块。

第七轮修复继续沿用同一公开测试表面，并依次完成：Requirement/Decision 预算门禁、共享 Result→HTTP 映射、Web 独立解码、API/Orchestrator 出站异常保护，以及全新检出的 contracts 初建与开发监听。没有引入新的领域对象、生产 Runtime 或持久化能力。

语义闭包 TDD 继续只通过公开 Interface 验证：must-have 的精确 predicate/值类型/单位和唯一可信事实、硬预算、Condition/Elimination 引用闭包、结构化 next step、固定 fixture、Executor 失败语义及 Web 用户可见步骤。三层路由的合同拒绝结果均由共享 Result→HTTP 映射决定。

以下是当时复审补充批次的历史实施顺序；该批次后来已经完成，不再是当前 TDD 入口：

1. 用公开 Result 解码 Interface 为 `ELIMINATED`、`NOT_SELECTED`、重复/缺失 Disposition 建立正反例；
2. 为 `BUY_IF_PRICE` 未闭合 Critical Gap、Risk 指向未选 Candidate、通用 `NEED_MORE_INFO` 伪成功建立失败测试；
3. 最小修订未发布的 v1 类型、Schema、fixture 和私有不变量，不增加新公开函数；
4. 证明 Executor 把不可信 Runtime 的上述产物归一为结构化失败且无 bundle；
5. 更新 Web 的 Disposition 展示和端到端测试，再运行统一门禁与真实四进程验证。

## 14. TDD 前置决策记录

1. **已确认：** 同步 action 使用 `POST /api/v1/decision-tasks:execute`，本期不返回任务句柄、不提供轮询或 SSE。
2. **已确认：** 命令增加 `executionRequestId`；`DECISION_EXECUTION_STATUS_UNKNOWN / TRANSPORT` 使用 `retryMode=SAME_EXECUTION_ONLY`，只能复用同一 ID 重试。
3. **已确认：** Zod 作为合同 Module 的内部校验实现，不暴露 Zod 类型或原生错误对象；具体版本在实现前从官方 registry 核验并固定。

前三项设计决策及 Candidate Disposition、开放状态闭包已经确认并完成过实施。当时的下一个门禁是新的 [`p0-03-claim-evidence-authority-module-design.md`](p0-03-claim-evidence-authority-module-design.md)；该设计已于 2026-08-14 获接受并完成其范围内的受控 TDD，后续代码审查、提交、推送、PR、合并和验收仍须独立批准。
