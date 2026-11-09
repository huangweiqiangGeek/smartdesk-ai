# SmartDesk AI V1 数据模型与一致性

> T02 已实现 24 个实体与数据库静态约束，迁移/测试证据见 [数据库验收](database-development.md)。本文第 6—8 节涉及的业务事务、并发与统计仍按后续任务实现。基于 [PRD](prd-v1.md) 与 [技术方案](technical-plan-v1.md)；HTTP 返回字段另见 [API](api-v1.md)，不能直接返回数据库实体。

## 目录导航

- [1 通用约定与关系](#1-通用约定与关系)
- [2 身份与组织](#2-身份与组织)
- [3 客户、会话与消息](#3-客户会话与消息)
- [4 知识与 AI](#4-知识与-ai)
- [5 工单与基础设施](#5-工单与基础设施)
- [6 事务与并发操作](#6-事务与并发操作)
- [7 查询、统计与生命周期](#7-查询统计与生命周期)
- [8 模型验收](#8-模型验收)

## 1 通用约定与关系

24 个逻辑实体。id 为 UUID；时间为 PostgreSQL timestamptz，API 输出 UTC ISO 8601；计数/version 为非负整数。表列使用 snake_case，API 使用 camelCase，由一处映射负责。下表以 API 风格字段名便于跨文档阅读。

除 users、auth_sessions 和创建组织时的全局操作收据外，均直接或通过明确绑定携带 organizationId；业务表建 (organizationId,id) 唯一键，跨实体外键优先使用该复合键，阻止不同组织的记录被错误关联。身份全局表不允许客户端用 ID 绕过 membership 校验。

createdAt/updatedAt 为可变实体通用字段；不可变事件/消息/版本以 createdAt 为主。必填字段默认非空，“?” 表示可空。文本长度遵循 PRD 第 9 节，以 Unicode code point 校验。

~~~mermaid
erDiagram
    USERS ||--o{ MEMBERSHIPS : joins
    ORGANIZATIONS ||--o{ MEMBERSHIPS : owns
    ORGANIZATIONS ||--|| WIDGET_CONFIGS : configures
    ORGANIZATIONS ||--o{ CUSTOMERS : owns
    CUSTOMERS ||--o{ VISITOR_SESSIONS : authenticates
    CUSTOMERS ||--o{ CONVERSATIONS : starts
    CONVERSATIONS ||--o{ MESSAGES : contains
    CONVERSATIONS ||--o{ CONVERSATION_NOTES : internal
    CONVERSATIONS ||--o{ TICKETS : follows
    KNOWLEDGE_DOCUMENTS ||--o{ KNOWLEDGE_VERSIONS : versions
    KNOWLEDGE_VERSIONS ||--o{ KNOWLEDGE_CHUNKS : splits
    CONVERSATIONS o|--o{ AI_TASKS : triggers
    AI_TASKS ||--o| AI_RESULTS : yields
    TICKETS ||--o{ TICKET_EVENTS : records
~~~

图是主要关系，所有租户业务关联仍需 organizationId；knowledge_test 类型 AI task 没有会话，不能因此跳过组织和成员授权。

## 2 身份与组织

| 实体 | 关键字段与类型 | 约束、索引与行为 |
| --- | --- | --- |
| users | id；emailNormalized:text；displayName:text；passwordHash:text；status:active/disabled；createdAt | emailNormalized 全局唯一；登录邮箱作为账号标识，V1 不实现邮件验证或找回，界面不标已验证 |
| auth_sessions | id；userId:FK；tokenHash:text；expiresAt/revokedAt?:time；lastSeenAt:time | tokenHash 唯一；userId+revokedAt 索引；7 天绝对有效期默认；不保存当前组织为唯一授权来源 |
| organizations | id；name；timezone；aiEnabled:bool；aiConfigRevision:int；knowledgeRevision:int；authorizationRevision:int；aiSenderId/systemSenderId:UUID；version:int | 两个服务发送 ID 不同；修订号只在对应规则变化时增加；普通消息不更新组织统计计数 |
| memberships | id；organizationId；userId；role:admin/agent；status:active/disabled；availability:available/away；readingLanguage:zh/en；version | (organizationId,userId) 唯一；role/status 索引；最后管理员规则在组织排他锁内校验 |
| invitations | id；organizationId；tokenHash；role；createdByMembershipId；expiresAt；acceptedByUserId?；acceptedAt?；revokedAt? | tokenHash 唯一；有效期 7 天；条件更新一次消费；邀请不是自动邮件，没有 email 所有权验证承诺 |
| widget_configs | id；organizationId；publicKey:UUID；allowedOrigins:jsonb；welcomeText；defaultLanguage:zh/en；enabled:bool；version | organizationId 与 publicKey 各唯一；V1 每组织一个配置，可允许多个精确 origin；不使用任意子域通配符 |
| presence_connections | id:UUID；organizationId；membershipId；authSessionId；transport:socket/http；socketId?:text；lastSeenAt；disconnectedAt? | 非空 (organizationId,socketId) 唯一；membershipId/lastSeenAt 索引；15 秒心跳、60 秒失效；HTTP 首次心跳可绑定自己的新连接，不要求已有 Socket；ID 不能换绑身份 |

auth_sessions 存储随机 Cookie 的哈希，访客令牌不复用此表。切企业携带显式组织上下文，每次读取 membership；多标签页切企业不会通过全局 session.currentOrg 串数据。邀请接受时已有 membership 则返回现有身份，不把一次旧邀请用于静默升级角色。

## 3 客户、会话与消息

| 实体 | 关键字段与类型 | 约束、索引与行为 |
| --- | --- | --- |
| customers | id；organizationId；name?；email?；emailNormalized?；preferredLanguage:zh/en；internalNotes?；version | 邮箱不唯一，不跨身份合并；组织+姓名/邮箱查询；搜索结果先做资源 ACL |
| visitor_sessions | id；organizationId；customerId；widgetConfigId；parentOrigin:text；tokenHash；expiresAt；revokedAt? | tokenHash 唯一，30 天默认；凭据绑定组织、客户、站点与 origin；相同邮箱不能恢复会话 |
| conversations | id；organizationId；customerId；createdByVisitorSessionId；clientConversationId:UUID；status；assignedMembershipId?；version；lastSeq:int；lastVisitorSeq:int；inputRevision:int；receptionEpoch:int；clarificationPending:bool=false；activeAiTaskId?；enteredAiAt?；firstHandoffAt?；firstHandoffReason?；firstHumanReplyAt?；firstHumanReplyMembershipId?；closedAt?；resolution? | (organizationId,createdByVisitorSessionId,clientConversationId) 唯一；status/assignee/updatedAt 和 customerId/createdAt 索引；human_active 必有负责人，ai_active/waiting_human 无负责人 |
| messages | id；organizationId；conversationId；senderId:UUID；senderType；senderMembershipId?；senderCustomerId?；clientMessageId:UUID；seq:int；content:text；contentHash；aiTaskId?；createdAt | (organizationId,conversationId,seq) 与 (organizationId,conversationId,senderId,clientMessageId) 唯一；aiTaskId 非空唯一；正文不可修改 |
| conversation_notes | id；organizationId；conversationId；authorMembershipId；clientNoteId:UUID；content:text；createdAt | (organizationId,conversationId,authorMembershipId,clientNoteId) 唯一；独立于 messages，不能进入访客补拉或占用公开 seq |
| conversation_reads | organizationId；conversationId；membershipId；lastReadSeq:int；updatedAt | 三字段联合主键；游标只单调前进且不超过已存在水位；内部未读不等同于访客已读回执 |
| conversation_events | id；organizationId；conversationId；type；actorType/actorId?；commandId:UUID；fromStatus?/toStatus?；fromAssignee?/toAssignee?；reason?；version；createdAt | 会话+version/type 索引；记录 handoff、claim、assign、transfer、close、reopen；首次转接时间不被后续事件覆盖 |

T05 增量字段：messages.conversationVersion:int，保存消息提交时的会话版本，非负且不可变；默认0仅兼容旧记录，禁止把当前会话版本猜作历史提交版本。新消息明确保存当次 version，与 canonical Message 一致；迁移见 [消息开发说明](messages-development.md)。

senderId 规则：访客为 customerId，人工为 membershipId，AI/system 为组织中保留的对应发送 ID。外键约束约束真人发送列，检查约束保证 senderType 与对应列一致；AI/system 身份只能由业务服务填入，不能从请求体接收。

inputRevision 仅因新的访客输入增加，lastVisitorSeq 指向对应公开消息；receptionEpoch 在接待状态/负责人变动、结束或重开时增加。普通 version 用于页面修改冲突。阅读游标和生成中动画不得改变自动回答的输入版本。

clarificationPending 在澄清消息提交事务内置 true；只在有依据的业务回答成功提交后重置。新会话初始 false，问候/重试不能重置，防止无依据反复追问。

resolution 为 customer_confirmed / agent_resolved / unconfirmed，只有关闭动作设置；访客“已解决”必须是明确操作，不能由 AI 自报。closed 会话可保留历史负责人；重开由执行成员接管，重新进入 human_active。

firstHandoffAt 是第一次进入等待人工或被直接人工接管的时间；创建即等待时取创建时间。firstHumanReplyAt 和对应成员只在第一条成功保存的人工对客消息时填写，不因重开覆盖。创建时间必须对应首条访客消息事务。

## 4 知识与 AI

| 实体 | 关键字段与类型 | 约束、索引与行为 |
| --- | --- | --- |
| knowledge_documents | id；organizationId；type:faq/text；status:draft/enabled/disabled；currentVersionId?；version:int；deletedAt?；createdByMembershipId | 组织+status+deletedAt 索引；currentVersionId 只指向本组织本条目；软删除后不参与检索 |
| knowledge_versions | id；organizationId；documentId；revision:int；titleOrQuestion；body；contentHash；preparationStatus；embeddingProfileVersion；embeddingModelId；embeddingDimensions:int；preparedAt?；lastErrorCode?；preparationAttempt:int；leaseToken?；leaseExpiresAt?；createdByMembershipId | (organizationId,documentId,revision) 唯一；正文不可变；准备状态可变；processing 超时可重试，所有 chunk 完成才 ready |
| knowledge_chunks | id；organizationId；documentId；versionId；ordinal:int；text；contentHash；embedding:vector；embeddingProfileVersion；createdAt | (organizationId,versionId,ordinal) 唯一；组织/版本 B-tree；维度由版本显式声明并在写入时校验；V1 不建 ANN 索引，检索集合不混用 embedding 配置 |
| ai_tasks | id；organizationId；conversationId?；scope:conversation_auto/conversation_assist/knowledge_test；operation；requestedByMembershipId?；commandId?；inputRevision；sourceThroughSeq?；inputMessageIds:jsonb；questionText?；latestVisitorSeq?；receptionEpoch?；knowledgeRevision；aiConfigRevision；promptVersion；modelId；status；version:int；deadlineAt?；attemptCount；attempts:jsonb；leaseToken?；leaseExpiresAt?；startedAt?/finishedAt?；lastErrorCode? | 自动任务 (organizationId,conversationId,inputRevision,operation) 唯一；客户轮次只一个 answer；手动/试问按 commandId 判重；status/deadlineAt 索引；每次状态变化增加 version |
| ai_results | id；organizationId；taskId；resultKind；result:jsonb；sourceSnapshot:jsonb；modelVersion；promptVersion；usage:jsonb；usageEstimated:bool；createdAt | taskId 唯一；JSON 按 operation 校验；只允许后台读详细结果；自动对客正文仍需单独 messages 事务 |

knowledge_versions 的维度与部署 Embedding 配置一致；模型或维度变更必须建立新 embeddingProfileVersion、重建知识并重新启用。T01 尚无真实模型配置，T02 不推测固定维度：采用 vector 列及版本维度/profile 一致性约束；同一列可保存不同 profile 的历史数据，检索必须先限定当前 profile，不能跨模型或维度混比。真实配置与检索由 T13 验证。

sourceSnapshot 包含 documentId/versionId/chunkId、标题和实际支持片段及内容 hash，不依赖当前仍存在的知识状态来展示历史依据；查看历史来源仍须当前会话权限。模型提交的片段必须是提供给它的 chunk 子串，来源有效性由服务端校验；这不等于语义正确性已被证明。

knowledge_test 的 questionText 为后台试问输入，不建立 customer/conversation/message，不计业务统计。自动任务没有客户端 operation=answer 的触发入口。

ai_tasks 另存 targetLanguage:zh/en（translate 必填、其他操作取当次已确定语言），不在 worker 重试时重新取可能变化的偏好。inputRevision 是整数：自动任务取 conversations.inputRevision；会话辅助任务取创建时 conversations.lastSeq，同时固化 sourceThroughSeq/inputMessageIds；单轮 knowledge_test 固定为 1。自动任务唯一键只对 scope=conversation_auto 生效，手动任务可按新 commandId 请求重新生成。当前性比较还必须匹配 operation、源消息、目标语言及适用的知识版本，不能只比较裸整数。

attempts 只保留各 attemptId 的模型标识、时间、结果码与 usage/usageEstimated，不存重复正文；按 attemptId 幂等合并，包含失败和迟到尝试。ai_results 的 usage 是结果所对应尝试，成本诊断合计 attempts，不能只统计最后成功调用。

知识准备以 versionId 为业务键，经 outbox/BullMQ 执行，状态保存在 knowledge_versions，无需再增一套通用任务表。该表另持久化 preparationStartedAt?/preparationDeadlineAt?，首次 processing 设置 300 秒截止，同次自动重试/重复点击不延长；failed 后明确重新准备才建立新 preparationAttempt 和期限。索引失败保留当前版本的失败信息；重试以当前 lease 防止旧 worker 把新状态覆盖。

## 5 工单与基础设施

| 实体 | 关键字段与类型 | 约束、索引与行为 |
| --- | --- | --- |
| tickets | id；organizationId；conversationId；customerId；title；description；ownerMembershipId?；priority:low/normal/high；status；version；createdByMembershipId；createdCommandId；resolvedAt? | 建单请求唯一；会话与客户必须匹配；组织+status/owner/priority/updatedAt 索引；客户消息不自动推进状态 |
| ticket_events | id；organizationId；ticketId；actorMembershipId；commandId；type:created/updated/assigned/status_changed/comment；fromStatus?/toStatus?；content?；reason?；version；createdAt | 不可变处理记录；ticketId+createdAt/id 索引；解决说明和重开原因必填 |
| outbox_events | id；organizationId；aggregateType；aggregateId；aggregateVersion；eventType；destination:socket/queue；payload:jsonb；status:pending/published；attemptCount；availableAt；leaseToken?；leaseExpiresAt?；publishedAt? | (organizationId,aggregateType,aggregateId,aggregateVersion,eventType,destination) 唯一；status/availableAt 索引；发布成功不代表客户端已见 |
| operation_receipts | id；organizationId?；actorScope:text；operation:text；commandId:UUID；requestHash；responseRef:jsonb；secretExpiresAt?；createdAt | (actorScope,operation,commandId) 唯一；租户动作的 actorScope 必含组织及身份，bootstrap 含 publicKey+parentOrigin；身份、归一化 body、目标 ID 均进入 hash；业务收据随业务记录保留 |
| audit_events | id；organizationId；actorMembershipId?；action；resourceType/resourceId；requestId；beforeMeta?/afterMeta?:jsonb；createdAt | 组织+资源/时间索引；记录设置、知识、成员操作；禁止把密码/令牌或整段正文写入审计 |

工单负责人停用时保留历史 FK，通过 membership.status 派生 needsReassignment=true；未解决数仍包含它。管理员改派到有效本企业成员，不能用删除成员记录清空历史。

operation_receipts 用于建组织、建会话首消息、转接、认领、关闭、建单、邀请接受和手动 AI 等重试；消息/备注有专用唯一键，不重复依赖通用收据。鉴权失败不能通过收据绕过当前可见性。

创建组织前尚无租户，actorScope=account:当前 userId，收据 organizationId 为空，responseRef 指向新组织；对 user 行串行锁定并在同事务创建组织/成员/收据，不能按随机新组织 ID 查幂等。其余已知组织动作先走组织锁顺序。

bootstrap 的 responseRef 特例含 AES-GCM 加密的首次响应、随机 nonce、认证标签和 keyId，10 分钟后清除密文但保留请求收据及过期标记；密钥只在服务端配置中。其他收据只保存可重新授权读取的业务引用，不缓存旧权限下的完整敏感响应。具体恢复语义见 API A021。

## 6 事务与并发操作

| 操作 | 一个事务内的最小效果 | 提交后动作 |
| --- | --- | --- |
| 注册 | users + auth_sessions；邮箱冲突回滚 | Set-Cookie，不广播 |
| 创建企业 | organization + 首个 admin membership + widget_config + 幂等收据 | 返回企业，进入配置页 |
| 接受邀请 | 锁 invite，检查有效/未消费，创建或复用 membership，标消费 | 重新查询可用企业，不用旧角色缓存 |
| 首消息建会话 | 访客授权、稳定 clientConversationId、conversation + message(seq=1) + task（如需）+ outbox + 收据 | 返回会话和已保存消息 |
| 后续消息 | 锁会话，查请求，分配 seq，保存消息；访客输入推进轮次并 supersede 旧自动任务 | ACK 后广播，outbox 投递新 task |
| AI 最终提交 | 组织共享锁、会话锁、任务锁；核对 deadline/轮次/epoch/组织修订/来源；保存 result+message+outbox 与 succeeded | 发布 canonical Message；任何校验失败不保存对客消息 |
| 转人工 | 锁会话，填首次转接事实，清负责人，推进 epoch，旧自动任务 superseded，写事件/收据/outbox | 通知双方；异步摘要不在临界路径 |
| claim/assign/transfer | 检查当前权限、可接待成员、expectedVersion，更新唯一负责人和 epoch，记录事件/收据 | 旧负责人失去写权限，推送按新 ACL 重算 |
| 编辑/停用知识 | 组织排他锁、文档锁；增加 knowledgeRevision；新版本或 disabled/deleted；旧可用版本退出集合 | 准备任务异步；旧 answer 保存时失败 |
| 关闭 AI | 组织排他锁，改 aiEnabled/revision，按 ID 顺序处理当前 ai_active 会话转等待 | 固定提示与摘要；重新开启不重置现有会话 |
| 停用/降级成员 | 组织排他锁，验证最后管理员，更新 membership；停用者人工会话回等待，历史工单不解决 | 撤销订阅、界面重新授权；工单显示需改派 |
| 工单状态 | 锁工单，授权/expectedVersion，验证转换，更新 ticket + append event + 收据/outbox | 只发 ticket.updated，不改会话 |

组织共享/排他锁和固定顺序见技术方案第 16 节；有大量在服会话时须测量管理操作锁时长，不默认全量处理可无限扩展。重试事务最多 2 次，仅用于瞬时数据库并发失败；不能吞掉真实版本/权限冲突。

AI task leaseToken 是尝试执行的围栏：旧 worker 即使晚返回，也必须携带当前 token 并满足业务版本才能提交。失败记录与自动交接可同事务完成；候选已 superseded 时只记元数据，不重开任务。

## 7 查询、统计与生命周期

列表采用稳定键集游标 (createdAt,id) 或 (updatedAt,id)，统一 limit≤100；消息用 seq。所有搜索先叠加组织和资源 ACL，后做排序/分页，不能先全局分页再在前端过滤。

知识检索从 organizationId、当前 enabled+ready 版本和 embeddingProfileVersion 过滤后做精确 cosine 距离排序，不允许把租户过滤留给模型。字段来自授权 repository，向量原始查询须参数化。

| 指标 | 数据事实与 SQL 设计口径 |
| --- | --- |
| 新增会话 | conversations.createdAt 在企业时区换算的 UTC 半开区间内；按 id 计数 |
| AI 接待 | 同一新建会话集合且 enteredAiAt 非空 |
| 转人工及原因 | firstHandoffAt 在区间内；按 firstHandoffReason 分组，每会话一次 |
| 待处理工单 | 当前 status!=resolved；不套会话日期过滤，response 明示 snapshotAt |
| 首次人工响应 | 首次请求在区间内，firstHumanReplyAt 非空者平均差值；另返 respondedCount/pendingCount |
| 客服本人 | 按 firstHumanReplyMembershipId 归属已响应量/平均响应；工单按当前 owner；不下发企业明细 |

时区区间使用明确的 IANA 时区转换，先转换每日边界再求差，不能用固定 24 小时代替夏令时日期。未来变更组织时区需记录版本，查询显示当前采用时区。

业务消息/事件/知识版本不做 V1 自动清理；已过期会话令牌可独立清理，不能级联删除客户历史。outbox 已发布条目保留诊断窗口后可清理，但不能删除业务幂等记录；具体窗口在部署任务记录。备份和恢复测试覆盖向量扩展与知识版本。

## 8 模型验收

空库迁移和重复初始化幂等；跨组织 FK 写入失败；同消息/同建单重试只一份；备注不占公开 seq；并发 claim/知识停用/成员停用与 AI 提交结果合法；knowledge_test 不创建业务统计对象；到期/过期 lease 的结果不能提交；统计样本可手工核算。对应 T02、T05、T08、T11—T14、T18、T20—T22。
