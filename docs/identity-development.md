# T03 账号、企业、成员与邀请

2026-11-06 本地实施。按 [T03 工作单](development-tasks-v1.md#t03-账号企业成员与邀请) 交付身份范围的 A001—A014、A069 和 P01/P02；完整聊天、团队设置页与接待补偿不在本任务内。

## 已实现行为

- 注册、登录、退出、当前账号查询；邮箱去首尾空格并转小写；密码 12—128 Unicode code point。Argon2id 使用 m=19456 KiB、t=2、p=1，随机盐由库生成。
- 256 位随机会话令牌，数据库只存 SHA-256 摘要；Cookie 为 HttpOnly、SameSite=Lax、Path=/，7 天有效，生产环境附 Secure。每次请求重新校验会话及用户状态。
- 原子创建企业、管理员 membership 和默认禁用的 widget 配置；企业列表仅包含本人有效 membership。时区默认 Asia/Shanghai。
- 企业请求必须携带 X-Organization-Id，与 URL 中企业一致；角色与停用状态实时读取。企业级写事务统一先锁企业，再锁会话；创建企业按用户锁串行化。
- 成员列表/角色变更/停用与恢复、乐观版本检查、最后一名有效管理员保护；成员变更提升 authorizationRevision，并作废该成员的 presence 记录。
- 邀请创建、最小预览、接受、撤销与分页列表；有效期 7 天、单次消费、令牌只存摘要。已加入者接受邀请不升级角色；已停用者不能借邀请恢复。并发消费只成功一次。
- 业务写命令使用 UUID Idempotency-Key；收据仅保存资源引用，重试会重新鉴权并投影当前状态。同键不同内容返回 409。企业/邀请/成员变更写入审计事件。
- 所有写请求要求精确 APP_ORIGIN、application/json 和 X-Requested-With: SmartDesk。没有开放凭据 CORS。注册/登录/邀请预览按来源 IP+路径限流：单 API 进程 30 次/15 分钟；这是当前单实例基础限流，非分布式限流证明。

## 页面与配置

入口 `/login`、`/register`、`/invite`、`/app/organizations`、`/app/onboarding`、`/app/o/:organizationId`。登录后可创建或选择企业。邀请链接用 fragment 传令牌，客户端读取后移除 URL fragment，在当前标签 sessionStorage 暂存，登录/注册后返回接受页，成功后清除。

企业上下文仅由当前页面路由和请求头提供；没有账号级全局“当前企业”。新企业工作区显示实际企业资料和后续接待功能的开发状态。T19 再提供 P09 成员与邀请管理界面；目前管理员可通过身份 API 操作。

企业入口从 A004 `/auth/me` 的 `memberships` 摘要按路由企业 ID 选择当前成员，建立统一客户端身份；A007 企业详情不返回 membership。共享 `CurrentUserView` 明确该摘要，不能把创建企业响应的 membership 误用于详情响应。

| 配置 | 默认值与含义 |
| --- | --- |
| APP_ORIGIN | `http://127.0.0.1:3100`，API 接受浏览器写操作的唯一 Origin，也是邀请链接站点地址 |
| NUXT_API_BASE | `http://127.0.0.1:3101`，Nuxt 私有服务端代理目标，不下发浏览器 |
| NODE_ENV | API 为 production 时 Cookie 带 Secure，须用 HTTPS；本地体验保持开发配置 |

API 读取根 `.env`；更换 Nuxt 代理目标须向 Nuxt 进程传入 `NUXT_API_BASE`。默认体验地址统一使用 127.0.0.1，localhost 是不同 Origin。Nuxt `/api/v1/**` 同源代理转发 Cookie/Origin，业务逻辑仍由 NestJS 所有。

## 合同补充与分期边界

- 邀请创建首次返回 `201 {id,inviteLink,expiresAt}`。同键重放返回 `200 {id,expiresAt,inviteLink:null,linkUnavailable:true}`：原令牌不持久化、不能回取。若首次响应丢失，撤销该邀请后用新命令创建；不把明文令牌放入收据。
- T08 已替换 A008/A014 的保护性拒绝：关闭 AI 和停用在服成员在同一管理事务内把相应会话转等待，见 [接待说明](reception-development.md)。开 AI 不复活既有人工会话，工单不联动。
- T03 实测 HTTP 请求鉴权和会话撤销；T06/T08 已补齐 Socket 撤权与真实在线判定。完整 AT16 仍含 T19/T21 的页面与后续责任，不以本轮 API 验收替代。
- aiHealth 只提供知识 ready 计数，providerState 为 unverified；未接入或证明真实模型能力。
- 数据库 schema 和两条已应用迁移保持原样，不重置主库，不向体验库写入验收数据。

## 可重复验收

在项目根目录执行 `pnpm test:identity`：先构建 shared/server/web，再创建本机 `smartdesk_t03_<pid>_<timestamp>` 隔离库、部署现有迁移、启动临时 API/Nuxt，使用真实 HTTP 和 Playwright Chromium 检查。首次使用机器需先 `pnpm exec playwright install chromium`。

12 组场景覆盖启动、账号/哈希、企业原子幂等、跨租户/CSRF/DTO、非法 JSON、邀请与无静默提权、并发/撤销/过期/分页、最后管理员和成员失效、审计、退出/过期/禁用账号、浏览器流程、限流；另核验主库每张表全部行摘要不变。浏览器实际走注册→创建企业→退出→错误登录→邀请→登录返回→接受→双标签企业隔离→退出失效，并检查 390px 手机布局。

2026-11-09 修复企业入口读取不存在的 `membership.id`：成功进入、接受邀请、双标签、刷新和切企业均新增无错误提示断言，并核对当前用户、企业的有效 presence 记录。旧构建在新增断言上失败，修复后 12 组通过；页面捕获的异常也会使验收失败，不再只检查标题与 `pageerror`。本轮另以浏览器手动走通注册、创建、退出、邀请登录返回与切企业，并回到原 DVGO 企业刷新确认。真实模型与完整客服聊天页面不在本轮验证范围。

测试结束自动关闭浏览器和自建 API/web，删除且仅删除该次生成的隔离库，检查端口释放。截图和主库摘要默认在 `test-results/identity`，可用 `IDENTITY_EVIDENCE_DIR` 指向报告目录。原有 `pnpm test:database` 继续验证 58 项数据库约束；`pnpm test:e2e` 是独立的体验环境入口 smoke。

## 依赖依据

新增且锁定 node-argon2 0.45.2（Node >=16.17.0），当前 Node 22.23.4 实际安装、原生 hash/verify 与 HTTP 密码验证通过。pnpm allowBuilds 明确允许 argon2 原生安装。没有新增业务微服务或数据库实体。

官方资料：[node-argon2](https://github.com/ranisalt/node-argon2)、[Node.js 22 Crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html)、[NestJS Controllers](https://docs.nestjs.com/controllers)、[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。依赖和密码参数在编码前核对；Nuxt/Nest/Prisma 沿用 T01/T02 锁定版本。
