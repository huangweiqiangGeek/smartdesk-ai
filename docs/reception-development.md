# T08 会话状态与人工接待

2026-11-08：A015—A017、A030—A037 已实现，A008/A014 的保护性拒绝已替换为事务补偿。沿用现有 schema、三条迁移与依赖，无新增微服务。完整客服/访客/团队页面分别归 T09/T10/T19。

## 状态与事务

ConversationStateService 是接待状态写入入口，供 ConversationService、IdentityService 管理补偿以及消息接收时的配置丢失交接调用。普通命令按组织共享锁→身份会话→成员→幂等键锁→目标成员→会话锁执行；管理变更取组织排他锁，并按 ID 顺序锁住受影响会话。事务内只访问 PostgreSQL。

命令重新检查当前权限、expectedVersion 和目标可用性；claim 使用等待且未分配的条件更新。转交后原负责人立即失去发送权限；管理员也须接管后回复。幂等收据绑定身份、操作和 commandId，摘要包含目标与输入；同键异体/异目标冲突，历史成功重放仍需当前读取权限。首次转接和首次人工回复只记录一次。

转接、指派、转交、关闭与重开递增 version/receptionEpoch，清除 activeAiTaskId/clarificationPending，并把 queued/running 的 conversation_auto 任务改成 superseded、清空 lease。既有终态历史不改。T08 验证任务事实和旧 lease 条件写入失败；真实模型执行与最终自动发送消费者归 T14，模型调用数为 0。

关闭 AI 将当前 ai_active 全部转等待；开 AI 不恢复既有等待或人工会话。成员停用将其 human_active 会话转等待、清负责人；保留历史负责人/首次回复事实和工单数据。关闭会话与工单解决独立。visitor 可提交 customer_confirmed/unconfirmed；成员可提交 agent_resolved/unconfirmed。重开只允许原负责人或管理员，执行成员成为人工负责人，不回 AI。

read 游标单调且不超过已保存 lastSeq；events 采用组织/成员/会话绑定游标，只向当前授权成员开放，不向访客公开 commandId 或内部事件。

## 成员在线

可接待 = 成员 active + availability=available + 至少一个有效连接。连接须 lastSeenAt 距当前严格小于 60 秒、未断开，所属登录会话未撤销/未过期且用户 active。查询实时计算，不依赖 Redis 或后台扫描是否及时运行。

HTTP `POST /presence/heartbeat` 可以首次登记 UUID，绑定当前组织、成员和登录会话；已有 ID 不能重绑身份或 transport。Socket 握手由服务器登记独立 UUID，连接后发控制事件 `presence.registered: { connectionId }`，后续 `presence.heartbeat` 必须携带该连接的 ID。访客禁止登记成员在线状态。断开只标记该 Socket 连接，其他有效 HTTP/Socket 连接继续生效。

SupportClient 在有成员身份且页面可见时每 15 秒串行心跳；Socket 注册前或不可用时直接 HTTP 首次登记，已注册后走 Socket。隐藏暂停，重新可见立即心跳，退出/身份切换/销毁取消计时并隔离迟到回调。HTTP 没有额外离线端点，页面关闭后在 60 秒窗口内自然失效；退出立即撤销登录会话。

presence.updated 是刷新通知：aggregateType=presence，aggregateId 为独立事件发生标识，payload 只存 membershipId；不借用 Membership.version，否则多个连接会撞 Outbox 唯一键。投递时依当前企业权限重新查询在线事实，只向成员发送 `{id, online}`。旧 membership 聚合投影保持兼容。资料版本仅随资料/接待意愿变更增加。

## 实际验收

`pnpm test:reception` 构建 shared/server，创建独立 PostgreSQL 数据库、两个真实 API、真实 Socket 客户端及 Chromium。HTTP 首次心跳浏览器场景加载实际 SupportClient，并从首次加载就阻断 Socket。Redis 指向不可用端口以验证人工路径独立；AI 使用 fake 配置与可控数据库任务，未伪造模型能力。

13 组通过：HTTP/身份绑定/超时；Socket 多连接和通知隐私；双 API 认领与撤权；关闭/重开/首次人工事实/工单；read/events；重复转接与旧 AI lease；关 AI 补偿；管理员重开与非法目标；成员停用与最后管理员；数据库故障回滚；停用和发送竞争；浏览器心跳生命周期；归档 11 接口脚本。`test-results/reception` 保存结果、日志、截图及体验库全部 25 张 public 表前后摘要；测试数据未写入体验库，临时服务/数据库/端口已清理。

基线和变更后 T03 12组、T05 14组、T06 14组、T07 10组通过；这里按直接运行脚本计数，T05/T06 不重复计算原任务的独立归档脚本。T05 故障注入须设置 OUTBOX_ENABLED=false，避免投递器对事务快照产生干扰。前端新增两项心跳单测，原 19 项仍通过。

可复现接口脚本位于仓库内 `tests/integration/reception-api.mjs`；集成脚本给它提供已启动的隔离 API 和临时身份，接口脚本本身不启动服务，不依赖本机 DevCodex 台账。原任务归档仍保留 `T08-接口验证.cjs/.http`。上述验收记录对应 T08 完成时的本地验证，不代表线上部署或真实模型验收。
