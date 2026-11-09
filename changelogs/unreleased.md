# 未发布变更

## 目录导航

T08 人工接待 → T07 前端连接 → T06 实时投递 → T05 会话与消息事务。

## T08

新增成员 availability、独立 HTTP/Socket 心跳、会话状态命令、单调已读及内部事件；统一事务服务负责旧 AI 任务失效和首次事实保护。成员停用和关闭 AI 改为原子补偿，关闭/重开不联动工单，也不把人工会话转回 AI。13 组隔离实测及 11 接口归档验证通过，见 [接待说明](../docs/reception-development.md)。无新依赖或迁移，完整 UI 和模型执行按后续任务验收；未发布。

## T07

新增单一浏览器 API/Socket 客户端、身份/连接代次、连续 seq 补拉、pending/sent/failed 归并、同 ID 查询重试与内存草稿隔离。既有企业和访客页面接入，新增公开 Socket 网关配置与真实浏览器隔离测试；见 [前端连接说明](../docs/frontend-development.md)。无服务端合同、迁移或完整聊天 UI 变更，未发布。

## T06

新增同 API 的 Socket.IO 身份、订阅与提交后 ACK，复用 T05 消息事务；Outbox 领取租约、围栏、退避与重复投递，BullMQ 只生产真实 ID-only 任务。支持当前 ACL 撤权和公开投影，Redis 故障时本地 Socket/HTTP 可用。新增依赖、配置与隔离实测见 [实时说明](../docs/realtime-development.md)。无迁移、无聊天 UI 或真实模型能力声明；未发布。

## T05

新增首消息原子建会话、seq分配、幂等重试、原发送者结果查询和授权历史分页。消息/outbox/必要AI任务同事务，新增不可变保存时会话版本列。实测与边界见 [消息验收](../docs/messages-development.md)。未发布、未提交或推送。
