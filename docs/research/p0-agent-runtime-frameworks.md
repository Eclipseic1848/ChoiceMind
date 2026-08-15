# P0 智能体运行层候选研究

## 1. 文档状态

- 研究对象：CoreMind、LangGraph.js、Mastra、OpenAI Agents SDK TypeScript，以及作为互补耐久执行层的 Temporal TypeScript。
- 核验时间：2026-08-12T19:47:43-07:00（America/Los_Angeles）。部分 GitHub Release 的 UTC 日期已进入 2026-08-13，表中保留来源所示的 UTC 时间。
- 资料范围：只使用官方文档、官方 GitHub 仓库与 Release、npm/PyPI 官方元数据。
- 本文性质：P0-01 的选型研究输入，不是最终 ADR，也不构成生产认证。
- 未执行事项：未安装任何候选、未运行代码、未调用真实模型、未验证 Windows/Linux 端到端兼容性。

本文严格区分：

- **事实**：可由所列一手来源直接复核。
- **推断**：基于事实和 ChoiceMind 已确认边界作出的工程判断。
- **建议**：需要通过原型或由项目负责人确认，不能当成既定决定。

GitHub stars 未用于质量判断；官方示例、README 声明、冒烟测试和包已发布均不等于 ChoiceMind 生产认证。

## 2. ChoiceMind 对运行层的约束

本次比较以 ChoiceMind P0 已确认的目标为准：

1. Web 是交互载体，产品是智能消费决策智能体，不是购物网站或工作台。
2. ChoiceMind 持有 Requirement、Candidate、Evidence、Decision、RunEvent、Memory 等业务语义，运行框架不能成为这些领域对象的权威存储。
3. Node/TypeScript 是 API、编排和运行层主路径；采集、解析、媒体、Embedding、Reranker 等 Python 能力通过明确的进程边界接入。
4. 必须支持流式可观察状态、人工暂停/恢复、失败不伪装成功，以及可审计的副作用恢复语义。
5. Provider 必须允许百炼、DeepSeek、本地 OpenAI-compatible 服务及未来其他模型，不得把 ChoiceMind 锁定到单一厂商。
6. Windows 用于开发与前后端验证，最终部署到 Linux；维护者是一人全栈。
7. Postgres/pgvector、Redis Streams、SeaweedFS 和 ChoiceMind 自己的 Outbox/Effect Receipt 是已确认的业务基础设施方向，框架不得未经 ADR 另建一套业务真相。

由此可见，候选不只是在比较“Agent API 好不好用”，还要回答两个不同问题：

- **Agent Runtime**：模型循环、工具、结构化输出、流式事件、人工审批由谁提供。
- **Durable Orchestrator**：跨进程、跨重启、长时间暂停、重试和副作用协调由谁提供。

一个框架可以覆盖两者的一部分，但不应仅因其自称“durable”就假定它能替代 ChoiceMind 的 Outbox、Effect Receipt 或业务幂等键。

## 3. 版本、维护和许可证快照

| 候选 | 截止核验时的公开版本事实 | 许可证事实 | 维护/发布事实 |
|---|---|---|---|
| CoreMind | GitHub 最新 Release 为预发布 `v0.3.0-rc.2`，绑定提交 `2460f185...`；npm `coremind-ai` 的 `next` 为 `0.3.0-rc.2`，但 `latest` 仍为 `0.2.0-beta.2`；PyPI `coremind-ai` 最新公开版本仍为 `0.2.0rc1`。主分支 package metadata 已是 `0.3.0-rc.2`。 | MIT | 仓库未归档，`v0.3.0-rc.2` 于 2026-08-13 01:18 UTC 发布；全部公开版本仍是 beta/rc。npm、PyPI、README/主分支版本并非完全同步。 |
| LangGraph.js | npm `@langchain/langgraph` 为 `1.4.9`；package 要求 Node `>=18`。 | MIT | `1.4.9` Release 于 2026-08-03 发布，仓库在核验日仍有提交，未归档。 |
| Mastra | npm `@mastra/core` 稳定版为 `1.58.0`；要求 Node `>=22.13.0`。 | `@mastra/core` 包为 Apache-2.0；仓库所有名为 `ee/` 的目录受 Mastra Enterprise License 约束。 | `@mastra/core@1.58.0` 于 2026-08-12 发布，仓库活跃且未归档；发布频率高。 |
| OpenAI Agents SDK TS | npm `@openai/agents` 为 `0.15.0`。包未声明 `engines`；官方运行时支持表要求 Node 22+，CI 主测试矩阵使用 Node 22/24。 | MIT | `v0.15.0` 于 2026-08-11 发布，仓库活跃且未归档。当前仍是 `0.x`。 |
| Temporal TypeScript | npm `@temporalio/worker` 为 `1.22.0`，registry 要求 Node `>=20.3.0`；官方仓库说明当前支持 Node 20、22、24。 | MIT | `v1.22.0` 于 2026-08-05 发布，仓库活跃且未归档。 |

