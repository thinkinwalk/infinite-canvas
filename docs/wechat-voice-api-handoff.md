# 微信语音工作台 API 交接

## 交付范围

已随 **v0.19.91** 发布并部署至 `https://studio.lingzhouai.com`，源码提交 `364b28789cdcac6e19bc7de4add57249cd3c44d1`，发布分支 `release/v0.19.60`。稳定语音接口、普通账号客户端 API Key 管理、私有音色保存、任务恢复及音频归档下载复用已有 Replicate 模型路由、固定版本、任务表、报价、事务扣费和退款服务。

创建音色只保存参考录音、录音原文和配置，不训练独立模型。每次新文字生成都会调用 Qwen；下载已有音频与客户端重复播放不重新计费。

桌面端只依赖 HTTPS、普通账号 API Key 和这些业务接口，不需要网页、浏览器会话、管理员令牌、调试端口或上游密钥。

## 已核对配置

- 仓库模型：`qwen/qwen3-tts`，固定版本 `d490a561cf1171a8dc3d96d1e57efffea7dd34607148bb641f3d9de4e38c472e`。
- 只读核对生产数据库：“Replicate 官方”渠道启用，包含上述 Qwen 与 `vaibhavs10/incredibly-fast-whisper`，已配置凭据；仅输出是否已配置，不输出凭据原文。
- Qwen 当前规则：`input_characters`，每 1000 个字符向上取整为一档，每档 70 算力点，每次最低 100 点，再乘用户组倍率向上取整。实际以报价为准，不在客户端写死金额。
- Whisper 当前规则：输入秒数向上取整，每秒 1 点，最低 20 点；现有转写功能保留，本次接口要求用户提供录音原文，不自动产生转写费用。
- 本地数据库仍有旧共享 Replicate 配置，运行时沿用现有渠道归一化；与生产配置不是同一份。
- 模型公开说明：<https://replicate.com/qwen/qwen3-tts/readme>；参数：<https://replicate.com/qwen/qwen3-tts/api/schema>；文件输入：<https://replicate.com/docs/topics/predictions/input-files>。实际版本始终由仓库固定，升级需服务端调整及验收。

## 鉴权及 Key 管理

普通用户网页登录后，右上角账号菜单 → **客户端 API Key** → 输入名称 → 创建。完整 Key 只在本次弹窗内展示，关闭后无法找回，可复制并保存在 Windows 凭据管理器。列表只返回名称、前缀、创建及撤销时间。服务端保存 256 位随机 Key 的 SHA-256 摘要，不保存完整 Key。

业务请求：

```http
Authorization: Bearer ${VOICE_API_KEY}
```

Key 与普通账号绑定，每个请求重新检查 Key 是否撤销及用户是否禁用，读取当前用户组和余额。Key 只可访问本文语音业务路由，不能访问管理员、其他模型接口或创建新 Key。业务路由也允许同一普通账号的有效登录 JWT，方便网页集成；桌面运行时使用 Key 即可。

以下管理接口必须使用普通账号网页登录 JWT，不能使用客户端 Key 或管理员 JWT：

| 方法 | 路径 | 请求及结果 |
| --- | --- | --- |
| POST | `/api/client-api-keys` | `{"name":"微信语音工作台"}` → `data: {key: {id,name,prefix,created_at}, api_key}`，`api_key` 仅本次返回 |
| GET | `/api/client-api-keys` | `data: {items: [...]}`，含已撤销记录，不含摘要及完整 Key |
| DELETE | `/api/client-api-keys/{id}` | 撤销本人 Key，`data: true`；别人 Key 为 404 |

撤销后，新请求和下载立即拒绝；已经鉴权并开始的模型任务会继续，已开始传输的响应不追溯中断。用户可用其他有效 Key 获取原任务。

## 响应封装

成功为 `{"code":0,"data":...,"msg":"ok"}`。错误使用实际 HTTP 状态码，并返回稳定英文机器码及中文说明：

```json
{
  "code": 1,
  "data": null,
  "msg": "同一幂等键已用于不同的生成内容",
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "同一幂等键已用于不同的生成内容"
  }
}
```

客户端必须同时处理 HTTP 状态和 `code`，不能将 202 当作生成完成。JSON 不允许未知字段、多余 JSON 对象或尚未实现的语速、情绪、模型、版本、参考 URL、服务器文件路径参数。

