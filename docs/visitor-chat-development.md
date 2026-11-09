# T10 访客聊天与真实演示入口

## 运行与边界

- P03 `/widget/:publicKey` 只能通过真实 loader 建立身份；父页以 publicKey+origin 保存凭据，iframe 复用 SupportClient 发起 Bearer 请求，成员 Cookie 不参与。
- P10 `/demo/:publicKey` 是虚构“墨舟”SaaS，品牌、项目与方案明确标注合成；聊天、联系人和会话均走真实 API，无管理员凭据或自动后台登录。
- `NUXT_PUBLIC_WIDGET_ORIGIN` 是演示页使用的公开客服 origin，空值取当前 origin；跨站托管演示页时须设为服务端 `WIDGET_ORIGIN`，并在该站点配置中允许演示页 origin。此值通过 Nuxt 运行环境传入，不接受 URL 参数覆盖。
- AI 自动回复尚未开放，页面明确当前人工路径；`ai_active` 仅展示真实状态和转人工入口，不合成消息或声称调用模型。

## 消息与状态

首消息通过 A027 原子创建会话及消息，组件保留同一 clientConversationId/clientMessageId 与原正文，未知结果显示待确认并原请求重试。后续消息沿用 T07 的 pending/sent/failed、ACK 查询/同 ID 重试及连续 seq；“已保存”仅说明服务端确认，不代表客服已读。

初次打开先订阅水位再取最新 50 条；更早消息走独立历史分页。授权会话列表支持分页与手动刷新；会话元信息每五秒刷新，消息恢复仍只由 SupportClient 执行。已加载草稿保存在同一访客身份的客户端内存，切会话隔离；刷新不自动重发未知请求。

四状态来自服务端；等待时说明尚未接通、可以留言稍后查看，不承诺在线或等待时长。ConversationView 新增可选 `assignedDisplayName`，仅投影负责人显示名。转人工 A030 与关闭 A034 使用稳定命令 ID；失败不假报成功，409 显示冲突并刷新实际状态。结束后旧会话只读，新咨询在首消息时创建新记录。

姓名/邮箱/语言使用 T04 A024 版本控制，均不改变凭据关联。无邮箱仍可留言；相同邮箱不能获取其他身份历史。联系方式为空不代表会自动发送邮件通知。

## 加载与交互

真实 loader 负责浮动入口、首方存储、bootstrap 恢复及受限 postMessage。演示组件卸载时派发本地 dispose 事件，loader 取消请求、移除监听和 iframe。A020 同源 GET 缺 Origin 时，仅在 fetch metadata 为 same-origin 且 Referer 属于配置的 widget origin 时恢复该 origin，仍检查 allowlist；跨站和错误 Referer 保持拒绝。

聊天、错误、待确认和重试均有文本状态；Enter 发送、Shift+Enter 换行，输入法 composition 中不发送。小屏使用同一聊天界面与独立滚动消息区；输入内容不因收到消息被覆盖。

## 验收命令与证据

`pnpm test:visitor-chat` 构建后复用 T04 的隔离 PG/API/Nuxt/HTTPS fixture，运行前置身份负例与 T10 真实浏览器交互；原始日志与截图位于 `test-results/visitor-chat/`。数据库、临时端口与证书由 finally 清理，体验主库逐表摘要保护保持启用。

2026-11-09 实测（锁定依赖，无真实模型调用）：

| 命令 | exitCode | 结果 |
| --- | --- | --- |
| `node tests/integration/widget.mjs`（实施前） | 0 | T04 12 组，真实不同 HTTPS 站点与禁第三方 Cookie |
| `node tests/integration/frontend.mjs`（前后各一次） | 0 | T07 10 组，乱序/重复/连续水位/身份与草稿隔离 |
| `node tests/integration/reception.mjs`（前后各一次） | 0 | T08 13 组，状态锁/心跳/补偿与归档 API |
| `node tests/integration/inbox.mjs`（变更后） | 0 | T09 11 组，真实工作台与权限失效 |
| `pnpm build` | 0 | shared/server/Nuxt 产物构建 |
| `node tests/integration/visitor-chat.mjs`（最终产物） | 0 | 22 组：T04 12 组及 T10 10 组；最终日志 `test-results/t10-browser-final.log` |
| `pnpm lint`、`pnpm format:check`、`pnpm typecheck` | 0 / 0 / 0 | ESLint/Ruff/Prettier/TypeScript/Nuxt/mypy |
| `pnpm test` | 0 | Vitest 31 项、Pytest 8 项；既有 Starlette/HTTPX 弃用提示保留 |

T10 实测涵盖：无邮箱且零在线客服留言；同凭据跨站刷新与另一父站点隔离；转人工 503/响应丢失同键恢复；真实客服工作台开始接待、接管与回复、显示名、访客草稿保留和备注隔离；关闭只读/新咨询/旧历史；首消息已提交但响应丢失只落一条；合成 AI 状态无假回复、关闭 409；断网后原消息重试和重复正文；320px 窄屏、Enter/Shift+Enter/composition 事件；历史加载错误及重试；同源缺 Origin 兼容及跨源错误 Referer 负例；首方存储不可用与 Bearer/Cookie 隔离。输入法验证为 Chromium composition 事件与键盘交互，未使用本机系统输入法候选窗。

实测发现并修复 A027 缺幂等请求头、测试入口循环导入，以及客服成员资料未就绪时可提前点击接待按钮。状态最终以服务端详情驱动，避免将消息版本水位作为状态版本。失败尝试未算通过；最后一轮 22 组、主库所有 public 表摘要相同、临时库/进程/端口/证书自动清理。

保留的体验数据库中两个 DVGO 站点仍为 disabled，未自动启用或修改允许来源。演示页面可访问；实际接入需管理员按 T04 说明启用站点并加入准确 origin。AI 自动回复、邮件通知与生产部署不在本次能力声明内。
