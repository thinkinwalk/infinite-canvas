# 管理员客户端 API Key 管理交接

## 入口

- 普通用户：右上角小人图标 → 客户端 API Key，管理本人 Key。
- 管理员：同一账号菜单 → 客户端 API Key，搜索并选择所属普通账号后管理。
- 后台：用户管理 → 对应用户操作列的钥匙图标，直接打开该账号 Key 列表。
- 普通账号可由后台现有“新增用户”创建，不需要退出管理员登录来代建 Key。

## 权限与行为

管理员可为正常普通账号创建 Key，查看选定用户的 Key 元数据并撤销；禁用或已经升为管理员的账号不能创建新 Key，但历史 Key 仍可查看、撤销。普通账号和客户端 Key 不能访问管理员接口；管理员自己的登录令牌仍不能用于语音生成。

完整 Key 只在创建响应和本次弹窗展示，关闭弹窗即清除；列表不含原文或摘要。服务端沿用 256 位随机 Key 和 SHA-256 摘要；撤销立即阻止后续请求。管理员代建 Key 使用所选普通账号当前分组、权限、余额和本人资源，不附加管理员权限。账号被禁用或升为管理员后，其旧 Key 不能调用语音接口。

修改不增加表、字段、供应商配置、模型调用或计费规则；沿用原普通用户自助管理接口。

## 管理员接口

需要有效管理员 JWT：

| 方法 | 路径 | 请求与响应 |
| --- | --- | --- |
| GET | `/api/admin/users/{user_id}/client-api-keys` | `{code:0,data:{items:[{id,name,prefix,created_at,revoked_at}]},msg:"ok"}` |
| POST | 同上 | `{"name":"微信语音工作台"}` → `{code:0,data:{key:{id,name,prefix,created_at},api_key:"<仅此一次>"},msg:"ok"}` |
| DELETE | `/api/admin/users/{user_id}/client-api-keys/{key_id}` | 撤销归属该用户的 Key，`data:true` |

JSON 严格校验，不能通过 body 指定另一个归属账号。所有操作按 URL 中用户 ID 校验；Key 不属于该用户时返回 404 `KEY_NOT_FOUND`。响应禁止缓存。管理员路由沿用既有 `AdminAuth`，无权请求须同时判断 HTTP 和 `code`。

| HTTP | 机器码 | 说明 |
| --- | --- | --- |
| 404 | `USER_NOT_FOUND` | 所选用户不存在 |
| 400 | `INVALID_KEY_OWNER` | 创建目标不是普通账号 |
| 409 | `ACCOUNT_DISABLED` | 创建目标已禁用 |
| 400 | `INVALID_REQUEST` | 名称无效、未知字段等 |
| 404 | `KEY_NOT_FOUND` | Key 不存在或不属于所选用户 |

普通用户自助接口仍为 `/api/client-api-keys`；客户端运行仍使用 `Authorization: Bearer ${VOICE_API_KEY}` 调用 `/api/v1/voices` 和 `/api/v1/speech/...`。详细调用与可执行 PowerShell 示例见 `docs/wechat-voice-api-handoff.md`、`scripts/wechat-voice-api.ps1`。

## 验证

已执行 `go test ./router -run '^(TestAdminClientAPIKeysHTTP|TestSpeechAPIHTTPWorkflow)$' -count=1`，真实 TCP/HTTP 验证通过：

- 管理员代建后实际 Key 归属、摘要及普通用户权限/余额正确，目标用户可自助查看。
- 管理员与普通用户列表均不返回 Key 原文或摘要；创建响应禁止缓存。
- 匿名、普通用户、客户端 Key 对管理员列表/创建/撤销全部拒绝。
- 禁止管理员本人创建、禁止 Key 自我扩权、错误用户 URL 撤销和未知字段；目标账号不存在/禁用有机器码。
- 用户禁用或改管理员后旧 Key 无法调用语音；管理员可查看/撤销历史 Key，恢复普通身份后撤销仍生效。
- 账号余额不变；原完整语音 HTTP 回归通过，模型响应使用模拟，无真实付费请求。

已随 **v0.19.93** 发布生产，提交 `77d8f2341682a64378e8fd196f502a0b4f2af8b5`，GitHub Release：<https://github.com/thinkinwalk/infinite-canvas/releases/tag/v0.19.93>。管理员打开网站后刷新页面，即可从账号菜单或后台 `https://studio.lingzhouai.com/admin/users` 进入。

生产真实 HTTPS 验证完成，使用三个专用临时账号覆盖代建、归属及摘要、本人查看、管理接口越权拒绝、错误归属、账号禁用/改角色后历史撤销及撤销后失效；所有临时账号和 Key 已清理。未修改真实用户配置、余额或素材，未请求付费模型。

内外健康均为 HTTP 200 `ok`，实际资源为 `/assets/index-CMpRJrnG.js`，独立工作站核对版本、所属账号选择器及 Key API 代码。13 张表记录数、设置、余额/角色/分组/状态、default/VIP 模型目录和六项可用模型报价、8,829 个既有任务/媒体文件哈希一致。没有新迁移；Worker 未重启。

在线 SQLite、旧 Compose 与私有环境备份：`/opt/infinite-canvas/backups/v0.19.93-20261023-165211/`，构建前备份 `v0.19.93-prebuild-20261023-164621/`。回滚恢复旧 Compose 并执行 `docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml up -d --no-build --no-deps app`，不恢复旧数据库。生产证据为 `/opt/infinite-canvas/releases/v0.19.93-deployment.json`、`v0.19.93-keys-smoke.json`，工作站副本位于外层工作区 `artifacts/release-v0.19.93/`。首次部署预检因用户组默认项假设停止在切换前，修正验证脚本后完成；未改变模型配置。

前端交互待验收：浏览器工具仅有空 MCP App 页面，没有可用网页连接；不能把资源代码或后端测试通过视为管理员弹窗已点击验收。遵循仓库约定未运行本地构建和类型检查，服务器按精确发布 tag 构建生产镜像成功。

## 修改文件

`handler/client_api_key.go`、`router/router.go`、`router/admin_client_api_key_test.go`、`web/src/services/api/client-api-keys.ts`、`web/src/components/layout/client-api-keys-modal.tsx`、`web/src/components/layout/user-status-actions.tsx`、`web/src/app/(admin)/admin/users/page.tsx`，以及变更记录和相关交接文档。
