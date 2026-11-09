# 知识管理开发与验收

## 目录导航
- [实现与边界](#实现与边界)
- [API 与状态](#api-与状态)
- [准备配置与投递](#准备配置与投递)
- [实际验收](#实际验收)

## 实现与边界

2026-11-09，T11 实现 A043—A051 的 FAQ/文本 CRUD、不可变版本、准备请求、显式启停、逻辑删除、knowledgeRevision、审计与 Outbox。NestJS 的 knowledge 模块复用 IdentityService 事务，未增加依赖、迁移或业务服务。

P05 管理页面属于 T16；真正切片、Embedding、准备消费者和向量检索属于 T13，自动回答最终提交裁决属于 T14。本次未调用模型，不能把状态夹具视为真实准备成功。原有体验服务和主库保持，T11 在隔离 API 验收；重启 API 后加载本次代码。

## API 与状态

统一 `/api/v1`，成员 Cookie + X-Organization-Id；写请求验证 Origin、JSON、X-Requested-With: SmartDesk 和 Idempotency-Key。访客 Bearer 被拒绝。所有变更在组织排他锁内重验管理员，再锁文档；读请求取组织共享锁并重验成员。修订和事件与业务同事务提交。

| API | 已实现行为 |
| --- | --- |
| A043 GET /knowledge | q/type/status + 默认20/最大100分页，游标绑定组织/角色/筛选；摘要不含 body |
| A044 POST /knowledge | faq/text；去首尾空白，问题/标题1—200、FAQ答案1—8000、文本1—50000 code point；201草稿，重放200 |
| A045 GET /knowledge/:id | 当前版本详情，agent 只能 enabled+ready；其他租户和不可见条目404 |
| A046 PATCH /knowledge/:id | expectedVersion；新不可变正文版本、转draft、版本号递增、旧集合立即失效 |
| A047 POST /knowledge/:id/prepare | 当前versionId；202表示准备请求持久化；重复点击不重复准备尝试 |
| A048 POST /knowledge/:id/enable | expectedVersion + versionId，当前ready且配置匹配才显式启用 |
| A049 POST /knowledge/:id/disable | expectedVersion，立即退出可用集合 |
| A050 DELETE /knowledge/:id | If-Match版本，必须先disabled；204软删除，重放仍204 |
| A051 GET /knowledge/:id/versions | admin版本元数据分页，无向量/历史正文；逻辑删除后普通入口404 |

公开 KnowledgeSummary/KnowledgeView/KnowledgeVersionMetadata 由 shared 导出。业务状态 draft/enabled/disabled；数据库 pending 映射公开 not_started，processing/ready/failed 原样。preparationRequested 表明已建立准备尝试；未消费的已排队版本仍为 not_started。lastErrorCode 为受控错误码，不携带堆栈/提供方原始错误。

正文、内容哈希、模型/维度/profile 和创建信息受 T02 数据库不可变触发器保护。历史正文和来源记录不因编辑/软删除丢失。编辑、启停与删除的实际变化增加组织 knowledgeRevision；同键重放不再变更版本、审计或 Outbox。后续 T14 必须在组织共享锁内重验该修订和引用，不得只依赖生成前快照。

JSON parser 上限为1mb，容纳50,000 code point及JSON转义；业务字段仍按自身上限验证。依据 [Nest 官方请求体限制说明](https://docs.nestjs.com/faq/raw-body#body-parser-size-limit)，使用现有 NestExpressApplication.useBodyParser，无依赖升级。

## 准备配置与投递

- 新正文版本冻结服务端配置身份。fake 固定 fake-embedding-v1/8，profile=fake-embedding-v1:8:v1；真实模式由配置 modelId/维度派生 profile，不能混用两者索引。
- 默认 disabled 允许存草稿。因现有不可变配置字段非空，内部用 unconfigured/profile及1维占位；该值不是有效模型能力，不创建向量。prepare 返回503 AI_UNAVAILABLE。配置后须编辑形成新版本；旧版本操作返回409 EMBEDDING_PROFILE_CHANGED，不能静默改写旧元数据。
- 准备请求以版本ID为业务身份，首次或 failed 后新命令令 preparationAttempt 递增，写 knowledge.prepare.requested；pending/processing/ready 重复请求复用现状，同一旧命令不能重新启动 failed 尝试。
- 沿用 smartdesk 前缀 ai-tasks 队列，job.name=knowledge.prepare.requested，data仅versionId，jobId=versionId-attempt。TaskPublisher 重验组织、当前版本、未删除、pending与attempt；迟到旧事件不排新任务。Redis失败由现有Outbox保留重试。
- 本次不标 processing 或创建300秒运行期限；T13消费者首次执行时负责设置期限/lease、完成或失败，并同步文档版本及事件。准备成功仍不能自动启用。

## 实际验收

`pnpm test:knowledge` 构建 shared/server，创建独立 PostgreSQL 库、专属 Redis Docker 容器和随机端口 API（双 fake、disabled、自动投递实例）。真实HTTP/Socket/BullMQ共12组，通过后 finally 关闭临时进程/容器并删除隔离库；主库全部25张public表前后行数/摘要一致。真实模型调用0。

1. 两类创建、白名单摘要/详情、跨进程幂等重放和一次审计。
2. Unicode边界、空白/未知字段、分页和游标组织/筛选绑定。
3. admin/agent/未认证/Bearer、跨组织和CSRF负例。
4. 准备请求真实排队、同尝试去重、job仅ID且无假ready。
5. failed新尝试、旧键/旧事件、Redis故障与恢复。
6. 合成ready夹具下显式启用、双API编辑一胜一409、旧正文不可变、历史可追溯。
7. 编辑/停用竞争、If-Match、软删除和重复删除保留版本。
8. 无配置草稿、配置变化拒绝、停用成员立即失权。
9. 九接口覆盖、六类审计和内部字段不泄漏。
10. Outbox插入故障事务回滚后原键重试、ready重复prepare不降级。
11. 真实Socket事件状态映射、无正文/跨组织泄漏、API循环实际队列投递。
12. 归档接口脚本连接已运行隔离实例，A043—A051九接口与持久化读回。

证据位于 test-results/knowledge/{results.json,http-calls.json,api-verification.log,main-before.json,main-after.json}，执行输出为 test-results/t11-knowledge-final.log。正式台账另存任务目录的 .http/.cjs；普通clone运行 tests/integration/knowledge-api.mjs，需提供已运行API及合成ready夹具，脚本自身不启动服务。

首次构建暴露返回值推断问题，首轮HTTP暴露默认100kb误拒合法长文本；修复后完整重跑通过，不把失败轮计入通过。

| 实际命令 | 结果 | exitCode |
| --- | --- | --- |
| pnpm test:knowledge（另设 KNOWLEDGE_API_ARCHIVE 指向正式 .cjs） | 12组，含九接口归档验证 | 0 |
| pnpm test:messages（OUTBOX_ENABLED=false） | 14组；真实消息事务与浏览器回归 | 0 |
| pnpm test:realtime | 14组；真实Redis/Socket/Chromium回归 | 0 |
| pnpm lint / pnpm format:check / pnpm typecheck / pnpm build | 分别通过 | 各0 |
| pnpm test | Vitest31 + Pytest8 | 0 |
| validate-profile.js --profile-dir ../.devcodex/smartdesk-ai/profile --project-root . | Profile通过 | 0 |
| git diff --check | 通过 | 0 |

Pytest已有一条 Starlette/httpx 弃用警告，未为T11升级依赖。主环境 web3100/API3101/AI8100存活HTTP200，worker原进程保留，PG55432/Redis56379健康；无主库迁移/种子写入。T11代码保留本地，T10已推送bff3001。
