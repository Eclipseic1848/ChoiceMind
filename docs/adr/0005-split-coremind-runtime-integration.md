---
status: accepted
---

# 将 CoreMind Runtime 接入拆成最小运行验证与完整运行能力

P0-07 原本把最小 `run`、事件流、暂停恢复、取消、RuntimeSnapshot 和 EffectReceipt 一次性绑定，导致生产框架验证被整体后置，也容易让 P0 Fake Adapter 被误当成自研 Runtime。产品负责人确认：先修正 ChoiceMind 的 Claim/Evidence 输出合同，随后通过单独授权的 P0-07A 使用薄 CoreMind Adapter 跑通确定性 `run` 纵向链路；P0-07B 再完成 `resume`、`cancel`、事件流、快照、收据和安全恢复。这样既尽早验证 CoreMind，又不让框架替代 ChoiceMind 对 Requirement、Claim、Evidence、Decision 和失败关闭语义的所有权。

## Consequences

- P0-07A 只验证 CoreMind 的最小 `run` Adapter、确定性测试 Provider、精确版本与依赖来源，以及框架私有类型隔离；它不宣称已经完成生产 Runtime 或最终框架认证。
- P0-07B 保留完整 `AgentRuntimePort`、RuntimeSnapshot、EffectReceipt、取消、事件流和安全恢复门禁，不因最小链路通过而提前宣称完成。
- 当前 Claim/Evidence 冲突属于 ChoiceMind Runtime 输出合同问题；接入 CoreMind 不能弱化或绕过 DecisionBasis 的唯一派生与失败关闭。
- Fake Adapter 继续只做确定性合同替身，不得演化为模型循环、工具调度、Checkpoint 或 Effect Receipt 的第二套实现。
- 两个切片的实现、依赖安装、GitHub Issue 修改、提交和推送仍分别需要明确授权。
