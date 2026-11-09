# 架构与范围

本文用于初始化与模块边界变更。第一版采用 Nuxt 前端、模块化 NestJS 业务后端和无业务数据写权限的 FastAPI AI 服务；保持两个语言服务的责任清晰，不重复实现业务逻辑。

## 技术与目录

前端沿用 Nuxt 4、Vue 3、TypeScript、Tailwind CSS、shadcn-vue；业务后端使用 NestJS、Socket.IO、Prisma、PostgreSQL+pgvector、Redis、BullMQ；AI 服务使用 Python FastAPI 与 OpenAI-compatible API。版本在初始化时核对官方文档后锁定。完整部署、身份、并发与 ADR 见 [V1 技术方案](technical-plan-v1.md)。

| 规划位置 | 职责 | 边界 |
| --- | --- | --- |
| `apps/web/app` | 客服工作台、客户聊天入口、页面和状态 | 不直接调用 AI 服务或数据库 |
| `apps/server/src/modules` | auth、organizations、memberships、widget、customers、knowledge、conversations、messages、tickets、stats、ai-jobs | Controller/Gateway 调用统一业务 service |
| `apps/server/src/workers` | outbox 投递、AI 任务消费、结果回写 | 可独立进程部署，复用业务服务规则 |
| `services/ai-service` | 知识回答候选、翻译、摘要、回复建议、Embedding 与提供方适配 | 无业务数据库连接，不管理工单和会话权限 |
| `packages/shared` | 公共事件 Schema、DTO 类型与生成客户端 | 不包含 Prisma 实体、服务端凭据或 Nest 业务实现 |
| `database/schema`、`database/migrations` | Prisma schema 与迁移 | Prisma 明确配置 schema 位置，避免两份迁移目录 |
| `tests`、`docs` | 跨服务验证与规范 | 不存放真实业务运行数据 |

按实际模块逐步创建目录。Nuxt 仅做渲染和必要代理；同源入口把 `/api/v1` 和 Socket.IO 连接路径转发到 NestJS。FastAPI 只在内部网络供受认证的 worker 调用。

## 所有权与依赖

1. NestJS 独占组织、用户、客户、知识及版本、会话、消息、工单、AI 任务与结果的业务写入，PostgreSQL 是事实源。
2. Controller 与 Gateway 校验传输格式并获取身份；service 负责授权、幂等与事务；repository/Prisma 只负责受限数据访问。HTTP 与 Socket.IO 不能各实现一套发消息规则。
3. AI 服务接收最小必要的已授权文本快照，输出类型化结果，不主动获取任意会话或凭调用者填写的 organizationId 自行扩权。
4. Redis 第一版只负责任务队列，在线心跳与业务事实保存在 PostgreSQL。首版单 API 实例和独立 worker；未来缓存/多实例广播需另验连接路由、广播和故障恢复。
5. NestJS worker 负责跨服务超时、重试、结果幂等和任务状态；Python AI 服务不再创建另一套业务队列或重试编排。
6. 本项目与 Enterprise Agent Hub 分别拥有数据库、迁移、队列命名空间及存储，不直接互查或提前抽取共享业务服务。

## 消息与 AI 流程

发送请求 → 校验会话权限 → 同一事务保存 message、会话序号与 outbox → 提交后确认发送方 → 发布事件。AI 接待时异步检索授权知识并生成候选，NestJS 复核状态、输入和知识版本后保存 AI 消息；人工模式只保存内部辅助结果。

消息数据库提交成功是确认边界。发布或 Redis 故障不回滚已保存消息；历史查询和重连补偿恢复可见性。若多实例广播不可用，明确显示实时连接降级，不能承诺各实例仍立即收到通知。

AI 自动接待失败进入人工流程，不能阻塞人工发消息。转人工、接管、关闭与自动发送共用会话状态裁决；转接被接受后迟到候选不能写成消息。人工模式中客服点击发送才产生人工消息，AI 草稿本身不能触发发送。

## 范围控制

第一版为自建 Web 客服渠道、FAQ/粘贴文本知识、AI 优先接待、两种成员角色和人工认领/分配，范围以 [V1 PRD](prd-v1.md) 为准。知识采用 pgvector 精确 cosine 检索，按组织与当前 enabled+ready 版本过滤，不预建 ANN 索引；详见 [数据模型](data-model-v1.md) 与 [AI 流程](ai-workflow-v1.md)。S3 用于后续明确需要的附件能力，文字聊天闭环无需提前增加附件系统。PDF/网站导入、支付、订阅计费、WhatsApp 等渠道、复杂自动派单、多 Agent 和 MCP 工具执行不进入第一版。

状态及跨层字段见 [contracts.md](contracts.md)；异常验收见 [quality.md](quality.md)。
