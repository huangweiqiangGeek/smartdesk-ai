# T07 前端消息状态与连接

T08 已在同一 SupportClient 接入可见成员页面的 15 秒串行心跳、HTTP 首次注册及身份销毁清理，见 [接待说明](reception-development.md)。原消息恢复和草稿边界保持不变。

## 目录导航

装配与配置 → 消息窗口 → 发送与草稿 → 身份与资源生命周期 → 验收与边界。

## 装配与配置

`apps/web/app/plugins/support.client.ts` 为每个浏览器 Nuxt app 建立一个 `SupportClient`，不在 SSR 模块级保存身份。`useSupportClient` 负责快照订阅及页面消费者释放；`useIdentityApi` 复用同一个 HTTP 实现。服务分为 `api.ts`（凭据与错误）、`socket.ts`（传输）、`message-state.ts`（消息窗口）和 `support-client.ts`（生命周期）。既有企业页和访客 iframe 已接入；聊天页面归 T09/T10。

web 精确依赖 `socket.io-client@4.8.4`，复用 T06 已锁定版本，未升级其他框架。安装前读取 [客户端选项](https://socket.io/docs/v4/client-options/) 和 [客户端 API](https://socket.io/docs/v4/client-api/)，核对 forceNew、autoConnect、auth、volatile 和 timeout。使用独立 Manager，身份建立后连接，不启用 Socket.IO 离线发送队列或隐式重试队列。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| NUXT_API_BASE | http://127.0.0.1:3101 | 既有服务端 HTTP 代理目标，不公开 |
| NUXT_PUBLIC_SOCKET_BASE | http://127.0.0.1:3101 | 浏览器可达的公开 Socket 网关，客户端追加 /support，传输路径为 /socket.io/ |

本地使用同一主机不同端口，成员 Cookie 能到达 API。部署时公开 Socket 网关必须与成员 Cookie 的作用域匹配，推荐同源入口转发 `/socket.io/` 到 NestJS；HTTPS 页面使用 HTTPS 网关。修改 `APP_ORIGIN`/`WIDGET_ORIGIN` 必须继续满足服务端精确来源校验。T07 没有增加 Nuxt WebSocket 代理或部署平台，线上网关归 T24 验收。

成员 HTTP 使用 Cookie 与活动企业头，显式请求另一企业会被客户端拒绝；切企业需先清理旧身份。访客 HTTP 使用 Bearer 且 `credentials=omit`，Socket auth 仅含访客令牌。浏览器可能给同主机 WebSocket 附带环境 Cookie，服务端仍只按访客令牌认证。令牌不进入 URL、SSR payload 或消息快照。

## 消息窗口

首次连接等待订阅 ACK 的 `snapshotThroughSeq`，按水位查询最新 50 条并验证连续性。期间事件先缓存在消息窗口；历史区间以前的未加载消息明确属于上翻范围，不误判为实时缺口。纯 HTTP 降级没有订阅 ACK，使用 A039 返回的固定水位。

归并以 server messageId、seq 和原发送者的 clientMessageId 为依据；同样文字可多次发送。`lastContiguousSeq` 仅在连续消息到齐后前移；见到更大 seq 只提高补拉目标。上翻使用独立 before 游标和加载锁，不倒退实时游标。重连重新订阅，从连续游标追赶固定水位；实时事件超出水位后再补下一轮。

HTTP 备用补拉每 3 秒一次，缺口、重连、手动恢复共用一个串行恢复驱动。连接代次变化会中止旧恢复，已发出的迟到响应仍需通过代次校验。页面隐藏停止非必要轮询，重新可见恢复。上翻历史可与实时补拉独立运行。

## 发送与草稿

`send` 在第一次调用时生成稳定 clientMessageId 并固定正文；`retry(id)` 复用 ID 和正文。pending 表示结果未知，canonical Message 来自 ACK、广播或查询才变为 sent，明确拒绝才变为 failed。sent 只表示已保存，不代表已读。

ACK 超时先查 A040；查询明确不存在后允许一次同 ID HTTP 重试。查询仍因网络失败时保留 pending，不把超时假报为失败。广播先到后，迟到错误不会把 sent 降级。每个 ID 同时只执行一次发送；HTTP 轮询仅核对未知结果，不循环自动重发。

草稿按当前身份内的 conversationId 分区，只保存在浏览器内存；切会话保留草稿，切企业、退出或失效全部清理。当前消息窗口和未确认条目只保留当前打开会话；页面刷新/离开后先补拉已保存历史，不自动重发丢失的请求。发送只同步清除当时与正文相同的草稿，迟到 ACK 不碰之后输入的文字。事件不写入人工草稿；显式应用建议需同时匹配身份代次、会话、草稿 revision、输入 seq 且不存在缺口。AI 建议产生和产品按钮归后续任务。

## 身份与资源生命周期

切企业/退出先递增 contextGeneration，取消请求与恢复计时器、解绑事件、断开旧连接并清空缓存。旧 HTTP/ACK/事件回调全部校验身份和连接代次。凭据失效或服务端主动断开清空身份；既有页面同时移除已失效的用户/企业/访客资料并显示提示。

同会话多消费者复用一次订阅，最后一个消费者释放时取消订阅。订阅和取消操作按连接串行，快速关闭重开不会被旧取消操作覆盖；确认结果未知时重建连接，隔离服务端迟到操作。路由跨身份域、pagehide 和 HMR dispose 清理连接，bfcache 恢复重新加载身份。

## 验收与边界

`pnpm test` 含客户端单元测试；`pnpm test:frontend` 编译共享包和服务端后，用实际前端服务源码、真实 Chromium、隔离 PostgreSQL 和独立 NestJS 执行验收。测试页面只用于操纵故障与观察状态，不是交付的聊天 UI，也不向体验库写入合成消息。

覆盖双身份最新 50 条与上翻、相同文字、ACK 丢失查询、乱序/重复/缺口、断网重连、从未成功建立 Socket 的 HTTP 发送和轮询、切企业/退出迟到事件、凭据撤销。单元测试另外控制迟到 HTTP/ACK、隐藏页、并行历史、快速重开与取消确认丢失、草稿编辑等时序。

证据写入 `test-results/frontend`，包括场景结果、API 日志、体验库所有 25 张 public 表（24 业务表加迁移表）前后摘要和资源清理结果。命令最终结果另见任务报告。T03/T04 的隔离身份及跨站回归需要先 `pnpm build`，分别执行 `node tests/integration/identity.mjs`、`node tests/integration/widget.mjs`。模型调用数为 0；presence 与接管接口已由 [T08](reception-development.md) 验收，完整收件箱和小窗消息 UI、真实模型及线上部署仍由后续任务验收。
