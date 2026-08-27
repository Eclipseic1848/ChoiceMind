# 安全策略

## 支持范围

ChoiceMind 尚未发布 V1.0，也未声明生产就绪。当前仅对 `main` 的最新代码提供安全修复；历史分支、旧 commit、本地实验产物和未合并 PR 不承诺持续支持。

| 范围 | 安全修复 |
| --- | --- |
| `main` 最新版本 | 支持 |
| 历史分支与旧 commit | 不保证 |
| 未发布、未合并或本地实验版本 | 不支持 |

## 私下报告漏洞

请优先使用仓库 **Security → Report a vulnerability** 的私密报告入口。若该入口不可用，请通过 [Eclipseic1848 的 GitHub 主页](https://github.com/Eclipseic1848) 提供的私密联系方式联系维护者。

不要在公开 Issue、PR、Discussion、日志或截图中披露漏洞细节、真实凭据、Cookie、个人数据或可直接利用的攻击步骤。

报告建议包含：

- 受影响的分支、commit SHA、组件和环境；
- 影响范围与可能的攻击前提；
- 最小复现步骤或经过脱敏的证明；
- 已尝试的缓解措施；
- 是否存在已知公开披露或正在利用的迹象。

维护者会尽快确认报告、评估严重程度并协调修复与披露时间。修复完成前，请避免公开细节或对不属于你的系统进行测试。

## 项目安全边界

- 不得把 API Key、Provider Credential、Source Credential、Cookie 或访问令牌写入仓库、Issue、测试 fixture 或运行证据。
- 受保护对象按 User 所有权隔离；`ADMIN` 或 `SUPERADMIN` 角色本身不授予读取其他 User 私有任务、事件或凭据的权限。服务端不能信任客户端自报的身份或角色。
- 每条 Secret 使用独立数据密钥进行信封加密，主密钥必须与数据库密文分离；Secret 只能在受控使用期内解密，不能序列化到 API、RunEvent、日志或错误详情。
- 凭据访问或变更在加载、解密、回调或保存前必须先写入不可变审计事实；审计不可用时操作失败关闭。
- 外部访问必须经过 RiskPolicy 与 EgressGuard。EgressRecord 只能包含主体、操作、目标来源、方法、策略结果、关联标识和时间，不得包含 URL 路径、查询参数、正文、响应或 Secret。
- Evidence 采集只允许精确 allowlist 中的 HTTPS URL；必须在 Egress 与正文读取前拒绝回环、私网、链路本地、DNS 解析失败和手动重定向，且不得仅依赖可伪造的 `Content-Length` 执行大小限制。
- MIME 与大小门禁必须在对象写入前执行。网页原始字节只进入 SHA-256 内容寻址对象存储；Postgres 只能持久化来源、locator、哈希、parser 版本、对象引用和向量元数据，不得新增原始正文列。
- Provider、Runtime、工具和外部来源输出均是不可信输入，必须经过 ChoiceMind 合同、安全策略与失败关闭校验。
- Postgres 是任务状态和公开 RunEvent 的权威来源；Redis、缓存或实时通知不能覆盖权威事实。SSE 断线恢复必须按持久游标从 Postgres 补发。
- 公开 RunEvent 只能包含可审查的阶段、动作和失败摘要，不得包含模型隐藏思维链、凭据、个人数据或原始模型响应。
- 本地测试、合成数据、真实服务冒烟和产品验收都不等于生产安全认证。

普通缺陷、功能建议或不涉及安全影响的问题请使用公开 [Issues](https://github.com/Eclipseic1848/ChoiceMind/issues)。
