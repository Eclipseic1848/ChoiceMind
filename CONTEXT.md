# ChoiceMind 消费决策

ChoiceMind 是一个面向单个消费者的智能消费决策上下文。它把消费问题转化为可审查的研究任务，并以个人约束和可验证证据形成可以买、等待、不买、继续使用或需要补充信息的 Decision。

## 主体与交互

**User**:
唯一的个人账号主体；一个账号只对应一个人，不代表家庭、团队或共享画像。
_Avoid_: Customer、家庭成员、团队成员

**Session**:
User 与智能体围绕一个或多个相关消费问题形成的连续对话。
_Avoid_: 工作台、家庭空间、聊天室

**Decision Task**:
围绕一个明确消费问题开展、可以后台运行并接受暂停、恢复、取消和审查的一次研究任务。
_Avoid_: 订单、购物任务、Agent Run

**Agent Run**:
Decision Task 的一次智能体执行尝试；同一任务可以因安全恢复、人工核验或重试产生多个 Run。
_Avoid_: Decision Task、Session

## 需求与研究

**Requirement Revision**:
User 的目标、约束、场景、假设和关键未知项在某一时点的不可变版本。
_Avoid_: 用户画像、Prompt

**Minimum Viable Requirement**:
足以开始有界候选研究的最小需求集合，至少能够限定消费目标、主要场景和影响筛选的关键约束；未达到时应继续澄清而不是生成热门 Candidate。
_Avoid_: 完整需求、随意猜测的默认值、商品榜单输入

**Research Plan**:
针对 Requirement Revision 和 Evidence Gap 制定的有界研究方案。
_Avoid_: 无限搜索、隐藏思维链

**Candidate**:
被纳入比较的消费方案，可以是待购买选项，也可以是用户当前已有的设备；必须绑定足以区分型号、代际、市场和配置的身份。
_Avoid_: 热门商品、泛化产品名、仅指待购买商品

**CURRENT_ASSET Candidate**:
代表用户当前已有设备及“继续使用”方案的一类 Candidate；它不是零元商品，不应伪造购买价格。
_Avoid_: 新商品 Candidate、价格为零的商品、长期记忆本身

**Category Package**:
表达某一品类特有 Schema、规则、查询模板、风险主题和 Gold Set 的扩展包；它不能改变核心 Decision 语义。
_Avoid_: 品类 Agent、核心品类分支

## 证据与结论

**Claim**:
能够被 Evidence 检验的最小消费命题；它的语义类型与证据状态是两个独立概念。
_Avoid_: 无来源断言、模型常识

**Claim Kind**:
Claim 的语义类型，只能是事实命题（`FACT_ASSERTION`）、来源观点（`SOURCE_OPINION`）或系统推断（`SYSTEM_INFERENCE`）；`SOURCE_OPINION` 只表示某个来源表达过该观点，不把观点升级为普遍事实；`SYSTEM_INFERENCE` 表示 ChoiceMind 基于明确前提形成的推断，不冒充来源事实。Claim Kind 不表示 Claim 是否已被证据支持。
_Avoid_: 把 `VERIFIED_FACT`、`CONFLICTED` 或 `UNKNOWN` 当作 Claim 类型；把已获支持的来源观点或系统推断自动当作客观事实

**Evidence State**:
Decision Basis 根据一个 Claim 的全部有效 Evidence 唯一派生的整体支持情况，只能是已支持（`SUPPORTED`）、已反驳（`REFUTED`）、证据冲突（`CONFLICTED`）或证据不足（`INSUFFICIENT`）；它不改变 Claim Kind，后两种状态不能作为 `BUY_NOW`、`BUY_IF_PRICE`、`WAIT`、`KEEP_CURRENT` 或 `NO_MATCH` 的依据。
_Avoid_: Claim Kind、把命题来源类型当作可信状态

**Claim Assessment**:
一个 Claim 的权威 Evidence State 以及分别支持、反驳它的有效 Evidence 集合；没有有效 Claim-Evidence Link 时，其状态是 `INSUFFICIENT`。它是可验证的派生依据，不是 Runtime、模型或界面可以自报或改写的事实。
_Avoid_: `Claim.status`、Runtime Assessment、界面自行计算的证据状态

**Evidence**:
能够支持或反驳至少一个 Claim，并带有来源、适用范围、时效和定位信息的证据片段；没有关联任何 Claim 的孤立记录不是 Evidence Gap。
_Avoid_: Runtime Execution Evidence、模型生成内容

