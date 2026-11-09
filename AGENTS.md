# SmartDesk AI 开发入口

完整规范在 [docs](docs/README.md)。先识别任务，再按下表读取；不要求每次全量加载所有文档。

| 任务 | 必读 |
| --- | --- |
| 产品功能、角色、接待流程、状态与验收 | [V1 PRD](docs/prd-v1.md)；协议表示另读 [契约](docs/contracts.md) |
| 初始化、服务拆分、技术选型、数据归属 | [架构边界](docs/architecture.md)、[完整技术方案](docs/technical-plan-v1.md)、[数据模型](docs/data-model-v1.md)、[本地开发与配置](docs/local-development.md)、[质量规范](docs/quality.md) |
| 页面、组件、样式、聊天界面状态 | [前端规范](docs/frontend.md)、[页面设计](docs/pages-v1.md)；编码与验收读 [质量规范](docs/quality.md) |
| HTTP、Socket、权限、数据库、消息、工单、队列 | [后端规范](docs/backend.md)、[契约](docs/contracts.md)、[API 详设](docs/api-v1.md)、[数据模型](docs/data-model-v1.md)、[质量规范](docs/quality.md) |
| 知识问答、AI 接待与交接、翻译、摘要、回复建议、模型和 Prompt | [V1 PRD](docs/prd-v1.md)、[AI 规范](docs/agent.md)、[Agent 流程](docs/ai-workflow-v1.md)、[契约](docs/contracts.md)、[质量规范](docs/quality.md) |
| 开发任务、依赖、验收与 Codex 工作单 | [任务清单](docs/development-tasks-v1.md)、[提示词包](docs/codex-prompts-v1.md)；再读该任务引用的设计 |
| T03 身份功能、会话、企业、成员与邀请维护 | [身份开发与验收](docs/identity-development.md)、[API 详设](docs/api-v1.md)、[后端规范](docs/backend.md) |
| T04 跨站接入、访客身份、收据与 iframe | [访客接入开发与验收](docs/widget-development.md)、[API 详设](docs/api-v1.md)、[前端规范](docs/frontend.md)、[质量规范](docs/quality.md) |
| T05 会话、消息事务、幂等与历史 | [消息开发与验收](docs/messages-development.md)、[API 详设](docs/api-v1.md)、[数据模型](docs/data-model-v1.md)、[质量规范](docs/quality.md) |
| T06 Outbox、Socket、队列投递与恢复 | [实时开发与验收](docs/realtime-development.md)、[API 详设](docs/api-v1.md)、[契约](docs/contracts.md)、[质量规范](docs/quality.md) |
| T07 前端客户端、身份、消息归并、恢复与草稿 | [前端连接开发与验收](docs/frontend-development.md)、[前端规范](docs/frontend.md)、[API 第 4 节](docs/api-v1.md#4-socket-合同与历史恢复)、[页面公共规则](docs/pages-v1.md#2-公共前端规则) |
| T08 在线心跳、认领/交接/关闭、成员停用与 AI 开关补偿 | [接待开发与验收](docs/reception-development.md)、[API](docs/api-v1.md)、[后端](docs/backend.md)、[数据模型](docs/data-model-v1.md) |
| T09 三栏工作台、授权列表/未读、人工输入与内部备注 | [收件箱开发与验收](docs/inbox-development.md)、[前端](docs/frontend.md)、[页面 P04](docs/pages-v1.md)、[API](docs/api-v1.md) |
| T10 访客聊天、离线留言、历史和 SaaS 演示 | [访客聊天开发与验收](docs/visitor-chat-development.md)、[页面 P03/P10](docs/pages-v1.md)、[API](docs/api-v1.md)、[前端](docs/frontend.md) |
| 消息字段、ACK、事件或跨服务调用变更 | [契约](docs/contracts.md)及涉及的前端/后端/AI 规范 |
| 仅修改文档 | [文档索引与维护规则](docs/README.md)及被修改主题；检查反向引用 |

跨多类任务读取对应集合；仅改页面样式不需要加载 AI 服务全文。测试、依赖及部署任务按 [质量规范](docs/quality.md) 读取对应章节。出现规范与实现冲突时先核实，不静默改变契约。

DevCodex 工作区入口：[项目 Profile](../.devcodex/smartdesk-ai/profile/README.md)。独立迁出仓库时保留项目 docs，并重新绑定 Profile，不复制另一套完整规则。
