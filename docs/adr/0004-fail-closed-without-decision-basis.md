---
status: accepted
---

# 缺少结构化 Decision Basis 时失败关闭

ChoiceMind 不把自由文本理由或任意 Evidence 引用认证为选择依据。P0-03 的 Decision Risk 必须引用被选 Candidate 的可信 Claim；在结构化 Preference Criterion、Candidate Comparison 和 User Fit 尚未具备前，P0-03 关闭 `NOT_SELECTED`，多个 Candidate 均满足 Hard Constraint 时宁可形成 `NEED_MORE_INFO` 追问偏好，也不生成无法证明的最终选择。

## Consequences

- P0-03 仍可用 `ELIMINATED` 表达有 Claim/Evidence 证明的 Hard Constraint 违规。
- `niceToHaves` 自由文本在 P0-03 只用于需求记录，不能成为最终选择依据。
- V1.0 继续保留 Not-selected Record；只有结构化 Preference/Fit 合同、正反例和真实验证完成后才能重新开放。
- 用户可见文案不参与稳定判断；无证据的新事实必须成为 Claim/Evidence 或保持 Gap，不能藏在 Risk、reason 或 impact 中。