## 最终业务接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/voices` | multipart 保存本人参考录音 |
| GET | `/api/v1/voices?page=1&page_size=20` | 当前账号有效音色分页，`page_size` 最大沿用项目 500 |
| PATCH | `/api/v1/voices/{id}` | JSON `{"name":"新名称"}`；首版仅可重命名 |
| DELETE | `/api/v1/voices/{id}` | 停用音色，禁止新任务，重复删除返回成功 |
| POST | `/api/v1/speech/quote` | `voice_id,text,language` 报价，不扣费、不调用上游 |
| POST | `/api/v1/speech/tasks` | 同上，可选 `expected_credits`；必须提供 `Idempotency-Key`；启用统一模型管理时还需传报价返回的 `quote_token` |
| GET | `/api/v1/speech/tasks/{id}` | 状态、实际扣费、退款及成品信息 |
| GET | `/api/v1/speech/tasks/{id}/audio` | 本人成功任务的音频二进制，支持 Range、ETag |

所有音色、任务、音频按账号隔离；ID 不是授权凭证。不存在和别人资源统一返回 404。仅能下载 `completed` 且已落盘的音频。

### 保存音色

multipart 字段：`name`、`file`、`reference_text` 必填，`language` 可省略为 `auto`。只接受一份文件和各一份文本字段。`reference_text` 应与本人录音内容一致。

```json
{
  "code": 0,
  "data": {
    "voice_id": "voice-<uuid>",
    "name": "我的音色",
    "reference_text": "这段录音的实际原文。",
    "language": "Chinese",
    "version": "<64位内容摘要>",
    "mime_type": "audio/wav",
    "bytes": 960044,
    "duration_seconds": 10,
    "created_at": "<RFC3339时间>",
    "updated_at": "<RFC3339时间>"
  },
  "msg": "ok"
}
```

列表的 `data` 为 `{items: [音色对象], total, page, page_size}`，不返回私有文件路径和参考音频 URL。重命名不改变内容版本；首版参考原文、录音和语言不可原地修改，需新建音色。

### 文件与语言限制

- 沿用项目参考音频限制：文件最大 **15 MiB（15 × 1024 × 1024 字节）**，真实 MP3 或 WAV，非空、音轨可解码、有效时长大于 0，不含视频或封面流。
- FFprobe 对文件实际容器、音轨、可读取帧和时长进行检测，不信任扩展名、客户端 MIME 或客户端时长。音质、人声清晰度、录音人与原文一致性由调用方确认；静音检测和真人识别不在首版范围。
- Qwen 公开说明可以用约 3 秒录音克隆；这属于能力说明，不是固定最短上传规则。当前固定版本公开 schema 未声明参考时长硬上限，因此服务端未套用其他模型的 10 秒、30 秒等限制。推荐使用清晰、干净的短录音，需用真实素材验收效果。
- 语言只能为：`auto`、`Chinese`、`English`、`Japanese`、`Korean`、`French`、`German`、`Italian`、`Spanish`、`Portuguese`、`Russian`，大小写须一致。合成未传语言时为 `auto`，不会隐式继承音色语言。
- 上游输入固定为 `mode: voice_clone`、`text`、`language`、`reference_text`、`reference_audio`。服务端从私有持久文件构造内联 data URI，避免公开录音 URL；真实渠道对此输入组合的生成仍需验收。
- 输出不强制转 MP3；读取真实音频容器后返回 WAV、MP3、FLAC、M4A 或 OGG，客户端按 `mime_type` 与 `format` 保存和解码。

### 报价与提交示例

```http
POST /api/v1/speech/quote
Content-Type: application/json
Authorization: Bearer ${VOICE_API_KEY}

{"voice_id":"voice-<uuid>","text":"这是需要生成的新文字。","language":"Chinese"}
```

```json
{
  "code": 0,
  "data": {
    "voice_id": "voice-<uuid>",
    "voice_version": "<音色内容版本>",
    "model": "qwen/qwen3-tts",
    "model_version": "<服务端固定版本>",
    "config_version": "<模型、版本、克隆模式摘要>",
    "credits": 100,
    "balance": 500,
    "sufficient_balance": true,
    "billing_mode": "input_characters",
    "billable_units": 1,
    "unit_credits": 70,
    "minimum_credits": 100,
    "calculation": "<中文计价说明>"
  },
  "msg": "ok"
}
```

