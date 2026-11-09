# SmartDesk AI

面向 SaaS 和服务型网站的多租户智能客服系统，以 AI 优先接待、必要时转人工为核心流程，支持可靠消息收发、团队协作与工单跟进。

当前状态：T01—T08 已通过本地功能验收。已有四个应用入口、真实 PostgreSQL+pgvector/Redis、24 个业务实体与数据库约束，账号/企业/成员/邀请和跨站访客身份可用。T05 提供原子首消息、seq、幂等与授权历史 API；T06 提供 Socket 与 Outbox 实时投递、队列生产和故障恢复；T07 提供统一前端客户端、消息归并、连续水位恢复及草稿隔离；T08 提供统一接待状态和在线心跳。聊天界面归 T09/T10，P09 管理界面归 T19。见 [数据库验收](docs/database-development.md)、[身份验收](docs/identity-development.md)、[跨站接入验收](docs/widget-development.md)、[消息验收](docs/messages-development.md)、[实时验收](docs/realtime-development.md)、[前端连接验收](docs/frontend-development.md) 与 [接待验收](docs/reception-development.md)。八个模块和五条规则见 [V1 PRD](docs/prd-v1.md)，T09—T26 按 [任务清单](docs/development-tasks-v1.md) 开发。

开发前从 [AGENTS.md](AGENTS.md) 按任务读取 [docs 开发规范](docs/README.md)；工作区上下文见 [DevCodex Profile](../.devcodex/smartdesk-ai/profile/README.md)。

T08 已补齐在线心跳、交接/认领/指派/转交/关闭/人工重开，以及成员停用和关闭 AI 的事务补偿，见 [接待验收](docs/reception-development.md)。运行 `pnpm test:reception` 执行隔离数据库、双 API、Socket 和真实浏览器验收；它保留已有体验数据并清理自建服务。

## 本地启动

使用 Node 22.23.4、pnpm 12.14.0、Python 3.15.2，在项目根目录执行：

```powershell
pnpm install --frozen-lockfile
python -m pip install --target .tools/uv uv==0.13.7
pnpm ai:sync
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm db:generate
```

安装并启动 Docker 后运行 `pnpm deps:up`、`pnpm check:dependencies`、`pnpm db:migrate`。分别在四个终端运行 `pnpm dev:web`、`pnpm dev:api`、`pnpm dev:worker`、`pnpm dev:ai`；默认地址为 web 3100、API 3101、AI 8100。模型默认关闭，配置和验收细节见 [本地开发与 T01 验证](docs/local-development.md)。数据库迁移/约束测试使用 `pnpm test:database`，只向自动创建的隔离库写入合成数据。

检查命令：`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm db:validate`；依赖集成使用 `pnpm test:integration`，只读登录入口/代理 smoke 在 web 启动后使用 `pnpm test:e2e`。结束服务用 Ctrl+C，结束本地依赖用 `pnpm deps:down`（保留数据）。

体验入口为 `http://127.0.0.1:3100/login`，可自行注册并创建企业。`pnpm test:identity` 构建后使用隔离数据库、独立 API/web 和真实 Chromium 验收身份流程，自动清理；不向体验库创建测试账号。APP_ORIGIN 和 Nuxt 私有代理配置见 [身份开发说明](docs/identity-development.md)。

`pnpm test:widget` 验收两个真实 HTTPS 父站点与独立 iframe、禁第三方 Cookie、收据丢失/过期和身份隔离；自动清理隔离资源。加载脚本、服务端加密 keyring 及站点配置方法见 [访客接入说明](docs/widget-development.md)。

`pnpm test:frontend` 使用实际前端客户端和隔离 API/数据库验收消息状态与恢复，自动清理测试资源。公开 Socket 网关由 `NUXT_PUBLIC_SOCKET_BASE` 配置，默认 `http://127.0.0.1:3101`；部署时与 Cookie 作用域、HTTPS 和服务端 Origin 配置保持一致，详见 [前端连接说明](docs/frontend-development.md)。

`pnpm test:messages` 使用隔离库、多个 API 与 Chromium 验证消息并发、失败回滚、历史水位和权限；自动清理临时资源。体验库已应用消息版本增量迁移，原有业务数据保留。API 运行代码已更新，当前页面仍为身份与小窗外壳；模型默认关闭，T05 只验证任务事实。

## 产品定位

