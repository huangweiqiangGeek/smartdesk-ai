# SmartDesk AI 开发规范

这套规范面向项目开发者和编码 Agent，定义客服前端、NestJS 后端与 Python AI 服务的责任及验收边界。T01 已建立最小入口，运行、版本和配置合同见 [本地开发](local-development.md)；T02 数据模型、T03 成员身份、T04 跨站访客身份、T05 消息事务、T06 实时投递、T07 前端连接、T08 接待状态及 T09 客服工作台已完成本地验收，其余业务接口和产品流程仍是后续实现目标。

## 按任务读取

| 当前任务 | 应读取的规范 |
| --- | --- |
| 功能范围、权限、接待/交接、指标与验收 | [V1 产品需求文档](prd-v1.md) |
| 完整方案与文档阅读顺序 | [V1 完整技术方案](technical-plan-v1.md) |
| 实体、字段、索引、事务与生命周期 | [V1 数据模型](data-model-v1.md) |
| Prisma 生成、迁移、合成种子与约束实测 | [T02 数据库开发与验收](database-development.md) |
| 登录、企业、成员/邀请 API、身份配置与实际浏览器验收 | [T03 身份开发与验收](identity-development.md) |
| 跨站加载器、iframe、访客令牌、加密恢复与真实站点验收 | [T04 访客接入开发与验收](widget-development.md) |
| 首消息建会话、seq、幂等事务、授权历史与故障验收 | [T05 消息开发与验收](messages-development.md) |
| Outbox、Socket 身份/ACK、队列投递与进程恢复 | [T06 实时开发与验收](realtime-development.md) |
| 前端身份上下文、消息状态、历史补拉、连接与草稿隔离 | [T07 前端连接开发与验收](frontend-development.md) |
| 在线判定、会话状态命令、停用/关闭 AI 补偿 | [T08 接待开发与验收](reception-development.md) |
| 三栏工作台、授权未读、公开消息/备注与真实浏览器验证 | [T09 客服工作台开发与验收](inbox-development.md) |
| 访客聊天、同凭据历史、离线留言及合成 SaaS 演示页 | [T10 访客聊天开发与验收](visitor-chat-development.md) |
| 知识CRUD、不可变版本、准备请求与启停 | [T11 知识管理开发与验收](knowledge-development.md) |
| 路由、DTO、角色、错误、Socket 与 AI 内部调用 | [V1 API 详细设计](api-v1.md) |
| 核心页面、交互和页面接口映射 | [V1 页面设计](pages-v1.md) |
| 产品运行时 Agent 编排、检索、交接与评测 | [V1 Agent 执行流程](ai-workflow-v1.md) |
| 开发依赖、估算、需求追溯、验收及工作单 | [V1 开发任务](development-tasks-v1.md)、[Codex 提示词](codex-prompts-v1.md) |
| 初始化、新模块、服务拆分与数据所有权 | [架构与范围](architecture.md) |
| 安装、启动、模型配置、锁定版本与 T01 实测 | [本地开发与 T01 验证](local-development.md) |
| 客服工作台、客户入口、聊天交互与状态 | [前端规范](frontend.md) |
| HTTP、Socket.IO、权限、数据库、工单与队列 | [后端规范](backend.md) |
| 知识问答、自动接待、交接、翻译、摘要与回复建议 | [V1 PRD](prd-v1.md)、[Agent 和 AI 边界](agent.md) |
| 消息字段、事件、幂等、状态与联调 | [接口与事件契约](contracts.md)，并读涉及的两端规范 |
| 编码、测试、依赖、验收和部署 | [质量与交付](quality.md) 中相关章节 |

仅改页面样式不需要加载 AI 服务全文；消息状态、事件或回复发送逻辑改变时，联读 contracts、frontend、backend，涉及 AI 建议时再读 agent。

## 文档责任

- docs 保存完整规则；根 AGENTS.md 保存任务索引；DevCodex Profile 保存项目事实、技术摘要和规范链接。
- prd-v1 是产品范围、行为、权限、状态语义与验收的主文档；contracts 维护对应的协议枚举、字段、预算和事件名称，两者变更需同步。业务字段从后端 Schema 派生类型，不能在前后端手写两份长期漂移的接口定义。
- technical-plan-v1 维护整体设计与取舍；data-model-v1/api-v1/pages-v1/ai-workflow-v1 分别维护详细实体、接口、页面和执行流程；development-tasks-v1 维护依赖及验收归属，codex-prompts-v1 引用同一任务 ID。设计与提示词不能作为实现完成证据。
- 文档与代码冲突时先核实实现和需求，再同步正文、类型、消费者与测试。重大边界改变记录理由、替代方案、迁移或兼容办法及验证。
- 两个项目的 docs 分别完整保留；不依赖另一个仓库的规范链接才能开发本项目。

## 第一版目标

完成“维护 FAQ/文本 → 客户消息保存 → AI 有依据回答 → 必要时转人工并停止自动回复 → 人工接管 → 工单独立跟进”的闭环。自动回答由业务服务校验后发送；人工端草稿仍需客服确认。AI 不自动变更工单、权限或外部业务；第三方渠道、自动派单和通用多 Agent 平台均留待后续需求。
