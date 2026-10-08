# 视频处理服务

与前端的视频工具工作台配套。新增 Go 后端适配复用已有 Replicate 私有 Token 调用云模型，本服务负责 FFmpeg/Whisper 后期处理与可选自部署引擎。实现与验收状态见 [IMPLEMENTATION_REPORT.md](./IMPLEMENTATION_REPORT.md)。

## 当前可运行的能力

| 能力 | 运行条件 | 本机状态 |
| --- | --- | --- |
| 上传、抽帧、字幕烧录、关键词高亮、配乐、结果下载 | FFmpeg | 已实际运行 |
| 语音转写、字幕时间轴、语音段落剪辑 | faster-whisper + 本地模型 | 已配置 small 多语言模型，CPU 可运行 |
| 数字人口型 | MuseTalk 与模型权重 | 适配器完成，尚未部署推理环境 |
| 声音样本克隆 | CosyVoice HTTP 服务 | 接口完成，尚未部署该服务 |
| 人物替换 | Wan-Animate 与预处理权重 | 预处理、推理适配器完成，尚未部署 GPU 环境 |
| 商品、背景替换 | VACE 与模型权重 | 动态掩膜/矩形掩膜链路完成，尚未部署 GPU 环境 |
| 高清增强 | Real-ESRGAN 与权重 | 逐帧增强、音轨合成链路完成，尚未配置引擎 |
| 硬字幕去除 | LaMa 与权重；自动检测另需 PaddleOCR | 掩膜与修复链路完成，尚未配置引擎 |

前端会读取服务的真实能力清单，缺少引擎时给出缺项。配置存在不代表推理质量已经验收。当前没有使用其他工具的示例冒充本平台生成结果。

## Windows 本地启动

在 `video-worker` 目录执行：

```powershell
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements-ai.txt
./.venv/Scripts/python.exe -c "from faster_whisper.utils import download_model; download_model('small', output_dir='data/models/whisper-small')"
./start.ps1
```

`start.ps1` 默认监听 `127.0.0.1:8767`，若 `data/models/whisper-small/model.bin` 已存在，自动使用该本地模型。FFmpeg 可使用 imageio-ffmpeg 自带版本，无需再安装系统级 FFmpeg。Windows 原生推理通过项目虚拟环境中的 `msvc-runtime` 加载 C++ 运行库，避免依赖旧版系统 DLL。

前端默认服务地址：`http://127.0.0.1:8767`。已保存过其他地址时，在页面右上角「处理服务」更新地址后检查连接。入口：

- `/video/cloud-create`：Replicate 单镜头图生视频、可编辑脚本。
- `/video`：原有自由创作、参考图片/视频/音频、AI 代写。
- `/video/content-replace`：内容替换。
- `/video/store-explore`：探店素材分析与脚本。
- `/video/viral-recreate`：参考视频分析与改编。
- `/digital-human`：数字人六步工作台。
- `/video/upscale`：视频高清。
- `/video/subtitle-remove`：硬字幕去除。

当前执行时已在本机创建 `.venv`、下载 Whisper small 权重，并启动服务。这些运行数据位于被 Git 忽略的 `data` 和 `.venv` 中，迁移到其他电脑需要重新安装或复制权重。

## 模型渠道

前端沿用项目的模型设置与已有接口，不在 Python 服务里复制 API Key。

- 分析/文案：选择支持图片输入的文本模型。探店资料没有填写的价格、地址或促销不会被当作已知事实。
- 视频创作、复刻和模型方式的内容替换：选择视频模型。参考视频/音频需要 Seedance 类型接口或支持相应参数的模型脚本，普通图片转视频接口会拒绝这些输入。
- 口播：选择语音模型及该模型支持的 voice 名称，或导入已有音频。
- AI 封面：选择图片编辑模型；视频首帧封面只需 FFmpeg。

模型调用仍按所选渠道计费。本次没有购买 GPU、开通新付费 API、创建新账户或部署生产环境。

## 配置专用引擎

复制 `engines.example.json` 为 `engines.json`，在各开源仓库各自的 Python 环境中按上游说明安装依赖、下载对应权重，然后修改 `cwd`、`required_paths` 和 `command` 中的绝对路径。示例使用 Linux 路径；Windows 部署时改为实际的 `python.exe` 和权重目录。

示例中的参数基于以下上游文件核对；代码与权重版本应一起固定，升级后用真实素材再次验收：

