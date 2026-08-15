# ChoiceMind 星枢智购：产品与研发规格书

> 面向 V1.0 发布完成态的产品、领域、研发、测试与验收权威基线

| 文档属性 | 内容 |
| --- | --- |
| 产品名称 | ChoiceMind 星枢智购 |
| 文档版本 | V1.2 |
| 状态 | 已确认需求基线；不代表功能已经实现 |
| 基线日期 | 2026-08-12 |
| 首发市场 | 中国大陆、简体中文、人民币 |
| 产品形态 | Web 端智能消费决策智能体 |
| 目标用户 | 小范围邀请测试的多画像消费者 |
| 研发资源 | 一人全栈，AI 编码工具辅助 |
| 最终目标 | P0-P4 全部完成并通过门禁后发布 V1.0 |

## 1. 文档控制

### 1.1 权威性

本文件在 ChoiceMind 产品范围、用户体验、角色权限、数据处理、领域语义、分期和 V1.0 门禁方面取代
`ChoiceMind_CoreMind_智能消费决策顾问_研发需求与实施规格书_v1.1.md`。V1.1 保留为历史输入，不再作为当前实施依据。

当前实施发生冲突时，按以下顺序裁决：本 V1.2 产品与研发规格 → `CONTEXT.md` 统一语言与领域边界 → 已接受的 ADR → 当前阶段规格。低层文档只能细化上层决定，不能静默改变产品范围、数据含义、权限或已确认的领域语义；确需改变时必须先由产品负责人确认并同步上层文档。

CoreMind 自身的接口和运行语义仍以其仓库当前版本、权威计划和 handoff 为准。ChoiceMind 不得通过复制或修改 CoreMind 内部实现来规避其公开合同。

需求术语：

- **MUST**：V1.0 必须实现，缺失即阻断发布。
- **SHOULD**：原则上实现；若不实现，必须记录原因、影响和替代。
- **MAY**：不阻断 V1.0，可作为后续增强。
- 未标注的需求默认为 MUST。

### 1.2 V1.2 的主要修正

| V1.1 表述 | V1.2 权威决定 |
| --- | --- |
| 产品名暂定 | 产品名固定为“ChoiceMind 星枢智购”。 |
| CoreMind Domain Package / Agent Skill Package | 产品是一个独立 Web 智能体；CoreMind 是运行框架，不把产品称为 Package 或工作台。 |
| 目标用户包含家庭/团队共决策 | 一个账号只代表一个用户；没有家庭、团队或多人画像。只允许分享只读快照。 |
| Decision Board / 个人决策工作台 | 用户界面称“对话”和“决策结果页”，不得出现“XX 工作台”产品概念。 |
| 按少数参考品类逐步开放 | 核心接受所有合法消费品类；按正式保障、实验性、风险拒绝三档表达能力和质量。 |
| 数据外传默认本地 | 外部模型、搜索和百炼 ASR 是正式能力；按最小化、明示、加密、可配置和审计治理。 |
| 六期及持续完全态 | V1.0 固定为 P0-P4 五期；每一期都是最终完成态的一部分。 |
| 按周排期和多人团队假设 | 不规定日期和周期；按一人全栈可独立完成的纵向切片组织。 |
| 未来受控交易协同 | 永久排除购物车、下单、支付、贷款、保险、物流、履约和代用户交易。 |
| 长期 Memory 每次逐项确认 | 首次总授权后可自动维护低敏偏好；敏感或易误判字段仍逐项确认。 |

### 1.3 变更治理

以下内容发生变化时必须先取得产品负责人确认，再修改规格、测试和 handoff：

- 产品范围、非目标和风险拒绝边界；
- 对外接口、领域对象和结果状态语义；
- 用户、管理员、超级管理员权限；
- Cookie、API Key、私人文件、长期记忆的数据处理方式；
- 数据来源、外部服务、自动备用和数据出境策略；
- V1.0 门禁和阶段退出条件；
- 发布、提交、推送、打标签或部署生产环境。

## 2. 产品定义

### 2.1 一句话定位

ChoiceMind 星枢智购是一个站在消费者立场、以个人约束和可验证证据为核心、允许得出“买、等、不买、继续使用或补充信息”结论的智能消费决策智能体。

它交付的是 **Decision（决策）**，不是商品榜单，不是电商网站，也不是通用聊天机器人。

### 2.2 需要解决的问题

消费者面对的困难不是网页数量不足，而是：

- 需求模糊，预算、尺寸、兼容性和真实场景没有被系统化；
- 官网、测评、社区、电商和短视频中的事实、观点与营销混在一起；
- 同名产品存在代际、配置、地区版、套装和卖家差异；
- 价格、库存、召回和售后信息会过期；
- 推荐系统倾向促成购买，很少认真研究“不买”或“继续用”；
- 大模型容易生成听起来合理但无法复核的结论。

ChoiceMind 必须把一次复杂购物转化为一个可暂停、可恢复、可审查的研究任务，并把结论绑定到用户、SKU、来源和时间。

### 2.3 核心产物

```text
Decision = 结论状态
         + 已确认需求与假设
         + 最适合候选及淘汰记录
         + 关键证据链
         + 负面研究与风险
         + 价格条件与购买时机
         + 不确定性和有效期
         + 用户可执行的下一步
```

Decision 状态至少包括：

- `BUY_NOW`：当前条件下可以买；
- `BUY_IF_PRICE`：产品适合，但只在给定价格或渠道条件下购买；
- `WAIT`：等待的预期价值更高；
- `KEEP_CURRENT`：继续使用现有产品更合理；
- `NEED_MORE_INFO`：关键事实不足，不能给出购买结论；
- `NO_MATCH`：当前候选均违反约束；
- `REFUSE_RISK`：请求超出风险边界，拒绝作出消费决定。

#### 2.3.1 Decision 状态语义矩阵

下表定义 V1.0 完成态的七种产品状态。Candidate 表示参与比较的消费方案，可以是待购买选项，也可以是代表用户已有设备的 `CURRENT_ASSET`。最终取舍中，每个未选 Candidate 都必须有 Candidate Disposition；`NEED_MORE_INFO` 因尚未形成最终取舍而例外。