一手来源：

- CoreMind：[GitHub Release v0.3.0-rc.2](https://github.com/Eclipseic1848/CoreMind/releases/tag/v0.3.0-rc.2)、[根 package.json](https://github.com/Eclipseic1848/CoreMind/blob/main/package.json)、[coremind-ai package.json](https://github.com/Eclipseic1848/CoreMind/blob/main/packages/coremind/package.json)、[npm 包](https://www.npmjs.com/package/coremind-ai)、[PyPI 包](https://pypi.org/project/coremind-ai/)。
- LangGraph.js：[@langchain/langgraph package.json](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/package.json)、[Release](https://github.com/langchain-ai/langgraphjs/releases/tag/%40langchain%2Flanggraph%401.4.9)、[LICENSE](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE)。
- Mastra：[@mastra/core Release](https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fcore%401.58.0)、[@mastra/core package.json](https://github.com/mastra-ai/mastra/blob/main/packages/core/package.json)、[许可证映射](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md)。
- OpenAI Agents SDK：[v0.15.0 Release](https://github.com/openai/openai-agents-js/releases/tag/v0.15.0)、[@openai/agents package.json](https://github.com/openai/openai-agents-js/blob/main/packages/agents/package.json)、[LICENSE](https://github.com/openai/openai-agents-js/blob/main/LICENSE)、[运行时支持表](https://openai.github.io/openai-agents-js/guides/troubleshooting/)、[CI](https://github.com/openai/openai-agents-js/blob/main/.github/workflows/test.yml)。
- Temporal：[v1.22.0 Release](https://github.com/temporalio/sdk-typescript/releases/tag/v1.22.0)、[SDK 仓库与 Node 支持](https://github.com/temporalio/sdk-typescript)、[@temporalio/worker](https://www.npmjs.com/package/%40temporalio/worker)、[LICENSE](https://github.com/temporalio/sdk-typescript/blob/main/LICENSE)。

## 4. 能力事实矩阵

| 维度 | CoreMind | LangGraph.js | Mastra | OpenAI Agents SDK TS | Temporal TS（互补层） |
|---|---|---|---|---|---|
| 定位 | 配置驱动 Agent Runtime/Harness/Loop，TS SDK、CLI/TUI 与 Python SDK 共用 Node Runtime | 低层、图式、可控 Agent 编排运行时 | TS-first 一体化 Agent、Workflow、Memory、RAG、Evals、Server 生态 | 轻量 Agent loop、handoff、tools、guardrails、sessions、HITL | 通用耐久业务工作流引擎，不是 Agent Runtime |
| 流式/事件 | JSONL 运行事件、带 ID/sequence 的 Trace；README 声明 append-only RunState | `messages`、`updates`、`values`、`custom`、`checkpoints`、`tasks`、`debug` 等流模式；新事件 API 提供类型化投影 | Agent/Workflow 流式输出；`resumeStream`；Server/AI SDK 适配器 | `raw_model_stream_event`、`run_item_stream_event`、`agent_updated_stream_event`；Runner/Agent 生命周期钩子 | Event History、Query、Signal、Update；不是面向 token 的 Agent UI 流，需要应用层转译 |
| 持久化/暂停恢复 | RunState、Session、Checkpoint、Protocol v1；安全恢复会核对输入/配置及 Effect Receipt | Checkpointer 在每个 super-step 保存状态；支持 Postgres/Redis/SQLite/MongoDB；interrupt 可无限等待并恢复 | Workflow Snapshot 通过配置的 storage 持久化 suspend/resume；有 Postgres 等 storage adapter；另有 Temporal 集成 | Session 持久对话；`RunState` 可序列化并跨进程恢复审批中断；内置 MemorySession 仅进程内，其他存储需自建或用 OpenAI Conversations | 核心能力是通过 Event History 重放与 Worker 恢复长任务；支持长时间等待、消息和 worker 重启 |
| 副作用/幂等 | 工具声明 effect；运行时记录幂等关联标识，但业务工具必须实现收据/去重；明确不承诺恰好一次 | 官方要求把副作用封装为 task，并仍设计幂等；interrupt 前副作用可能因节点重跑重复 | Snapshot 保存步骤状态；核心文档未提供“外部副作用自动恰好一次”的证据；Temporal 集成可增加 durable execution，但 Activity 仍需幂等 | Provider retry 有 replay-safety 信息；官方要求有副作用的工具按 call ID 幂等；RunState 并非通用业务工作流引擎 | Activity 可能执行多次或部分完成；官方明确要求幂等，可用 Workflow Run ID + Activity ID 构造幂等键；只保证完成被观察一次，不保证外部效果只发生一次 |
| Provider 开放性 | 40 个可配置入口、自定义 OpenAI-compatible；截至官方矩阵仅百炼 1 个完成当前真实认证 | 经 LangChain 标准模型接口接多 Provider，并支持 OpenAI-compatible base URL | Model Router/AI SDK Provider 覆盖多厂商，支持运行时选择与 BYOK | `Model`/`ModelProvider` 是公开接口，但默认实现围绕 OpenAI；其他厂商需自建适配或使用兼容实现 | 完全不关心模型 Provider；Agent Runtime 仍需另选 |
| Python 边界 | Python SDK 通过本地 stdio JSON-RPC 调用同一 Node Runtime；不是第二套 Loop | 有独立 Python 版 LangGraph，但未发现 JS/Python 共享同一 checkpoint schema 的官方承诺；外部 Python 工具仍宜走服务/RPC | 本次一手资料未发现正式 Python Runtime；Python 工具宜走 HTTP/MCP/队列边界 | 有独立 Python SDK，但未发现与 TS `RunState` 互换的正式承诺；Python 工具宜走服务/RPC | 有正式 Python SDK，官方样例包含“其他语言 Workflow 调用 Python Activity”的 polyglot 路径 |
| 自托管 | 源码/npm/PyPI 本地运行；无官方托管 API 或官方 Docker 镜像 | MIT 核心库可嵌入自有 Node 服务，生产 checkpointer 可自托管；官方 standalone Agent Server 另需 LangGraph Cloud license key，不能与核心库混为一谈 | OSS Server/adapter 可嵌入 Express/Hono/Fastify/Koa 或单独部署；核心之外有托管产品 | SDK 可嵌入自有 Node 服务；OpenAI Conversations/Responses 状态属于可选的厂商托管路径；默认 tracing 的外部导出需显式评估或关闭 | Temporal Server 可自托管，也可用 Temporal Cloud；自托管需额外部署、监控、安全和升级 |
| Windows/Linux 证据 | 官方 README 声明 Windows/Linux，并称 CI 双平台；Node 要求 `>=22.19` | Node package 本身无 OS 限制，但本研究未完成双平台真实安装验证 | Node `>=22.13`；可自托管，但本研究未取得完整 Windows/Linux 对称 CI 证据 | Linux 主 CI 跑 Node 22/24；Windows CI 只覆盖部分 sandbox path 测试，不能据此宣称全功能 Windows 认证 | Node 20/22/24 官方支持；生产 Server 通常作为独立基础设施。Windows 本地开发路径仍需 ChoiceMind 实测 |

关键一手来源：

- CoreMind：[README](https://github.com/Eclipseic1848/CoreMind#readme)、[Provider 认证矩阵](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/README.zh-CN.md)、[Python SDK（PyPI）](https://pypi.org/project/coremind-ai/)、[Checkpoint 指南](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-checkpoints/GUIDE.zh-CN.md)。
- LangGraph.js：[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)、[Functional API 与幂等](https://docs.langchain.com/oss/javascript/langgraph/functional-api)、[Event streaming](https://docs.langchain.com/oss/javascript/langgraph/event-streaming)、[Model interfaces](https://docs.langchain.com/oss/javascript/langchain/models)、[Standalone Agent Server 许可证要求](https://docs.langchain.com/langsmith/deploy-standalone-server)。
- Mastra：[Workflow snapshots](https://mastra.ai/en/reference/workflows/snapshots)、[Temporal integration](https://mastra.ai/blog/introducing-temporal-workflows)、[Server adapters](https://mastra.ai/blog/mastra-server-adapters)、[Model Router](https://mastra.ai/blog/model-router)、[Postgres storage](https://www.npmjs.com/package/%40mastra/pg)。
- OpenAI Agents SDK：[Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/)、[Streaming](https://openai.github.io/openai-agents-js/guides/streaming/)、[Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)、[HITL 与跨进程 RunState](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)、[`ModelProvider` 源码](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/model.ts)、[Tracing 配置](https://openai.github.io/openai-agents-js/guides/tracing/)。
- Temporal：[官方文档首页](https://docs.temporal.io/)、[Activity 幂等与执行语义](https://docs.temporal.io/activity-definition)、[TypeScript 消息传递](https://docs.temporal.io/develop/typescript/workflows/message-passing)、[自托管指南](https://docs.temporal.io/self-hosted-guide)、[Python polyglot samples](https://github.com/temporalio/samples-python/tree/main/activity_worker)。

## 5. 候选逐项判断

### 5.1 CoreMind

#### 已验证事实

- CoreMind 的公开 API 和 ChoiceMind 已写入规格的概念高度接近：Runtime、Harness/Loop、RunOutcome、Trace、RunState、Checkpoint、权限模式、预算、安全恢复和 Effect Receipt。
- `coremind-ai@0.3.0-rc.2` 要求 Node `>=22.19.0`，运行时依赖 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 和 XState。
- Python SDK 不是另一个 Python Agent Loop，而是通过 stdio JSON-RPC 调用捆绑的 Node worker。
- Provider 官方矩阵明确区分“可配置”和“已认证”；截至生成日期只有 `alibaba-model-studio` 具有完整当前认证。
- GitHub Release、npm stable/next、PyPI 和主分支 package metadata 存在版本不同步，且最新候选仍为 rc。

#### 基于证据的推断

- 其最大优势不是生态规模，而是已经把 ChoiceMind 关心的副作用、权限、失败终态和跨语言边界作为一等概念，适配成本可能最低。
- 其最大风险是 ChoiceMind 与 CoreMind 由同一位个人维护：选用它会把“应用开发成本”转化为“应用 + 框架双重维护成本”，缺陷隔离和升级节奏也更难独立。
- 版本不同步说明在依赖固定、可复现构建和灾难恢复演练之前，不能把它当成稳定供应链。

#### 尚未验证的建议

- 保留为基准候选和回退路径，不因“自己写的”自动优先，也不因生态较小自动淘汰。
- 只有在干净安装、Protocol round-trip、暂停恢复、错误映射、Windows/Linux 和百炼真实调用均通过 ChoiceMind 自己的合同测试后，才可进入最终 ADR。

### 5.2 LangGraph.js

#### 已验证事实

- LangGraph.js 是低层图式运行时，核心直接提供 checkpoint、fault-tolerance、interrupt、time travel、流式状态和 human-in-the-loop。
- 官方生产级 checkpointer 选项包含 Postgres；也有 Redis、MongoDB 和 SQLite 实现。
- 失败 super-step 中已成功节点的 pending writes 可保存；从 checkpoint replay 时，checkpoint 后的 LLM/API/interrupt 会重新执行。
- 官方文档明确要求 task 和副作用设计为幂等；中断恢复会重新运行节点，不能把 checkpoint 误解成外部副作用恰好一次。
- LangChain 标准模型接口覆盖多 Provider，并可配置 OpenAI-compatible base URL。

#### 基于证据的推断

- 它与 ChoiceMind 的 `AgentRuntimePort`、Postgres 权威状态、独立 Evidence/Decision 模型最容易形成“深而窄”的适配层；ChoiceMind 能保留较强控制权。
- 代价是需要自己定义图、状态、事件转译、工具权限、Effect Receipt 和 Web 事件协议；框架不会替项目完成这些业务基础设施。
- 对一人团队而言，代码量高于 Mastra/OpenAI SDK，但隐式平台行为和许可证边界较少，长期可解释性较好。

#### 尚未验证的建议

- 作为 P0 主决赛候选之一。
- 原型必须使用 Postgres checkpointer，而不是 MemorySaver；必须做“节点已产生外部效果但 checkpoint 未确认”的失败注入。

### 5.3 Mastra

#### 已验证事实

- Mastra 是 TS-first 全栈框架，覆盖 Agent、Workflow、Memory、RAG、Evals、Observability、Server adapter 和模型路由。
- Workflow suspend 时自动保存 snapshot；resume 会从 storage 读取。Postgres adapter 暴露 workflow snapshot 读写操作。
- `@mastra/temporal` 可将相同 Mastra Workflow 映射到 Temporal Workflow/Activity，提供更强耐久执行，但会引入 Temporal 运行基础设施。
- 核心包为 Apache-2.0，但仓库 `ee/` 目录不是 Apache-2.0；不能把整个仓库笼统视为纯 Apache-2.0。
- 稳定包发布频率很高，当前 Node 基线是 `>=22.13.0`。

#### 基于证据的推断

- 它提供最短的“从 Agent 到可用 Server/流式 UI/Workflow/Storage”路径，可能显著减少一人团队的样板代码。
- 同时它与 ChoiceMind 计划自有的 ProviderConfig、Memory、Evidence/RAG、Workflow 状态和后台能力存在较大重叠；若不提前划界，容易形成两套业务语义。
- 高频发布和较宽 API 面意味着升级测试成本较高；只固定 `@mastra/core` 仍不足以代表相关 adapter/storage 包组合稳定。

#### 尚未验证的建议

- 作为 P0 主决赛候选之一，但原型只允许使用 OSS core、workflow、stream 和明确的 Postgres adapter，不引入 `ee/`、Mastra Cloud 或与 ChoiceMind 重叠的长期记忆语义。
- 验证同一 workflow 在原生 snapshot 与 Temporal adapter 下的边界差异，但 P0 不因此自动引入 Temporal。

### 5.4 OpenAI Agents SDK TypeScript

#### 已验证事实

- SDK 提供小型 Agent loop、handoff、agent-as-tool、guardrail、HITL、Session、事件流和结构化运行结果。
- `RunState` 可序列化，长时间审批可以关闭进程后重建同一 agent graph 并恢复。
- 内置 `MemorySession` 仅用于进程内开发；持久会话要么使用 OpenAI Conversations，要么实现五个方法的自定义 `Session`。
- `Model` 和 `ModelProvider` 是公开接口；默认 Provider 是 OpenAI。
- 官方文档要求有副作用的工具用 call ID 实现幂等。SDK 的 resumable state 不能自动替业务实现 Effect Receipt。
- Node/Deno/Bun 的 tracing 默认开启并导出到 OpenAI；官方提供环境变量和 Runner 选项关闭。ChoiceMind 若采用自托管默认值，必须把是否外发 trace 作为显式配置和权限决策。
- 主 Linux CI 覆盖 Node 22/24；Windows job 仅针对部分 sandbox path，不能据此证明全部 SDK 能力已做 Windows 对称验证。

#### 基于证据的推断

- SDK 足够小，适合当作一个 AgentRuntime adapter；ChoiceMind 可以自己掌控持久任务、事件和业务状态。
- 对 ChoiceMind 的国内多 Provider目标而言，自定义 Provider/兼容端点和认证矩阵工作量会明显高于 Mastra/LangChain；使用 OpenAI Conversations 又会引入额外外部数据状态。
- 它的跨进程 RunState 主要解决 Agent/HITL 延续，不是 Postgres Outbox、后台任务和跨服务耐久编排的替代品。

#### 尚未验证的建议

- 保留为“轻量对照候选”，用于校验我们是否真的需要图式/全栈框架。
- 若进入原型，必须使用 ChoiceMind 自建 Session 和自定义 Provider，不得用 OpenAI 托管会话掩盖自托管要求。

### 5.5 Temporal TypeScript（互补层，不是主 Agent Runtime 候选）

#### 已验证事实

- Temporal 是通用耐久执行平台，Workflow 通过 Event History 重放恢复，支持长时间运行、Signal/Query/Update 和 worker 重启。
- Activity 可能执行多次，官方明确要求业务 Activity 幂等，并建议用 Workflow Run ID + Activity ID 构造幂等键。
- TypeScript SDK 正式支持 Node 20/22/24；Temporal Server 可以自托管或使用 Cloud。
- 自托管生产环境需要处理部署、TLS/mTLS、认证授权、监控、Visibility、升级和归档。
- Temporal 具备 Python SDK 和 polyglot Activity 官方样例，可让 TS Workflow 调用 Python Worker。

#### 基于证据的推断

- Temporal 最适合承担 ChoiceMind 的“跨小时/天、跨 worker 重启、外部服务易失败”的耐久编排，不适合替代 AgentRuntime 的模型循环和 token/event UI。
- 它能减少自研调度/恢复机制，但不能消除 ChoiceMind Effect Receipt 和幂等义务。
- 对一人 P0 而言，引入 Temporal Server、Worker、版本化 Workflow 和运维面，明显增加初始复杂度，并与既定 Postgres Outbox + Redis Streams 路径发生重叠。

#### 尚未验证的建议

- P0 默认不引入生产依赖，只保留接口和实验位。
- 仅当失败注入证明现有 Outbox/Redis/框架 checkpoint 无法以可接受复杂度满足 P0-09，或 P1/P2 明确出现跨日 workflow，再单独立 ADR 决定是否接入。

## 6. 适合一人全栈的成本判断

以下为推断，不是官方事实：

| 候选 | P0 上手成本 | 长期自主可控 | 隐性维护面 | 主要成本来源 |
|---|---:|---:|---:|---|
| CoreMind | 中 | 高 | 高 | 同时维护框架和应用；预发布供应链与版本同步 |
| LangGraph.js | 中高 | 高 | 中 | 图、事件、权限和持久任务需要自行集成 |
| Mastra | 低至中 | 中 | 中高 | API 面宽、发布快、与 ChoiceMind 业务能力重叠、许可证分区 |
| OpenAI Agents SDK TS | 低 | 中高 | 中 | 多 Provider、durable task、业务权限和存储需自行补齐 |
| Temporal TS | 高 | 高 | 高 | 新增服务、Worker、Workflow 版本化与生产运维 |

这个表不能单独用于选型。P0 的关键不是减少首个 Demo 的代码，而是减少到 V1.0 发布时仍需由一人长期理解和验证的状态所有者数量。

## 7. 收口建议：保留两个主决赛候选，不做最终选型

### 已验证事实所支持的结论

1. Temporal 不是 CoreMind/LangGraph/Mastra/OpenAI Agents SDK 的同类替代品；它是可选的耐久编排层。
2. 四个 Agent Runtime 候选都不能替 ChoiceMind 自动保证外部副作用恰好一次。
3. CoreMind 与现行规格语义最贴近，但成熟度和维护集中风险最高。
4. OpenAI Agents SDK 最轻，但对国内多 Provider、自托管持久任务和完整恢复的补齐工作最多。
5. LangGraph.js 与 Mastra 分别代表两个合理方向：前者是低层可控，后者是一体化高效率。

### 建议的 P0 原型短名单

- **主决赛候选 A：LangGraph.js**，验证“ChoiceMind 保留业务真相，只借用图运行/checkpoint/interrupt”的可行性。
- **主决赛候选 B：Mastra OSS core**，验证“一体化能力能否在不吞并 ChoiceMind 领域边界的前提下降低一人开发成本”。
- **基准候选：CoreMind**，用同一合同样本衡量语义贴合度和恢复安全；不直接默认胜出。
- **轻量对照：OpenAI Agents SDK TS**，只在 A/B 原型显得过重时验证。
- **互补观察：Temporal TS**，P0 不作为默认基础设施。

这只是研究建议。最终选型必须由项目负责人确认，并写入 ADR；任何候选在原型通过前都不得标记为 `CERTIFIED`。

## 8. 最小原型门禁

为避免做四套完整应用，建议用相同的 `AgentRuntimePort` 合同运行最小样本：

1. 输入同一个合成 Requirement，产生严格 schema 的 Decision。
2. 流式输出至少包括运行开始、模型增量、工具开始/完成、暂停、恢复、完成/失败，且不泄露隐藏思维链。
3. 在工具执行前暂停审批，关闭进程，重启后恢复。
4. 在工具已经产生外部效果、但运行层未记录完成时注入故障；系统必须停在 `unknown/needs_review` 或借助业务幂等键安全复用，不得伪造成功。
5. Provider 至少覆盖：Fake Provider、本地 OpenAI-compatible Qwen、百炼真实模型（需另行授权）。
6. Python 工具通过同一稳定进程边界调用，不让框架私有类型跨入 Python Worker。
7. Windows 开发和 Linux 容器分别运行相同合同；记录精确版本、lockfile、错误映射和事件序列。
8. 对比实现代码量、框架胶水代码、状态所有者数量、升级破坏面和故障解释成本，而不是只比较首轮响应是否成功。

建议的淘汰条件：

- 不能稳定使用自定义 OpenAI-compatible Provider，或真实百炼工具/结构化输出无法通过。
- 不能把框架状态与 ChoiceMind Decision/Evidence/RunEvent 明确分离。
- 恢复时会静默重放未知副作用，且没有可插入的幂等/收据接口。
- 失败被包装成成功文本，或缺少可机器判断的终态。
- 只能依赖托管服务才能满足基础持久化，无法按 ChoiceMind 自托管边界部署。
- Windows/Linux 合同结果不一致且无法通过薄适配层消除。

## 9. 必须由项目负责人确认的未决项

1. 是否同意把最终原型短名单收敛为 LangGraph.js 与 Mastra，CoreMind 作为同合同基准，而非默认框架。
2. P0 是否允许为框架评估编写可丢弃原型；原型结论进入正式代码前需再次确认。
3. 是否坚持 P0 使用既定 Postgres Outbox + Redis Streams，不引入 Temporal Server。
4. 是否允许 Mastra 仅使用 Apache-2.0 区域，并建立 CI 禁止导入 `*/ee/*`。
5. 百炼/本地模型真实测试的网络、密钥和费用授权仍需在执行前单独确认。

## 10. 研究局限

- 版本和发布状态变化很快；正式固定依赖前必须重新查询 Release、npm/PyPI 和 package metadata。
- 本文没有执行干净安装、编译、合同测试、故障注入、安全审计或性能测试。
- 官方声称“production-ready”“durable”只记录为项目方声明；ChoiceMind 仍需自己的验收证据。
- 未对许可证提供法律意见。特别是 Mastra `ee/` 目录，如果未来需要相关能力，应先做单独许可审查。
- 没有把任何 README 示例、官方 sample 或单次真实 Provider 证据外推为 ChoiceMind 的生产资格。
