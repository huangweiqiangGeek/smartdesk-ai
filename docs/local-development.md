# SmartDesk AI 本地开发与 T01 验证

后续状态：T02 数据模型、迁移及约束验收也已完成，使用 `pnpm db:generate`、`pnpm db:migrate` 和 `pnpm test:database`，详见 [数据库开发与验收](database-development.md)。T03 已加入身份 API、注册登录和企业/邀请入口，配置与隔离浏览器验收见 [身份开发与验收](identity-development.md)。T04 的跨站入口、服务端加密配置与 `test:widget` 见 [访客接入开发与验收](widget-development.md)。本页 T01 实测表保留其当时的历史范围。

T01 工程初始化与本地验收已通过。2026-11-06 在 Windows 上完成安装、静态检查、构建、应用启动及真实 PostgreSQL+pgvector/Redis 连接，并验证依赖故障与恢复。根 `.env` 已按样例配置，模型默认禁用；业务功能仍待后续任务实现。下方保留首次缺 Docker 时的历史记录，并单列 Docker 就绪后的完整复验。

## 安装与启动

T06 的 Socket/Outbox 随 API 启动，无新增端口或迁移；OUTBOX 配置、单节点限制及真实队列验收见 [实时开发说明](realtime-development.md)。

T07 web 复用精确版本 socket.io-client 4.8.4，公开 `NUXT_PUBLIC_SOCKET_BASE` 默认 `http://127.0.0.1:3101`；HTTP 私有代理仍为 `NUXT_API_BASE`。Socket 网关必须匹配成员 Cookie 作用域和服务端 Origin 配置，HTTPS 页面使用 HTTPS 网关。前端状态与真实浏览器测试命令 `pnpm test:frontend` 见 [前端连接说明](frontend-development.md)。

以下命令在项目根目录执行，终端示例为 PowerShell。使用 Node 22.23.4、pnpm 12.14.0、Python 3.15.2；Python 工具只安装到项目的 `.tools/uv`，依赖只安装到服务的 `.venv`。

~~~powershell
pnpm install --frozen-lockfile
python -m pip install --target .tools/uv uv==0.13.7
pnpm ai:sync
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
~~~

安装并运行 Docker Desktop 后，先确认 `docker version` 与 `docker compose version` 成功，再运行：

~~~powershell
pnpm deps:up
pnpm check:dependencies
~~~

`deps:up` 使用项目根 `compose.yaml`，只启动 PostgreSQL+pgvector 和 Redis。空 volume 首次启动执行 `database/init/001-vector.sql`；已有 volume 不会重跑初始化脚本。若已有数据库缺少扩展，由该开发库的管理者执行 `CREATE EXTENSION IF NOT EXISTS vector;` 后重新检查，不删除 volume。

依赖可用后，分别在四个终端启动：

~~~powershell
pnpm dev:web
pnpm dev:api
pnpm dev:worker
pnpm dev:ai
~~~

| 入口 | 默认地址/行为 |
| --- | --- |
| Nuxt | http://127.0.0.1:3100/login；T03 登录/注册及企业入口 |
| Nest API | http://127.0.0.1:3101/health/live |
| worker | 独立 Nest application context；输出依赖状态、consumers=0，暂无业务队列消费者 |
| FastAPI | http://127.0.0.1:8100/health/live；仅内部健康接口 |
| PostgreSQL | 127.0.0.1:55432，数据库/用户 smartdesk |
| Redis | 127.0.0.1:56379 |

本地入口固定使用 3100/3101/8100，数据库端口为 55432/56379。API 连接取根 `.env` 或进程环境变量，环境变量优先；Nuxt 不读取或暴露模型 Key。FastAPI 未持有业务数据库连接。结束开发时在各终端 Ctrl+C，再执行 `pnpm deps:down`；此命令保留数据库 volume。

当前只提供本地依赖 Compose。包含反向代理及全部应用的部署编排属于 T24。T02 已实现业务 schema 与迁移，新环境在依赖启动后执行 `pnpm db:generate` 和 `pnpm db:migrate`；合成种子仅供隔离数据库测试，不向体验页灌入假聊天闭环。

## 健康合同

| 检查 | 成功与失败含义 |
| --- | --- |
| web/API/AI 的 GET /health/live | HTTP 200，只表示进程活着 |
| API GET /health/ready | 数据库失败为 503/not_ready；数据库可用且 Redis 或 AI 不可用为 200/degraded |
| AI GET /health/ready | disabled 为 503；fake 为 200/fake；真实配置完整但适配器未实现为 503/configured_unverified；始终 realModelVerified=false |
| worker 一次性检查 | `node apps/server/dist/workers/main.js --check`；DB 与 Redis 都可用才退出 0，否则退出 1 |
| pnpm check:dependencies | 真实 PostgreSQL SELECT、vector 扩展、余弦距离操作及 Redis PING；任一失败退出 1 |