| 状态 | Candidate 与选择 | Condition / Gap | 未选 Candidate | 风险与下一步 | P0-03 开放状态 |
| --- | --- | --- | --- | --- | --- |
| `BUY_NOW` | 至少一个 Candidate；必须选中一个具体待购买方案 | 不得存在尚待满足的 Decision Condition 或 Critical Gap | 每个未选 Candidate 必须有 Candidate Disposition | Decision Risk 只能关联被选 Candidate | 锁定，后续开放 |
| `BUY_IF_PRICE` | 至少一个 Candidate；必须选中一个具体待购买方案 | 至少一个可核验 Decision Condition；每个 Critical Gap 必须映射到购买前条件和核验步骤，无法映射则改为 `NEED_MORE_INFO` | 每个未选 Candidate 必须有 Candidate Disposition | 每个 Condition 必须有明确核验步骤；Risk 只能关联被选 Candidate | **已开放** |
| `WAIT` | 至少一个 Candidate；必须选中当前最合适的比较基准，但不构成当前购买建议 | 不得存在会推翻等待结论的 Critical Gap；至少一个 Reassessment Trigger | 每个未选 Candidate 必须有 Candidate Disposition | 必须说明等待依据及日期、事件或事实变化触发的重新评估步骤 | 锁定，后续开放 |
| `KEEP_CURRENT` | 必须选中一个代表用户已有设备的 `CURRENT_ASSET` Candidate | 不得存在会推翻继续使用结论的 Critical Gap；至少一个 Reassessment Trigger | 每个未选替代方案必须有 Candidate Disposition | Risk 只能关联被选现有设备；必须说明何时重新评估更换 | 锁定，后续开放 |
| `NEED_MORE_INFO` | 不得选择 Candidate；未达到 Minimum Viable Requirement 时 Candidate 必须为空，研究中途发现缺口时可保留部分 Candidate | 必须有至少一个明确 Gap、澄清问题和补充信息步骤 | 尚未形成最终取舍，不要求 Candidate Disposition，也不得虚构淘汰 | User 回答后形成新的 Requirement Revision，再继续研究 | **已开放** |
| `NO_MATCH` | 至少一个已研究 Candidate；不得选择 Candidate | 不得保留会使“全部不匹配”无法确定的 Critical Gap | 每个 Candidate 都必须有证明违反 Hard Constraint 或风险边界的 Elimination Record | 只能建议调整约束；User 确认后形成新的 Requirement Revision | 锁定，后续开放 |
| `REFUSE_RISK` | 在候选研究前终止；Candidate 必须为空且不得选择 | 不产生商品购买 Condition；必须有结构化请求级拒绝原因 | 不适用 | 必须说明安全边界和安全替代下一步；属于正常完成的安全 Decision，不是系统失败 | 锁定，后续开放 |

Candidate Disposition 必须区分：

- **Elimination Record**：Candidate 有证据证明违反 Hard Constraint 或风险边界；
- **Not-selected Record**：Candidate 满足硬约束，但综合适配度低于被选方案；不得伪装成硬约束违规。

状态按语义完备度分阶段开放。产品枚举属于 V1.0 最终范围，不代表每个早期合同版本都能安全生成或接受全部状态；开放门禁见 ADR-0003 与对应阶段规格。

P0-03 的阶段合同进一步失败关闭：在结构化 Preference Criterion、Candidate Comparison 和 User Fit 尚未具备前，只允许有 Hard Constraint 违规证据的 Elimination Record，不允许 `NOT_SELECTED`。多个 Candidate 均满足 Hard Constraint 且缺少已确认取舍偏好时，必须形成 `NEED_MORE_INFO` 追问；Decision Risk 必须引用被选 Candidate 的可信 Claim。该阶段决定不删除 V1.0 完成态的 Not-selected Record。

### 2.4 产品原则

| 编号 | 原则 | 强制约束 |
| --- | --- | --- |
| PR-01 | 需求先于商品 | 未建立最低可用需求前不得直接给热门榜单。 |
| PR-02 | Best Fit | 结论必须解释为何适合这个用户，而非声称通用最好。 |
| PR-03 | 证据优先 | 关键事实没有证据就不能作为确定结论。 |
| PR-04 | 主动证伪 | Standard/Deep 的 Top Candidates 必须执行 Negative Research 和 Decision Critic。 |
| PR-05 | 允许不买 | 不买、等待和继续使用与购买同等合法。 |
| PR-06 | 时效诚实 | 当前价、库存、型号、召回等必须绑定来源、SKU 和抓取时间。 |
| PR-07 | 用户控制 | 用户能管理画像、记忆、私有密钥、分享和私人文件。 |
| PR-08 | 失败可见 | 工具或模型失败不得被包装成成功。 |
| PR-09 | 核心品类无关 | 新增品类不得在核心状态机和 Decision Engine 中增加品类分支。 |
| PR-10 | 不促成交易 | 排名不得受佣金或广告影响，系统永不替用户完成交易。 |

## 3. 范围与边界

### 3.1 V1.0 包含

- Web 端注册、登录、对话、任务状态、决策结果、证据查看、反馈和分享；
- 需求澄清、市场扫描、候选发现、实体/SKU 归一、比较和淘汰；
- 官网、说明书、认证、召回、搜索网页、社区、短视频和电商信息研究；
- 文本、网页、PDF、办公文档、图片、视频字幕/语音和关键帧解析；
- UGC 聚合、冲突处理、转载去重、负面研究和来源可靠性判断；
- 价格、库存、渠道、历史观测、总拥有成本和 Buy-or-Wait；
- 个人适配、风险门禁、Decision Critic 和证据化报告；
- 用户授权的长期偏好、已有设备、尺寸、预算习惯和使用反馈；
- 平台模型、本地免费模型和用户自有 API Key；
- 用户、管理员、超级管理员三类角色；
- 后台的模型、数据源账号、Cookie、ASR、健康检查和反馈管理；
- Windows 开发验证和 Linux Docker Compose 部署。

### 3.2 永久排除

ChoiceMind 不是购物网站，以下能力不进入当前或远期产品范围：

- 购物车、订单、结算、支付、分期、贷款、保险；
- 自动领券、自动下单、抢购、代购或代用户签约；
- 收货地址、发票、仓储、物流、配送、安装履约和售后代办；
- 以联盟佣金、广告费或商家出价改变排序；
- 读取或操作用户私信、联系人、订单、地址、支付、收藏和浏览历史；
- 点赞、关注、评论、发帖、私信或修改第三方账号；
- 医疗诊断、处方、用药或治疗决策；
- 投资、贷款、保险、法律结论和房地产投资决策；
- 烟草、违法商品、武器和其他高风险商品推荐。

允许提供商品链接、价格提醒、购买核对清单、保修/退换注意事项和“去哪核验”，但最终操作始终由用户在外部平台完成。

### 3.3 品类策略

不通过固定白名单限制合法消费品类，而是使用三档质量状态：