| 引擎 | 对接内容 | 上游参考 |
| --- | --- | --- |
| Wan-Animate | 原视频与人物图 → 官方预处理 → `generate.py` 替换模式 | [Wan2.2](https://github.com/Wan-Video/Wan2.2) |
| VACE | 原视频、编辑掩膜、主体/背景图与提示词 → `vace_wan_inference.py` | [VACE](https://github.com/ali-vilab/VACE) |
| MuseTalk | 自动写入单任务 YAML → `scripts.inference` v15 → 指定结果文件 | [MuseTalk](https://github.com/TMElyralab/MuseTalk) |
| Real-ESRGAN | 抽出所有帧 → `inference_realesrgan.py` → 保留音轨合成 | [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) |
| LaMa | 帧与同名 `_mask.png` → `bin/predict.py` → 合成视频 | [LaMa](https://github.com/advimman/lama) |
| faster-whisper | 音轨转 16 kHz → 本地 Whisper → 字幕时间轴/语音剪辑 | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| CosyVoice | 转换声音样本 → `/inference_zero_shot` → PCM 封装 WAV | [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) |

`adapters/wan_animate.py` 和 `adapters/vace.py` 执行上游的实际命令。引擎命令只从操作员配置读取，浏览器不能传入命令或任意文件路径。

CosyVoice 配置：

```powershell
$env:COSYVOICE_URL = 'http://127.0.0.1:50000'
$env:COSYVOICE_SAMPLE_RATE = '24000'
```

采样率必须与部署模型的实际输出一致；示例值用于相应输出为 24 kHz 的模型。官方接口返回 16 位单声道 PCM，服务按配置封装成 WAV；若对接的服务已返回 WAV，则保留 WAV。页面需要上传声音样本并填写样本实际文字。

可选语音环境变量：`WHISPER_MODEL`（本地权重目录）、`WHISPER_DEVICE`（默认 cpu）、`WHISPER_COMPUTE_TYPE`（默认 int8）。推理不在任务执行时自动联网下载权重。

### 编辑方式和质量范围

- Wan-Animate 人物模式使用官方动作/分割预处理。人物与背景同时替换时请选择支持该操作的模型 API；专用人物引擎会提示其处理范围。
- VACE 可上传与原视频对齐的动态黑白掩膜，也可框选固定矩形。白色表示编辑、黑色表示保留。矩形覆盖整个时间轴，移动主体建议使用动态掩膜。输入按 VACE 示例的 16 fps 对齐，帧数按模型要求调整为 `4n+1`。生成后恢复原音轨。
- 高清增强中的目标帧率使用 FFmpeg `minterpolate`，没有冒充 RIFE 推理。
- 当前 LaMa 路线逐帧修复，快速运动可能闪烁。未框选区域时，OCR 路线会检测画面中的文字，需要确认没有误删本来要保留的招牌等内容。
- 引擎环境需按其官方要求选择显卡与权重，当前电脑没有可用的独立 GPU。本次尚未验证真实人物口型、替换质量、超分细节和字幕修复质量。

### 使用许可

本实现没有内嵌或下载以上专用引擎权重。已核对的代码许可：MuseTalk 和 faster-whisper 为 MIT、Real-ESRGAN 为 BSD 3-Clause、LaMa 和 CosyVoice 为 Apache 2.0。商用时还需核对所用权重、底层依赖及素材各自许可；Wan/VACE 以安装时上游代码和所选模型的许可为准。MoneyPrinterTurbo、Video2X 和 Video Subtitle Remover 仅用于流程研究，没有将这些项目整体嵌入应用。ProPainter 没有作为默认商业引擎加入。

## 本地记录与任务恢复

- 前端素材、草稿、阶段结果与任务记录存储在当前浏览器的 localforage；「保存素材」和「加入新画布」也保存在当前浏览器，没有云同步。
- 工作者服务的上传、结果及 JSON 任务清单存放在 `data/media` 和 `data/jobs`。
- 页面刷新后可从任务记录恢复已提交任务的查询。更改处理服务地址后，旧任务不会自动使用当前令牌请求旧地址。
- 已完成的步骤会被自动流程复用；失败后可只重试对应阶段。修改前置输入会清除受影响的后续输出。
- 「停止等待」暂停浏览器查询，服务端任务可能继续。「取消处理任务」会取消本站处理服务启动的子进程。语音识别运行在独立子进程中，原生崩溃会让该步骤失败，API 服务可以继续工作。
- 服务重启会将未完成任务标记为失败，保留已经完成的文件。当前没有断点续算的承诺。同步执行的模型插件没有可跨刷新恢复的插件结果。

## 远程部署

直接访问 worker 的模式面向可信操作员。正式部署应使用新增 Go 网关 /api/v1/video-worker，以平台登录校验用户和任务/文件归属；worker 放在内部网络，令牌仅在服务器配置，普通用户无需填写。例如：

```powershell
$env:VIDEO_WORKER_TOKEN = '填写自己的长随机令牌'
$env:VIDEO_WORKER_ORIGINS = 'https://studio.lingzhouai.com'
```

手动直连远程 worker 时才在前端填写对应令牌和 HTTPS 地址。正式站内网关由网站后端读取同一个 VIDEO_WORKER_TOKEN，前端只发送平台登录 JWT。不要把真实令牌提交到 Git。普通本地启动只绑定回环地址。`VIDEO_ENGINE_CONFIG` 可指定配置文件，`VIDEO_WORKER_DATA` 可指定持久化目录，`SUBTITLE_FONT` 可指定已安装字体。

附有 `Dockerfile` 供准备 CPU 服务镜像。GPU 模型各自的环境、模型挂载和显卡驱动需按上游配置；本次没有执行 Docker 构建或生产部署。

## 本次运行证据

`data/verification` 保留了本地运行的视频和 JSON 清单：

- `composed.mp4`：FFmpeg 合成样片，含实际烧录的中文字幕和混入的音乐。
- `speech-video.mp4`：Windows 本地 TTS 与合成画面，用于语音时间轴和剪辑。
- `report.json`：抽帧数量、合成文件信息、取消状态与未授权请求结果。
- `speech-report.json`：真实语音识别文本、时间轴与剪辑输出。
- `canvas-result.png`：浏览器完成字幕合成与首帧封面、保存素材、刷新恢复后，将约 6.92 秒的实际结果加入新画布；标题明确标注为非 AI 生成验收样片。

上面这些先前 CPU 素材不是云生成证明。本轮另生成八次真实 Replicate 预测，文件以 replicate- 开头；供应商输入照片/人物参考和合成声音克隆的来源登记于 trial-provenance.json。参见实施报告中的逐项质量结论。


## 当前服务器与 Replicate 方案

数字人视频学习与字幕识别已增加云端语音路线：后端通过 FFmpeg 从素材提取 MP3，交给固定版本的 Incredibly Fast Whisper 识别，结果与时间戳存入平台任务；该路线不加载本服务的 Whisper。需更新 Go 后端、配置公开 HTTPS 素材地址及 FFmpeg/FFprobe，在管理员 Replicate 设置启用识别模型并配置本站输入音频秒数单价后使用。模型默认关闭，不以供应商典型任务估价作为本站固定收费。当前仅完成本地音频准备和模拟页面验证，尚未生产部署或真实付费验收。

选择处理服务识别时仍走本服务；剪气口当前仍加载本服务 Whisper，字幕烧录与配乐、抽帧仍需要本服务。Windows 开发后端若找不到 FFmpeg/FFprobe，可通过 `FFMPEG_PATH` / `FFPROBE_PATH` 指向实际可执行文件；Docker 网站镜像已包含 FFmpeg 工具。

已有 Token 无需重新配置。新增八项模型的代码已接入本站后端，但尚未运行新版 Go 服务做整站验收，也没有部署生产。首轮真实云调用复用服务器后台 Token，累计预留 $3.29，批准上限 $5；逐笔实际费用需账户账单确认。

本次成功运行 Qwen3-TTS、Wan2.2 S2V、Sync LipSync2、Wan2.2 Animate Replace、Wan2.2 I2V Fast、Wan2.7 VideoEdit、Topaz。Qwen 分别做了配音和声音克隆，共八次预测。VACE 仅完成接口适配；真实商品替换、真人声音相似度、硬字幕修复质量尚未验收。

服务器已只读检查为 4 vCPU、约 7.8 GiB 内存、无 NVIDIA GPU。方案让 Replicate 执行大模型，服务器负责 Go 网站与 CPU 后期处理。正式使用不依赖开发电脑；并发承载需要服务器实测。

生产配置草案为 ../server-customizations/docker-compose.video.example.yml；部署、数据库备份、镜像回退及验收清单见 IMPLEMENTATION_REPORT.md。worker 不映射公网端口，模型权重挂载 /models，处理文件挂载 /data。应用数据挂载 /app/data 内保存 reference-media 和 replicate-results，不能只挂载 SQLite 数据库单个文件。

CPU 队列、并发值、文件保留/清理和无人打开页面时的云结果归档仍待完成。结果目前在查询中下载保存，离开页面不会重新创建模型任务；长时间不恢复查询时需要核对供应商文件是否仍可取。新边界值按 AGENTS.md 在实施前确认，当前没有静默加入并发 1 或清理期限。

已有 adapters/gpu_worker.py 与 engines.remote.example.json 可供未来自托管，未运行远程推理。站内登录网关、收费事务和用户归属已写入代码，仍需新版后端运行验收；素材库与阶段历史保存在本浏览器，并非跨浏览器云同步。