API 的 DB 就绪判断只要求数据库可用；向量扩展单独由严格依赖检查验证，避免把向量故障等同于所有数据库读写故障。API 未实现业务人工聊天，这个降级策略目前只通过健康合同验证。worker 启动日志是当时的依赖快照，不代表持续探活。

## 模型与 Embedding 配置合同

唯一运行时校验入口为 `services/ai-service/app/config.py`，样例在根 `.env.example`。以下预算是应用限制，不是对任一真实模型能力的声明。

| 配置 | 规则 |
| --- | --- |
| AI_MODE | disabled（默认）、fake、openai_compatible |
| AI_BASE_URL / AI_API_KEY | 真实模式必填；URL 必须为 HTTP(S)，Key 不得为空 |
| AI_MODEL_ID | 真实模式明确指定提供方 modelId，无自动选择；fake 固定 fake-chat-v1 |
| AI_EMBEDDING_MODEL_ID | 真实模式明确指定；fake 固定 fake-embedding-v1 |
| AI_EMBEDDING_DIMENSIONS | 真实模式必填正整数，最大 16000（vector 类型范围）；fake 固定 8 |
| AI_MODEL_CONTEXT_TOKENS | 真实模式必填，输入+输出预算不得超过该上限 |
| AI_EMBEDDING_CONTEXT_TOKENS | 真实模式必填，Embedding 预算不得超过该上限 |
| AI_INPUT_TOKEN_BUDGET | 默认/最大 8000，包含指令、历史、知识和本轮输入 |
| AI_OUTPUT_TOKEN_BUDGET | 默认/最大 2000 |
| AI_EMBEDDING_TOKEN_BUDGET | 默认/最大 8000，后续按实际提供方上限调低 |
| AI_CALL_TIMEOUT_SECONDS | 默认/最大 30 秒 |

真实模式缺 modelId、维度或上下文上限时启动失败。没有真实配置就保持 disabled；设置 fake 可运行确定性测试，不能把 fake 标识用于真实知识索引。fake 提供方仅有内存中的确定性输出及 timeout/unavailable 故障开关，不提供 /infer 或 /embed HTTP 端点，也不生成聊天数据。

T01 校验配置格式和预算关系。真实 Tokenizer、计数及截断、提供方 HTTP 请求、响应维度校验和中英能力验证属于 T12/T13；不能以字符数替代真实 Token 数，也不能仅凭配置值声称上下文或向量能力通过。切换 Embedding 型号/维度须在 T13 重新准备向量，禁止混用。自动接待 30 秒总期限（含排队）、辅助 running 120 秒/排队 60 秒和知识准备 300 秒仍由后续 Nest worker 实现。

## 已锁定版本与官方依据

核对日期：2026-11-06。直接依赖使用精确版本；JS 全部传递解析结果见 `pnpm-lock.yaml`，Python 全部解析结果及分发哈希见 `services/ai-service/uv.lock`。镜像以 tag+digest 固定，已实际拉取、运行并回读版本，Docker Desktop 4.98.0、Engine 29.9.2、Compose 5.6.1（desktop-linux / linux-amd64）。