`pnpm test:realtime` 创建隔离 PostgreSQL/Redis/API 与真实 Chromium，验证 Socket、租约、ACK、权限撤销和故障恢复并自动清理。Socket.IO 随 API 在 3101 启动；当前仅单实时 API 节点，AI worker 尚未消费业务任务。配置及本机实测边界见 [实时说明](docs/realtime-development.md)。

面向 SaaS 和服务型网站，AI 根据企业 FAQ 与文本知识先接待，必要时带上下文转人工，持续问题通过工单跟进。客服端保留翻译、回复草稿和摘要辅助。计划在 Enterprise Agent Hub 核心闭环完成后开发。

## 核心演示流程

管理员维护知识 → 客户消息保存成功 → AI 有依据回答 → 客户请求或 AI 无法处理时转人工 → 停止自动回复 → 客服接管并编辑草稿发送 → 创建与独立处理工单。

## 第一版范围

- 客户聊天入口：网站小窗、演示页、文字聊天、历史、转人工与离线留言。
- 知识库：手动 FAQ 与粘贴文本，编辑、启停、试问和来源追溯。
- AI 接待与交接：知识回答、必要澄清、带上下文转人工。
- 客服工作台：认领、分配、转交、内部备注、结束会话和 AI 辅助。
- 客户资料：基础信息、搜索与授权历史。
- 工单管理：创建、负责人、优先级、四种状态和处理记录。
- 基础统计：会话、AI 接待、转人工、待处理工单和首次人工响应。
- 团队与设置：登录、企业、成员、管理员/客服权限、接入配置与数据隔离。

完整功能与验收以 [PRD](docs/prd-v1.md) 为准，其中补充默认值单列于第 14 节。PDF/网页知识导入、附件、情绪分析、智能派单、满意度评分、邮件通知、Webhook 和第三方渠道延后。

## 关键业务约束

- 消息先持久化，再向发送方确认。
- 使用 clientMessageId 并结合租户、会话及发送者身份验证处理重复提交。
- 历史查询与断线重连支持补拉遗漏消息；不能仅依赖 WebSocket 连接保证可靠性。
- AI 任务异步执行，AI 故障不能阻塞普通消息收发。
- AI 自动回答由业务服务核验会话状态、最新输入和有效知识后发送；转人工被接受后停止自动回答。
- 人工模式下 AI 回复建议必须经客服确认后发送；无人在线仍保存留言，联系方式可选。
- 会话与工单独立，结束会话不自动解决工单。
- HTTP 接口、WebSocket 连接及消息操作都需要验证身份和租户归属。

## 原对话建议的技术栈

以下为规划选型，具体版本及必要依赖在工程初始化时确认。数据库采用最新方案的 PostgreSQL。

| 层级 | 规划技术 |
| --- | --- |
| 前端 | Nuxt 4、Vue 3、TypeScript |
| 界面 | Tailwind CSS、shadcn-vue |
| 后端与通信 | NestJS、Socket.IO / WebSocket |
| 数据与异步任务 | PostgreSQL + pgvector 精确检索、Prisma、Redis、BullMQ |
| AI 服务 | Python、FastAPI、OpenAI-compatible API |
| 部署 | Docker Compose；附件所需 S3 存储延后 |
| 测试 | Vitest、Playwright |

## 开发顺序与验收

1. 明确 PRD、架构和数据模型，搭建前后端及基础服务。
2. 完成登录、组织与 RBAC，验证跨租户及越权访问被拒绝。
3. 完成客户、会话和实时消息，验证持久化、重复发送与断线补拉。
4. 建立 FAQ/文本知识与 AI 接待，验证知识失效、转人工停发、超时降级；接入人工端翻译、草稿与摘要。
5. 完成工单、基础统计和客服工作台，跑通客户与客服双窗口演示。
6. 补齐测试、Docker 启动说明、架构说明和演示材料。

详细执行顺序、依赖与验收以 [开发任务清单](docs/development-tasks-v1.md) 为准：先可靠人工链路，再知识与 AI，再其余业务和系统验收。完整 V1 初估 166—262 小时，按每天 3—4 小时约 42—88 个投入日；首个里程碑后按实际速度重估，不沿用原三周建议作为承诺。

## 开发方式

项目采用 AI 辅助开发，由维护者负责产品决策、代码审查和最终验收。产品范围以 [V1 PRD](docs/prd-v1.md) 为准，实施进度和验证结果见 [开发任务清单](docs/development-tasks-v1.md) 及对应验收文档。
