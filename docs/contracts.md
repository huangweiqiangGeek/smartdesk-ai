# 接口与事件契约

以下是第一版协议基线，产品语义与权限以 [V1 PRD](prd-v1.md) 为准。端点、DTO、错误与样例见 [API 详细设计](api-v1.md)，字段存储见 [数据模型](data-model-v1.md)；身份 API 已在 T03 实现，访客接口实现范围见 [T04 接入说明](widget-development.md)，其他端点随任务实施。公共 DTO 由 shared 统一输出，服务端 Prisma 投影与消费者共同接受类型检查。

## HTTP 与权限

- `/api/v1` 为基础路径；JSON 字段 camelCase；ID 使用 UUID 字符串，时间为 UTC ISO 8601。
- 成功 `{ data, requestId }`；列表 `{ data: { items, nextCursor }, requestId }`；错误 `{ error: { code, message, details? }, requestId }`。204 无响应体。
- 默认 limit=20，最大 100；聊天补拉按会话 seq 升序，游标必须绑定组织和会话，不能凭游标绕过授权。
- 401 未认证、403 同租户已知资源权限不足、404 不存在或不可见、409 幂等内容/版本/状态冲突、422 输入错误、429 限流、503 暂时不可用。业务失败不统一返回 200。
- 企业成员仅有 admin、agent 两种角色；创建者为 admin。admin 管理企业、知识、成员、会话分配与工单；agent 可查看并认领未分配等待会话，处理自己负责的会话/工单。visitor 仅访问服务端凭据授权的本人会话，不是组织成员。管理员回复前也需接管，最后有效管理员不可停用或降级。

## 消息与幂等

canonical Message 至少含 `id、conversationId、senderId、senderType、clientMessageId、seq、content、createdAt`。organizationId 由服务端上下文确定；seq 为会话内递增整数，由数据库事务分配，重试不重新分配。

senderType 为 `visitor | agent | ai | system`；admin 回复仍为 agent 类型。AI/系统发送身份和幂等标识由服务端产生，客户端不能传入这些身份。为兼容统一消息结构，服务端生成的发送标识也映射到 clientMessageId 字段。内部备注采用独立可见性和受限读取/事件，不混入访客消息流。

客户端展示状态为 `pending | sent | failed`：sent 表示服务端已持久化，不表示对端已收到或已读。数据库已保存消息不保留客户端 pending/failed 作为业务真相。T05 将 Message.conversationVersion 固化为保存时版本，重试/历史不替换成当前会话版本；旧数据未记录值为0。实现与 HTTP 分页细节见 [消息说明](messages-development.md)。

幂等唯一键为 `(organizationId, conversationId, senderId, clientMessageId)`。同键同内容返回原消息；不同内容返回 409 / IDEMPOTENCY_CONFLICT。去重记录至少随消息实体保留。发起方超时后先查询或以同 ID 重试，不生成新 ID。

## HTTP 与实时事件

| 操作 | 契约 |
| --- | --- |
| 发送消息备用 HTTP 入口 | `POST /conversations/{id}/messages`，输入 clientMessageId、content；首次 201、重复 200，均返回 canonical Message |
| 历史/补拉 | `GET /conversations/{id}/messages`，latest/beforeSeq/afterSeq 互斥模式，返回 items、snapshotThroughSeq、windowStartSeq、nextCursor/hasMore；首次 50 条、旧历史与实时补拉分开 |
| Socket 发送 | `message.send`，输入 conversationId、clientMessageId、content；与 HTTP 共用业务 service |
| Socket ACK | 成功 `{ ok: true, data: Message, requestId }`；失败 `{ ok: false, error: { code, message }, requestId }`；提交后才 ACK |
| 消息广播 | `message.created`，事件 envelope 包含 canonical Message；客户端按 messageId/clientMessageId 合并 |
| AI 辅助请求/查询 | `POST /conversations/{id}/ai-tasks`，operation、inputRevision；只允许授权客服的辅助操作，202 返回含 id 的 AiTaskView；`GET /ai-tasks/{id}` 查询授权结果；自动接待由业务服务触发 |
| AI 通知 | `ai.task.updated`，携带 taskId、status、inputRevision、version，只向授权后台通知；客户端不据此发送消息，已保存的自动回答另走 message.created |
| 会话/工单通知 | `conversation.updated`、`ticket.updated`，携带资源 ID、version 和允许公开的变更字段 |

事件 envelope：`{ eventId, type, occurredAt, data }`。消息排序以 data.seq 为准；非消息资源以 version 防止旧事件覆盖新状态。eventId 用于重复事件去重，不能代替数据库补拉。广播范围由服务器计算，不接受客户指定任意 room。

T06 实现为单实时 API 节点，成员 Cookie + auth.organizationId 与访客 auth.visitorToken 分离；当前 ACL 决定每次推送。Outbox 允许重复/乱序；published 不是送达确认。ACK 查询、私有事件投影、配置与队列生产边界见 [实时说明](realtime-development.md)。

连接/重连时重新认证，校验房间权限，监听事件并暂存后补拉历史，再合并去重；只推进连续 seq。服务端分页补拉至最新快照水位，客户端发现空洞再次补拉。资源不可见或游标失效返回明确错误，不静默清空聊天。ACK 丢失但广播已到也视为已保存。

