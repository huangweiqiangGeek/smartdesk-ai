# T06 实时投递开发与验收

## 目录导航

运行配置 → 身份与消息 → Outbox 与队列 → 实际验收 → 后续边界。

## 运行配置

Socket.IO 挂在现有 NestJS API 的 HTTP server，路径 `/socket.io/`，namespace `/support`，默认地址 `http://127.0.0.1:3101/support`。无需增加应用或数据库迁移。V1 只运行一个实时 API 节点；多个 API 竞争同一 socket Outbox 不能代替跨节点广播适配器。

| 配置 | 默认值 | 合同 |
|---|---|---|
| OUTBOX_ENABLED | true | 仅 true/false；false 暂停 socket/queue 投递器，HTTP、Socket 写入和历史仍可用，待投递事实保留 |
| OUTBOX_POLL_MS | 250 | 25—10000 整数毫秒；socket/queue 独立循环 |
| OUTBOX_LEASE_MS | 30000 | 500—120000 整数毫秒；DB 时钟和随机 token 围栏 |
| APP_ORIGIN | 既有值 | 成员连接的精确 Origin |
| WIDGET_ORIGIN | APP_ORIGIN | 访客 iframe 连接的精确 Origin，仍校验 token 所绑定站点 |
| REDIS_URL | 既有值 | BullMQ 生产者；本地 Redis 保持 AOF + noeviction |

新增依赖精确锁定 Socket.IO/server/client 4.8.4、BullMQ 6.7.1，Node 22.23.4 / pnpm 12.14.0。client 仅作服务端集成测试开发依赖，前端产品接入归 T07。可选 msgpackr-extract 不运行原生构建，使用 JS 实现；没有升级 Nuxt/Nest/Prisma。

