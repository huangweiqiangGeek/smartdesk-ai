# T04 跨站小窗身份与接入

本任务实现 A018—A021、A024 访客本人资料，以及 P03 的加载器和 iframe 外壳。后续 T05 已提供 [消息与历史 API](messages-development.md)，T10 接入 [真实访客聊天与演示页](visitor-chat-development.md)；成员查看客户权限和站点设置页面分别留给 T17、T19，不展示模拟聊天。

## 接入与配置

管理员通过 Cookie、`X-Organization-Id` 调用 `GET /api/v1/widget-config` 获取 publicKey、loaderUrl 和版本；PATCH 同一路径提交 `expectedVersion`、`allowedOrigins`、`enabled` 等字段，同时提供 UUID `Idempotency-Key`、`Origin=APP_ORIGIN`、`X-Requested-With=SmartDesk`。来源必须是规范化的精确 HTTP(S) origin，不包含路径、末尾斜线或通配符。欢迎语最长 500 字。

把以下脚本放在获准网站的 body 中，替换公开配置返回的 URL 和 publicKey。HTTPS 网站应使用 HTTPS SmartDesk 地址；不同站点必须各自加入 allowedOrigins。

```html
<script
  src="https://smartdesk.example/widget-loader.js"
  data-public-key="替换为企业的公开 UUID"
></script>
```

| 服务端配置 | 合同 |
| --- | --- |
| WIDGET_ORIGIN | 对外 iframe/加载器 origin；默认 APP_ORIGIN，再默认本机 3100。访客写请求 Origin 必须为该值 |
| BOOTSTRAP_ACTIVE_KEY_ID | 新加密收据使用的 keyId |
| BOOTSTRAP_RECEIPT_KEYS | JSON 对象：keyId → base64 编码的 32 字节随机密钥；只供 NestJS 读取，不放入 Nuxt public runtime config |

本机 `.env` 已生成独立随机密钥；`.env.example` 保留空值。缺配置时 bootstrap 返回 `503 BOOTSTRAP_UNAVAILABLE`，健康入口仍可用。生成新密钥的命令为 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`。轮换时加入新 keyId、切换 active 并重启 API，旧 key 至少保留十分钟及运维余量；删除仍被有效收据引用的 key 会导致 `503 BOOTSTRAP_RECOVERY_UNAVAILABLE`，不会创建替代身份。

## 身份与恢复合同

1. 父页以 `credentials: omit` 请求公开配置/bootstrap。服务端对公开接口按已允许的 Origin 设置 CORS，不启用跨站 Cookie。
2. 父页 localStorage 使用 `smartdesk:visitor:{publicKey}:{location.origin}`，保存 token 和尚未确认的 `{commandId,resumeToken?}`。发送前保存待定请求；响应丢失、重试和完整刷新保留同一 commandId 和请求内容。
3. iframe URL 仅含 publicKey、parentOrigin、随机 channel，不含 token。双方 postMessage 使用精确 targetOrigin，同时校验 event.origin、event.source、publicKey 和 channel。iframe 令牌仅存内存，SSR 不含凭据。
4. 服务端在组织锁内建立客户、visitor_session 和 receipt 后响应。token 为 256 位随机值，30 天有效；visitor_sessions 仅存 SHA-256 hash。AES-256-GCM 收据包含 keyId/nonce/tag/ciphertext，AAD 绑定站点/来源/命令/摘要/截止时间，十分钟内恢复原始响应。
5. 到期后 30 秒周期清理密文；过期键访问时立即清理并提交墓碑，返回 `409 BOOTSTRAP_RECEIPT_EXPIRED`。客户端只有点击“开始新的咨询身份”才换键；后台停机期间的残留密文在 API 重启或访问时清理，截止时间不延长。
6. 有效 resumeToken 恢复原客户。已过期但归属正确的 token 明确返回 `identityReset: true` 及新身份；未知、撤销或属于其他来源的 token 返回 401。没有凭据不能用邮箱恢复。
7. 资料 PATCH 从 iframe origin 发起，Bearer 与成员 Cookie 分离。校验令牌、当前站点启用、原 parentOrigin 仍允许、customerId 本人及 expectedVersion。返回仅含 id/name/email/preferredLanguage/version，姓名和邮箱可为空，邮箱非空校验，语言仅 zh/en；不接受 internalNotes 或客户端组织/站点覆盖。
8. 第一方存储不可用时当前加载器实例仍可重试、更新资料；明确提示刷新后可能无法恢复，不承诺持久恢复。

## 实际验收方法

运行 `pnpm test:widget`：构建后创建随机命名隔离 PostgreSQL 数据库并应用现有迁移，启动临时 API/Nuxt 和 HTTPS 代理。使用 Chromium 的本地域名映射访问 `site-a.test`、`site-b.test` 与 `widget.test`，三个地址有不同的 schemeful site；没有用同域端口变化替代跨站。

HTTPS 测试证书由本机 OpenSSL 临时生成，默认路径 `C:/Program Files/Git/usr/bin/openssl.exe`，可用 `OPENSSL_PATH` 指向其他安装。证书不加入系统信任，测试浏览器忽略该临时证书错误。Cookie 验收先在 iframe 站点首方验证 SameSite=None;Secure canary 存在，再启用 CDP Network.setCookieControls，确认跨站 iframe 的 credentials=include 探针不携带 canary，然后验证 A/B 各自更新与刷新恢复。

故障注入保留浏览器发起请求的 body、Origin、Idempotency-Key，经实际隔离 API 提交后丢弃响应。Playwright 代发请求使用本机 API 地址，避免其 Node 网络层不遵循 Chromium 域名映射；随后浏览器真实跨站重试。覆盖丢响应、过期明确新建、密文篡改、密钥轮换/缺失、存储拒绝、错误 postMessage 来源、Cookie/Bearer 隔离、版本和同邮箱负例。

证据输出 `test-results/widget/`，包含分组结果、移动截图、服务日志及主库前后逐表行数/摘要；普通 Playwright smoke 输出隔离到 `test-results/e2e/`，避免清理其他验收证据。所有临时进程、端口、数据库与证书清理；不向体验主库创建测试账号。邮箱负例在隔离库建立旧客户私有会话，验证同邮箱新 token 仍绑定新客户且未继承旧历史归属；T05 历史读取端点尚未实现，不将此声明为历史 API 完整验收。

## 官方资料

- [MDN postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)：精确 targetOrigin 与接收端 origin/source 校验。
- [Node.js 22 crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html)：AES-GCM nonce、AAD 与 authTag。
- [Chromium Network.setCookieControls](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-setCookieControls)：第三方 Cookie 控制；参数同时与已安装 Playwright 1.65.0 的 protocol 类型核对。

无新增依赖或数据库迁移；版本沿用 T01/T03 锁定结果。正式实际命令与退出码在 T04 实施报告记录。