| 状态 | 含义 | 允许的输出 |
| --- | --- | --- |
| `FORMAL` | 该品类的关键约束、来源、风险和 Gold Set 已通过门禁 | 可在证据充分时给出完整 Decision。 |
| `EXPERIMENTAL` | 通用核心可以研究，但类别规则或数据质量尚未完全认证 | 明示实验性；仅给条件式结论，缺口可见。 |
| `REFUSED` | 请求触发永久风险边界或硬安全策略 | 解释边界，必要时建议专业渠道。 |

V1.0 优先建设和交叉验证的类别包括：

- IT 与数码：电脑、显示器、网络设备、外设及相关软硬件；
- 智能家居：中控、传感器、照明、门锁和生态兼容设备；
- 家庭机器人：擦窗机器人、扫拖机器人等；
- 家具与机电家居：电动沙发等涉及尺寸、进门、承重和电机的商品；
- 核心家电：洗衣、烘干、冰箱、空调等；
- 个体适配产品：跑鞋等。

这些类别用于证明通用性和建设 Gold Set，不代表其他合法品类被禁止。

### 3.4 高风险普通消费

- 母婴、保护装备、按摩或康复类商品：只分析公开产品事实、认证、召回和适用条件；不推断疾病或疗效。
- 涉及人身安全的关键未知项：提升研究深度，并在缺证据时输出 `NEED_MORE_INFO`。
- 药品、处方、用药和治疗：输出 `REFUSE_RISK`，不得给购买或使用决定。
- `RiskPolicy` 是不可绕过的硬模块，管理员和超级管理员均不能关闭。

## 4. 用户、角色与隔离

### 4.1 账号模型

- V1.0 支持邀请码注册和管理员代注册。
- 登录凭证为用户名或邮箱加密码。
- 一个账号只对应一个用户，不存在家庭、团队或多人共享画像。
- 用户的 Session、Decision、Memory、API Key、第三方登录态、上传文件和反馈相互隔离。
- 用户可分享 Session/Decision 的选择性只读快照，但分享对象不能访问原始会话。

### 4.2 角色

| 能力 | 用户 | 管理员 | 超级管理员 |
| --- | --- | --- | --- |
| 使用智能体和管理本人数据 | 是 | 可使用自己的普通用户空间 | 可使用自己的普通用户空间 |
| 用户启用/停用、邀请码、代注册 | 否 | 是 | 是 |
| 数据源公共账号与健康检查 | 否 | 是 | 是 |
| 反馈列表、分类与处理状态 | 本人反馈 | 是 | 是 |
| 模型全局启停和平台 API Key | 否 | 否 | 是 |
| 管理管理员角色 | 否 | 否 | 是 |
| 安全审计、应急总开关 | 否 | 否 | 是 |
| 查看用户私人会话/画像 | 仅本人 | 否 | 否 |
| 查看明文 API Key/Cookie | 否 | 否 | 否 |

管理员如需排查反馈，只能在用户明确勾选后读取随反馈提交的脱敏 Session/Decision 快照；授权仅覆盖该次反馈，不构成持续访问。

## 5. 功能需求

### FR-001 账号、邀请与权限

- 支持邀请码注册、管理员代注册、登录、退出、密码修改、账号停用和删除。
- RBAC 必须在 API 层实施，不能只依赖前端隐藏。
- 所有资源查询必须包含服务端用户归属检查。
- 管理员和超级管理员操作写入不可篡改审计事件。

**验收：**跨用户访问、越权管理、对象 ID 猜测和分享链接越权测试全部通过；权限缺陷为 0。

### FR-002 对话、任务和用户可见状态

- 用户通过多轮对话提出消费问题，智能体优先询问真正会改变结论的问题。
- 系统自动选择 Quick、Standard 或 Deep，并向用户说明原因；用户可以覆盖深度，但不能降低安全门禁。
- Deep 任务在后台执行，用户关闭网页后继续运行。
- 支持暂停、恢复、取消和从 checkpoint 安全继续；仅当 Runtime 权威快照标记 `resumable=true`，且未完成副作用的 Effect Receipt 证明可以重放时，才允许自动恢复。
- 已提交调用不得自动重放；`started` 或 `unknown` 副作用必须暂停并人工核验。系统通过幂等键、结果复用和成本记录避免重复调用与重复成本，但不得把第三方系统描述为保证“恰好一次”。
- Session 流式显示“理解需求、制定计划、搜索、抓取、解析、核验、负面研究、比较、生成结论、完成”等用户可理解状态。
- 状态可以显示来源/工具名、成功、失败、重试、暂停、降级、耗时和模型调用量，但不得展示模型私有思维链。

**验收：**状态与真实运行事件一致；刷新页面或进程重启后，安全恢复边界内的任务可继续；不安全副作用进入人工核验；失败状态不得显示“已完成”。

### FR-003 需求画像与研究深度

- 将自然语言转为带 revision 的 `PurchaseRequirement`。
- 区分预算、预算弹性、场景、频率、Must Have、Nice to Have、Must Not Have、尺寸、已有产品、生态兼容、时间和关键未知项。
- 假设必须标记为 `assumed`，允许用户随时纠正。
- Hard Constraint 不能被其他高分抵消。
- 决策复杂度只控制研究投入，不直接决定推荐结果。

**验收：**已确认 Hard Constraint 的最终候选违反率为 0；需求修改产生新 revision 且可比较。

### FR-004 品类无关核心与 Category Package

- 核心状态机、Requirement、Candidate、Claim/Evidence、Risk、Fit、Price 和 Decision 语义保持品类无关。
- 品类差异优先以 Schema、规则、查询模板、风险主题和 Gold Set 表达。
- 特殊分析只能通过统一 `CategoryCapability` 接口扩展。
- `core/**` 禁止依赖 `categories/**`；核心禁止按 category ID 写条件分支。

**验收：**新增合成品类包时 core diff 为 0；架构依赖门禁通过。

### FR-005 市场扫描、候选与 SKU 身份

- 跨品牌、跨型号、跨品类发现候选，包含“继续使用、维修、租赁、二手、不买”等替代方案。
- 区分品牌、产品族、型号、代际、配置、颜色/尺寸、地区版、套装、卖家和商品状态。
- 候选淘汰必须保留约束和证据原因。
- 当前价格和库存必须先绑定 SKU、卖家、渠道和抓取时间。

**验收：**地区版、代际、配置和套装误合并为 0；无正确 SKU 身份时禁止声称确定价格。

### FR-006 多源发现与数据采集

V1.0 数据源至少包括：