**Evidence Eligibility**:
一份 Evidence 在 `Decision.validFrom` 时是否有资格参与权威 Claim Assessment；当时已经过期的 Evidence 可保留追溯，但不影响派生状态，之后回看也不按当前时间改写历史 Assessment。Evidence 必须先被采集且有效期不得早于采集时间，不能用未来证据解释过去 Decision。
_Avoid_: 用页面打开时间重新计算历史结论、删除过期 Evidence、未来 Evidence、倒置的有效期

**Claim-Evidence Link**:
连接同一 Decision Task 内的一个 Claim 与一份 Evidence，并声明支持或反驳方向的唯一关系记录；同一 Claim 与 Evidence 组合只能有一个方向，复合证据片段必须拆分或通过更精确的 Claim 消除歧义。
_Avoid_: `Claim.evidenceIds`、`Evidence.claimId`、`Evidence.direction`、断链、跨 Task Link、同一组合的重复或相反方向 Link

**Runtime Execution Evidence**:
工具执行、工程验证和运行轨迹形成的运行证据；它用于恢复、审计和运行验真，不能直接证明消费事实。
_Avoid_: Evidence、Claim 来源

**Evidence Gap**:
尚未获得且可能改变结论、降低置信度或阻止形成 Decision 的信息。
_Avoid_: 已被模型猜测填补的信息

**Critical Gap**:
会使购买结论不安全或不可验证的 Evidence Gap；存在时禁止产生 `BUY_NOW`。`BUY_IF_PRICE` 只有在每个 Critical Gap 都能转化为购买前可核验的 Decision Condition 和下一步时才成立，否则必须进入 NEED_MORE_INFO。
_Avoid_: 普通待办、可忽略缺口、没有核验路径的购买条件

**Constraint Assessment**:
根据 Candidate 的 Claim 和 Evidence，判断它对一项结构化 Hard Constraint 是满足、违反还是无法确定的派生结论。
_Avoid_: Runtime 自报的满足标记、从展示文案猜测的约束结果

**Decision Basis**:
把 Decision 中会影响选择、淘汰、风险或购买条件的结构化断言，连接到对应 Requirement、Claim、Evidence 或 Critical Gap 的可审查依据；用户可见文案本身不是依据。
_Avoid_: 自由文本理由、无关 Evidence ID、Runtime 自报结论

**Preference Criterion**:
User 已确认、用于比较可行 Candidate 的结构化软偏好，包含稳定事实键、比较目标和优先级。
_Avoid_: 未确认的模型偏好、作为权威依据的 `niceToHaves` 自由文本、总分权重猜测

**Candidate Comparison**:
针对一个 Preference Criterion，用双方 Claim 和 Evidence 形成的可审查 Candidate 取舍依据。
_Avoid_: 综合更合适、只引用单侧事实、Runtime 自报更优

**Negative Research**:
主动寻找候选方案的缺陷、风险、不适用条件和反例的研究活动。
_Avoid_: 负面情绪汇总、只验证初始推荐

**Synthetic Evidence**:
仅用于确定性合同测试、演示或故障验证，并明确标记为非真实来源的一类 Evidence；它不能证明现实商品事实，也不能混入真实 Decision。
_Avoid_: 真实 Evidence、Runtime Execution Evidence、未标记的测试数据

**Decision**:
ChoiceMind 交付的消费决策，包含结论状态、适用条件、约束、证据、风险、不确定性、有效期和下一步；它不等同于推荐购买。
_Avoid_: 商品榜单、购买指令、自动下单

**BUY_NOW Decision**:
当前已验证条件下可以行动的 Decision；它必须选择一个具体 Candidate，且不存在尚待满足的购买前条件或 Critical Gap。
_Avoid_: 不指向具体方案的泛化购买建议、仍需核验条件的购买结论

**BUY_IF_PRICE Decision**:
Candidate 已确定适合，但仍有价格、渠道、保修等购买前必要条件尚待用户核验的 Decision；它必须选择具体 Candidate，并把每个 Critical Gap 转化为可核验的 Decision Condition 和下一步。
_Avoid_: 条件已经全部满足的 BUY_NOW、等待价值更高的 WAIT

**WAIT Decision**:
等待的预期价值高于立即行动的 Decision；它必须选择一个当前最合适的 Candidate 作为比较基准，提供至少一个可验证的 Reassessment Trigger，且不得保留会推翻等待结论的 Critical Gap，但不构成当前购买建议。
_Avoid_: 没有比较基准或重新评估触发点的泛化观望、BUY_IF_PRICE

**KEEP_CURRENT Decision**:
继续使用现有设备比购买替代品更合理的 Decision；它必须选择代表该设备的 CURRENT_ASSET Candidate，用可审查证据支撑继续使用的理由，提供至少一个 Reassessment Trigger，且不得保留会推翻继续使用结论的 Critical Gap。
_Avoid_: 没有现有设备对象或重新评估触发点的泛化不买、零元购买建议