报价不预留余额。创建时重新报价并事务检查余额；可传 `expected_credits` 防止报价变化后继续扣费。启用统一模型管理时，模型由后台 `api.speech` 功能绑定解析，报价返回稳定平台模型 ID、数字配置版本和 `quote_token`。客户端应原样将凭据带入创建请求；它绑定当前账号、音色、文本、语言、渠道和配置版本。版本变化后重新报价，已创建任务仍可按原幂等键恢复。

```http
POST /api/v1/speech/tasks
Content-Type: application/json
Authorization: Bearer ${VOICE_API_KEY}
Idempotency-Key: ${VOICE_IDEMPOTENCY_KEY}

{"voice_id":"voice-<uuid>","text":"这是需要生成的新文字。","language":"Chinese","expected_credits":100,"quote_token":"<启用统一模型管理时原样传回报价凭据>"}
```

首次接受为 HTTP 202；相同幂等请求恢复为 HTTP 200，均返回同一任务对象：

```json
{
  "code": 0,
  "data": {
    "task_id": "speech-<摘要>",
    "status": "running",
    "voice_id": "voice-<uuid>",
    "voice_version": "<音色版本>",
    "model": "qwen/qwen3-tts",
    "model_version": "<固定版本>",
    "config_version": "<配置版本>",
    "language": "Chinese",
    "quoted_credits": 100,
    "charged_credits": 100,
    "refunded": false,
    "created_at": "<RFC3339时间>",
    "updated_at": "<RFC3339时间>",
    "audio": null,
    "error": null
  },
  "msg": "ok"
}
```

完成后，`GET` 同一任务返回 `status: completed`，`audio` 为：

```json
{
  "url": "/api/v1/speech/tasks/speech-<摘要>/audio",
  "mime_type": "audio/wav",
  "format": "wav",
  "bytes": 960044,
  "duration_seconds": 10,
  "sha256": "<成品文件SHA-256>",
  "cache_key": "<同一SHA-256>"
}
```

下载需要同一账号的有效 Key。`audio.url` 是相对本站地址，不能拼接到供应商域名。响应包含实际 Content-Type、Content-Disposition 和 ETag；支持条件请求返回 304。鉴权发生在条件请求之前，撤销 Key 后不能靠 ETag 绕过鉴权。

## 状态、幂等和计费

| 状态 | 含义及动作 |
| --- | --- |
| `creating` | 本地任务与扣费已经提交，正在提交上游；同 Key 查询或重试 |
| `running` | 已取得上游任务编号；轮询查询，不创建新模型任务 |
| `generated` | 上游成功，平台正在下载或验证音频；尚不可下载 |
| `completed` | 已验证并保存平台音频；可以下载 |
| `failed` | 上游明确拒绝或明确失败，事务返还一次 |
| `cancelled` | 原任务通过现有系统被确认取消，事务返还一次；首版语音接口未开放取消操作 |
| `uncertain` | 提交断网、服务中断或上游未返回编号，不能确认上游是否创建；不自动重提、不假定退款，需管理员核对 |