- 品牌官网、说明书、认证、召回和售后政策；
- 通用搜索、网页、PDF 和用户上传资料；
- 社交/内容平台：抖音、小红书、哔哩哔哩、知乎；
- 电商：京东、淘宝/天猫、拼多多；
- 微博、贴吧可配置，但不作为 V1.0 阻断源。

采集要求：

- 优先复用 Crawl4AI、Scrapling、MediaCrawler、Playwright 等成熟项目；Firecrawl 仅作为可选 Adapter，不作为必需依赖。
- 不破解验证码、不绕过登录、不对抗访问控制、不使用未批准的隐蔽反检测技术。
- 遇到验证码、风控、限流、登录失效或页面结构变化时停止、重试或降级，并准确呈现失败。
- 数据来源必须记录 URL、平台、公开作者/机构、发布时间、抓取时间、内容 ID 和适用市场/SKU。
- 所有外部网页内容按不可信数据处理，不能改变系统指令、权限、工具或模型路由。

**验收：**所有 MUST 数据源均有真实样本成功、空结果、登录失效、限流和页面变化用例；固定快照测试不等于实时源认证。

### FR-007 数据源账号、Cookie 与扫码登录

- 管理后台维护公共研究账号别名、平台、状态、最近验证、失效原因和更新时间。
- 管理员可以更新 Cookie 或发起二维码登录，但系统不得显示或导出 Cookie 明文。
- 公共账号失效且管理员未及时更新时，可提示用户扫描第三方平台二维码，使用用户自己的登录态完成只读研究。
- 用户登录态按用户和平台隔离、加密保存，保留到失效、用户主动删除或安全策略撤销。
- 只读操作白名单：搜索、打开公开内容、读取公开评论；禁止点赞、关注、评论、私信、发帖、下单和账号设置。
- 遇到验证码、异常验证或封禁风险信号立即停止，不承诺“零封禁风险”。

用户提示必须诚实说明：ChoiceMind 仅使用研究所需登录态，不主动读取私信、联系人、订单、地址、支付、收藏和历史，不执行互动或交易；自动访问仍可能触发平台验证，触发后系统会停止。

**验收：**Cookie 不进入日志、模型上下文、报告、反馈快照或管理员页面；跨用户登录态读取为 0。

### FR-008 多模态解析与语音转写

- PDF、DOCX、PPTX、XLSX 和图片优先通过 MinerU 与 OCR Adapter 解析。
- 视频处理至少包含字幕、音轨转写和关键帧；引用必须定位到时间点或时间段。
- 小红书图片等图文内容进行 OCR、视觉描述和图文上下文关联。
- 评论保留父子关系、公开时间、公开互动指标和上下文，不把单条高赞评论当作事实。
- 语音转写采用双通道：百炼为主，本地 FunASR 为备用，均通过 `SpeechTranscriptionProvider`。
- 百炼默认使用适合长文件的非实时模型；本地优先采用 FunASR 的 OpenAI 兼容服务。
- 公开视频默认百炼失败后自动转本地；私人文件未同意发送百炼时只走本地。
- 私人文件发送百炼前必须取得单次明确同意。

**验收：**真实消费视频能产出带时间戳的转写和关键帧证据；双通道切换、拒绝云端同意和双失败均有正确状态。

### FR-009 Evidence、Claim 与证据链

- Claim 必须使用独立的 `ClaimKind` 标记为 `FACT_ASSERTION`、`SOURCE_OPINION` 或 `SYSTEM_INFERENCE`；Claim Kind 不表示证据是否可信。
- P0-03 的 Hard Constraint 满足/违反判定、Elimination 和最终选择只能使用 `ClaimKind = FACT_ASSERTION` 且派生 `EvidenceState = SUPPORTED` 的 Claim；`SOURCE_OPINION` 与 `SYSTEM_INFERENCE` 可以保留和展示，但在来源聚类与样本范围合同、推断前提合同具备前，不得单独形成上述判定或结论。
- `ClaimEvidenceLink` 是 Claim 与 Evidence 之间支持/反驳方向的唯一关系记录；删除 `Claim.evidenceIds` 以及 `Evidence.claimId`、`Evidence.direction`，不得在关系两端保留可互相冲突的副本。同一 Evidence 可以通过不同 Link 关联多个 Claim，每个 Claim 仍独立形成 Assessment。
- 同一 `claimId + evidenceId` 组合至多存在一条 Link，重复 Link 或同时出现 `SUPPORTS`、`REFUTES` 必须返回 `CONTRACT_INVALID`。若一个来源片段表达了方向不同的多个事实，上游必须拆成原子 Evidence 或细化 Claim 后再建立 Link；合同不从自由文本猜测方向。
- Claim 可以没有 Link，此时规范化 Assessment 必须为 `INSUFFICIENT`；每份 Evidence 必须至少通过一条 Link 关联 Claim，且 Link 两端必须存在并属于同一 Decision Task。孤立 Evidence、断链或跨 Task Link 均返回 `CONTRACT_INVALID`，不得降级为“证据不足”。
- `EvidenceState` 只能由 Decision Basis 根据 Claim 的全部有效 Evidence 派生为 `SUPPORTED`、`REFUTED`、`CONFLICTED` 或 `INSUFFICIENT`；Runtime、模型、Provider 或 Adapter 自报的状态不具权威性，Decision 消费者只能读取该派生 Assessment。
- Evidence Eligibility 固定以 `Decision.validFrom` 为评估时点；`validUntil` 早于该时点的 Evidence 可以保留和展示用于追溯，但不得参与权威 Assessment。用户日后回看时不得按当前系统时间改写历史 Assessment；Decision 自身是否已经过期由界面另行提示。
- `Evidence.capturedAt` 晚于 `Decision.validFrom` 表示 Decision 引用了未来证据，`Evidence.validUntil` 早于其 `capturedAt` 表示有效期倒置；两者均返回 `CONTRACT_INVALID`。最终生成器必须在证据采集完成后确定 `Decision.validFrom`。
- 最终版本化 Decision Result 必须携带由 Decision Basis 生成的规范化 `ClaimAssessment`，明确 Claim 的 Evidence State 及支持、反驳两侧 Evidence；Runtime 只提交 Claim、Evidence 及其关系，不得提交权威 Assessment。API、Orchestrator 与 Web 等跨进程解码入口必须根据同一输入重新派生并精确核验，任何缺失、伪造或不一致均返回 `CONTRACT_INVALID`，不得静默改写后继续形成结论。
- `BUY_NOW`、`BUY_IF_PRICE`、`WAIT`、`KEEP_CURRENT` 或 `NO_MATCH` 不得依赖 `CONFLICTED` 或 `INSUFFICIENT` 的 Claim；Decision Engine 必须排除该依据后重新决策，若它不可替代则返回 `NEED_MORE_INFO`。请求级安全拒绝 `REFUSE_RISK` 不依赖商品 Claim，不受本门禁限制。
- 未发布 v1 采用严格迁移：删除旧 `Claim.status`、`Claim.evidenceIds`、`Evidence.claimId` 和 `Evidence.direction`，一次性迁移本地调用方、测试和固定样本；旧格式必须返回 `CONTRACT_INVALID`，不得保留新旧格式双读或让旧状态、旧关系参与派生。
- Evidence State 派生不得为此引入生产规则引擎、RDF 或通用图框架；使用可审查的确定性纯函数实现四格真值表。
- 后续 TDD 可以在取得单独依赖安装授权后原型评估 `fast-check`，仅用于开发期性质测试；它不得进入生产 Runtime，也不得成为 Evidence State 的实现权威。
- Evidence 记录来源、片段、截图/时间点、发布时间、抓取时间、适用 SKU、哈希、商业偏见和独立来源簇。
- 本规格中的 Evidence 专指能够支持或反驳消费决策 Claim 的来源证据。CoreMind 的工具执行、工程验证和运行 Trace 只属于 Runtime Execution Evidence；未经领域校验并绑定 Source，不得进入 Claim/Evidence Graph。
- 转载和搬运必须聚类，不得被当成多个独立来源抬高置信度。
- 冲突证据并存展示；系统不能只选择支持初始判断的一方。
- 关键事实默认显示 3-5 个核心依据，并可展开 `[E12]` 等证据编号查看详情。
- Decision 的解释路径必须能够回到“约束 → 淘汰 → 证据 → 负面研究 → 结论”。