**NEED_MORE_INFO Decision**:
关键事实不足、尚不能形成最终取舍的可继续 Decision；它必须提出具体澄清问题，User 回答后形成新的 Requirement Revision。需求未达到 Minimum Viable Requirement 时不生成 Candidate；研究中途发现缺口时可以保留已有 Candidate，但不得选择或虚构淘汰。
_Avoid_: 猜测缺失事实、热门 Candidate 填充、虚构 Elimination Record、信息不足时仍给购买结论

**NO_MATCH Decision**:
经过候选研究后，所有 Candidate 都有证据证明违反至少一项 Hard Constraint 的 Decision；它必须逐项解释淘汰原因，只能建议调整约束，不能替 User 放宽 Requirement。
_Avoid_: 尚未研究就声称无匹配、自动降低标准、没有 Evidence 的淘汰

**REFUSE_RISK Decision**:
请求明确超出安全边界时，在候选研究前终止并形成的安全 Decision；它不包含 Candidate 或购买结论，但必须说明结构化拒绝原因和安全下一步。
_Avoid_: 系统失败、先推荐商品再免责、无解释拒绝

**Decision Condition**:
Decision 成立前必须同时满足且允许用户核验的一项条件；条件不满足时，原结论不再适用。
_Avoid_: 隐藏前提、支付条件、自动执行规则

**Decision Risk**:
最终选中 Candidate 仍然存在、需要 User 权衡或核验的不利事实及其影响；未选 Candidate 的不利事实属于其 Candidate Disposition，请求级安全边界属于 REFUSE_RISK Decision。
_Avoid_: 关联未选 Candidate 的结论风险、免责文案、没有 Evidence 的风险猜测

**Reassessment Trigger**:
要求 ChoiceMind 或 User 重新评估原 Decision 的可观察日期、事件或事实变化，例如新品正式发布或价格越过阈值；它不是当前购买结论成立前的条件。
_Avoid_: 模糊的“以后再看”、Decision Condition、自动购买触发器

**Elimination Record**:
记录某个 Candidate 因违反 Hard Constraint 或风险边界而退出比较的 Candidate Disposition。
_Avoid_: 综合适配度较低但仍满足硬约束、隐藏过滤、被静默删除的候选

**Not-selected Record**:
记录某个 Candidate 满足 Hard Constraint、但综合适配度低于被选方案而未入选的 Candidate Disposition；它必须说明比较理由并引用该 Candidate 的 Claim 和 Evidence。
_Avoid_: Elimination Record、无证据的低分候选、伪造硬约束违规

**Candidate Disposition**:
最终 Decision 对一个未选 Candidate 给出的可审查去向，区分“违反硬约束或风险边界而淘汰”和“满足硬约束但综合适配度较低而未入选”；两者都必须引用相应 Claim 和 Evidence。
_Avoid_: 把未入选伪装成违反硬约束、仅按总分降序、没有解释的候选消失

**Decision Revision**:
Decision 在某一组 Requirement、Candidate 和 Evidence 下形成的不可变版本。
_Avoid_: 被静默覆盖的结论

## 运行与恢复

**RunEvent**:
对 User 和审计者可理解的一项已发生运行事实，例如阶段变化、工具成功或失败、暂停和完成；它不包含模型私有思维链。
_Avoid_: 思维链、仅存于内存的进度文案

**RuntimeSnapshot**:
描述某个 Agent Run 在特定时点的不可变权威运行快照，并明确该运行是否具备恢复资格。
_Avoid_: UI 状态、可变缓存

**Effect Receipt**:
记录一次外部副作用处于 `not_started`、`started`、`committed` 或 `unknown` 的权威收据。
_Avoid_: 第三方恰好一次保证、普通日志

**Checkpoint**:
Agent Run 可以引用的持久执行位置；它本身不证明运行可以安全恢复。
_Avoid_: 恢复许可、成功状态

## 用户控制的数据

**Memory Item**:
经 User 授权保存、可查看、修改、导出和删除的一项长期个人信息。
_Avoid_: 未经授权的画像推断、Session 临时上下文

**Source Credential**:
用于访问特定第三方数据源的登录态，只能用于对应来源的隔离访问。
_Avoid_: Provider Credential、ChoiceMind 登录密码

**Provider Credential**:
平台或 User 提供、用于调用模型或外部服务的秘密凭据。
_Avoid_: Source Credential、明文 API Key

**Share Snapshot**:
从指定 Session 或 Decision Revision 派生、可以撤销的脱敏只读副本；它不授予原始对象访问权。
_Avoid_: 共享账号、原始会话授权