- 幂等范围为账号 + `Idempotency-Key`，任务主键由它们的 SHA-256 派生，不保存 Key 原文。不同账号使用相同 Key 互不影响。
- 请求内容摘要为音色 ID、首尾去空白后的文字、归一化语言；同 Key 同内容返回原任务，同 Key 不同内容 HTTP 409。`expected_credits` 是首次提交报价断言，不属于生成内容，不会阻止已接受任务的恢复。
- 第一次成功创建时绑定当时的音色版本、模型版本、渠道及计价快照。后续改价、停用音色或升级模型，不改变已创建任务；相同 Key 仍返回原任务。
- 任务插入、检查音色未停用、扣费及账本写入在同一事务；余额不足不创建上游任务。数据库主键阻止重复扣费，进程内提交标记避免重复提交。
- 上游明确拒绝或生成失败：状态、返款、账本同事务，仅执行一次。任务 `quoted_credits` 保留历史金额，`charged_credits` 为实际净扣费，退款后为 0。没有第二次按音频时长补扣费。
- 下载临时失败、音频验证失败进入 `generated` 并继续归档，不自动重做生成，也不把上游成功误当成退款条件。
- 后台启动时立即扫描持久任务，随后每分钟恢复已知任务的轮询与归档，客户端查询也能触发同一路径；同进程并行恢复按任务串行，终态不会回退。轮询/归档使用既有 15 分钟 HTTP 超时，后台逐条执行，不新增付费任务队列。
- `creating` 没有上游编号且已无提交进程时，恢复为 `uncertain`。管理员可沿用 `/api/admin/replicate/tasks/{id}/reconcile` 核对固定模型、版本和输入指纹后关联已存在的供应商任务；不得为恢复而重新生成。
- 不引入自动重提次数、运行时间价格结算或新的余额体系。客户端网络重试应一直保留相同幂等键；不要换 Key 来“重试”未确认任务。

## 错误码

| HTTP | 机器码 | 说明 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 字段缺失、未知参数、格式错误、重复 multipart 字段等 |
| 400 | `INVALID_AUDIO` | 空文件、伪造格式、无有效音轨/时长或 FFprobe 检测失败 |
| 400 | `INVALID_LANGUAGE` | 不支持的语言 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 缺少幂等键 |
| 401 | `UNAUTHORIZED` | Key 无效/撤销、用户禁用或不是普通账号 |
| 401 | `SESSION_REQUIRED` | Key 管理需要普通账号登录 JWT |
| 402 | `INSUFFICIENT_CREDITS` | 当前余额不足 |
| 404 | `VOICE_NOT_FOUND` / `TASK_NOT_FOUND` / `KEY_NOT_FOUND` | 资源不存在或不属于该账号 |
| 404/500 | `AUDIO_UNAVAILABLE` | 平台存储文件缺失或记录异常 |
| 409 | `VOICE_DISABLED` | 音色已停用或事务检查版本不匹配 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同 Key 不同生成内容 |
| 409 | `QUOTE_CHANGED` | 提交时价格与确认值不一致 |
| 409 | `SUBMISSION_IN_PROGRESS` | 任务提交临界窗口，请保留相同幂等键重试 |
| 409 | `AUDIO_NOT_READY` | 尚未完成平台归档 |
| 413 | `UPLOAD_TOO_LARGE` | 文件超 15 MiB 或 multipart 请求过大 |
| 502 | `UPSTREAM_QUERY_FAILED` | 查询暂时失败，后续可恢复，不重提 |
| 503 | `MODEL_DISABLED` | 模型未启用 |
| 503 | `MODEL_VERSION_MISMATCH` | 固定模型版本与价格版本不一致 |
| 503 | `MODEL_NOT_CONFIGURED` / `MODEL_UNAVAILABLE` | 模型计价或可用性配置未就绪 |
| 503 | `CHANNEL_NOT_CONFIGURED` | 渠道未配置、禁用、缺密钥或账号无权限 |
| 503 | `REFERENCE_UNAVAILABLE` | 参考文件不可用 |
| 500 | `INTERNAL_ERROR` | 未向外部披露内部细节的服务错误 |

任务对象中的 `error` 另用 `UPSTREAM_FAILED`、`SUBMISSION_UNCERTAIN`、`AUDIO_ARCHIVE_PENDING`，HTTP 仍可能成功返回任务。接口不返回上游响应原文、供应商任务 ID、渠道密钥或私有路径。

## 存储及缓存

- 参考录音保存在数据卷 `voices/`，新文件采用私有权限；不放在现有匿名公开的 `reference-media/`，不加入视频临时素材清理租约。
- 成品沿用 `replicate-results/`，数据库保存格式、真实时长、大小和 SHA-256。完成后的下载不依赖供应商链接。
- 当前不设置自动保留到期时间，音色参考文件和任务成品随数据卷长期保留。DELETE 是停用，不是物理擦除；已完成成品仍可下载，参考文件也保留供已提交任务恢复核对。
- 客户端以账号隔离缓存，用音色版本 + 配置版本 + 文字 + 语言识别业务内容，用任务 ID / SHA-256 识别实际成品。不同生成可能产生不同波形，不保证同内容每次字节一致。
- 音色删除不强制清除已下载的本地音频。客户端自行管理缓存和隐私；下载既有音频不调用模型。
- 多实例部署必须共享同一数据库和数据卷；首版以现有单应用进程部署为验收目标，未验证分布式归档互斥。供应商链接失效前始终未能归档、磁盘丢失或备份不完整，仍可能导致音频无法恢复。

