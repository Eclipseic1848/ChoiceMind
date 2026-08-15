# Agent Runtime seam

## 目的

`AgentRuntime` Module 负责把一个 Decision Task 的运行意图转化为可观察、可暂停并在安全边界内恢复的 Agent Run。它向 ChoiceMind 隐藏具体智能体框架、Provider 环境、工具注册、框架检查点和原生事件格式。

本设计不把某个框架设为 ChoiceMind 领域语义的权威实现。产品负责人已确认优先用 CoreMind 做第一个最小 `run` Adapter 验证；这项提前验证不等于最终生产框架认证，完整接入仍受精确版本、依赖来源和恢复语义门禁约束。拆分理由见 [ADR-0005](../adr/0005-split-coremind-runtime-integration.md)。

## Interface

调用方只需要理解四项操作：

```ts
interface AgentRuntimePort {
  run(command: StartRun): Promise<RuntimeRunResult>;
  resume(command: ResumeRun): Promise<RuntimeRunResult>;
  cancel(command: CancelRun): Promise<CancelResult>;
  streamEvents(query: RunEventQuery): AsyncIterable<RunEvent>;
}
```

这项 Interface 还包含以下不可省略的行为合同：

- `run` 创建新的 Agent Run，不接收框架私有配置或类型。
- `resume` 只接受已经通过 `RuntimeSnapshot` 和 `EffectReceipt` 安全校验的运行。
- `cancel` 表达取消意图；若外部副作用状态未知，不把取消伪装成回滚成功。
- `streamEvents` 只输出版本化运行事实，不输出模型私有思维链。
- 所有结果明确区分成功、失败、暂停、取消和需要人工核验，部分结果不能冒充成功。

## 深度与 locality

调用方不需要了解以下实现复杂度：

- Provider 和单次运行凭据环境的组装；
- ChoiceMind 领域工具到框架工具定义的映射；
- 框架原生快照、检查点、事件和错误的校验与归一化；
- 原始运行制品的不可变保存和哈希引用；
- 副作用收据的归并与恢复资格计算；
- 取消、超时、限流、备用和不确定结果的映射。

删除该 Module 会迫使这些知识扩散到 Orchestrator、Decision、Evidence、Web 和测试，因此它应作为深模块存在。

## Adapter

P0 按以下顺序形成 Adapter：

- `FakeAgentRuntimeAdapter`：使用确定性输入输出验证 Interface、错误和状态语义；
- P0-07A CoreMind 最小 `run` Adapter：在 Claim/Evidence 输出合同修正后，用确定性测试 Provider 跑通同一条 Decision 链路；当前尚未实施；
- P0-07B `ProductionAgentRuntimeAdapter`：补齐经确认框架的完整运行、快照、收据、取消、事件流和恢复语义；当前尚未实施。

框架内部为了 Provider、存储或工具测试建立的 seam 保持私有，不通过 `AgentRuntimePort` 暴露。

## 集成切片与顺序

### P0-07A：CoreMind 最小运行验证

- 前置条件：ChoiceMind Claim/Evidence 合同只有一个可验证的派生状态权威，冲突产物不能形成成功 Decision；
- 只消费 `AgentRuntimePort.run`，固定 CoreMind 精确版本、提交或制品哈希；
- 使用确定性测试 Provider，不接入真实模型、真实数据源或外部副作用；
- 复用 P0-03 的同一合成需求、Decision Contract 和失败反例；
- CoreMind 私有命令、事件和错误只能存在于薄 Adapter 内。

### P0-07B：完整生产 Runtime 能力

- 实现 `resume`、`cancel` 和 `streamEvents`；
- 校验 RuntimeSnapshot、EffectReceipt、Checkpoint 和恢复许可；
- 覆盖取消、超时、不确定副作用、幂等恢复和框架升级；
- P0-07A 通过不能替代本切片验收。

## 状态所有权

| 状态 | 权威所有者 | Agent Runtime 的责任 |
| --- | --- | --- |
| User、Session、Decision Task | ChoiceMind | 只接收运行所需的最小引用和上下文 |
| Requirement、Candidate、Evidence、Decision | ChoiceMind | 通过领域工具请求读写，不直接持有业务真相 |
| 模型步骤和工具调用 | 选定运行框架 | 映射为版本化 RunEvent |
| RuntimeSnapshot、Effect Receipt、原始 Trace | 运行框架产生，ChoiceMind 不可变保存 | 校验、归一化并提供内容寻址引用 |
| 恢复许可 | ChoiceMind 安全合同 | 根据经校验快照和收据决定，不根据 UI 或单个 Checkpoint 推断 |
| 业务状态与审计 | ChoiceMind | 作为最终可查询和可审查事实保存 |

## 恢复矩阵

| 已验证运行事实 | ChoiceMind 行为 |
| --- | --- |
| `resumable=false` | 禁止自动恢复，保持暂停或进入人工核验 |
| 未完成 Effect 为 `not_started` | 允许在同一运行内重新评估并安全继续 |
| 未完成 Effect 为 `started` 或 `unknown` | 禁止自动重放，等待人工核验第三方结果和成本 |
| Effect 为 `committed` 且所属步骤稳定完成 | 复用已保存结果并继续后续步骤 |
| Effect 为 `committed` 但无法确认所属稳定步骤 | 暂停并人工核验，不自行推断成功 |

Checkpoint 只是执行位置，不是恢复许可；任何框架声称的重试、持久化或耐久执行能力都必须映射并通过上述矩阵验证。

## 测试表面

测试只通过 `AgentRuntimePort` 观察结果和事件，覆盖：

- 确定性成功路径；
- 非法输入和合同版本不兼容；
- Provider、工具和框架失败不产生伪成功；
- 取消与超时；
- 四类 Effect Receipt 的恢复行为；
- 重复 `resume` 的幂等行为；
- 框架升级后 ChoiceMind 领域调用方无需修改。

生产框架的原生类型和测试不替代 ChoiceMind 的 Interface 合同测试。
