# SmartDesk AI V1 完整技术方案

> 版本：1.0；日期：2026-11-06；依据：[PRD 1.0](prd-v1.md)。
> 状态：T01 工程初始化与本地依赖、T02 数据模型与迁移验收已通过，证据见 [本地开发](local-development.md) 和 [数据库验收](database-development.md)；业务接口、事务用例与真实 AI 能力仍待实施验证。
> 使用者：项目负责人、开发者、Codex 与验收人员。

阅读顺序：本方案 → [数据模型](data-model-v1.md) → [API](api-v1.md) → [页面](pages-v1.md) / [AI 流程](ai-workflow-v1.md) → [任务清单](development-tasks-v1.md) → [Codex 提示词](codex-prompts-v1.md)。工程实施从 T01 开始，后续状态以任务清单和实际验证证据为准。

## 目录导航

- [1. 架构目标与成功标准](#1-架构目标与成功标准)
- [2. 需求理解与业务场景](#2-需求理解与业务场景)
- [3. 角色、权限与核心业务对象](#3-角色权限与核心业务对象)
- [4. 系统边界与非目标](#4-系统边界与非目标)
- [5. 当前上下文与约束](#5-当前上下文与约束)
- [6. 整体架构图](#6-整体架构图)
- [7. 系统主流程](#7-系统主流程)
- [8. 子流程设计](#8-子流程设计)
- [9. 核心节点详细设计](#9-核心节点详细设计)
- [10. 状态机设计](#10-状态机设计)
- [11. 数据流设计](#11-数据流设计)
- [12. 时序设计](#12-时序设计)
- [13. 模块架构与依赖方向](#13-模块架构与依赖方向)
- [14. 数据模型、索引与生命周期](#14-数据模型索引与生命周期)
- [15. API、事件、CLI、Hook 或 MCP 契约](#15-api事件clihook-或-mcp-契约)
- [16. 一致性、事务、缓存与幂等](#16-一致性事务缓存与幂等)
- [17. 异常、重试、补偿与人工修复](#17-异常重试补偿与人工修复)
- [18. 权限、安全、隐私与审计](#18-权限安全隐私与审计)
- [19. 性能、容量与可扩展性](#19-性能容量与可扩展性)
- [20. 可观测性与运维策略](#20-可观测性与运维策略)
- [21. ADR 决策记录](#21-adr-决策记录)
- [22. 风险、取舍与待确认项](#22-风险取舍与待确认项)
- [23. 开发任务拆分与里程碑](#23-开发任务拆分与里程碑)
- [24. Architecture Review Checklist](#24-architecture-review-checklist)

## 1. 架构目标与成功标准

支撑 PRD 全部八模块和五条规则；将有依据的自动回答、可靠消息、人工交接、独立工单组织为一个可部署的客服系统。成功条件是 PRD AT01—AT27 和本方案的并发/故障验收通过，不以页面存在或模型返回文本判定完成。

关键不变量：同一发送请求只保存一次；转人工被接受后没有新的 AI 自动回答；知识编辑/停用不能被未完成的候选绕过；同企业也按资源授权；AI 与 Redis 故障不阻塞人工消息保存。

## 2. 需求理解与业务场景

| 场景 | PRD 需求 | 实施归属 |
| --- | --- | --- |
| 网站咨询、刷新恢复、无人在线留言 | V01—V05 | widget、conversations、messages |
| FAQ/文本进入可用知识集合 | K01—K06 | knowledge、AI embedding adapter |
| 自动回答、澄清、交接 | A01—A06 | ai-jobs、conversation state service |
| 认领、人工回复、内部辅助 | I01—I05 | inbox、messages、notes、AI assist |
| 客户与持续问题跟进 | C01—C03、T01—T04 | customers、tickets |
| 组织、设置与指标 | O01—O05、S01—S03 | auth、organizations、memberships、stats |

先实现可靠人工链路，再接知识和自动接待，最后汇总统计、评测与演示。分阶段不削减 V1 模块。

## 3. 角色、权限与核心业务对象

成员只有 admin、agent；访客凭据独立。admin 管理本组织资源，发送人工消息前也须成为会话负责人；agent 可读待认领队列及自己负责的会话，客户/工单查询逐条限制。AI/system 是服务端发送身份，不能登录。

核心对象为组织、成员、访客/客户、会话、公开消息、内部备注、知识及版本、AI 任务/结果、工单。细粒度权限矩阵沿用 PRD 第 3 节；表关联不能替代权限检查。

## 4. 系统边界与非目标

仅 Web 客服、文字、FAQ/粘贴文本、中英访客与翻译、手动认领/分配。PDF/网页导入、附件、支付、外部业务操作、第三方渠道、自动派单、多 Agent 编排均不进入 V1。

首次部署单 NestJS API 实例，一个独立 worker 进程和一个内部 FastAPI 服务。不开多地域、分库、独立向量数据库或通用工作流平台。

## 5. 当前上下文与约束

设计基线最初仅有文档。T01 已建立 Nuxt/Nest/FastAPI 入口与依赖锁，尚无 Git 或业务数据库迁移；本地依赖和实测状态见 [本地开发](local-development.md)。技术基线为 Nuxt 4/Vue/TypeScript、NestJS/Socket.IO、Prisma/PostgreSQL、Redis/BullMQ、Python/FastAPI。Tailwind CSS、shadcn-vue 和业务通信/队列依赖在对应页面与业务任务加入。

新增设计选择是 PostgreSQL 的 pgvector 扩展，首版精确余弦距离检索；不预建 ANN 索引。官方说明区分精确检索与以召回换速度的近似索引，本方案选择前者降低首版调试复杂度。[pgvector 官方说明](https://github.com/pgvector/pgvector#querying)

T01 的实际兼容版本、官方依据与模型配置合同见本地开发文档；真实模型标识和能力尚未配置或验证。不得照抄旧 ORM API 示例代替版本核验。

## 6. 整体架构图

~~~mermaid
flowchart LR
    H[客户网站与加载脚本] --> W[Nuxt 客服小窗 iframe]
    A[Nuxt 客服后台] --> N[NestJS HTTP 与 Socket]
    W --> N
    N --> P[(PostgreSQL 与 pgvector)]
    N --> O[数据库 outbox 投递器]
    O --> R[(Redis / BullMQ)]
    R --> B[NestJS worker]
    B --> P
    B --> F[内部 FastAPI 推理与向量接口]
    F --> L[模型与 Embedding 提供方]
    O --> N
~~~

N01—N08 业务节点见第 9 节。浏览器不访问 F/P/R；FastAPI 不访问业务数据库，不拥有聊天发送权；消息/状态事件只能在数据库提交后可见。

## 7. 系统主流程

~~~mermaid
flowchart TD
    N01[N01 成员与网站配置] --> N02[N02 录入并启用知识]
    N02 --> N03[N03 访客发送且持久化]
    N03 --> N04[N04 检索并生成候选]
    N04 --> C{会话和依据仍有效且可回答}
    C -->|是| N05[N05 原子校验并保存 AI 消息]
    C -->|否或客户请求| N06[N06 进入等待人工并接管]
    N06 --> N07[N07 人工回复与内部辅助]
    N07 --> N08[N08 独立工单跟进与统计]
    N05 -->|继续咨询| N03
~~~

关闭会话是明确动作，可从 AI/等待/人工状态进入；不是工单终态。AI 关闭、无知识、超时直接走 N06。

## 8. 子流程设计

| 子流程 | 入口、出口 | 失败与恢复 |
| --- | --- | --- |
| SF01 网站身份 | 允许域名加载 → 恢复/创建访客凭据 → 打开小窗 | 不允许域名拒绝；存储不可用仅本次会话，不谎称可跨刷新恢复 |
| SF02 消息提交 | 稳定请求 ID → 授权 → 事务 → ACK → 广播 | ACK 丢失查询/同 ID 重试；不能按内容去重 |
| SF03 知识准备 | 保存不可变版本 → outbox → 切片/向量 → ready → 管理员启用 | 失败显示原因并按同版本重试；修改后旧版本不继续服务 |
| SF04 AI 接待 | 消息已保存 → 任务 → 检索/推理 → 条件提交或交接 | 30 秒绝对期限；新输入替换旧轮次，超时不能被补投递复活 |
| SF05 人工交接 | 请求/主动接管 → 状态事务 → 原始历史 → 可选摘要 | 摘要失败不挡接管；并发认领只有一个成功 |
| SF06 业务跟进 | 人工建单 → 状态及记录 → 解决/重开 | 会话关闭不联动；冲突返回当前版本供刷新 |

## 9. 核心节点详细设计

| 节点 | 前置/输入 | 读写与状态 | 成功、失败与幂等 |
| --- | --- | --- | --- |
| N01 | 已登录成员，企业或邀请 | users、sessions、organizations、memberships、widget_configs | 邀请单次消费；保留最后管理员；组织创建按 commandId 防重复 |
| N02 | admin、FAQ/文本 | documents/versions/chunks；draft → ready → enabled；增加 knowledgeRevision | 版本内切片唯一；失效候选拒绝；失败可重试准备 |
| N03 | 有效访客/成员、content、clientMessageId | conversations、messages、outbox、必要时 ai_tasks | message+seq+outbox 同事务；同键同内容返回原结果 |
| N04 | 有效自动任务、剩余预算 | 读取当前授权知识，记录输入/模型/依据版本 | 外部调用不持有事务；失败分类、有限重试；仍受绝对期限约束 |
| N05 | 候选、输入轮次和版本 | 再验组织/会话/知识，保存 ai_results+AI message+outbox | 同轮唯一；转接先提交则拒绝；模型无权直接调用发送 API |
| N06 | 客户请求、故障或成员动作 | conversations、conversation_events、outbox | 幂等 commandId；首个 handoff 时间不覆盖；无需等 AI 结束 |
| N07 | 当前负责人 | 人工 messages、独立 notes、assist tasks、read cursors | 备注不进入访客流；草稿必须手动发送；权限撤销后不能写 |
| N08 | 授权会话/工单、expectedVersion | tickets、ticket_events；按业务事实聚合统计 | 建单按 commandId；工单转换独立；没有响应样本返回 null |

## 10. 状态机设计

枚举唯一入口为 [contracts](contracts.md)，业务语义为 PRD 第 7 节。会话 AI → 等待 → 人工 → 关闭；允许 AI 直接被管理员接管，允许未结束状态显式关闭；已关闭由授权成员重开为人工。等待/人工不能自动恢复 AI。

工单 open 可到 in_progress/resolved；in_progress 可到 waiting_customer/resolved；waiting_customer 可到 in_progress/resolved；resolved 只可带原因回 in_progress。其他转换 409。

知识的业务启停与准备状态分开，只有当前 enabled+ready 版本可用于自动回答。AI task queued/running 可进入 succeeded、failed、superseded；终态不能被迟到结果逆转。超时交接是业务效果，不是假装推理成功。

## 11. 数据流设计

前端 command/message → NestJS 身份上下文 → PostgreSQL 事实 → outbox → Socket 或 BullMQ。队列只携带 taskId/versionId 等定位信息，worker 从数据库取授权快照；模型输出先经过结构验证，再由业务事务裁决。

公开 Message 与内部 AI/备注 DTO 分离；知识来源快照只进授权后台。事件 payload 按当前订阅者权限投影，不把包含私密字段的内部事件原样广播。

## 12. 时序设计

~~~mermaid
sequenceDiagram
    participant V as 访客
    participant S as NestJS
    participant D as PostgreSQL
    participant W as Worker 与 AI
    V->>S: 客户消息与稳定请求 ID
    S->>D: 消息/轮次/任务/outbox 同事务
    D-->>S: 提交
    S-->>V: 已保存 ACK
    S->>W: outbox 投递任务 ID
    W->>W: 检索与生成候选
    V->>S: 请求转人工
    S->>D: 锁定会话并变更接待状态
    D-->>S: 提交等待人工
    S-->>V: 转接已接受
    W->>S: 返回候选
    S->>D: 重验状态/轮次/知识
    D-->>S: 候选已过期
    S-->>W: superseded，不写客户消息
~~~

worker 与 API 复用同一业务服务实现 N05/N06，不通过伪造客服凭据执行公开发送 API。

## 13. 模块架构与依赖方向

| 位置 | 模块与责任 | 允许依赖 |
| --- | --- | --- |
| apps/web/app | auth、inbox、widget、knowledge、customers、tickets、stats、settings 页面 | 生成 HTTP 客户端、共享事件类型 |
| apps/web/public/widget.js | 小型加载脚本，创建 iframe、身份存储与受限握手 | 浏览器 API；不加入另一套 UI 框架 |
| apps/server/src/modules | auth、organizations、memberships、widget、customers、conversations、messages、knowledge、tickets、stats、ai-jobs | service → repository/Prisma |
| apps/server/src/workers | outbox、知识准备、AI、超时修复 | 复用 server 业务服务；队列驱动 |
| services/ai-service | infer、embed、提供方适配和输出 Schema | 模型 HTTP API；无业务数据库权限 |
| packages/shared | 事件 Schema、公共 DTO/生成客户端、纯转换 | 不引入 Prisma、数据库连接和服务器配置 |
| database/schema、database/migrations | 唯一 schema 与迁移位置 | 初始化时锁定实际 ORM 版本及目录配置 |
| tests | 契约、集成、双窗口 E2E、AI 固定样本 | 独立合成数据与隔离数据库 |

不提前建立多包领域框架。模块间通过业务 service，禁止控制器、worker、AI 各写一套状态判断。

## 14. 数据模型、索引与生命周期

完整字段、24 个逻辑实体及约束见 [数据模型](data-model-v1.md)。业务表按组织隔离，跨业务外键带 organizationId；内部备注独立表，公开消息 seq 不因备注产生空洞。知识正文版本不可变，编辑建立新版本，历史回答保留来源快照。

V1 不提供客户删除/导出或无限制数据清理。演示只用合成数据；运行日志设滚动保留，业务数据删除政策在真实业务部署前确定，不在代码中私自定期删客户记录。

## 15. API、事件、CLI、Hook 或 MCP 契约

[API 文档](api-v1.md) 定义端点、身份、输入输出和错误；[contracts](contracts.md) 维护通用 envelope、枚举、预算与幂等规则。NestJS 生成 OpenAPI，前端从生成合同消费；Socket 事件 Schema 在 shared 维护，使用同一业务服务。

业务 CLI/Hook/MCP：N/A，V1 不提供这类产品接口。未来开发命令在 T01 创建后才写为可执行命令。

## 16. 一致性、事务、缓存与幂等

采用 PostgreSQL 短事务与显式行锁，模型/Redis/Socket 调用不在事务内。统一锁顺序：组织 → 身份会话（如适用）→ 成员 → 按 ID 排序的会话 → 知识/AI 任务/工单。实际行锁与唯一约束在集成测试验证，不靠进程内互斥维持一致性。

普通租户写入先对 organization 行取共享锁；影响授权、知识可用集合或 AI 开关的写入先取排他锁。这样配置修改与 AI 最终提交不能“先检查后穿透”；会话级写入再锁 conversation 行，实现发送/交接/关闭顺序裁决。共享锁与更新的冲突机制由 PostgreSQL 提供，固定顺序用于减少死锁。[PostgreSQL 行锁](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)

该组织级锁仅在短事务持有，不能跨模型调用；普通会话可并行共享，管理变更暂时等待。V1 接受这项保守取舍；更高吞吐时再细化锁域并重新验证。

消息、seq、outbox、触发的 AI task 同事务；幂等查询在授权之后、状态变更判断之前：已成功的同请求重试返回原结果，即使会话后来已关闭，仍须当前有读取权限。请求体不同则冲突。

outbox 为可重投递机制，消费者必须幂等。Socket.IO 默认不提供应用级持久化重放，因此数据库历史与连续 seq 补拉是必需路径。[Socket.IO 交付保证](https://socket.io/docs/v4/delivery-guarantees/)

首版不缓存消息历史、授权、知识启停或统计结果；Redis 只承担任务队列。在线状态使用数据库心跳，避免 Redis 故障同时影响接管判断。

## 17. 异常、重试、补偿与人工修复

| 故障 | 业务结果 | 恢复/人工处理 |
| --- | --- | --- |
| DB 写入失败 | 不 ACK 成功，不广播 | 保留请求，原 ID 重试 |
| ACK/广播丢失 | 已保存事实不回滚 | 查询请求结果、补拉历史 |
| Redis 失败 | 人工收发继续；自动任务仍有 DB 记录 | outbox 重投；到期自动接待转人工 |
| worker 崩溃 | 任务可能重复执行 | DB lease/唯一键/CAS 判重，超时修复器补偿 |
| AI/Embedding 限流或网络故障 | 有预算才重试，超时转人工 | 内部辅助可显式重试；自动接待不复活 |
| 输出不合法/无依据 | 不产生自动业务回答 | 一次必要澄清或交接，保留分类原因 |
| 知识/权限改变 | 候选 superseded | 当前资料重新判断；不能绕过剩余预算 |
| 会话/工单并发修改 | 409 与当前版本 | 刷新后由操作者重新决定，不自动覆盖 |

数据库修复器每秒扫描到期自动任务并按会话索引处理，独立于 Redis；每个自动提交都实时检查绝对 deadline。界面在等待上限提示转接、发起幂等请求，服务端未确认时不假报成功。调度抖动或整机故障不能承诺硬实时，但过期候选始终禁止提交。

outbox/任务重试只恢复合法效果，不保证外部模型只调用一次。重复付费调用可能发生，使用任务 ID、尝试记录和用量统计追踪。[BullMQ 幂等任务](https://docs.bullmq.io/patterns/idempotent-jobs)

## 18. 权限、安全、隐私与审计

后台采用服务端不透明会话 Cookie，HttpOnly、生产 Secure、SameSite=Lax；状态写入检查 Origin/CSRF。密码使用 Argon2id；初始参数参考 m=19 MiB、t=2、p=1，并在目标环境检查耗时与限流。[OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

访客采用独立可撤销的随机令牌，身份表只存哈希；首次接入的短期加密恢复收据见 API A021。设计初始有效期 30 天。加载脚本在客户网站第一方存储中保存该站点令牌，并通过精确 origin/source 校验的 postMessage 交给 iframe；令牌不放 URL、日志或 SSR payload。存储失败明确提示恢复能力受限。[postMessage 校验要求](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)

站点允许列表约束浏览器接入，不是防止非浏览器伪造 Origin 的身份机制；历史访问始终依赖访客令牌。禁止邮箱冒认身份。宿主网站脚本可访问其第一方存储，接入方网站应视为信任边界内的系统。

Nuxt 公开配置仅放 API 地址等公开值，模型密钥不进入 public 配置或页面数据。[Nuxt runtime config](https://nuxt.com/docs/4.x/guide/going-further/runtime-config)

请求日志记录 ID、耗时、错误与版本，默认不记录完整聊天。管理员变更和状态动作写审计；备注、模型输入、引用片段与详细错误不下发给访客。每次 Socket 操作和后台推送重新核对当前权限；不能只靠加入过房间来授权。

## 19. 性能、容量与可扩展性

初始验证夹具：2 个组织、每组织 3 个成员、200 篇知识、合计约 2,000 个 chunk、1,000 段会话、10,000 条消息；这是测试规模，不是产品硬额度。检索先按组织及当前版本过滤，再精确排序取前 5，预算不足只取可容纳片段。

验收保持 PRD 的双浏览器 100 条消息 p95 ≤2 秒与 AI 30 秒等待上限，记录硬件、模型、网络和样本。并发容量没有实测承诺；观察数据库锁等待、outbox 积压和模型排队后再决定扩容。

未来扩展点只保留真实边界：worker 扩容、知识 ANN 索引、Socket 多实例适配；均需新增故障与召回验证，V1 不先实现。

## 20. 可观测性与运维策略

使用 Docker Compose 编排反向代理、web、server、worker、ai-service、PostgreSQL+pgvector、Redis；仅代理公开 HTTP(S)。部署顺序为数据库就绪、迁移成功、启动 server/worker/AI/web；版本镜像和锁文件固定，迁移失败禁止继续发布。

活性检查只说明进程存活；就绪检查说明 PostgreSQL 可用，AI/Redis 单独暴露 degraded，不因此把可用人工聊天整体判死。指标包含发送成功率、消息保存/推送耗时、队列年龄、超时转接、stale 丢弃、模型 usage、检索空结果和权限拒绝。

单主机每日备份 PostgreSQL，并在隔离库完成恢复演练；V1 不承诺零数据丢失或高可用。应用回滚优先回退镜像，数据迁移采用向后兼容演进，破坏性回滚单独制定；不得自动回滚删除真实业务数据。

配置分公开地址、数据库/Redis/内部服务连接、模型与 Embedding 标识/维度、预算、日志和 bootstrap 收据加密密钥；使用部署环境的服务端配置注入。T01 已建立本地连接和模型配置样例；bootstrap 收据密钥属于 T04，届时通过 keyId 定位，轮换时旧密钥至少覆盖尚未过期的 10 分钟收据。

## 21. ADR 决策记录

| ADR | 选择与理由 | 未选方案、代价与复审条件 |
| --- | --- | --- |
| ADR01 | 模块化 NestJS + 独立 AI 服务，业务写入单一 | 不拆多个业务微服务；双语言部署仍有维护成本 |
| ADR02 | PostgreSQL+pgvector 精确检索，数据库内租户过滤 | 不引入独立向量库/ANN；数据增长后按延迟与召回复审 |
| ADR03 | 数据库消息+outbox，至少一次投递与幂等 | 不把 Socket/Redis 当历史；增加补偿与幂等实现工作 |
| ADR04 | 短事务行锁+版本检查协调 AI/人工 | 不使用 Redis 锁作为正确性基础；管理变更会短暂等待 |
| ADR05 | iframe 隔离界面，父站点存储访客令牌 | 不依赖第三方 Cookie；需要受限 postMessage 握手和宿主信任说明 |
| ADR06 | 自动回答整体校验后一次发送 | V1 不把未验证流式片段直接展示给访客；保留处理中状态 |
| ADR07 | 数据库心跳与人工认领 | 不引入智能派单；心跳写入量在目标测试规模可观察 |
| ADR08 | 确定性 AI 流程与类型化结果 | 不用通用 Agent/工具执行框架；无法自动办理退款等外部动作 |

## 22. 风险、取舍与待确认项

来源有效不等于回答语义一定正确，模型仍需固定样本人工评分。中英 embedding、兼容 JSON 输出、Token 计数、Prisma 的向量/原始查询支持都须在 T01/T12/T13 用锁定版本核验。

下列是技术默认值，后续可按证据调整，不声称用户逐条批准：访客令牌 30 天、后台会话 7 天、心跳 15 秒/失效 60 秒、精确 top-5 检索、chunk 约 500 code point/重叠 80、单次模型输出 2,000 Token、非流式发送。

阻塞编码的真实缺项为运行环境兼容版本与可用模型/Embedding 配置；它们不阻塞本次文档交付。实现时若缺配置，先完成可控假提供方测试，不用假结果冒充真实 AI 通过。

官方资料于 2026-11-06 核对；以下只支持机制，不证明本项目已实现：前文 Socket/PostgreSQL/pgvector/BullMQ/Nuxt/MDN/OWASP，以及 [NestJS OpenAPI](https://docs.nestjs.com/openapi/introduction)、[Prisma 事务](https://www.prisma.io/docs/orm/prisma-client/queries/transactions)、[FastAPI 响应模型](https://fastapi.tiangolo.com/tutorial/response-model/)。FastAPI 响应结构校验用于边界验证；业务授权仍由 NestJS 决定。

## 23. 开发任务拆分与里程碑

[任务清单](development-tasks-v1.md) 按 T01—T26 编号；先完成依赖再开下一项。每项有 PRD/节点、文档读取范围、交付和测试，配套 [提示词](codex-prompts-v1.md) 使用同一任务 ID。

阶段出口：工程与身份 → 可靠人工客服 → 知识和 AI 接待 → 八模块收尾 → 故障/隔离/模型验收 → 部署和产品演示。当前 T01 工程初始化、T02 数据模型/迁移与 T03 身份功能本地验收已通过，T04—T26 仍待实施。身份范围及分期边界见 [T03 实测](identity-development.md)。

## 24. Architecture Review Checklist

- 业务范围是否覆盖 37 个需求和 27 项 PRD 验收，任务是否有遗漏或循环依赖？
- N01—N08 是否都具备前置条件、输入输出、读写、状态、幂等及失败路径？
- 访客身份、成员授权、内部备注、引用快照是否在 HTTP 和 Socket 保持相同边界？
- AI 最终保存与转人工、知识修改、AI 关闭、连续输入是否采用同一裁决规则？
- 数据表、DTO、页面、任务、提示词的字段与 ID 是否一致，是否保留单一维护位置？
- 队列/模型故障是否独立于人工消息，worker 重启和确认丢失是否可恢复？
- 统计是否来自可核算的业务事实，未响应是否保持 null/未响应数量？
- 官方依据、设计默认值、未来实验和实际通过的证据是否明确分开？
- 文档交付是否保持“暂不写代码”，所有开发/发布行为是否等待后续实施指令？
