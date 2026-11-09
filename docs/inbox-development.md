# T09 客服工作台开发与验收

当前状态：2026-11-09 代码与本地功能验收通过。11 组真实浏览器场景、T07 的 10 组及 T08 的 13 组回归通过；不代表 AI、T10 访客产品页或线上部署完成。

## 入口与实现边界

- 企业入口提供“打开客服工作台”，路由 `/app/o/:organizationId/inbox` 与 `/inbox/:conversationId`。
- 复用 T07 单一 SupportClient 与 T08 状态服务，没有新增依赖、微服务、配置项或数据库迁移。
- 桌面三栏，窄屏按列表、聊天、客户资料逐层切换。同企业会话切换保持页面实例与独立公开/备注草稿，退出或切企业销毁状态。
- 会话选择使用 Router 即时路由状态，导航过渡暂时禁用输入，避免快速切换时写入上一会话；返回列表后再次点击当前会话会恢复聊天层。详情请求有独立代次，旧响应不能覆盖新权限或状态。
- 左栏提供等待、我的、全部有权和状态过滤；列表和详情可见时每三秒串行调度一次刷新，不另建消息补拉循环。分页刷新保留已加载范围。这里只标注已加载条数，不把它冒充全队列总数。
- 消息复用 T07 最新 50 条、水位、历史与实时补拉、幂等和 pending/sent/failed。成员显式标记当前查看消息为已读；计数仅访客消息，游标按成员独立。
- 管理员公开发送同样必须先接管。认领、指派、转交、关闭、重开使用真实状态命令和版本校验；409 刷新状态，保留人工输入。权限失效时隐藏会话私有数据，身份失效时清空全部页面缓存。
- 客户侧栏只展示 A029 授权摘要及 A037 操作记录。AI 摘要、翻译、建议明确不可用；工单功能仍归 T18。

## A041/A042 备注合同

GET `/conversations/:id/notes` 使用 scope 绑定的 cursor 与 limit（默认 50，上限 100），按创建时间及 ID 倒序。DTO 为 id、conversationId、authorMembershipId、clientNoteId、content、createdAt，不返回组织内部字段。

POST 同一路径接收 clientNoteId 和 1—8000 字符非空 content。沿用组织→身份→会话锁；只有当前负责人或管理员可写。幂等键由组织、会话、作者、clientNoteId 组成，同键同文返回既有记录，同键异文返回 409。已关闭会话不接受新备注，既有成功请求可在当前权限下读回。

访客 GET/POST 一律 403，成员无会话权限为 404。备注仅保存到既有 ConversationNote 表，不写 Message、Outbox 或 AiTask；公开历史与最后消息摘要不含备注。

## 可重复验证

`pnpm test:inbox` 先构建，再启动隔离数据库、API、Nuxt 和 Chromium 独立上下文。需要本地 PostgreSQL/pgvector 可用；不需要模型凭据。设置 `INBOX_HEADED=true` 时使用已安装 Chrome 的可见窗口，本次最终验收使用此模式。保留证据在 `test-results/inbox/`，脚本在 finally 中清理其进程、数据库并核验端口关闭。

访客验收页是测试专用真实 HTTP 夹具，使用独立 Bearer 身份及真实数据，未计入 T10 产品页面完成。客服端运行实际构建的 Nuxt 工作台与 Socket；截图辅助检查布局，交互断言与 trace 才是验收证据。

主库业务表前后摘要比较排除正常运行可能变动的 presence_connections、outbox_events；不宣称这些运行态表字节不变。若体验环境正在被使用，成员可用性等真实操作也会触发数据保护断言；不要删除这些数据或放宽保护来获取通过。本次最终在更新自建体验 Web/API 的短暂重启间隙完成比较，之后恢复原地址。T07/T08 回归的全部 25 张主库 public 表摘要一致。

## 实测记录

| 命令（项目根） | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm build` | 0 | shared、NestJS、Nuxt 构建通过 |
| `pnpm lint` | 0 | ESLint 与 Ruff 通过 |
| `pnpm typecheck` | 0 | TS/Nuxt 与 mypy 通过 |
| `pnpm test` | 0 | 31 项 TS、8 项 Python 通过；既有 Starlette/httpx 弃用提示保留 |
| `pnpm format:check` | 0 | Prettier 与 Ruff 格式检查通过 |
| `node tests/integration/frontend.mjs` | 0 | T07 的 10 组真实场景及全部 25 表主库保护通过 |
| `node tests/integration/reception.mjs` | 0 | T08 的 13 组、11 接口及全部 25 表主库保护通过 |
| `$env:INBOX_HEADED='true'; node tests/integration/inbox.mjs` | 0 | 4 个独立浏览器上下文、11 组场景、23 表主库保护及资源清理通过 |

11 组覆盖：访客真实咨询与授权列表、双客服同时认领/409、公开消息与键盘、备注 ACL/幂等/游标范围与非法正文、备注响应丢失同键重试、不可用成员转交失败后恢复及实际转交撤权、关闭/人工重开、超过 50 条消息与备注及焦点保留、快速切会话/390px 逐层导航、加载/空/503 重试与管理员先接管、成员停用及退出清理。最后一次运行未捕获浏览器异常为 0，真实模型调用为 0。

证据：`test-results/inbox/results.json`、四份 `window-*.zip` trace、桌面/移动截图、迁移日志、API/Web 日志、主库摘要；回归与工程日志位于 `test-results/inbox-*.log`。这些文件默认不提交。

中间失败包括不精确定位器、空正文按钮预期、停用成员预期状态码，以及测试包自带可见 Chromium 启动失败；已修正断言并改用本机 Chrome。真实窗口发现的快速路由/草稿问题已修复并在最终场景验证。未将失败轮次计为通过。

## 体验环境

Web `http://127.0.0.1:3100`，从企业入口进入工作台；API/Socket `http://127.0.0.1:3101`。原有账号与企业数据保留，未向主库添加验收咨询。AI 仍 disabled；完整访客聊天、AI 辅助、客户管理、工单分别按后续任务开发。