**验收：**关键事实证据覆盖率 100%；来源可定位率 100%；无证据不得产生当前事实断言。

### FR-010 UGC、负面研究与冲突

- 区分官方事实、专业实测、短期体验、长期体验、商业测评和社区讨论。
- 汇总 UGC 时说明样本范围、时间分布、平台分布、观点分歧和无法确定的偏差。
- 主动研究设计缺陷、耐久、召回、安全、兼容、隐私、售后、生态锁定、耗材和不适配人群。
- 单例不得泛化为普遍结论；无法核实的争议必须保持争议状态。

**验收：**Standard/Deep 的每个 Top Candidate 都有 Negative Research；高严重度风险漏检阻断发布。

### FR-011 价格、库存和购买时机

- 每条价格记录市场、币种、SKU、卖家、商品状态、套装、税费/运费、优惠前提、会员条件、库存和抓取时间。
- 区分标价、到手价、分期总成本、二手价和总拥有成本。
- 历史最低价只作为观测，不得声称当前可复现。
- Buy-or-Wait 同时考虑潜在降价、新品收益、当前痛点、等待成本和不确定性。
- 数据过期或不可访问时输出未知、阈值或人工核验清单。

**验收：**错误 SKU、卖家或条件绑定为 0；无证据价格断言为 0。

### FR-012 User Fit、Decision Engine 与 Critic

- Fit 至少覆盖场景、频率、技能、物理尺寸、生态兼容、学习成本、维护成本、预算和偏好。
- Decision Engine 先执行 Hard Constraint/veto，再进行效用、证据、风险、不确定性和 TCO 比较。
- 总分不能掩盖关键限制；默认展示区间、置信和主要驱动因素。
- Decision Critic 检查证据缺口、确认偏误、遗漏替代、反例、时效和商业偏见。
- Critical Gap 存在时禁止 `BUY_NOW`。

**验收：**固定输入和固定证据可重放；高置信 Decision 必须有 Critic 记录。

### FR-013 决策结果页、报告与分享

- 首屏展示结论、适用条件、最大风险、价格阈值、有效期和下一步。
- 详情展示需求、候选对比、淘汰原因、证据、负面研究、价格、Fit、Critic 和 revision。
- 支持人类可读导出和机器可读 JSON 导出。
- 用户可选择 Session/Decision 的部分内容创建只读分享快照。
- 分享自动移除画像、API Key、Cookie、内部日志和未选择的历史；支持有效期、密码和撤销。
- 分享对象无法访问原始 Session；原 Decision 更新时，旧分享不自动变化，除非用户明确发布新版本。

**验收：**分享越权为 0；每份报告和分享均带 revision、生成时间和数据有效期。

### FR-014 长期记忆与用户控制

- 首次授权时解释允许智能体自动维护哪些低敏消费信息。
- 获得一次总授权后，可自动维护普通偏好、预算习惯、已有设备、普通尺寸和使用反馈，并显示变更摘要与撤销入口。
- 身体健康、精确位置、儿童、孕产等敏感或易误判信息必须逐项确认。
- 推断内容不得静默写成用户事实；不确定信息先作为 Session 假设。
- 用户可以查看、修改、导出、删除或完全停用长期记忆。
- 删除覆盖主存储、向量索引、派生特征和缓存，并保留不含原文的删除审计凭证。

**验收：**未授权长期写入为 0；查看、修改、导出和删除 E2E 全部通过。

### FR-015 点赞、点踩与反馈管理

- 用户可以对每个 Decision revision 点赞或点踩。
- 可选原因包括结论不合适、证据不足、数据过期、遗漏候选、内容错误、表达问题和其他文本。
- 默认不附带完整 Session；用户明确同意后才附带脱敏快照。
- 管理员可以筛选、分类、标记处理状态和关联修复 Issue。
- 反馈不能自动改变用户画像、系统提示词或训练模型。

**验收：**反馈准确绑定 revision；未授权会话内容不进入后台；处理记录可审计。

### FR-016 模型 Provider、平台密钥与用户 BYOK

- 主模型使用外部 API，首批由平台提供百炼和 DeepSeek API Key。
- 支持配置百炼/Qwen、DeepSeek、Moonshot/Kimi、Z.ai/GLM、小米 MiMo、OpenAI GPT、xAI Grok、Anthropic Claude，并保留 Gemini、OpenRouter 等扩展接口。
- ChatGPT、Claude Code 等产品名称不得被误当成 API 模型；后台以 Provider、Base URL、Model ID 和能力矩阵配置。
- 用户后期可以配置自己的 API Key；服务端加密保存，只能验证、替换或删除，不能回显明文。
- 平台密钥仅提供全局启用/停用；停用后提示用户 BYOK 或使用免费本地模型，不建设复杂用户额度系统。
- 每个任务仍有模型调用次数和总时长上限，以防失控循环。
- 本地 `Qwen3.6-35B-A3B` 是免费测试与备用模型，不是默认主模型。

