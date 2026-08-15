---
status: accepted
---

# 由 Decision Basis 唯一派生 Evidence State

Claim Kind 只描述命题的语义类型，Evidence State 只描述全部有效 Evidence 对该 Claim 的整体支持情况。为避免 Runtime 自报状态与 Evidence 方向形成双重权威，产品负责人确认：Runtime、模型、Provider 和 Adapter 只能提交 Claim、Evidence 及其关系，Decision Basis 是 Evidence State 和下游 Claim Assessment 的唯一权威派生者；Constraint、Risk、Elimination 和其他 Decision 消费者不得自行解释或覆盖该状态。

## Consequences

- ChoiceMind 不信任框架或模型自报的 `SUPPORTED`、`REFUTED`、`CONFLICTED` 或 `INSUFFICIENT`。
- 同一份 Claim/Evidence 输入必须得到同一份权威 Assessment。
- `ClaimEvidenceLink` 是 Claim 与 Evidence 关系及方向的唯一权威；删除 `Claim.evidenceIds` 与 `Evidence.claimId`、`Evidence.direction`，不保留关系副本。同一 Evidence 可通过不同 Link 关联多个 Claim。
- 同一 `claimId + evidenceId` 组合至多有一条 Link；重复或相反方向 Link 以 `CONTRACT_INVALID` 失败关闭。复合来源片段由上游拆为原子 Evidence 或更精确 Claim，合同不解释自由文本来猜测关系方向。
- 无 Link 的 Claim 是合法的不确定状态并派生 `INSUFFICIENT`；每份 Evidence 至少关联一个 Claim，且 Link 两端存在并属于同一 Decision Task。孤立 Evidence、断链和跨 Task Link 是 `CONTRACT_INVALID`，不能伪装成证据不足。
- Evidence Eligibility 固定按 `Decision.validFrom` 计算；在该时点已过期的 Evidence 保留追溯但不参与 Assessment。跨进程解码和历史回看不得使用当前系统时间重新解释同一份 Result，Decision 过期提示属于独立展示状态。
- `Evidence.capturedAt > Decision.validFrom` 或 `Evidence.validUntil < Evidence.capturedAt` 是因果时间错误，必须以 `CONTRACT_INVALID` 失败关闭；最终生成器在证据采集完成后确定 `Decision.validFrom`。
- 最终版本化 Decision Result 保存规范化 `ClaimAssessment` 供审查和展示；它只能由 Decision Basis 生成。每个跨进程解码入口必须重新派生并与传入投影精确比对，缺失、伪造或不一致均以 `CONTRACT_INVALID` 失败关闭，不能静默修正。
- P0-03 的 Hard Constraint 满足/违反判定、Elimination 和最终选择只接受 `FACT_ASSERTION + SUPPORTED`；`SOURCE_OPINION` 与 `SYSTEM_INFERENCE` 可以保存和展示，但在来源聚类与样本范围、推断前提形成明确合同前，不得单独决定选择或淘汰。
- `BUY_NOW`、`BUY_IF_PRICE`、`WAIT`、`KEEP_CURRENT` 或 `NO_MATCH` 不得依赖 `CONFLICTED` 或 `INSUFFICIENT` 的 Claim；可以排除该依据后重新决策，无法排除时必须改走 `NEED_MORE_INFO`。
- 请求级安全拒绝 `REFUSE_RISK` 不依赖商品 Claim，不受上述门禁限制。
- 当前合同包为未发布的私有 `0.0.0`，因此直接删除旧 `Claim.status`、`Claim.evidenceIds`、`Evidence.claimId` 与 `Evidence.direction`，并一次性迁移全部本地调用方、测试和固定样本；旧格式返回 `CONTRACT_INVALID`，不提供双读兼容。
- Evidence State 派生使用可审查的确定性纯函数，不为四格真值表引入生产规则引擎、RDF 或通用图框架。
- 后续 TDD 可以原型评估 `fast-check` 作为开发期性质测试候选，但它不进入生产 Runtime；安装依赖仍需单独授权。