安装前读取了 [Socket.IO 初始化](https://socket.io/docs/v4/server-initialization/)、[投递保证](https://socket.io/docs/v4/delivery-guarantees/)、[服务端选项](https://socket.io/docs/v4/server-options/)、[BullMQ 连接](https://docs.bullmq.io/guide/connections) 与 [Job ID](https://docs.bullmq.io/guide/jobs/job-ids)，并核对实际安装类型和协议执行结果。Socket.IO 本身不提供数据库历史恢复；jobId 去重需要保留 job。

## 身份与消息

成员握手：Cookie `smartdesk_session` + `auth: { organizationId }`；访客：`auth: { visitorToken }`，不发送 organizationId。访客路径忽略环境中的成员 Cookie，不把它当身份。令牌不进入 URL/query，未知 auth 字段、任意 room 和错误 Origin 被拒绝。身份变更需新建连接。

| 操作 | 输入 | 成功 ACK |
|---|---|---|
| conversation.subscribe | conversationId | conversationVersion、snapshotThroughSeq |
| conversation.unsubscribe | conversationId | conversationId；重复可成功 |
| message.send | conversationId、clientMessageId、content | T05 canonical Message |

ACK 为 `{ ok: true, data, requestId }` 或 `{ ok: false, error: { code, message }, requestId }`。send 调用同一个 `ConversationService.send`，数据库事务提交后才返回成功；Socket 与 HTTP 同键并发只有一条消息，同键异文为 IDEMPOTENCY_CONFLICT。收到 message.created 也证明已保存；ACK 超时后仍应查询 A040 或同键重试 A038。

订阅、发送、推送均查询当前 Cookie/访客会话及资源 ACL。每秒复核旧连接，注销、停用、站点失效会断开；改派撤销不可见会话的订阅。每次业务操作和推送立即重新授权，不等待这一次定时复核。已排入网络的数据无法追回，授权查询为当前推送的裁决点。

服务端不直接广播 Outbox payload：message.created 从数据库投影 canonical Message；conversation.updated 只给访客 ID/version/status/lastSeq/updatedAt，后台增加允许字段。ticket/ai.task/knowledge/membership/presence 通知只向当前授权成员投影 ID、版本或状态，不传知识正文、AI 结果、内部备注或凭据。实际业务生产者包含 T05 消息/会话事件与 T08 会话状态/成员/在线事件；ticket、AI 结果和知识通知的业务生产者由后续任务实现。

每连接最多 100 个订阅、16 个并行操作；帧上限 64 KiB，未排空的传输包上限 100，超限断开后按历史恢复。广播不等待客户端 ACK。T08 已接入 presence.heartbeat 和独立连接绑定，状态服务成为新的会话/成员/在线事件生产者，见 [接待说明](reception-development.md)。

## Outbox 与队列

`Outbox.claim` 用单条 UPDATE + SELECT FOR UPDATE SKIP LOCKED 领取最多 20 条可用或租约到期的 pending 事件；批内最多 4 路并行，等待全部结算才进入下一批。满批时下一轮立即继续，未满批才等待轮询间隔，避免积压时人为增加延迟。短事务只领取，不跨网络持有数据库锁。完成/失败都匹配 ID、随机 leaseToken 和未过期 leaseExpiresAt；旧 worker 不能覆盖新租约。

失败保留 pending，指数退避最大 30 秒。进程在发布前退出会在租约到期后恢复；发布后、标记前退出可重复投递原 eventId，不重执行业务 send。socket published 表示完成当时的授权投递尝试，不表示客户端已收到或已读；没有在线订阅者也可 published，离线端从数据库补拉。事件可能重复/乱序，前端必须按 messageId/seq/version 归并，不能以最大已见 seq 作为连续水位。

队列为 `smartdesk:ai-tasks`；只支持 `ai.task.requested`，重查同租户 AiTask，payload 仅 `{ taskId }`，jobId 固定为 taskId，保留完成/失败 job。已过期或非 queued 任务不重新入队，不改变业务状态。未知事件保留 pending，不能把未实现消费者标为成功。

生产者禁离线等待队列，连接/命令超时有限。Redis 故障时 HTTP 发/查与单节点本地 Socket 仍运行；恢复后从 Outbox 入队。实际 AI 执行、任务超时裁决、业务重试和 job 保留清理策略归后续 worker 任务；现有 worker 仍报告 consumers=0，没有空成功消费者。

## 实际验收

执行 `pnpm test:realtime`：编译 shared/server，创建隔离 PostgreSQL 数据库与单独 Redis Docker 容器，启动 API、真实 Socket 客户端及两个 Chromium context；始终清理自己的进程、端口、数据库与容器，比较体验库 24 表前后摘要。需要已有项目 PostgreSQL、Docker 和已安装 Chromium，不向体验库写测试消息。

覆盖：握手与跨租户/访客隔离、双协议幂等/冲突/DB 失败、竞争领取/过期围栏、进程恢复、ACK 丢失/广播先到、重复事件、发布未标记崩溃、Redis 停止/恢复、稳定 jobId、过期任务、100 条真实浏览器投递、隐私投影、改派/停用/关闭/站点失效/注销。隔离 Worker 只证明真实队列传输与 job 去重，模型调用数为 0。

归档 `.cjs` 可用 `REALTIME_API_VERIFICATION` 指向任务目录的脚本，测试器把它连接到已经启动的隔离 API；脚本本身不启动服务。完整证据保存在 `test-results/realtime`，任务报告另存不可混淆的快照。T02—T05 回归使用 `OUTBOX_ENABLED=false`，避免将旧的多 API 事务测试误当成多节点实时部署。

2026-11-07 最终完整命令 `pnpm test:realtime`（含归档脚本）exitCode=0，15组通过。100条浏览器消息使用默认 poll=250ms、lease=30000ms，p95=1195ms，max=1222ms；故障阶段单独缩短租约至1000ms。验收过程中曾发现串行投递及满批轮询等待导致延迟超标，修正后仍按原2秒门槛验收。T02数据库60断言、T03身份12组、T04跨站12组、T05消息15组回归均exitCode=0；工程静态/类型/构建与18项单元测试通过。Python测试仍有既有 Starlette/httpx 弃用警告，没有因此升级依赖。

## 后续边界

T07 已实现前端监听、归并、连接代次、空洞补拉和 HTTP 轮询，见 [前端连接说明](frontend-development.md)；T08 实现 presence 与接管/交接；T09/T10 完成聊天页面；AI 业务消费者与模型能力按各任务验收。当前体验页仍是已有登录、企业和访客身份外壳。性能证据只覆盖本机隔离环境，不能等同于线上容量或完整 AT20—AT23 产品验收。