## 会话、工单与 AI 状态

T08 的统一事务状态服务、成员心跳和管理补偿已实现，具体锁、presence 控制事件和验收边界见 [接待说明](reception-development.md)。

会话状态为 `ai_active | waiting_human | human_active | closed`，分别对应 AI 接待、等待人工、人工处理中、已结束，完整转换语义见 PRD 第 7 节。转人工成功后不自动回 AI；重开进入 human_active。关闭会话不接受新消息，发送返回 CONVERSATION_CLOSED。

agent 可原子认领 waiting_human 中未分配会话，转交自己会话给可接待成员；admin 可分配/接管。认领、转接、关闭与自动回答保存按同一会话版本裁决。服务端接受交接后，尚未保存的 AI 候选失效；已保存历史保留。角色/分配变化撤销旧连接的相应权限。

首次转接主原因枚举：customer_request（客户请求）、knowledge_insufficient（资料不足/冲突）、unable_to_handle（无法处理）、ai_failure（AI 故障）、ai_unavailable（AI 关闭/未配置）、human_takeover（客服主动接管）。更细的故障/冲突信息只作内部 detail，不新建统计主分组；firstHandoffReason 对应首次事实，不能由后续转交覆盖。

工单状态为 `open | in_progress | waiting_customer | resolved`，对应待处理、处理中、待客户回复、已解决；转换见 PRD 第 7 节，resolved 重开到 in_progress 必须有原因。修改携带 expectedVersion，过期返回 409；改派由 admin 执行。会话关闭与工单解决互不自动触发。

知识业务状态为 `draft | enabled | disabled`，准备状态为 `not_started | processing | ready | failed`。仅当前 enabled+ready 版本可用于自动回答；编辑转草稿，重新准备后显式启用，旧候选不能继续发送。

AI 任务 `queued → running → succeeded | failed | superseded`；排队期间也可超时进入 failed 或因输入/状态过期进入 superseded。重试属于同 taskId，记录 attempt，不把 failed 任务无条件改回成功。操作为 `answer | translate | summarize | suggest_reply`。inputRevision 指定源消息集合/覆盖 seq、内容版本和目标语言；answer 还绑定知识版本、会话状态版本与 AI 配置版本，Prompt/模型配置一并固化。

inputRevision 的 scope 规则见 [数据模型](data-model-v1.md#4-知识与-ai)：自动任务为客户输入轮次，会话辅助为创建时 lastSeq，单轮试问为 1；源消息集合、语言与知识修订是独立快照字段。A053 接收当前 lastSeq，不能把自动轮次值代入辅助请求。

翻译以源消息版本判断当前性；摘要和回复建议在有更新消息时失效，未完成任务的过期候选写为 superseded；已经成功保存的结果保持历史记录，查询以 isCurrent=false 标明过期，不把终态重新执行。用户请求重新生成使用新任务 ID，不覆盖历史结果。客户端另外保存发起任务时的 draftRevision，客服本地编辑后禁止自动回填；本地草稿变化不伪装为服务器已经观察到的状态迁移。

## AI 内部契约与预算

FastAPI 暴露内部 `POST /internal/v1/infer` 与 `POST /internal/v1/embed`。infer 输入 taskId、operation、inputRevision、promptVersion、受限文本和语言，answer 另含授权知识片段及版本；输出 taskId、operation、inputRevision、result、modelVersion、usage/usageEstimated。answer 的 result 区分回答/澄清/建议交接及依据引用；embed 输入最小文本批次与固定模型/维度，返回同序向量。完整合同见 [API A067/A068](api-v1.md#5-ai-内部合同)。结果经 NestJS 校验并条件保存，Python 无业务数据库或消息发送权限。

| 约束 | MVP 初始值 |
| --- | --- |
| 单条文本消息 | 最多 8000 个 Unicode code point；前后端按同一规则计数 |
| AI 单次处理 | 输入最多 8000 Token、输出最多 2000 Token；超过输入预算显式截取并说明覆盖范围 |
| 单次 AI 请求 | 最长 30 秒且不超过所属任务剩余预算；仅 NestJS worker 调度重试，最多额外 2 次 |
| 自动接待 answer | 从客户消息成功保存起最多 30 秒，包含排队、推理与重试；超时转人工，恢复不重置期限 |
| 内部辅助总任务 | 从首次 running 起最多 120 秒，包括退避；排队失败可见并可人工重试，恢复不重置已开始的期限 |
| 内部辅助排队 | 最多等待 60 秒，超时失败可重新发起新任务 |
| 知识准备 | 从首次 processing 起最多 300 秒，失败重试使用新准备尝试，不延长同一次执行期限 |

以上是初始限制，不是实测性能承诺。自动接待过期后的补投递只允许收尾，不重新生成或发送；人工消息不等待 AI。输入、预算和重试不由模型输出决定；usage 缺失标为估算，不能伪造精确成本。完整 provider 错误只进入受控诊断，公开错误区分 AI_UNAVAILABLE、AI_TIMEOUT、AI_INVALID_OUTPUT、INPUT_TOO_LARGE。
