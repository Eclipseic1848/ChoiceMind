---
status: accepted
---

# Decision 状态按语义完备度分阶段开放

ChoiceMind V1.0 保留 `BUY_NOW`、`BUY_IF_PRICE`、`WAIT`、`KEEP_CURRENT`、`NEED_MORE_INFO`、`NO_MATCH` 和 `REFUSE_RISK` 七种产品状态，但早期合同只开放已经具备完整领域结构、正反例和真实纵向验证的状态。P0-03 因此只允许 `BUY_IF_PRICE` 与 `NEED_MORE_INFO`；其余五种状态在对应 Candidate、Disposition、Reassessment Trigger 或请求级拒绝结构完成前必须失败关闭，不能用枚举已存在来冒充能力已实现。

## Consequences

- 完整七状态矩阵保留在 V1.2 产品与研发规格中，分期不缩减 V1.0 最终范围。
- 每次开放新状态都必须同步合同、正反例、跨进程校验、Web 展示和真实纵向验证，并由产品负责人确认。
- 未开放状态不得形成成功 Decision；Runtime 若提前返回，当前阶段合同必须结构化拒绝且不得产生 `ok=true`。
