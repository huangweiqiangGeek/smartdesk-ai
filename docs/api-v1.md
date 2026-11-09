# SmartDesk AI V1 API 与事件详细设计

> V1 合同与实施索引：T03 身份、T04 跨站接入及 T05 的 A027—A029/A038—A040 已实现；其他接口随任务推进，不应视为已可调用。消息实际行为与验收见 [T05 说明](messages-development.md)。通用枚举、envelope 与预算遵循 [contracts](contracts.md)，数据定义见 [模型](data-model-v1.md)，消费页面见 [页面设计](pages-v1.md)。

T08 已实现 A015—A017/A030—A037，并完成 A008/A014 补偿与 Socket 心跳，实测和兼容细节见 [接待说明](reception-development.md)。

## 目录导航

- [1 通用合同](#1-通用合同)
- [2 公共 DTO](#2-公共-dto)
- [3 HTTP 接口清单](#3-http-接口清单)
- [4 Socket 合同与历史恢复](#4-socket-合同与历史恢复)
- [5 AI 内部合同](#5-ai-内部合同)
- [6 请求与失败示例](#6-请求与失败示例)
- [7 合同验收](#7-合同验收)

## 1 通用合同

业务基础路径 /api/v1。下文路径相对此前缀，健康检查与 AI 内部路径明确单列。所有业务接口归 NestJS；只有 A067/A068 归 FastAPI 内网服务。

身份缩写：P=未登录公共访问；U=已登录账号；M=当前组织有效成员；A=admin；R=当前会话负责人；V=授权访客；S=内部服务。agent 的可读范围为自己负责会话与未分配等待队列；工单只限本人负责，admin 可读本企业。

成员以 HttpOnly 会话 Cookie 鉴权，租户路由携带 X-Organization-Id；路径含组织 ID 时必须与请求上下文一致。访客使用 Authorization Bearer 令牌，组织/客户/origin 从凭据推导，拒绝客户端替换。认证接口不能接受访客令牌作为成员身份。

后台写入要求受信 Origin、application/json 与 X-Requested-With: SmartDesk，后台不向其他 origin 开放凭据 CORS；这是首版 CSRF 防护组合。公共 bootstrap 仅开放配置允许的 origin，不使用 credentials Cookie。令牌不是 CORS 的替代品。

除注册/登录/退出、邀请预览、心跳、已读游标外，创建及状态命令要求 Idempotency-Key: UUID，映射为服务端 commandId；普通消息与备注分别用 clientMessageId/clientNoteId。业务幂等键在一次用户操作的所有重试中保持不变。同键不同 body/目标为 409 IDEMPOTENCY_CONFLICT。注册由唯一邮箱保证不重复建账号；注册响应丢失后可直接登录，不自动重建账号。

需要版本校验的写入携带 expectedVersion；DELETE 通过 If-Match 携带版本。409 响应可带当前 version/status 的授权投影，不能带整个内部实体。转人工、停用邀请等单向动作可不要求 expectedVersion，仍需幂等；重复请求不重写首次业务时间。

成功沿用 {data,requestId}；创建 201，重复创建 200，异步任务 202，无正文删除/退出 204。普通列表 data={items,nextCursor}，默认 20/上限 100；消息使用 MessagePage。日期过滤输入 fromDate/toDate（自然日、含结束日），由服务端按组织时区转 UTC 半开区间；最长 366 天为初始查询保护值。

所有接口共同可能返回 401/403/404/422/429/503；表中列主要领域错误。跨租户/不可见资源返回 404；已可见资源但动作不允许返回 403。内部错误只回 requestId 和稳定错误码。

## 2 公共 DTO

| 名称 | 返回字段白名单 |
| --- | --- |
| UserView | id、displayName、email；不含 passwordHash/session hash |
| OrganizationView | id、name、timezone、version；成员侧可见 aiEnabled；A007 的 admin 投影另含 aiHealth{knowledgeReadyCount,providerState,observedAt}，只反映最近观测、不承诺本次推理成功，无服务凭据 |
| MembershipView | id、userId、displayName、role、status、availability、online、readingLanguage、version；无会话令牌 |
| WidgetConfigView | publicKey、allowedOrigins、welcomeText、defaultLanguage、enabled、version；公开版本省略 allowedOrigins 和管理字段 |
| VisitorBootstrap | visitorToken（创建及同请求恢复时）、expiresAt、customer{id,name,email,preferredLanguage,version}、widget 公共配置、identityReset（原凭据过期而新建时为 true）；恢复已有凭据时无需重发原令牌 |
| CustomerView | id、name、email、preferredLanguage、internalNotes、version、createdAt；访客修改结果仅返回本人 id/name/email/preferredLanguage/version |
| ConversationView | id、customer 摘要、status、assignedMembershipId、assignedDisplayName?（负责人公开显示名）、version、lastSeq、lastVisitorSeq、lastMessageSummary、updatedAt、firstHandoffAt、handoffReason、closedAt、resolution；后台另有 unreadCount，访客不含备注/内部错误；lastMessageSummary 只来自授权公开消息 |
| Message | id、conversationId、senderId、senderType、clientMessageId、seq、content、createdAt、conversationVersion；内部 aiTaskId 和 sourceSnapshot 不属于访客 DTO |
| MessagePage | items、mode、snapshotThroughSeq、windowStartSeq、nextCursor、hasMore；items 始终按 seq 升序 |
| NoteView | id、conversationId、authorMembershipId、clientNoteId、content、createdAt；仅授权后台 |
| KnowledgeView | id、type、status、version、currentVersion{id,revision,titleOrQuestion,body,preparationStatus,lastErrorCode?}、updatedAt；成员搜索仅返回 enabled+ready 的允许字段 |
| AiTaskView | id、scope、operation、status、version、inputRevision、sourceThroughSeq、isCurrent、createdAt、deadlineAt、errorCode?、result?；isCurrent 按当前输入/知识判断，历史成功结果不重执行；仅授权后台；自动状态给访客单独投影 processing/waiting |
| SourceView | documentId、versionId、chunkId、title、quote、contentHash；按会话或试问所有者授权 |
| TicketView | id、title、description、customerId、conversationId、ownerMembershipId、needsReassignment、priority、status、version、resolvedAt、createdAt、updatedAt |
| StatsView | timezone、fromDate、toDate、generatedAt、newConversations、aiReceived、handoffs、handoffReasons、openTickets{value,snapshotAt}、firstHumanResponse{averageMs?,respondedCount,pendingCount} |
| MyStatsView | 同一时间上下文、firstReplies、averageFirstResponseMs?、ownedOpenTickets、snapshotAt；不填入无权查看的企业总体指标 |

enum 按 contracts 维护。后台知识页不会通过访客 Message 获得来源；查看来源调用 A055。每个 endpoint 输出白名单独立验证，不能用“序列化完整实体后前端隐藏字段”实现。

## 3 HTTP 接口清单

表内输入省略共同的 Idempotency-Key、组织头和已有身份；“页”代表分页 DTO。无必填业务输入写“无”，不是缺少鉴权。node 对应主方案 N01—N08。

### 身份、企业、团队与在线状态（N01）

| ID | 方法与路径 | 身份/消费者 | 输入 | 输出 | 关键错误/规则 |
| --- | --- | --- | --- | --- | --- |
| A001 | POST /auth/register | P；P01 | email、password、displayName | 201 UserView + Set-Cookie | EMAIL_EXISTS；密码初始 12—128 code point |
| A002 | POST /auth/login | P；P01 | email、password | UserView + expiresAt + Cookie | INVALID_CREDENTIALS，失败文案不泄露账号是否存在 |
| A003 | POST /auth/logout | U；全部后台 | 无 | 204，撤销当前 session/Cookie | 重复退出可成功；同时断开当前 session 连接 |
| A004 | GET /auth/me | U；后台入口 | 无 | UserView、memberships 摘要 | 过期 401，不返回其他成员资料 |
| A005 | POST /organizations | U；P02 | name、timezone（默认 PRD） | 201 OrganizationView + admin membership | 同请求不重复创建 |
| A006 | GET /organizations | U；P02 | cursor、limit | 本人可用组织页 | 不列已停用 membership 的组织 |
| A007 | GET /organizations/{id} | M；P09 | 无 | OrganizationView | 404/成员失效 |
| A008 | PATCH /organizations/{id} | A；P09 | expectedVersion、name?/timezone?/aiEnabled? | OrganizationView | VERSION_CONFLICT；关 AI 转等待，开 AI 不恢复旧会话 |
| A009 | GET /memberships | M；P09/转交选择 | status?、cursor、limit | MembershipView 页 | agent 只得可协作字段，不含邀请凭据 |
| A010 | POST /invitations | A；P09 | role | 201 id、inviteLink、expiresAt | 最终链接以 fragment 带 token；响应不缓存 |
| A011 | POST /invitations/preview | P；P02 | token | organizationName、role、expiresAt | INVITATION_INVALID；只提供接受邀请必需信息 |
| A012 | POST /invitations/accept | U；P02 | token | membership、organization | EXPIRED/REVOKED/CONSUMED；单次消费，不静默升级已有角色 |
| A013 | POST /invitations/{id}/revoke | A；P09 | 无 | 204 | 已接受 409；已撤销幂等 |
| A069 | GET /invitations | A；P09 | status?、cursor、limit | id、role、status、expiresAt、createdAt、acceptedAt? 的页 | status 派生 pending/accepted/revoked/expired；不返回原 token 或邀请链接 |
| A014 | PATCH /memberships/{id} | A；P09 | expectedVersion、role?/status? | MembershipView | LAST_ADMIN_REQUIRED；停用者在服会话回等待 |

T03 实施补充：A010 的同键重放返回 200、inviteLink=null、linkUnavailable=true，令牌仅首次显示，丢失时撤销后新建。T08 已将 A008/A014 原有的 409 STATE_CONFLICT 保护替换为事务内会话补偿；完整行为与实测范围见 [身份开发与验收](identity-development.md) 和 [接待说明](reception-development.md)。

| ID | 方法与路径 | 身份/消费者 | 输入 | 输出 | 关键错误/规则 |
| --- | --- | --- | --- | --- | --- |
| A015 | PATCH /memberships/me/availability | M；收件箱/设置 | available/away、readingLanguage? | MembershipView | 非有效成员 403 |
| A016 | POST /presence/heartbeat | M；后台活动页面的 HTTP 心跳 | connectionId:UUID | serverTime、onlineUntil | 首次绑定当前 session/成员/组织；已有 ID 属其他身份拒绝；不要求已有 Socket |
| A017 | GET /presence | M；认领/转交 | 无 | 当前可接待 MembershipView 列表 | 可接待=有效+available+心跳有效 |

后台登录失效时保留不含敏感内容的返回路由；密码找回、邮件验证、SSO 不进入 V1。邀请 token 不放访问日志，预览/接受请求不记录正文。

### 网站入口、客户与会话（N01、N03、N06）

| ID | 方法与路径 | 身份/消费者 | 输入 | 输出 | 关键错误/规则 |
| --- | --- | --- | --- | --- | --- |
| A018 | GET /widget-config | A；P09 | 无 | WidgetConfigView + loaderUrl | 所属组织配置 |
| A019 | PATCH /widget-config | A；P09 | expectedVersion、allowedOrigins?/welcomeText?/defaultLanguage?/enabled? | WidgetConfigView | INVALID_ORIGIN；精确 scheme/host/port，无星号 |
| A020 | GET /public/widgets/{publicKey} | P；P03 加载器 | 浏览器 Origin | 公开 WidgetConfigView、iframeUrl | WIDGET_DISABLED/ORIGIN_NOT_ALLOWED；无内部配置 |
| A021 | POST /public/widgets/{publicKey}/bootstrap | P；P03 加载器 | resumeToken?，Origin | VisitorBootstrap | 旧 token 过期明确新建身份；不得按邮箱恢复 |
| A022 | GET /customers | M；P06 | q?、cursor、limit | CustomerView 摘要页 | 搜索前应用资源 ACL |
| A023 | GET /customers/{id} | M；P06/收件箱 | 无 | CustomerView | 无关联授权 404 |
| A024 | PATCH /customers/{id} | M 有关联权限；V 本人 | expectedVersion、name?/email?/preferredLanguage?/internalNotes? | 按身份裁剪 CustomerView | V 传 internalNotes 拒绝；非法邮箱 422 |
| A025 | GET /customers/{id}/conversations | M；P06 | cursor、limit | 本人有权访问的 ConversationView 页 | 有客户权限不代表能看全部历史 |
| A026 | GET /customers/{id}/tickets | M；P06 | cursor、limit | 授权 TicketView 页 | 同上；不扩大工单权限 |
| A027 | POST /conversations | V；P03 | clientConversationId、firstMessage{clientMessageId,content} | 201 {conversation,message}；同请求 200 | 首消息和会话同事务；没有空会话计数 |
| A028 | GET /conversations | M 或 V；P03/P04 | status?、view?、cursor、limit | 授权 ConversationView 页 | M view=waiting/mine/all；V 仅自身且不得传其他 customerId |
| A029 | GET /conversations/{id} | M 有权/V 本人；P03/P04 | 无 | ConversationView | 当前权限实时校验 |
| A030 | POST /conversations/{id}/handoff | V 本人；P03 | reason=customer_request | ConversationView | AI→waiting；已等待/人工原状态成功；closed 409 |
| A031 | POST /conversations/{id}/claim | M 可接待；P04 | expectedVersion | ConversationView | 仅未分配 waiting；ALREADY_ASSIGNED/VERSION_CONFLICT |
| A032 | POST /conversations/{id}/assign | A；P04 | expectedVersion、membershipId、reason? | ConversationView | 目标有效且可接待；AI 可直接接管并记首次转接 |
| A033 | POST /conversations/{id}/transfer | R 或 A；P04 | expectedVersion、membershipId、reason | ConversationView | 目标不可用/跨组织拒绝；原负责人失去写权 |
| A034 | POST /conversations/{id}/close | R/A 或 V 本人 | expectedVersion、resolution、reason? | ConversationView | resolution 按身份限制；工单不联动 |
| A035 | POST /conversations/{id}/reopen | 原负责人或 A；P04 | expectedVersion、reason | ConversationView | 必须 closed；操作者成为人工负责人，不恢复 AI |
| A036 | POST /conversations/{id}/read | M 有权；P04 | lastReadSeq | lastReadSeq | 单调更新，不产生访客已读回执 |
| A037 | GET /conversations/{id}/events | M 有权；P04 | cursor、limit | 内部状态事件页 | 不向 V 开放 |

A021 的 Idempotency-Key 对新建访客也生效：按 publicKey+已校验 parentOrigin+commandId 保存 bootstrap 收据，以服务端密钥 AES-GCM 加密完整首次响应，保留 10 分钟。相同请求在窗口内恢复相同身份和令牌；超时清除密文后，同键返回 409 BOOTSTRAP_RECEIPT_EXPIRED，客户端明确新建时使用新键。visitor_sessions 仍只存 tokenHash；收据和日志不存明文令牌。同键不同输入返回冲突，不能绑定另一客户。已有有效 resumeToken 时优先恢复原身份；没有凭据就不能按邮箱找回。

A020/A021 由父网站加载脚本请求，浏览器 Origin 必须匹配允许站点，CORS 仅允许所需方法和 Idempotency-Key 等头。之后父页通过受限 postMessage 将令牌交给 iframe；聊天 HTTP/Socket 从 SmartDesk iframe origin 发起，服务端验证该 origin、令牌绑定的站点仍启用及原 parentOrigin 仍允许，不错误要求 iframe 的 HTTP Origin 等于父网站。收到的 parentOrigin 字段不能覆盖令牌记录。

### 消息、内部备注、知识与 AI（N02—N07）

| ID | 方法与路径 | 身份/消费者 | 输入 | 输出 | 关键错误/规则 |
| --- | --- | --- | --- | --- | --- |
| A038 | POST /conversations/{id}/messages | V 本人或 R；P03/P04 | clientMessageId、content | 201/200 Message | CONVERSATION_CLOSED/NOT_ASSIGNEE/IDEMPOTENCY_CONFLICT |
| A039 | GET /conversations/{id}/messages | M 有权/V 本人 | afterSeq? 或 beforeSeq? 或 cursor?；throughSeq?；limit | MessagePage | 互斥游标模式，scope 绑定；不包含备注 |
| A040 | GET /conversations/{id}/message-requests/{clientMessageId} | 原发送者且当前可读 | 无 | Message 或 404 REQUEST_NOT_FOUND | 只查当前身份的请求；404 不证明旧请求永远不会提交 |
| A041 | GET /conversations/{id}/notes | M 有权；P04 | cursor、limit | NoteView 页 | V 一律拒绝 |
| A042 | POST /conversations/{id}/notes | R/A；P04 | clientNoteId、content | 201/200 NoteView | closed 默认只读，重开后可新增；不触发 AI |
| A043 | GET /knowledge | M；P05/收件箱 | q?、type?、status?、cursor、limit | KnowledgeView 摘要页 | agent 只能 enabled+ready，不能过滤出草稿 |
| A044 | POST /knowledge | A；P05 | type、titleOrQuestion、body | 201 KnowledgeView（draft） | 长度/空白验证 |
| A045 | GET /knowledge/{id} | A；agent 限已启用当前版本 | 无 | KnowledgeView | 不泄漏停用/删除正文 |
| A046 | PATCH /knowledge/{id} | A；P05 | expectedVersion、titleOrQuestion、body | 新 KnowledgeView | 新不可变版本；退出启用集合；旧候选失效 |
| A047 | POST /knowledge/{id}/prepare | A；P05 | versionId | 202 versionId、preparationStatus | 只当前版本；重复准备复用同业务键 |
| A048 | POST /knowledge/{id}/enable | A；P05 | expectedVersion、versionId | KnowledgeView | KNOWLEDGE_NOT_READY/STALE_VERSION |
| A049 | POST /knowledge/{id}/disable | A；P05 | expectedVersion | KnowledgeView | 立即退出检索，旧候选禁止发送 |
| A050 | DELETE /knowledge/{id} | A；P05 | If-Match；确认已停用 | 204 | KNOWLEDGE_MUST_BE_DISABLED；保留历史依据 |
| A051 | GET /knowledge/{id}/versions | A；P05 | cursor、limit | 版本元数据页 | 不返回向量，删除前可查看授权历史 |
| A052 | POST /knowledge/tests | M；P05 | question、language | 202 AiTaskView | 只测试当前已启用集合，不建客户/会话/消息 |
| A053 | POST /conversations/{id}/ai-tasks | M 有权；suggest_reply 要求 R/A | operation=translate/summarize/suggest_reply、messageId?、targetLanguage?、inputRevision | 202 AiTaskView | operation=answer 拒绝；INPUT_STALE；备注不进上下文 |
| A054 | GET /ai-tasks/{id} | M 授权；试问限请求者/A | 无 | AiTaskView | 转交后失去会话权限者不可读旧任务 |
| A055 | GET /ai-tasks/{id}/sources | 同 A054 | 无 | SourceView 列表 | V 无此权限；历史按快照展示 |

知识正文修改后调用 prepare，准备成功需用户显式 enable。保存草稿和“保存并准备”可以是一段前端动作，但 API 不暗中自动启用。

A053 的 inputRevision 取调用方当前看到的 ConversationView.lastSeq；服务端创建时比对后固化输入消息与语言。自动任务使用会话客户输入轮次，两种 scope 不能混比。翻译绑定不可变 messageId，已成功翻译不因无关后续消息失效；摘要/草稿随输入覆盖或知识变化标为非当前。

### 工单、统计与服务状态（N08）

| ID | 方法与路径 | 身份/消费者 | 输入 | 输出 | 关键错误/规则 |
| --- | --- | --- | --- | --- | --- |
| A056 | POST /tickets | M 可读源会话；P04/P07 | conversationId、title、description、priority?、ownerMembershipId? | 201/200 TicketView | 默认自己；agent 不能指定他人；客户从会话推导 |
| A057 | GET /tickets | M；P07 | status?/owner?/priority?/q?、cursor、limit | TicketView 页 | agent 只本人；筛选不能扩权 |
| A058 | GET /tickets/{id} | 工单负责人/A；P07 | 无 | TicketView | 不可见 404 |
| A059 | PATCH /tickets/{id} | 负责人/A；P07 | expectedVersion、title?/description?/priority?/ownerMembershipId? | TicketView | 改派仅 A；status 不允许在此更改 |
| A060 | POST /tickets/{id}/transitions | 负责人/A；P07 | expectedVersion、toStatus、reason/summary | TicketView | 非法转换/版本冲突 409；解决和重开说明必填 |
| A061 | POST /tickets/{id}/records | 负责人/A；P07 | content | 201 处理记录 | 不向访客自动发送 |
| A062 | GET /tickets/{id}/records | 负责人/A；P07 | cursor、limit | 处理记录页 | 按稳定时间/id 游标 |
| A063 | GET /stats/overview | A；P08 | fromDate、toDate | StatsView | 日期错误 422；失败不能回伪造的 0 |
| A064 | GET /stats/me | M；P08 | fromDate、toDate | MyStatsView | 只当前成员归属，不接受任意 userId |
| A065 | GET /health/live | 内部部署探测 | 无；实际路径不加 /api/v1 | 200 alive | 不泄漏连接配置 |
| A066 | GET /health/ready | 内部部署探测 | 无；实际路径不加 /api/v1 | DB 就绪与子能力状态 | DB 故障 503；AI/Redis 故障标 degraded，人工路径可就绪 |

## 4 Socket 合同与历史恢复

T06 已实现本节 subscribe/unsubscribe/message.send 和授权事件投影；部署配置、Outbox 重试与实际验收见 [实时说明](realtime-development.md)。T07 的前端身份、归并、连续水位与单恢复循环见 [前端连接说明](frontend-development.md)。T08 已实现 presence.heartbeat，成员握手后通过 presence.registered 控制事件返回本连接的 connectionId，见 [接待说明](reception-development.md)；完整聊天 UI 仍归 T09/T10。

单一 /support namespace。成员使用 Cookie + handshake.auth.organizationId；访客使用 handshake.auth.visitorToken，令牌不得进查询串。身份切换创建新连接，前端 connectionGeneration 隔离迟到回调。

| 事件 | 方向与数据 | 权限、确认与消费 |
| --- | --- | --- |
| conversation.subscribe | 客户端→服务端：conversationId | 重新鉴权；ACK 返回 conversationVersion、snapshotThroughSeq；不接受任意 room |
| conversation.unsubscribe | 客户端→服务端：conversationId | 解除订阅，重复可成功 |
| message.send | 客户端→服务端：conversationId、clientMessageId、content | 同 A038 service；提交后才 ACK；JSON Schema 与 HTTP 相同 |
| presence.heartbeat | 成员→服务端：connectionId | 同 A016；由握手注册 connectionId |
| message.created | 服务端→授权订阅者：Message | 按 messageId 合并，确认丢失时可视为已保存 |
| conversation.updated | 服务端→授权订阅者：ID、version、公开状态；后台附允许字段 | 旧 version 不覆盖新状态；权限变化撤销旧订阅 |
| ticket.updated | 服务端→授权成员：ID、version | 重新拉详情；不是访客消息 |
| ai.task.updated | 服务端→授权成员：taskId、status、inputRevision、version | 后台查询 A054；不触发发送 |
| knowledge.updated | 服务端→管理员及授权知识页：ID、version、准备状态 | 刷新权限内列表，不广播正文 |
| membership.updated / presence.updated | 服务端→授权后台：成员 ID、version 或 online | 刷新可接待列表；停用当前身份断开连接 |

所有服务端事件有 eventId/type/occurredAt/data。组织、会话、成员关系变化时按当前 ACL 重新投影接收者，不仅依赖旧 room 成员表；对端已经收到的数据不能通过撤销权限追回，但后续请求和广播必须停止。

Socket 与 HTTP 心跳使用各自 connectionId，均绑定有效后台 session；HTTP 模式可自行注册并每 15 秒续期，不依赖成功建立过 Socket。Socket 断开只终止对应连接；其他活动连接仍有效时成员不判离线。60 秒无有效心跳则过期，服务端同时核验 availability 和 membership.status。

首次打开：先订阅并暂存事件，取得 snapshotThroughSeq；A039 以该水位读取最新 50 条，建立 windowStartSeq 到水位的连续窗口，水位以前未加载的历史是明确分页区间。之后合并缓存中大于水位的连续事件；发现中间空洞按 afterSeq 补齐。

向上滚动用 beforeSeq 读取旧 50 条；断线重连从 lastContiguousSeq 向后补拉到本次水位，不用最大已见 seq 跳过缺口。每次分页水位固定，期间新消息留在事件缓冲或下一轮补拉。旧历史分页不能倒退实时恢复游标。

Socket 不可用时以 HTTP 同 ID 发送；当前打开会话每 3 秒做一次 afterSeq 补拉，后台页面隐藏时暂停非必要轮询。恢复连接后关闭该轮询，避免两个恢复循环叠加。

## 5 AI 内部合同

| ID | 服务/路径 | 输入 | 输出与错误 |
| --- | --- | --- | --- |
| A067 | FastAPI POST /internal/v1/infer | taskId、operation、inputRevision、promptVersion、deadlineAt、language、messages、knowledge[]、clarificationPending；source coverage | 同 taskId/operation/inputRevision；result、modelVersion、usage、usageEstimated；结构错误/不可用/超时分类 |
| A068 | FastAPI POST /internal/v1/embed | requestId、embeddingProfileVersion、modelId、texts[]、dimensions | vectors[] 与输入同序、实际 modelId/dimensions、usage；空/维度不符拒绝 |

使用服务端专用 Bearer 凭据、受限内网地址和严格请求 Schema；没有浏览器 CORS。NestJS 不转发访客/成员原始凭据给 FastAPI。模型响应中的 organizationId、senderId、send 等字段无效并拒收。

A067 result 是以 kind 判别的联合，kind 只能为下列类型：answer={text,citations[]}；clarify={text}；handoff={reasonCode,summary?}；translate={messageId,targetLanguage,text}；summarize={summary,unresolvedItems,sourceThroughSeq}；suggest_reply={draft,citations[]}。operation=answer 只允许前三类，其余 operation 必须与 kind 同名。reasonCode 使用 contracts 的转接原因，服务端仍按实际触发原因裁决。

messages 每项为 {id,seq,senderType,content}，knowledge 每项为 {documentId,versionId,chunkId,title,text,contentHash}，均由 NestJS 投影；citations 每项为 {documentId,versionId,chunkId,quote}，quote 必须来自所给片段。source coverage 包含 sourceFromSeq/sourceThroughSeq/truncated，表示实际输入范围。禁止额外授权或执行字段。JSON 不合法只记失败，不从任意文本正则截取“看起来像答案”的部分发送。

A068 只向量化给定最小文本，不读取业务库。单次 texts≤32、每段≤2,000 code point 为初始保护值；知识长文由 NestJS 先切片，查询只发当前授权问题与必要上下文。Provider 能力不支持指定维度时，必须匹配配置中的真实固定维度。

## 6 请求与失败示例

以下是合同样例，不是已执行请求；示例 ID 为说明用占位值，实施测试换成有效 UUID。

| 操作 | 最小输入示例 | 成功形状 | 反例 |
| --- | --- | --- | --- |
| 首次咨询 A027 | clientConversationId=C1；firstMessage={clientMessageId:M1,content:如何邀请同事？} | data={conversation:{id:C,status:ai_active},message:{id:M,seq:1}} | 同 C1 不同正文 → 409；不建第二个会话 |
| 发送重试 A038 | clientMessageId=M2；content=需要人工 | data={id:M3,seq:3,...}，重复返回同 M3 | 客户端传 senderType=ai → 422 |
| 转接 A030 | Idempotency-Key=K1；reason=customer_request | data.status=waiting_human 或已有 human_active | 不能返回 AI 正在生成而拒绝接收请求 |
| 认领 A031 | expectedVersion=4 | data.assignedMembershipId=当前成员；version=5 | 并发另一人 → 409 ALREADY_ASSIGNED |
| 工单重开 A060 | expectedVersion=7；toStatus=in_progress；reason=问题复现 | data.status=in_progress；version=8 | reason 空 → 422 |
| AI 查询 A054 | 有效后台身份与 taskId | data.status=succeeded；result 为类型化结果 | 访客 token → 403/404，不能读来源 |

错误 envelope 示例语义：error.code=VERSION_CONFLICT，error.message=记录已更新，请刷新后重试，error.details={currentVersion:5}，并含 requestId。客户端不得把这种响应显示为保存成功。

## 7 合同验收

每个方法/路径有唯一 ID；所有租户入口覆盖同组织与跨组织正反例；HTTP/Socket 发送共享测试；输出 DTO 防止敏感字段外泄；A027/A038/A056 的重试可复现；A039 初始水位与历史分页/实时补偿不串游标；A067/A068 用合法、缺字段、额外字段、超时和维度不符样本验证。对应 T03—T08、T11—T15、T18—T22。
