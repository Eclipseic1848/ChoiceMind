---
status: accepted
---

# 从 Requirement、Claim 和 Evidence 派生 Constraint Assessment

ChoiceMind 的 Decision Contract Module 从结构化 Requirement、Claim 和 Evidence 内部派生 Constraint Assessment，不接受 Runtime 自报的满足标记，也不解析 Candidate 展示文案。`nextSteps` 在尚未发布的 v1 中直接采用结构化判别联合，不兼容旧字符串数组；核心只比较相同 predicate、值类型和单位的规范化值。这样以较小公开 Interface 集中约束判断，防止 Runtime 用自相矛盾的数据形成成功 Decision，同时保持核心品类无关。

## Consequences

- Category Package 负责在进入核心合同前规范化 predicate、数值和单位；P0-03 不做单位换算。
- 缺少可信 Claim、单位不一致或事实冲突时，Constraint Assessment 为无法确定，不能据此选择 Candidate。
- Fake Runtime fixture 必须为 must-have 提供结构化 Claim/Evidence，并输出可机器关联的 next step。