| 组件 | 实际安装/固定目标 | 兼容依据 |
| --- | --- | --- |
| Node / pnpm | 22.23.4 / 12.14.0 | .node-version、packageManager；[Nuxt 安装要求](https://nuxt.com/docs/4.x/getting-started/installation)、[pnpm 安装](https://pnpm.io/installation) |
| Nuxt / Vue | 4.6.4 / 3.5.44 | Nuxt 包 engines 要求 Node ^22.22.3 等；Vue 与 Nuxt 内部解析一致，依赖图仅一个 Vue 版本 |
| Nest common/core/platform-express | 11.2.8 | core 要求 Node >=20；[Nest 入口](https://docs.nestjs.com/first-steps)、[独立 application context](https://docs.nestjs.com/standalone-applications) |
| Prisma / client / adapter-pg | 7.10.1 | [v7 系统要求](https://www.prisma.io/docs/orm/v7/reference/system-requirements)：Node ^22.12 可用；[schema 位置](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/location)、[生成器](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators) |
| TypeScript / Vitest / Playwright | 5.9.3 / 4.1.12 / 1.65.0 | 本机实际类型、单元及 HTTP smoke 检查 |
| ESLint / typescript-eslint / Prettier | 10.14.0 / 8.72.1 / 3.9.10 | Node 22.23.4 及插件 peer 范围相容；[ESLint 10 迁移要求](https://eslint.org/docs/latest/use/migrate-to-10.0.0)、[Vue ESLint](https://eslint.vuejs.org/user-guide/) |
| pg / node-redis | 8.23.1 / 6.3.1 | [Redis Node 客户端](https://redis.io/docs/latest/develop/clients/nodejs/connect/)；真实连接、故障和恢复探针已通过 |
| Python / uv | 3.15.2 / 0.13.7 | .python-version 与 requires-python >=3.15,<3.16；[uv 项目锁](https://docs.astral.sh/uv/guides/projects/) |
| FastAPI / Uvicorn / pydantic-settings | 0.162.0 / 0.54.0 / 2.16.2 | PyPI Python 下限分别 3.10/3.10/3.11；[FastAPI 入口](https://fastapi.tiangolo.com/tutorial/first-steps/) |
| Pydantic / pydantic-core | 2.14.3 / 2.50.4 | 锁文件；实际安装 CPython 3.15 Windows wheel |
| Ruff / mypy / Pytest / HTTPX | 0.17.4 / 2.4.1 / 9.2.0 / 0.28.1 | 实际 Python 检查通过；[FastAPI 测试](https://fastapi.tiangolo.com/tutorial/testing/) |
| PostgreSQL+pgvector 镜像 | 0.8.7-pg17-trixie；实际 PG 17.11 / vector 0.8.7 | [pgvector](https://github.com/pgvector/pgvector)、[官方镜像 tag](https://hub.docker.com/r/pgvector/pgvector/tags?name=0.8.7-pg17-trixie)；容器 SQL 版本回读通过 |
| Redis 镜像 | 8.8.4-alpine3.23 | [Redis 镜像](https://hub.docker.com/_/redis)、[Compose 就绪控制](https://docs.docker.com/compose/how-tos/startup-order/) |

镜像 digest 以 `compose.yaml` 为准。Prisma 7 使用根 `prisma.config.ts` 显式指向 `database/schema/schema.prisma` 和 `database/migrations`；生成产物只能在 server 内，shared 不导出数据库实体。当前探针使用 pg，不声称 Prisma 业务查询/迁移已通过。

pnpm 12 使用 `allowBuilds` 明确允许 @prisma/engines、prisma 和 esbuild 的安装脚本，依据[官方说明](https://pnpm.io/cli/approve-builds)。升级后应重新安装、运行检查并更新锁文件，不依赖浮动 latest。

## 首次验证记录（Docker 未安装时）

以下是同日首次交付时的历史结果，依赖缺项已由下一节复验补齐。命令工作目录均为项目根，除单独注明的服务启动 cwd。所有结果为本机证据，不代表完整应用容器部署或真实模型验证。

| 命令或检查 | 退出码/HTTP | 结论 |
| --- | --- | --- |
| pnpm install --frozen-lockfile | 0 | 锁文件安装通过 |
| python -m pip install --target .tools/uv uv==0.13.7 | 0 | 项目工具安装成功 |
| node scripts/uv.mjs sync | 0 | 建立 .venv 与 uv.lock |
| pnpm ai:sync | 0 | Python 冻结锁检查通过 |
| pnpm lint | 0 | ESLint、Ruff 通过 |
| pnpm format:check | 0 | Prettier、Ruff format 通过；历史 Markdown 按文档规则维护 |
| pnpm typecheck | 0 | Nuxt/TS strict、mypy 通过 |
| pnpm test | 0 | Vitest 10、Pytest 8 项通过 |
| pnpm build | 0 | Nuxt/Nest/shared 构建通过 |
| pnpm db:validate | 0 | 唯一 Prisma schema 校验通过 |
| pnpm test:e2e | 0 | Playwright request 1 项 HTTP smoke；未启动浏览器，不代表双窗口业务 E2E |
| GET web/API/AI /health/live | 均 200 | 三个实际 HTTP 进程存活 |
| GET API /health/ready（无 DB） | 503 | database/redis unavailable，AI disabled |
| GET AI /health/ready（默认） | 503 | disabled，realModelVerified=false |
| worker --check | 1 | 正确报告 DB/Redis 不可用 |
| pnpm check:dependencies | 1 | PostgreSQL+pgvector 与 Redis 连接未通过 |
| pnpm deps:up | 1 | 本机无 docker 命令，未启动容器 |

首次验证的 Pytest 有上游 Starlette 对 HTTPX 的弃用提示，8 项测试通过；未隐藏提示。当时未验证：Docker Compose 配方运行、镜像拉取、PostgreSQL/pgvector 版本回读与连接、Redis PING 成功、空库迁移、Prisma 业务访问、真实模型、浏览器交互和完整部署。空库迁移/业务访问仍属 T02，不因 schema validate 通过而标为完成。

本次实际启动：web `node .output/server/index.mjs`（cwd apps/web，NITRO_HOST=127.0.0.1，NITRO_PORT=3100，PID 45024）；API `node dist/main.js`（cwd apps/server，PID 18424）；worker `node dist/workers/main.js`（cwd apps/server，PID 44428）；AI `.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8100`（cwd services/ai-service，PID 30724，子进程 44052）。已停止上述进程及其子进程；3100/3101/8100 已释放，原 3000/PID 27152 未动。

## Docker 就绪后的完整复验（2026-11-06）

15:26—15:32（Asia/Shanghai）完成真实依赖、构建产物启动与故障恢复验收。开始前 Docker 中没有已有容器或数据卷，应用与依赖目标端口空闲；只操作本次创建的 `smartdesk-ai` Compose 项目。

| 命令或检查 | 退出码/HTTP | 实际结果 |
| --- | --- | --- |
| docker version / docker compose version | 0 / 0 | Engine 29.9.2；Compose 5.6.1 |
| docker compose config --quiet | 0 | Compose 配方解析通过 |
| pnpm install --frozen-lockfile / pnpm ai:sync | 0 / 0 | 沿用既有 JS/Python 锁文件，无依赖升级 |
| pnpm deps:up | 0 | 两个锁定 digest 镜像拉取成功，两个容器 healthy |
| pnpm check:dependencies | 0 | PostgreSQL SELECT、vector 扩展、余弦距离与 Redis PING 通过 |
| pnpm test:integration | 0 | 真实依赖通过；停启数据库后再次通过 |
| docker compose exec -T postgres psql -U smartdesk -d smartdesk -v ON_ERROR_STOP=1 -c "SELECT version(); SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'; SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS cosine_distance; SELECT count(*) AS business_tables FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';" | 0 | PG 17.11；vector 0.8.7；距离 0；业务表 0 |
| docker compose exec -T redis redis-cli INFO server / redis-cli PING | 0 / 0 | Redis 8.8.4；PONG |
| pnpm lint / pnpm format:check / pnpm typecheck | 0 / 0 / 0 | ESLint、Ruff、Prettier、TS/Nuxt 与 mypy 通过 |
| pnpm test | 0 | Vitest 10、Pytest 8 项通过 |
| pnpm build / pnpm db:validate | 0 / 0 | 三个 TS 包构建和唯一 Prisma schema 校验通过 |
| pnpm test:e2e | 0 | Playwright request 1 项通过，仅 HTTP smoke |
| GET web/API/AI /health/live | 200 / 200 / 200 | 三个 HTTP 入口实际运行 |
| GET API /health/ready | 200 | degraded；database/redis available、AI disabled |
| GET AI /health/ready | 503 | disabled；realModelVerified=false，符合默认配置 |
| node apps/server/dist/workers/main.js --check | 0 | DB/Redis available；consumers=0 |
| docker compose stop redis | 0 | API ready 200/degraded，redis unavailable；依赖与 worker 检查均退出 1，符合故障预期 |
| docker compose up -d --wait redis | 0 | Redis 恢复 healthy，API 回读 redis available |
| docker compose stop postgres | 0 | API ready 503/not_ready、live 200；依赖检查退出 1，符合故障预期 |
| docker compose up -d --wait postgres | 0 | 数据库恢复 healthy；API 回读 database available、集成检查退出 0 |
| 停止本次 AI 进程后 GET API /health/ready | 200 | degraded；AI unavailable，数据库和 Redis 仍 available |
| pnpm deps:down | 0 | 容器和网络移除，两个数据卷保留 |
| 进程、端口、容器与 volume 收尾断言 | 0 | 本任务进程 0、目标监听端口 0、Compose 容器 0；保留两个 volume |

本次应用均以隐藏进程启动并记录 stdout/stderr：web `node .output/server/index.mjs`（cwd `apps/web`，NITRO_HOST=127.0.0.1，NITRO_PORT=3100，PID 8660）；API `node dist/main.js`（cwd `apps/server`，PID 36624）；worker `node dist/workers/main.js`（同 cwd，PID 20744）；AI `.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8100`（cwd `services/ai-service`，PID 18096，子进程 36400）。15:32:55 已全部停止及清理子进程，3100/3101/8100/55432/56379 无监听；Docker Desktop 保留运行。数据保存在 `smartdesk-ai_postgres-data` 和 `smartdesk-ai_redis-data`，下次 `pnpm deps:up` 复用；未执行带 `-v` 的 down 或 volume prune。

本轮未增加或升级依赖，无需改变既有模型配置合同。Pytest 仍有一条 Starlette/HTTPX 弃用提示；Playwright 有 NO_COLOR/FORCE_COLOR 环境提示，测试通过。尚未验证的范围是 T02 业务迁移/Prisma 业务查询、真实模型与 Embedding 能力、浏览器业务交互及 T24 完整应用部署。当前通过的是 T01 最小工程验收，不代表八模块业务完成。