**验收：**百炼至少一个模型和 DeepSeek 至少一个模型通过真实认证；本地 Qwen 通过项目集成测试；其他 Provider 未认证时必须标注。

### FR-017 管理后台

后台是管理界面，不是面向消费者的“工作台”。至少包含：

- 用户、邀请码和账号状态；
- 管理员与超级管理员角色；
- Provider、Base URL、模型、能力、平台 API Key、启停和真实测试；
- 用户 BYOK 功能开关，但不显示用户密钥；
- 数据源公共账号、Cookie/二维码更新、健康和最近失败；
- 百炼 ASR 与本地 FunASR 的端点、模型、优先级、自动备用、超时和测试；
- Embedding、Reranker、OCR、MinerU 的端点和健康检查；
- 反馈管理、任务健康、来源健康、安全审计和应急停用。

**验收：**所有配置变更有操作者、时间、旧值摘要和新值摘要；秘密字段永不写入审计正文。

### FR-018 文件保留、证据失效与用户删除

- 抓取的大型原始视频、音频和完整截图默认保留 7 天。
- 到期后保留证据结构：原 URL、平台、公开作者、发布时间、抓取时间、内容 ID、引用片段、时间点、关键帧哈希和分析结果。
- 到期后界面显示外部 URL；来源不可访问时标记 `SOURCE_UNAVAILABLE`，不能假装仍可复核。
- 用户可在到期前选择“保留来源”，转为长期对象存储。
- 用户上传文件随 Session 保留，用户可删除；删除后相关 Decision 标记证据缺失。
- 私人文件发送百炼前取得单次同意；未同意时只能使用本地 ASR。

**验收：**保留、到期、外链失效和用户删除均有自动化测试；删除后不可从缓存或索引恢复正文。

### FR-019 硬风险策略

- `RiskPolicy` 在模型调用和工具执行之前进行意图检查，在 Decision 之前再次检查结果。
- 普通消费允许；母婴、保护、按摩/康复提高门禁；药品/治疗、金融、法律、烟草、违法和武器按边界拒绝。
- 外部模型、管理员配置和网页提示均不能覆盖 RiskPolicy。
- 拒绝结果解释原因并提供安全的下一步，而不是只返回错误码。

**验收：**安全 Gold Set 中硬拒绝绕过率为 0。

## 6. 统一领域模型

### 6.1 核心术语

| 术语 | 定义 |
| --- | --- |
| User | 唯一的个人账号主体；不是家庭或团队。 |
| Session | 用户与智能体的一组连续对话。 |
| Decision Task | 可后台执行、暂停、恢复、取消和审计的一次消费研究任务。 |
| Requirement Revision | 用户需求和假设的不可变版本。 |
| Research Plan | 针对需求和证据缺口生成的有界研究计划。 |
| Candidate | 绑定型号、代际、市场和 SKU 身份的候选方案。 |
| Claim | 可被证据支持、反驳、冲突或保持未知的最小命题。 |
| Evidence | 带来源、适用范围、时效和定位信息的证据片段。 |
| Runtime Execution Evidence | CoreMind 产生的工具执行、工程验证和运行轨迹证据；用于恢复、审计和运行验真，不直接证明消费事实。 |
| Evidence Gap | 缺失后可能改变结论或阻止高置信 Decision 的信息。 |
| Decision Revision | 带结论、条件、依据、风险和有效期的不可变版本。 |
| Memory Item | 用户授权保存、可修改和删除的长期个人信息。 |
| Source Credential | 第三方平台登录态；与用户账号和 API Key 分开。 |
| Provider Credential | 平台或用户提供的模型/服务 API Key。 |
| Share Snapshot | 从指定 revision 派生的脱敏只读副本。 |

避免使用：家庭画像、团队空间、多人决策、购物工作台、自动购买、代下单。

### 6.2 对象关系

```text
User 1 ── * Session 1 ── * DecisionTask
  │                          ├── * RequirementRevision
  │                          ├── * ResearchPlanRevision
  │                          ├── * RunEvent / Checkpoint
  │                          ├── * Candidate / SKU
  │                          ├── * Claim ← * Evidence
  │                          └── * DecisionRevision ← CritiqueReport
  ├── * MemoryItem / MemoryRevision
  ├── * ProviderCredential
  ├── * SourceCredential
  └── * ShareSnapshot / Feedback
```

### 6.3 任务状态

```text
CREATED → UNDERSTANDING → PLANNING → RESEARCHING
       ↘ PAUSED_USER       ↕
                         VERIFYING ↔ GAP_RESEARCH
                                      ↓
                            COMPARING → CRITIQUING
                                      ↓
                                  GENERATING
                                      ↓
                                  COMPLETED

任意运行态 → PAUSED_PERMISSION / PAUSED_SOURCE_LOGIN / PAUSED_LIMIT
           → CANCELLED / FAILED
```

只有处于 `PAUSED_*`、Runtime 权威快照标记 `resumable=true` 且副作用收据证明安全的运行，才能从持久化 checkpoint 原位恢复；`FAILED`、`CANCELLED` 等终态不得原位 resume，应创建新的重试运行并只复用已验证结果。重复 resume 必须幂等。

## 7. 模型、工具和已验证本地环境

### 7.1 模型路由原则

- 外部主模型优先，平台可配置首选、备用和能力要求。
- 路由依据包括结构化输出、工具调用、多模态、上下文、价格、延迟和认证状态。
- 自动备用只能发生在管理员批准的 Provider 链内，并在 Session 中显示。
- Provider 切换不能改变安全规则、Evidence 门禁或 Decision 语义。

### 7.2 2026-08-12 最小实测基线

| 服务 | 地址 | 已验证事实 | 当前结论 |
| --- | --- | --- | --- |
| Qwen3.6-35B-A3B | `192.168.121.32:6012` | OpenAI Chat/Responses/Messages；文本、JSON Schema、工具调用、图片和 SSE 最小样本通过；上下文上限报告 65536 | 测试与备用；仍需完整项目认证 |
| Qwen3-Embedding-4B | `192.168.121.33:8008` | `/v1/embeddings`；最小样本返回 2560 维归一化向量 | 可作为初始向量服务 |
| Qwen3-Reranker-4B | `192.168.121.33:8012` | `/v1/rerank`；中文相关性排序最小样本通过；服务报告最大长度 1024 | 可用，但必须测试截断和长文档策略 |
| PaddleOCR-VL-1.6-0.9B | `192.168.121.33:18080` | 实际为视觉 OCR 的 OpenAI 兼容服务；图片文字识别通过 | 作为 OCR/Vision Adapter，不称为 MinerU |
| MinerU 3.4.4 | `192.168.121.33:8000` | 健康、同步/任务接口；图片解析返回 Markdown；支持 PDF、图片和办公文档 | 作为文档解析 Adapter |