## PowerShell 调用

完整可执行脚本：`scripts/wechat-voice-api.ps1`，需要 PowerShell 7。凭据只通过环境变量传入，脚本不输出 Key。运行脚本会按报价创建收费模型任务，应使用本人授权录音。

```powershell
$env:VOICE_API_BASE_URL = "https://studio.lingzhouai.com"
$env:VOICE_API_KEY = "<普通账号创建的客户端 Key>"
$env:VOICE_REFERENCE_FILE = "C:\Voice\my-reference.wav"
$env:VOICE_REFERENCE_TEXT = "这段录音的实际原文。"
$env:VOICE_SYNTHESIS_TEXT = "这是使用我的音色生成的新文字。"
$env:VOICE_IDEMPOTENCY_KEY = "<本次业务请求的固定 UUID>"
pwsh -File .\scripts\wechat-voice-api.ps1 -OutputPath "C:\Voice\cache\speech.wav"
```

脚本执行：上传 → 列表 → 报价 → 提交（带 `expected_credits`）→ 查询 → 下载 → SHA-256 校验。按实际 `audio.format` 调整输出扩展名。输出目录需预先存在。

可通过普通用户登录 JWT 在同一脚本中创建客户端 Key；此令牌仅用于初始配置，不是桌面运行依赖：

```powershell
$env:VOICE_LOGIN_TOKEN = "<普通用户通过 /api/auth/login 获取的 JWT>"
pwsh -File .\scripts\wechat-voice-api.ps1 -CreateKey
```

生产使用推荐在网页管理入口创建 Key 并写入系统凭据库。脚本 `-CreateKey` 创建的原文只放当前 PowerShell 子进程环境，不自动写入磁盘。

恢复同一任务需固定音色 ID、文字、语言和原幂等键，防止重新上传得到不同音色 ID：

```powershell
$env:VOICE_ID = "<上次返回的 voice_id>"
# 保留原 VOICE_IDEMPOTENCY_KEY、VOICE_SYNTHESIS_TEXT、语言
pwsh -File .\scripts\wechat-voice-api.ps1
```

## 迁移及部署步骤

1. 停止待升级应用写入，按既有部署方式备份数据库及整个数据卷；SQLite 使用在线 backup 并检查 `quick_check`，不要只拷贝正在写入的主文件。
2. 编译新后端和新前端资源。启动时沿用 `repository.DB()` 的 GORM `AutoMigrate`，新增 `client_api_keys`、`voices` 两张表，为 `replicate_tasks` 新增 `speech_voice_id`、`speech_voice_version`、`speech_language`、`speech_request_hash`、`audio_duration`、`audio_bytes`、`audio_sha256`。不重写旧任务、旧余额或供应商配置。
3. 保留数据库与媒体目录原位置，确保 `voices/`、`replicate-results/` 可写且数据卷持久挂载。不要将它们配置成静态公开目录。
4. 安装/配置 `FFPROBE_PATH`；Linux 可使用 PATH 中的 `ffprobe`。上传和输出验证依赖 FFprobe。此链路不要求额外本地 ASR、GPU 或视频 Worker。
5. 检查现有 Replicate 官方渠道中 Qwen 的启用状态、密钥、分组权限及固定版本计价；不新增第二份供应商密钥。外部入口配置有效 HTTPS，代理上传上限应容纳 15 MiB 文件和 multipart 封装。
6. 更新实际使用的前端资源；只开 Vite 不能证明生产 Go 静态资源已更新。普通账号菜单确认 Key 管理入口。
7. 使用测试账号和授权本人录音进行真实 HTTPS/真实 Qwen 生成验收；确认上游接受内联音频、中文效果、真实扣费、归档、断线恢复、下载。

本次已完成生产增量迁移和应用部署；现有 `PUBLIC_BASE_URL` 仍用于原模型公开素材链路，新增私有音色链路不依赖它生成参考 URL。生产验证详情见下文。

