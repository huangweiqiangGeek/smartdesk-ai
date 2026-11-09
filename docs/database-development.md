# T02 数据库迁移与验收

供后端开发与验收使用。2026-11-06 已实现并验证 24 个业务实体；本地 `smartdesk` 库已应用两条迁移。产品接口、授权服务和业务状态转换仍按后续任务实现。

## 文件与执行顺序

- `database/schema/schema.prisma`：唯一 Prisma 模型，camelCase 字段映射 snake_case 列；UUID、timestamptz、租户复合外键、索引和普通唯一键。
- `database/migrations/202611060001_initial/migration.sql`：从 Prisma 模型生成的初始结构，事务内启用 vector 扩展、建表和外键。
- `database/migrations/202611060002_integrity/migration.sql`：95 个 CHECK、2 个 AI 任务部分唯一索引及 17 个完整性触发器；不包含业务状态推进或队列操作。
- T05 新增 `202611070001_message_version`：消息保存时版本列、非负检查和不可变触发器；旧两条迁移保持原样。当前回归增加两个版本约束断言，完整消息事务验收见 [T05](messages-development.md)。
- `database/seed.sql`：覆盖 24 类实体的合成数据，两个企业、重复联系邮箱、禁用账号、明确 fake 模型元数据；重复执行不修改已有样本。
- `tests/integration/database.mjs`：真实隔离数据库验收，创建的临时库在 finally 中删除，不删除现有开发库或数据卷。

项目根执行：

```powershell
pnpm deps:up
pnpm db:validate
pnpm db:generate
pnpm test:database
pnpm db:migrate
pnpm exec prisma migrate status
```

`test:database` 自动生成客户端、编译 server，再创建 `smartdesk_t02_<pid>_<time>_fresh/upgrade` 数据库，需要当前本地数据库账号具有建库权限。默认沿用根 `.env` 的 DATABASE_URL；不得指向生产库。`db:migrate` 使用 Prisma migrate deploy，不使用 db push。生成客户端位于 server 内并忽略提交/格式/lint，不通过 shared 导出。

单独运行 `pnpm db:seed` 时，必须显式设置 `SMARTDESK_SEED_DATABASE_URL`，目标库名必须为 `smartdesk_t02_*`；脚本不会默认向体验库灌入合成聊天记录。该入口已在隔离测试中实际运行并验证幂等。日常开发无需手动创建种子库，使用 `test:database` 即可。

## 约束与业务服务的边界

数据库保证跨组织 FK、同组织会话/客户与知识文档/版本归属、消息 seq 和幂等键、工单创建/操作收据/outbox/AI 任务唯一性、枚举与非负计数、接待状态与负责人/结束字段的组合、发送者身份、知识维度及配置匹配、历史正文与事件不可修改、成员历史引用不被级联删除。

在线连接的 auth session 必须属于其 membership 对应用户，连接身份不可换绑。AI/system 消息发送 ID 必须匹配组织保留 ID；这些约束不替代未来 Controller/Service 的鉴权。

最后管理员、成员是否可接待、会话/工单合法转换、read cursor 单调及已有水位、消息分配 seq、知识启停并发、任务 lease/deadline 当前性及 AI 原子提交等属于 T03/T05/T08/T11—T14/T18 的业务事务验证。当前仅约束行形状与引用完整性，不能把 T02 的数据库测试记成上述业务验收。

## Embedding 与原生 SQL

尚无真实模型配置，因此不硬编码 1536 等推测维度。列为 PostgreSQL `vector`（Prisma `Unsupported("vector")`）；知识版本明确声明 modelId、embeddingProfileVersion 和 1—16000 维度，chunk 写入必须匹配版本的维度与 profile，零向量拒绝。版本的正文及模型/维度配置不可修改，改模型建立新版本。

同一列允许承载不同 profile 的数据，检索集合必须先限制 organizationId、当前 enabled/ready 版本和 embeddingProfileVersion，再做精确 cosine；不能混合模型或维度比较，不建 ANN 索引。T02 只用 fake-embedding-v1 的 8 维合成向量证明数据库约束和运算，真实模型能力仍未验证。

Prisma 7.10.1 的部分索引 DSL 需要 `partialIndexes` Preview。当前未启用预览特性，两个部分索引和 CHECK/触发器统一由第二条迁移维护。Prisma diff 验证可表达结构；额外原生约束由真实非法写入及 catalog 回读验证，不能仅凭 diff 宣称所有约束正确。