最小样本通过不等于生产认证。还需覆盖批量、并发、长输入、超时、取消、错误映射、恢复、真实消费资料和 Windows/Linux 网络路径。

### 7.3 ASR 路由

```text
公开音视频：BailianASR → LocalFunASR → 明确失败/暂停

私人音视频：
  用户同意云端处理：BailianASR → LocalFunASR
  用户不同意云端处理：LocalFunASR only
```

后台可配置 Provider 启停、地址、模型、优先级、自动备用、超时、文件限制和健康测试。

## 8. 非功能需求

| 编号 | 要求 |
| --- | --- |
| NFR-001 正确性 | Hard Constraint、RiskPolicy、当前事实和错误语义不能被平均分或模型文案覆盖。 |
| NFR-002 证据性 | Decision → Claim → Evidence → Source/Tool Run 全链可定位。 |
| NFR-003 隔离 | Session、Memory、文件、Cookie、API Key、分享和缓存按用户隔离。 |
| NFR-004 秘密保护 | API Key/Cookie 服务端加密；不回显、不进入日志、模型、报告或反馈。 |
| NFR-005 可恢复 | Postgres 保存权威业务状态并关联 Runtime 快照/checkpoint；只在安全边界 resume，已提交调用不重放，不确定副作用转人工核验，并通过幂等键与结果复用避免重复成本。 |
| NFR-006 可观测 | 任务状态、来源、工具、模型、耗时、错误、重试、证据覆盖和 freshness 可观测。 |
| NFR-007 性能 | 目标容量：100 注册用户、20 同时在线、10 个并行 Deep Research 任务。 |
| NFR-008 可移植 | Windows 开发验证与 Linux Docker Compose 使用同一服务合同。 |
| NFR-009 可访问 | Web 响应式；键盘可完成关键流程；颜色不是唯一状态信号。 |
| NFR-010 数据治理 | 保留、导出、删除、外传同意、分享和管理员操作可审计。 |
| NFR-011 可演进 | 核心接口稳定，Provider、数据源、存储和 Category 可替换。 |
| NFR-012 编码 | 源码、注释、文档、样本和输出统一 UTF-8，无乱码。 |

## 9. 数据保留与隐私矩阵

| 数据 | 默认保留 | 用户控制 | 管理员可见 |
| --- | --- | --- | --- |
| Session/Decision | 持久化，直至用户删除 | 查看、导出、删除 | 否 |
| 低敏 Memory | 首次总授权后持久化 | 查看、修改、导出、删除、停用 | 否 |
| 敏感 Memory | 默认不保存 | 逐项确认、删除 | 否 |
| 用户 API Key | 加密，直至删除/失效 | 验证、替换、删除 | 仅状态，不见明文 |
| 用户 Source Credential | 加密，直至失效/删除 | 查看状态、更新、删除 | 仅公共账号；用户明文不可见 |
| 抓取大文件 | 7 天 | 到期前转长期保留 | 仅健康与容量摘要 |
| 用户上传文件 | 随 Session | 删除 | 否 |
| 分享快照 | 用户设定有效期 | 密码、撤销、重新发布 | 否 |
| 反馈快照 | 默认不附带 | 单次明确同意 | 脱敏后仅授权范围 |

## 10. V1.0 发布门禁

所有门禁同时通过才可称为 V1.0 完成；单元测试通过、某一数据源可用或某一期完成均不能替代发布门禁。

| 门禁 | 必须达到 |
| --- | --- |
| 硬约束 | Gold Set 中已确认 Hard Constraint 违反数为 0。 |
| 关键证据 | 关键事实 Evidence 覆盖率 100%，来源定位率 100%。 |
| 当前事实 | 价格、库存、型号等全部绑定 SKU、来源和抓取时间；无证据不声称。 |
| 反证 | Standard/Deep Top Candidates 的 Negative Research 和 Decision Critic 执行率 100%。 |
| 风险 | RiskPolicy 绕过数为 0；Critical Gap 下 `BUY_NOW` 为 0。 |
| 隔离 | 跨用户 Session、Memory、文件、Cookie、API Key、缓存和分享访问测试全部通过。 |
| 秘密 | Cookie/API Key 明文出现在日志、模型上下文、报告、后台和反馈中的次数为 0。 |
| 失败语义 | 超时、限流、登录失效、验证码、模型失败、源失效和重启均正确暂停、恢复或失败；伪成功为 0。 |
| 容量 | 100 注册用户、20 同时在线、10 并行 Deep 任务的目标压测通过。 |
| 环境 | Windows 开发主流程和 Linux Docker Compose 主流程均通过。 |
| 模型 | 百炼和 DeepSeek 各至少一个模型通过真实认证；本地 Qwen 通过集成认证。 |
| 数据源 | 官网/文档、搜索、抖音、小红书、B站、知乎、京东、淘宝/天猫、拼多多均有真实样本与失败样本。 |
| 多模态 | OCR、MinerU、百炼 ASR、本地 FunASR、关键帧和时间戳证据通过真实样本。 |
| 用户控制 | Memory、BYOK、登录态、分享、文件和账号的查看/修改/删除流程通过。 |
| 可运维 | 备份恢复、监控告警、配置审计、应急停用和恢复演练通过。 |

## 11. 五期实施路线

不规定开发时间。每期都必须形成可独立复核的证据包，阶段转换由产品负责人确认。

### P0：合同、边界与可验证底座

**目标：**冻结 V1.0 不可绕过的领域、接口、安全和发布语义。

范围：

- Monorepo、开发规范、CONTEXT、ADR 和 handoff 机制；
- CoreMind 集成边界、确定性 Fake 合同样本，以及 Claim/Evidence 输出合同修正后提前接入的最小 `run` Adapter；
- Requirement、Candidate、Evidence、Decision、RunEvent、RunSnapshot、Effect Receipt、Checkpoint、错误合同；
- Provider、DataSource、DocumentParser、ASR、Embedding、Reranker、ObjectStore、TaskTransport 接口；
- PostgreSQL/pgvector、Redis、SeaweedFS 的开发基线；
- RBAC、RiskPolicy、秘密加密、审计和用户隔离测试骨架；
- 跨品类 Gold Set、数据源真实样本计划和发布门禁自动化骨架。

