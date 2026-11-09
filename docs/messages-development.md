# T05 会话与消息事务

## 目录导航

- [接口与身份](#接口与身份)
- [事务与重试](#事务与重试)
- [历史与列表](#历史与列表)
- [迁移与任务边界](#迁移与任务边界)
- [实际验收](#实际验收)

## 接口与身份

实现 A027—A029、A038—A040，基础路径 `/api/v1`。返回统一 `{data,requestId}` 或稳定错误 envelope，全部 `Cache-Control: no-store`。

| 方法与路径 | 输入与结果 |
| --- | --- |
| POST /conversations | 访客；Idempotency-Key UUID；`{clientConversationId,firstMessage:{clientMessageId,content}}`；201 首建、200 原创建恢复 |
| GET /conversations | status/view/cursor/limit；返回授权会话页；访客不能传 customerId、组织头或成员 view |
| GET /conversations/{id} | 当前授权的 ConversationView |
| POST /conversations/{id}/messages | `{clientMessageId,content}`；201 新保存、200 已保存原消息；不要求通用 Idempotency-Key |
| GET /conversations/{id}/messages | latest/beforeSeq/afterSeq/cursor 互斥，throughSeq 固定水位 |
| GET /conversations/{id}/message-requests/{clientMessageId} | 当前可读且是原发送者；Message 或 404 REQUEST_NOT_FOUND |

访客仅凭 Bearer，由服务端推导企业和客户；存在 Authorization 就不回退成员 Cookie。每次校验令牌有效性、站点启用及绑定的 parentOrigin 仍在允许列表。访客写入要求 `Origin=WIDGET_ORIGIN` 和 JSON。真实同源 GET 可能不带 Origin：允许省略，但若提供必须匹配；无 Origin 时拒绝 cross-site/same-site Fetch Metadata。持凭据的非浏览器客户端仍可读取，Origin 不是身份凭据。

成员使用 Cookie 和 X-Organization-Id，写入检查 APP_ORIGIN、JSON、X-Requested-With: SmartDesk。admin 可读本企业，agent 只读自己负责和未分配等待队列；所有人工发送均要求当前 human_active 负责人，管理员也需接管。失权后不能通过旧幂等键读取消息。

正文保留原文，拒绝纯空白、NUL、不完整 Unicode 与超过 8000 code point；客户端不能指定 sender/seq/组织/客户。Message 只输出 shared 白名单，不包含 hash、内部任务、来源和备注。

## 事务与重试

锁顺序：组织共享锁 → 身份会话 → 成员 → 会话 → AI task。首建锁 visitor session FOR UPDATE；普通收发使用身份共享锁与会话写锁，不用进程内 mutex。配置和权限管理沿用组织排他锁。

首条消息、会话、必要任务、outbox 和创建收据在同一事务保存；创建时间与首消息时间相同。打开/刷新历史不建会话。clientConversationId 绑定访客 session；即使误换命令键，同一首消息仍返回原会话，内容或首消息 ID 不同则 409。

后续先鉴权，再按组织/会话/发送者/clientMessageId 判重，最后判断 closed 和负责人；同键同文返回原消息，同键异文 409 IDEMPOTENCY_CONFLICT。关闭后的原请求仍能恢复；新消息返回 CONVERSATION_CLOSED。404 REQUEST_NOT_FOUND 仅表示查询时未见已提交结果，不能证明并发请求永远不会提交。

每条新消息分配一个 seq 和保存时 conversationVersion，访客输入推进 inputRevision/lastVisitorSeq。message.created、conversation.updated 和必要的任务 outbox 同事务提交。HTTP 成功发生在提交之后，失败返回503并用原ID重试。首次人工回复时间只填写一次。

## 历史与列表

消息默认50、上限100，全部升序。latest 取固定水位之前最新窗口；beforeSeq 向前翻页；afterSeq 从连续游标向后补拉。返回 `snapshotThroughSeq/windowStartSeq/hasMore/nextCursor`，空页 windowStartSeq=null。cursor 固化原水位、方向与身份/企业/会话，不与 before/after/throughSeq 同传；limit 可调整。后续新消息留到下一轮水位，备注不占公开 seq。

会话列表默认20、上限100，createdAt/id 降序 keyset；view=waiting/mine/all 仍与角色 ACL 相交。cursor 绑定过滤条件、企业和身份。分页重查授权和状态，不提供跨页的状态冻结承诺。后台 unreadCount 统计阅读水位之后非本人成员发送的公开消息，不代表访客已读。

## 迁移与任务边界

新增 `202611070001_message_version`：messages.conversation_version 非负、默认0且不可变。0仅代表旧数据未记录保存时版本，不猜测回填。旧两条迁移不改写。部署顺序为 `pnpm db:generate` → `pnpm db:migrate` → 启动新API。回退旧API可保留新增列，禁止重置库。

组织开启AI、有部署模型配置且存在当前 enabled+ready 知识时，保存 conversation_auto/answer 任务，固化输入消息窗口（最近最多50条公开消息）、轮次、组织修订、语言、modelId、auto-answer-v1 和消息时间+30秒期限；新输入使旧未完成任务 superseded。实际上下文 Token 裁剪与模型调用由后续 AI 任务负责。

没有配置/关闭AI/无可用知识走等待人工；已有 AI 会话在后续输入发现配置或知识失效时，仍保存消息并进入等待人工。等待会话不会因重新启用AI返回自动接待。测试使用 fake-chat-v1 仅验证任务事实，没有 AI 结果或自动业务回复。

本任务未实现 outbox 投递和 Socket（T06）、客户端消息状态（T07）、认领/关闭 API（T08）、聊天界面（T09/T10）及模型执行（T15）。测试通过隔离库直接安排 human_active/closed 状态以验证 T05 发送边界，不代表 T08 已实现。

## 实际验收

`pnpm test:messages` 自动创建并升级有旧样本的隔离库，启动两个真实 API 及一个 disabled 配置 API，运行 Chromium，结束后删除本次库并核验端口释放。证据保存 `test-results/messages/`；主库全部行摘要前后比较，不向主库写测试数据。

2026-11-07：最终归档15组验收通过，包括12路并发首建、16路同键发送、20路不同消息连续seq、同键异文并发竞争、丢失响应、关闭后重试、失权拒绝、分页中新增消息、Unicode边界、内部备注隔离、消息/outbox/收据/任务失败回滚、AI任务版本与期限、真实无Cookie无Origin GET、六API归档检查，以及原数据保留与清理。T02回归60项断言、T03 12组、T04 12组通过。

体验库三条迁移已应用，24张业务表旧字段摘要完全保留；新API已运行于3101，web3100/AI8100/数据库55432/Redis56379及worker保持运行。AI readiness 为 disabled，未宣称真实模型已验证。

正式归档另通过 MESSAGE_API_VERIFICATION 指向任务目录的 T05-接口验证.cjs，对已运行隔离 API 核对六个端点；不把它指向有真实业务的环境。报告记录最终执行命令、退出码及回归结果。真实模型效果保持 UNVERIFIED。