主要修改：

- `model/voice.go`、`model/replicate_task.go`：音色、客户端 Key、语音任务快照与音频元数据。
- `repository/voice.go`、`repository/db.go`、`repository/replicate_task.go`：持久化、自动迁移、归属查询与事务检查。
- `service/client_api_key.go`、`service/voice_audio.go`：安全摘要、普通账号解析、FFprobe 真实音频检测。
- `handler/voice.go`、`handler/speech.go`、`handler/voice_error.go`、`handler/client_api_key.go`：业务接口、稳定错误码、恢复与下载。
- `handler/replicate.go`：提取共用提交/刷新逻辑，复用供应商及账本，验证语音结果并支持落盘恢复。
- `middleware/admin.go`、`router/router.go`、`main.go`：独立业务鉴权、路由及后台恢复启动。
- `web/src/components/layout/client-api-keys-modal.tsx`、`web/src/components/layout/user-status-actions.tsx`、`web/src/services/api/client-api-keys.ts`：普通账号管理入口。
- `router/speech_api_test.go`、`handler/speech_recovery_test.go`、`repository/voice_migration_test.go`：真实本地 HTTP + 模拟上游、恢复与一次退款、旧表迁移及数据库重开测试。
- `scripts/wechat-voice-api.ps1`：完整外部调用脚本。

## 验证记录

已执行的检查：

| 检查 | 结果及边界 |
| --- | --- |
| `go test ./handler ./repository ./router -count=1`（配置真实 FFprobe） | 全部通过，含现有回归测试及本次语音测试 |
| `TestSpeechAPIHTTPWorkflow` | 真实 TCP/localhost HTTP、真实路由和鉴权、真实 multipart 与 FFprobe；供应商请求由测试 transport 模拟并禁止其他外部地址。覆盖摘要存储、Key 作用域与撤销、用户隔离、非法/空/超大录音、持久文件、报价、余额不足、模型禁用、渠道缺失、未知参数、价变、重复及并发恢复、幂等内容冲突、无效成品归档重试、ETag、停用后历史下载、退款和不确定提交 |
| PowerShell 7 完整脚本 | 在上述真实 HTTP 服务上实际执行 `-CreateKey`，完成上传、列表、报价、创建、轮询、下载和 SHA-256 校验；上游全为模拟，脚本输出不含凭据 |
| `TestSpeechRecoveryNeverResubmitsAndRefundsOnce` | 从已有任务行恢复；已禁用原渠道仍可查询旧任务；没有上游 ID 时转 uncertain；没有付费重提或重复退款 |
| `TestVoiceMigrationPreservesLegacyDataAcrossReopen` | 从旧任务表迁移新增表/列，关闭后重开 SQLite，再迁移保持幂等；旧任务金额/状态和用户余额不变，音色/Key 留存，`quick_check=ok` |
| 现有报价及计费 4 项定向测试 | 通过，覆盖计价方式、本人素材时长、固定模型计价和转写启用 |
| `go build` | 后端构建成功 |
| Vite 生产构建 | 从工作区实际物理路径构建成功；C 盘入口映射到 I 盘导致首次构建路径错误，改从实际目录运行后通过。存在项目原有大包和静态/动态导入混用提示 |
| 全量 `go test ./... -count=1` | handler/repository/router/config 通过；service 中两项既有渠道导入测试失败，已在未修改 HEAD 导出的隔离副本复现，未将其记为通过 |
| `npm run typecheck` | 未通过：既有 `web/src/services/api/video-worker.ts:186` 将 string 赋给 UUID 模板字面量类型，文件与 HEAD 相同；没有本次新增文件的类型报错 |
| Key 管理 UI 浏览器验收 | 未完成，当前工具没有可用 Chrome/Edge/网页浏览器连接；不能把构建通过当作交互及视觉验收 |
| 独立常驻测试环境 | 启动命令被自动审批拒绝，仅返回 `blocked by policy`；没有绕过拒绝。HTTP 全流程使用自动测试启动并关闭的服务，不提供未运行的手工环境地址 |