官方依据：[Prisma 自定义迁移](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/unsupported-database-features)、[部分索引](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes#configuring-partial-indexes-with-where)、[外键删除行为](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/relations/referential-actions)、[PostgreSQL 17 CHECK/FK](https://www.postgresql.org/docs/17/ddl-constraints.html)、[pgvector 类型与维度](https://github.com/pgvector/pgvector#vector-type)。没有新增或升级依赖。

## 2026-11-06 实测

| 命令/场景 | 退出码 | 结果 |
| --- | --- | --- |
| pnpm db:validate / pnpm db:generate | 0 / 0 | 24 模型有效，客户端生成成功 |
| pnpm test:database | 0 | 58 项断言；空库、重复种子、重复 deploy、带数据升级、SQLSTATE 拒绝、Prisma 关系查询、向量运算 |
| pnpm --filter @smartdesk/server build | 0 | 生成客户端随 server 编译通过 |
| pnpm lint / pnpm format:check / pnpm typecheck | 各 0 | TS/Nuxt/Python 静态检查通过 |
| pnpm test | 0 | 原有 Vitest 10、Pytest 8 通过，保留 HTTPX 弃用提示 |
| pnpm db:migrate（本地开发库，两次） | 0 / 0 | 首次应用两条迁移，第二次无待应用迁移 |
| prisma migrate status / migrate diff --from-config-datasource --to-schema database/schema/schema.prisma --exit-code | 0 / 0 | 已同步，无结构差异 |
| pnpm check:dependencies | 0 | PostgreSQL/vector 与 Redis 可用 |

真实回读：24 个业务表、61 个 FK、95 个 CHECK、17 个完整性触发器，两条迁移 finished；开发库合成企业数为 0。10,000 行消息样本的查询计划使用 `messages_organization_id_conversation_id_seq_key` Index Scan；这是索引可用性检查，不是业务时延或性能 SLA 证明。

初次 lint 的 URL 全局问题已通过显式 node:url 导入修复，格式检查失败已修复后重跑。测试断言分别检查 23503（FK）、23505（唯一键）、23514（CHECK/完整性），防止把任意报错当成成功。带数据升级精确比较消息字段和时间戳；失败迁移通过注入数据库错误并 ROLLBACK 验证结构/数据保留。

## 2026-11-06 收尾复验

17:11—17:14 重新执行 `db:validate`、`test:database`、`prisma migrate status`、`db:migrate`、`prisma migrate diff --from-config-datasource --to-schema database/schema/schema.prisma --exit-code`、`lint`、`format:check`、`typecheck`、`test`、`build` 和 `check:dependencies`，11 条命令退出码全部为 0。数据库断言仍为 58 项，Vitest 10 项、Pytest 8 项通过；HTTPX 弃用提示保留。

独立前后快照确认：24 业务表、61 FK、95 CHECK、17 触发器、2 个 AI 部分唯一索引；2 条已完成迁移的 checksum 与磁盘一致。主库所有业务表合计 0 行，前后计数不变；schema、迁移、seed、测试、数据模型、PRD 和依赖锁摘要不变。临时测试库剩余 0 个。

快照比较首次因数据库 Date 与 JSON 字符串的表示差异退出 1；只修正任务内验收脚本的序列化比较后，复验退出 0。没有修改业务 schema 或历史迁移，也没有通过重置主库解决验收问题。

正式收尾任务为 `6396625b-90b9-583b-9704-f6a7a496ab5c`。当前运行日志、命令时间与退出码、快照、CP 和终态证据归档于工作区 `.devcodex/smartdesk-ai/requirements/SmartDesk AI T02 数据模型与迁移约束/`；最终状态以该任务正式回执为准。

## 恢复与保留方式

两条迁移各自 BEGIN/COMMIT。尚未提交的失败迁移回滚事务；已成功迁移不自动 DROP 表或回写历史文件，后续用修正迁移前滚，或按运维计划从备份恢复。开发库应用前已导出备份，本轮未验证生产备份恢复，不提供会删除业务数据的自动 down。

本次隔离测试库均已清理。此前用户要求的 web/API/worker/AI 和 Docker 依赖继续运行；迁移后页面 HTTP 200，API 的 DB/Redis available、AI disabled。没有新增永久服务，也未停止原体验进程。
