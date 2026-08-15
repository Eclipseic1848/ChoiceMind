---
status: accepted
---

# ChoiceMind 持有框架中立的智能体运行合同

ChoiceMind 自己定义 `AgentRuntimePort`、`RuntimeSnapshot`、`EffectReceipt`、稳定终态、错误和安全恢复语义；CoreMind、其他成熟框架或组合方案只能作为该 seam 后面的 Adapter。这样可以在复用成熟能力的同时避免框架私有类型和恢复假设扩散到消费决策领域，并允许未来更换实现而不改变 Decision、Evidence 或安全门禁。

## Consequences

- Fake Adapter 与最终生产 Adapter 共同证明该 seam 确实存在，测试通过同一 Interface 观察行为。
- 采用任何候选框架都不能弱化 ChoiceMind 对失败可见、副作用核验和禁止伪成功的要求。
- CoreMind 是需要与其他候选同等评估的实现选项，不是预设依赖。