两项基线失败为 `TestReplicateChannelImportPreservesCredentialsPricingAndID`（旧测试写死模型数量）和 `TestReplicateChannelImportPersistsOnSaveWithoutLosingSecret`（旧 Replicate 导入把 WaveSpeed 模型混入后被协议验证拒绝），本次保留原实现，未扩大修改范围。

可重复执行：

```powershell
$env:FFPROBE_PATH = "<本机 ffprobe 可执行文件完整路径>"
$env:GIN_MODE = "release"
go test ./handler ./repository ./router -count=1
go test ./service -run "^(TestCalculateReplicateCreditsByBillingMode|TestReplicatePricingUsesOwnedMediaDuration|TestNormalizeReplicatePricingIncludesPinnedModels|TestTranscriptionPricingRequiresAdministratorActivation)$" -count=1
# PowerShell 7 在 PATH 时，HTTP 测试同时执行交付脚本
```

真实付费 Qwen 生成：**未执行**。没有提供已明确授权的本人录音测试素材，因此不使用其他用户录音。测试 WAV 是程序生成的 PCM 容器，仅验证格式、时长、落盘和下载，不能称为真实克隆成功。

## 生产发布与交接结果

- 生产镜像：`infinite-canvas:v0.19.91`，镜像 ID `sha256:d86442cbb33a01b2ddd25c7c3b291b79763a307d8e00fee78a17db4fe217e615`，由服务器检出精确标签构建。GitHub Release：<https://github.com/thinkinwalk/infinite-canvas/releases/tag/v0.19.91>。
- 仅更新应用，未重启视频 Worker；其容器 ID、镜像、启动时间及 `v0.19.87-worker` 挂载均一致。既有 11 张表记录数、用户余额/角色/分组/状态、模型目录/报价/权限、保存配置及 8,829 个既有任务/媒体文件哈希一致。
- 启动迁移确认新增两张表和上述七个任务字段，SQLite `quick_check=ok`；内外健康均为 HTTP 200 `ok`，9 个页面及普通账号 default/VIP Worker 网关通过。
- 前端实际发布资源为 `/assets/index-C21SbVxG.js`，含版本及 Key 管理代码；独立工作站请求确认同一资源。此项验证不代表管理弹窗已经完成浏览器点击验收。
- 使用两个专用临时普通账号，通过真实 HTTPS 验证 Key 创建、摘要存储、作用域与撤销，非法音频拒绝，合成 PCM WAV 的真实 FFprobe 检测及私有落盘，列表、重命名、停用和用户隔离；Qwen 固定版本报价为样例 100 点，余额不足拦截及未知参数拒绝通过。
- 下载专项使用直接写入的**合成已完成任务记录**和合成 WAV，验证任务查询、鉴权下载、实际 MIME/SHA-256、ETag 304、停用后历史下载、同内容幂等返回及内容冲突；未调用供应商，不能视为真实模型生成。首次检查脚本因 HTTP 头大小写读取方式失败，修正脚本后全部通过，无需修改应用。
- 所有专项测试账号、Key、音色、任务和文件已清理，清理后原记录数、配置和余额一致。没有使用其他用户录音，没有创建真实付费任务。
- 最终备份：`/opt/infinite-canvas/backups/v0.19.91-20261023-114224/`，含在线 SQLite 备份、旧 Compose 及仅 root 可访问的环境备份；构建前另有 `v0.19.91-prebuild-20261023-113950/`。媒体保持原数据卷并核对哈希，本轮未额外复制整个媒体卷。
- 回滚：从上述目录恢复旧 Compose，执行 `docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml up -d --no-build --no-deps app`。旧镜像 v0.19.90 保留；新增表/列可保留，不要把旧数据库覆盖到发布后产生的新业务数据。
- 生产证据：`/opt/infinite-canvas/releases/v0.19.91-deployment.json`、`/opt/infinite-canvas/releases/v0.19.91-speech-smoke.json`；工作站副本位于外层工作区 `artifacts/release-v0.19.91/`。发布未重复本地构建或测试，服务器镜像构建和上述生产 HTTP 验证已实际执行。

仍需验收：本人授权录音的真实 Qwen 内联参考音频组合、声音相似度与质量、真实上游扣费/失败/归档恢复、Key 管理 UI 交互、多实例运行。开发模拟及生产合成任务下载测试均不代表真实声音克隆成功。