P0 的 CoreMind 接入分为两个受控切片：P0-07A 在 Claim/Evidence 输出合同稳定后，通过薄 Adapter 和确定性测试 Provider 尽早跑通最小 `run` 链路；P0-07B 再补齐事件流、暂停恢复、取消、RuntimeSnapshot、EffectReceipt 和安全恢复。最小链路通过不代表完整生产 Runtime 或最终框架认证，两个切片均需单独授权与验收。

退出门禁：核心合同版本化；合成 Category 不改 core；失败不能伪成功；本地五个已知服务完成合同测试。

### P1：可用智能体 Alpha

**目标：**让受邀用户通过 Web 完成一次真实的、带证据的消费决策。

范围：

- 邀请注册、登录、对话、后台任务、SSE 状态、暂停/恢复/取消；
- CoreMind Orchestrator、外部主模型、本地 Qwen 备用；
- Crawl4AI/MediaCrawler/浏览器最小真实链路，至少打通小红书、抖音和通用网页；
- 管理员公共账号、Cookie 检验更新和用户扫码；
- MinerU、OCR、百炼 ASR、本地 FunASR、视频关键帧；
- Requirement → Candidate → Evidence → Negative → Decision → 结果页的完整纵向闭环；
- 选定参考类别的真实样本。

退出门禁：完整链路可运行且失败可见；关键证据可展开；Alpha 只用于内部/小范围测试，不称 V1.0。

### P2：可信研究 Beta

**目标：**从“能跑”升级为“结论可验证、冲突和时效诚实”。

范围：

- SKU/实体图谱、Evidence Graph、转载去重和冲突；
- 评论树、UGC 主题、Negative Research、Decision Critic；
- 价格、库存、卖家、渠道、freshness、历史观测和 TCO；
- 京东、淘宝/天猫、拼多多、B站、知乎及所有 MUST 源适配；
- 正式/实验性品类状态、跨类别评测和真实样本回归。

退出门禁：关键事实覆盖、错误 SKU 绑定、负面研究、数据源失败语义达到 V1.0 门禁；仍是 Beta，不自动发布。

### P3：个性化与运营闭环

**目标：**让用户可以长期使用，同时不给管理员越权访问私人数据。

范围：

- Memory 首次总授权、敏感逐项确认、自动低敏更新、查看/修改/导出/删除；
- 用户 BYOK、平台密钥全局启停和 Provider 管理；
- 管理员/超级管理员、邀请、数据源账号、ASR 和本地服务配置；
- 点赞点踩、单次反馈快照授权和反馈管理；
- Session/Decision 分享、密码、有效期、撤销和导出；
- 大文件 7 天策略、外链失效和用户长期保留。

退出门禁：用户控制和隔离测试全通过；管理后台不能查看明文秘密或私人会话。

### P4：Linux 稳定发布

**目标：**将 P0-P3 的功能组合成可运营、可恢复的 V1.0 完成态。

范围：

- Windows 与 Linux 同合同 Docker Compose；
- 生产网络、TLS、秘密注入、备份恢复、迁移和回滚；
- OpenTelemetry、Prometheus/Grafana、日志和告警；
- 浏览器 Worker 隔离、并发、限流、故障注入和容量验证；
- 百炼/DeepSeek/本地 Qwen、所有 MUST 数据源、ASR 和解析服务的真实认证；
- 全量 Gold Set、安全红队、发布清单和运维手册。

退出门禁：第 10 章全部通过，经产品负责人独立批准后才可发布 V1.0、提交、推送或打标签。

## 12. 需求追踪矩阵

| 需求 | 首次形成 | 最终验证 |
| --- | --- | --- |
| FR-001/002 | P0-P1 | P4 权限、恢复、SSE E2E |
| FR-003/004/005 | P0-P1 | P2 跨品类 Gold 与 SKU 回归 |
| FR-006/007 | P1 | P2-P4 全源真实与失败样本 |
| FR-008 | P1 | P4 云/本地 ASR、OCR、文档与视频认证 |
| FR-009/010/011/012 | P1-P2 | P4 Evidence/Negative/Price/Decision Gold |
| FR-013 | P1 | P3-P4 导出、分享、证据 UX E2E |
| FR-014/015 | P3 | P4 Memory/反馈隔离与删除 |
| FR-016/017 | P0-P3 | P4 Provider 实证和后台权限 |
| FR-018/019 | P0-P3 | P4 保留、删除、安全红队 |
| NFR-001-012 | P0 持续建设 | P4 全量发布门禁 |

## 13. 每期证据包

每期交付必须包含：

- 本期范围、非目标、需求 ID 和经批准的接口；
- 实际变更文件清单，不包含无关改动；
- 单元、合同、集成、E2E、故障注入和 Gold 测试结果；
- 真实 Provider、数据源和本地服务的环境、请求和结果摘要；
- 示例 Requirement、Evidence、Critique、Decision 和 RunOutcome；
- 安全、数据外传、秘密、隔离、删除和恢复证据；
- 已知风险、未验证项和阻断状态；
- 更新后的 `handoff.md`，并等待产品负责人决定是否进入下一期。

## 14. 实施纪律

- 开始任务前完整读取 `AGENTS.md`、`CONTEXT.md`、相关 ADR、`handoff.md`、本规格和 CoreMind 当前 handoff。
- 先把需求转换为可验证目标，再做最小纵向实现。
- 只修改本任务需要的文件；不顺手重构无关代码。
- 外部依赖下载慢或失败，不得未经确认更换源、版本、镜像、URL 或实现路径。
- 测试通过不等于用户验收、生产资格或发布授权。
- 阶段完成后先交付证据和遗留问题，不自动进入下一期。
- Git 提交、推送、Tag、npm/PyPI 发布和生产部署均需独立授权。

## 15. V1.0 完成定义

V1.0 不是“已经能聊天”，也不是“抓到了几个平台的数据”。它必须同时做到：

1. 能理解一个具体消费者的约束，并保持画像隔离和用户控制；
2. 能从真实、多模态、多平台来源获取信息，诚实处理登录、验证码和失败；
3. 能把事实、观点、推断、冲突和未知组织成可核验 Evidence；
4. 能主动研究为什么不买，并将价格、时效、SKU 和风险纳入 Decision；
5. 能输出买、等、不买、继续使用或补充信息，而不促成站内交易；
6. 能在 Windows 开发、Linux 部署、外部主模型和本地备用之间保持相同结果语义；
7. 能让用户管理 Memory、BYOK、登录态、文件、反馈和分享；
8. 能在真实故障、重启和并发下保持正确状态，不伪造成功；
9. 能通过第 10 章全部门禁并取得独立发布批准。
