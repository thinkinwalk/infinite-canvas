import asyncio
import importlib.util
import json
import math
import signal as process_signal
import mimetypes
import os
import secrets
import shutil
import sys
import uuid
import wave
from pathlib import Path

import httpx
import imageio_ffmpeg
import yaml
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, ImageDraw
from pydantic import BaseModel


ROOT = Path(os.environ.get("VIDEO_WORKER_DATA", Path(__file__).parent / "data")).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
MEDIA = ROOT / "media"
JOBS = ROOT / "jobs"
MEDIA.mkdir(exist_ok=True)
JOBS.mkdir(exist_ok=True)
TOKEN = os.environ.get("VIDEO_WORKER_TOKEN", "")
ORIGINS = os.environ.get("VIDEO_WORKER_ORIGINS", "http://127.0.0.1:8081,http://localhost:8081,http://127.0.0.1:3000,http://localhost:3000").split(",")
ENGINE_FILE = Path(os.environ.get("VIDEO_ENGINE_CONFIG", Path(__file__).parent / "engines.json"))
FFMPEG = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()
TASKS: dict[str, asyncio.Task] = {}
PROCESSES: dict[str, asyncio.subprocess.Process] = {}


async def authorize(request: Request):
    origin = request.headers.get("origin")
    if origin and origin not in ORIGINS:
        raise HTTPException(403, "该页面来源未获处理服务授权，请配置 VIDEO_WORKER_ORIGINS")
    if request.headers.get("x-canvas-worker") != "1":
        raise HTTPException(403, "缺少处理服务请求标识")
    if TOKEN and not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {TOKEN}"):
        raise HTTPException(401, "处理服务访问令牌不正确")


app = FastAPI(title="灵图视频处理服务", dependencies=[Depends(authorize)])
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type", "X-Canvas-Worker"])


class JobRequest(BaseModel):
    operation: str
    inputs: dict[str, str | list[str]] = {}
    options: dict = {}


def atomic_json(path: Path, data: dict):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def load_engines():
    if not ENGINE_FILE.exists():
        return {}
    data = json.loads(ENGINE_FILE.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("引擎配置必须是 JSON 对象")
    return data


def engine_ready(name: str):
    spec = load_engines().get(name)
    if not spec or not isinstance(spec.get("command"), list) or not spec["command"]:
        return False
    if any(not os.environ.get(key) for key in spec.get("required_env", [])):
        return False
    executable = str(spec["command"][0]).format_map({"python": sys.executable, "adapter_dir": str(Path(__file__).parent.resolve() / "adapters")})
    if not (Path(executable).is_file() or shutil.which(executable)) or (spec.get("cwd") and not Path(spec["cwd"]).is_dir()):
        return False
    return all(Path(path).exists() for path in spec.get("required_paths", []))


def capabilities():
    ffmpeg = Path(FFMPEG).exists()
    model_path = os.environ.get("WHISPER_MODEL", "")
    whisper = bool(importlib.util.find_spec("faster_whisper") and model_path and Path(model_path, "model.bin").is_file())
    return [
        {"name": "frames", "available": ffmpeg, "reason": "需要 FFmpeg"},
        {"name": "compose", "available": ffmpeg, "reason": "需要 FFmpeg"},
        {"name": "cut", "available": ffmpeg and whisper, "reason": "需要配置 Whisper 转写模型"},
        {"name": "transcribe", "available": ffmpeg and whisper, "reason": "需要安装 faster-whisper 并配置 WHISPER_MODEL"},
        {"name": "upscale", "available": ffmpeg and engine_ready("realesrgan"), "reason": "需要配置 Real-ESRGAN 引擎及权重"},
        {"name": "subtitle-remove", "available": ffmpeg and engine_ready("lama"), "reason": "需要配置已获得相应使用许可的修复引擎及权重"},
        {"name": "digital-human", "available": ffmpeg and engine_ready("musetalk"), "reason": "需要配置 MuseTalk 引擎及权重"},
        {"name": "replace-person", "available": engine_ready("wan-animate"), "reason": "需要配置 Wan-Animate 引擎及权重"},
        {"name": "replace-product", "available": engine_ready("vace"), "reason": "需要配置 VACE 视频编辑引擎及权重"},
        {"name": "voice-clone", "available": bool(os.environ.get("COSYVOICE_URL") and os.environ.get("COSYVOICE_SAMPLE_RATE")), "reason": "需要部署 CosyVoice HTTP 服务并配置实际输出采样率"},
        {"name": "ocr", "available": bool(importlib.util.find_spec("paddleocr")), "reason": "需要部署 PaddleOCR"},
    ]


@app.get("/health")
async def health():
    return {"capabilities": capabilities()}


def media_path(identifier: str):
    if Path(identifier).name != identifier or identifier.startswith("."):
        raise HTTPException(400, "素材标识不正确")
    path = (MEDIA / identifier).resolve()
    if path.parent != MEDIA or not path.is_file() or path.suffix == ".json":
        raise HTTPException(404, "素材不存在，请重新上传")
    return path


@app.post("/media")
async def upload(file: UploadFile = File(...), metadata: str = Form("{}")):
    mime = file.content_type or ""
    if not mime.startswith(("image/", "video/", "audio/")):
        raise HTTPException(400, "仅支持图片、视频或音频素材")
    suffix = Path(file.filename or "").suffix.lower()
    if not suffix or not suffix[1:].isalnum():
        suffix = mimetypes.guess_extension(mime) or ".bin"
    identifier = f"{uuid.uuid4().hex}{suffix}"
    path = MEDIA / identifier
    try:
        details = json.loads(metadata)
        if not isinstance(details, dict):
            raise ValueError()
        with path.open("wb") as destination:
            await asyncio.to_thread(shutil.copyfileobj, file.file, destination)
        if path.stat().st_size == 0:
            raise ValueError("上传的文件为空")
        atomic_json(path.with_suffix(path.suffix + ".json"), {"mime": mime, **details})
        return {"id": identifier}
    except (ValueError, json.JSONDecodeError) as error:
        path.unlink(missing_ok=True)
        raise HTTPException(400, str(error) or "素材元信息不正确") from error
    finally:
        await file.close()


@app.get("/media/{identifier}")
async def download(identifier: str):
    path = media_path(identifier)
    return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0])


def job_path(identifier: str):
    try:
        uuid.UUID(identifier)
    except ValueError as error:
        raise HTTPException(400, "任务标识不正确") from error
    return JOBS / f"{identifier}.json"


def read_job(identifier: str):
    path = job_path(identifier)
    if not path.exists():
        raise HTTPException(404, "任务不存在")
    return json.loads(path.read_text(encoding="utf-8"))


def update_job(identifier: str, **patch):
    data = read_job(identifier)
    data.update(patch)
    atomic_json(job_path(identifier), data)
    return data


@app.on_event("startup")
async def recover():
    for path in JOBS.glob("*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data["status"] == "running":
            data.update(status="failed", error="处理服务已重启，本次处理未完成，请重试该步骤")
            atomic_json(path, data)


def validate_options(request: JobRequest):
    try:
        for key in ("scale", "fps", "count", "subtitleSize"):
            value = request.options.get(key)
            if value is not None and (not math.isfinite(float(value)) or float(value) <= 0):
                raise ValueError(f"{key} 必须是有限正数")
        validate_regions(request.options.get("regions", []))
        if request.operation == "replace" and request.options.get("replacement") not in ("person", "product", "background"):
            raise ValueError("请选择人物、商品或背景替换")
        if request.operation == "replace" and request.options.get("replacement") != "person" and not request.options.get("regions") and "mask" not in request.inputs:
            raise ValueError("VACE 编辑需要框选改动区域")
        if request.operation == "replace" and request.options.get("replacement") == "person" and "background" in request.inputs:
            raise ValueError("人物专用引擎仅处理人物替换；同时替换背景请使用支持该编辑的模型 API")
        if request.operation == "voice-clone" and not request.options.get("text", "").strip():
            raise ValueError("口播文案不能为空")
    except (TypeError, KeyError, ValueError) as error:
        raise HTTPException(422, str(error)) from error


@app.post("/jobs")
async def create_job(request: JobRequest):
    available = {item["name"]: item for item in capabilities()}
    capability = "replace-person" if request.operation == "replace" and request.options.get("replacement") == "person" else "replace-product" if request.operation == "replace" else request.operation
    if capability not in available or not available[capability]["available"]:
        raise HTTPException(422, available.get(capability, {}).get("reason", "不支持该处理操作"))
    validate_options(request)
    if request.operation == "subtitle-remove" and not request.options.get("regions") and not available["ocr"]["available"]:
        raise HTTPException(422, "自动检测需要 PaddleOCR，或请先在视频上框选字幕区域")
    for value in request.inputs.values():
        for identifier in value if isinstance(value, list) else [value]:
            media_path(identifier)
    identifier = str(uuid.uuid4())
    data = {"id": identifier, "status": "running", "step": "准备素材", "request": request.model_dump()}
    atomic_json(job_path(identifier), data)
    TASKS[identifier] = asyncio.create_task(run_job(identifier, request))
    return data


@app.get("/jobs/{identifier}")
async def get_job(identifier: str):
    data = read_job(identifier)
    return {key: value for key, value in data.items() if key != "request"}


@app.post("/jobs/{identifier}/cancel")
async def cancel_job(identifier: str):
    data = read_job(identifier)
    if data["status"] == "running":
        task = TASKS.get(identifier)
        if task:
            task.cancel()
        return update_job(identifier, status="cancelled", step="已取消", error="任务已取消")
    return data


async def command(identifier: str, arguments: list[str], cwd: str | None = None):
    process = await asyncio.create_subprocess_exec(*arguments, cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **({"start_new_session": True} if sys.platform != "win32" else {}))
    PROCESSES[identifier] = process
    try:
        stdout, stderr = await process.communicate()
        if process.returncode:
            raise RuntimeError((stderr or stdout).decode("utf-8", errors="replace")[-4000:] or f"处理引擎进程异常退出（{process.returncode}），请检查运行库、显卡环境与引擎日志")
        return stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
    except asyncio.CancelledError:
        if process.returncode is None:
            if sys.platform == "win32":
                killer = await asyncio.create_subprocess_exec("taskkill", "/PID", str(process.pid), "/T", "/F", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await killer.wait()
                if process.returncode is None:
                    process.kill()
            else:
                try:
                    os.killpg(process.pid, process_signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await process.wait()
        raise
    finally:
        PROCESSES.pop(identifier, None)


async def ffmpeg(identifier: str, *arguments):
    return await command(identifier, [FFMPEG, "-y", "-nostdin", *map(str, arguments)])


def publish(path: Path):
    identifier = f"{uuid.uuid4().hex}{path.suffix}"
    shutil.copyfile(path, MEDIA / identifier)
    return identifier


def metadata(path: Path):
    reader = imageio_ffmpeg.read_frames(str(path))
    try:
        return next(reader)
    finally:
        reader.close()


async def transcribe(identifier: str, video: Path, work: Path):
    audio = work / "transcription.wav"
    output = work / "transcription.json"
    try:
        await ffmpeg(identifier, "-hide_banner", "-loglevel", "error", "-i", video, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", audio)
    except RuntimeError as error:
        print(str(error), file=sys.stderr, flush=True)
        if "matches no streams" in str(error):
            raise ValueError("参考视频没有音轨，无法识别口播原文。请上传带清晰人声的视频，或在参考原文框中手动粘贴文案。") from error
        raise RuntimeError("无法读取视频音频，请确认视频含有可正常播放的声音后重试。") from error
    update_job(identifier, step="识别语音与时间轴")
    try:
        await command(identifier, [sys.executable, str(Path(__file__).parent / "adapters" / "transcribe.py"),
            "--input", str(audio), "--output", str(output), "--model", os.environ["WHISPER_MODEL"],
            "--device", os.environ.get("WHISPER_DEVICE", "cpu"), "--compute", os.environ.get("WHISPER_COMPUTE_TYPE", "int8")])
    except RuntimeError as error:
        if "mkl_malloc: failed to allocate memory" not in str(error):
            raise
        print(str(error), file=sys.stderr, flush=True)
        raise RuntimeError("语音识别模型加载失败：处理服务所在电脑可用内存不足。请关闭不用的程序后重试；若仍失败，请检查系统虚拟内存。") from error
    return json.loads(output.read_text(encoding="utf-8"))


def ass_time(seconds):
    total = round(float(seconds) * 100)
    return f"{total // 360000}:{total // 6000 % 60:02}:{total // 100 % 60:02}.{total % 100:02}"


def ass_color(value):
    value = str(value).lstrip("#")
    if len(value) != 6 or any(char not in "0123456789abcdefABCDEF" for char in value):
        raise ValueError("字幕颜色不正确")
    return f"&H00{value[4:6]}{value[2:4]}{value[:2]}"


def write_subtitles(path: Path, segments: list[dict], options: dict, size: tuple):
    color = ass_color(options.get("subtitleColor", "#ffffff"))
    highlight = ass_color(options.get("highlightColor", "#ffe066"))
    fontsize = float(options.get("subtitleSize", 42))
    if fontsize <= 0:
        raise ValueError("字幕字号必须大于零")
    font = os.environ.get("SUBTITLE_FONT", "Microsoft YaHei" if sys.platform == "win32" else "Noto Sans CJK SC")
    header = f"[Script Info]\nScriptType: v4.00+\nPlayResX: {size[0]}\nPlayResY: {size[1]}\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,{font},{fontsize},{color},{color},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,30,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n"
    lines = []
    keywords = [word.strip() for word in str(options.get("keywords", "")).replace("，", ",").replace("\n", ",").split(",") if word.strip()]
    for segment in segments:
        start, end = float(segment["start"]), float(segment["end"])
        if start < 0 or end <= start:
            raise ValueError("字幕开始、结束时间不正确")
        text = str(segment["text"]).replace("{", "（").replace("}", "）").replace("\\", "＼").replace("\n", "\\N")
        for keyword in keywords:
            if "{" not in keyword and "}" not in keyword and "\\" not in keyword:
                text = text.replace(keyword, "{\\c" + highlight + "}" + keyword + "{\\c" + color + "}")
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{text}")
    path.write_text(header + "\n".join(lines), encoding="utf-8-sig")


async def run_engine(identifier: str, name: str, bindings: dict, work: Path):
    spec = load_engines()[name]
    bindings = {**bindings, "output": str(work / "output.mp4"), "output_dir": str(work / "engine-output"), "python": sys.executable, "ffmpeg": FFMPEG, "ffmpeg_dir": str(Path(FFMPEG).parent), "background": bindings.get("background", "")}
    Path(bindings["output_dir"]).mkdir(exist_ok=True)
    bindings["adapter_dir"] = str(Path(__file__).parent.resolve() / "adapters")
    if name == "musetalk":
        binary_dir = work / "ffmpeg-bin"
        binary_dir.mkdir(exist_ok=True)
        shutil.copyfile(FFMPEG, binary_dir / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"))
        if sys.platform != "win32":
            (binary_dir / "ffmpeg").chmod(0o755)
        bindings["ffmpeg_dir"] = str(binary_dir)
    config = work / "inference.yaml"
    config.write_text(yaml.safe_dump({"task_0": {"video_path": bindings.get("avatar", ""), "audio_path": bindings.get("audio", ""), "bbox_shift": 0, "result_name": str(work / "output.mp4")}}), encoding="utf-8")
    bindings["config"] = str(config)
    arguments = [str(argument).format_map(bindings) for argument in spec["command"]]
    update_job(identifier, step=f"运行 {name} 引擎")
    try:
        await command(identifier, arguments, spec.get("cwd"))
    except asyncio.CancelledError:
        remote = work / "remote-job.json"
        if remote.is_file():
            details = json.loads(remote.read_text(encoding="utf-8"))
            if details.get("url") == os.environ.get("GPU_WORKER_URL", "").rstrip("/"):
                headers = {"X-Canvas-Worker": "1"}
                if os.environ.get("GPU_WORKER_TOKEN"):
                    headers["Authorization"] = "Bearer " + os.environ["GPU_WORKER_TOKEN"]
                try:
                    async with httpx.AsyncClient(timeout=None) as client:
                        response = await client.post(details["url"] + "/jobs/" + details["id"] + "/cancel", headers=headers)
                        response.raise_for_status()
                except Exception as error:
                    update_job(identifier, status="cancelled", step="本机已取消", error=f"本机进程已取消，远程任务取消未确认：{error}")
        raise
    if name in ("lama", "realesrgan"):
        files = sorted(Path(bindings["output_dir"]).rglob(spec.get("output_glob", "*.png")))
        if not files:
            raise RuntimeError("处理引擎未输出帧图像")
        return files
    candidates = [Path(bindings["output"]), *sorted(Path(bindings["output_dir"]).rglob("*.mp4"))]
    result = next((path for path in candidates if path.is_file() and path.stat().st_size), None)
    if result is None:
        raise RuntimeError("处理引擎没有输出视频，请检查引擎命令与输出目录")
    return result


def validate_regions(regions):
    for region in regions:
        values = [float(region[key]) for key in ("x", "y", "width", "height")]
        x, y, width, height = values
        if not all(math.isfinite(value) for value in values) or min(values) < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
            raise ValueError("字幕区域必须位于视频画面内")


async def repair_frames(identifier, source, work, options):
    info = await asyncio.to_thread(metadata, source)
    frames = work / "input-frames"
    frames.mkdir()
    await ffmpeg(identifier, "-i", source, "-fps_mode", "passthrough", frames / "%08d.png")
    images = sorted(frames.glob("*.png"))
    regions = options.get("regions", [])
    validate_regions(regions)
    ocr = None
    if not regions:
        from paddleocr import PaddleOCR
        ocr = await asyncio.to_thread(PaddleOCR, use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
    for image_path in images:
        with Image.open(image_path) as image:
            mask = Image.new("L", image.size)
            painter = ImageDraw.Draw(mask)
            if regions:
                for region in regions:
                    painter.rectangle((region["x"] * image.width, region["y"] * image.height, (region["x"] + region["width"]) * image.width, (region["y"] + region["height"]) * image.height), fill=255)
            else:
                predictions = await asyncio.to_thread(lambda: list(ocr.predict(str(image_path))))
                for prediction in predictions:
                    for polygon in prediction["rec_polys"]:
                        painter.polygon([(float(point[0]), float(point[1])) for point in polygon], fill=255)
            mask.save(frames / f"{image_path.stem}_mask.png")
        await asyncio.sleep(0)
    repaired = await run_engine(identifier, "lama", {"frames": str(frames), "input": str(source)}, work)
    if len(repaired) != len(images):
        raise RuntimeError("修复帧数量与原视频不一致，已停止导出")
    return await assemble_frames(identifier, repaired, source, work, info["fps"])


async def assemble_frames(identifier, frames, source, work, fps):
    sequence = work / "render-frames"
    sequence.mkdir(exist_ok=True)
    for index, frame in enumerate(frames):
        shutil.copyfile(frame, sequence / f"{index:08d}.png")
    output = work / "result.mp4"
    await ffmpeg(identifier, "-framerate", fps, "-i", sequence / "%08d.png", "-i", source, "-map", "0:v:0", "-map", "1:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", output)
    return output


async def run_job(identifier: str, request: JobRequest):
    work = JOBS / identifier
    work.mkdir(exist_ok=True)
    options = request.options
    try:
        inputs = {key: [media_path(item) for item in value] if isinstance(value, list) else media_path(value) for key, value in request.inputs.items()}
        operation = request.operation
        result = {}
        if operation == "frames":
            source = inputs["video"]
            info = await asyncio.to_thread(metadata, source)
            if not info.get("duration"):
                raise ValueError("无法读取参考视频时长")
            count = int(options["count"])
            if count <= 0:
                raise ValueError("抽帧数量必须大于零")
            files = []
            for index in range(count):
                output = work / f"frame-{index}.jpg"
                await ffmpeg(identifier, "-ss", info["duration"] * index / count, "-i", source, "-frames:v", "1", output)
                files.append(publish(output))
            result = {"files": files, "metadata": {"duration": info["duration"], "fps": info["fps"]}}
        elif operation == "transcribe":
            segments = await transcribe(identifier, inputs["video"], work)
            result = {"segments": segments, "text": "\n".join(segment["text"] for segment in segments)}
        elif operation == "voice-clone":
            sample = work / "voice-sample.wav"
            await ffmpeg(identifier, "-i", inputs["voice"], "-vn", "-ac", "1", "-ar", "16000", sample)
            with sample.open("rb") as voice:
                async with httpx.AsyncClient(timeout=None) as client:
                    response = await client.post(os.environ["COSYVOICE_URL"].rstrip("/") + "/inference_zero_shot", data={"tts_text": options["text"], "prompt_text": options["promptText"]}, files={"prompt_wav": (sample.name, voice, "audio/wav")})
            response.raise_for_status()
            audio = work / "speech.wav"
            if response.content.startswith(b"RIFF"):
                audio.write_bytes(response.content)
            else:
                rate = int(os.environ["COSYVOICE_SAMPLE_RATE"])
                if rate <= 0 or not response.content or len(response.content) % 2:
                    raise ValueError("CosyVoice PCM 响应或输出采样率不正确")
                with wave.open(str(audio), "wb") as destination:
                    destination.setnchannels(1)
                    destination.setsampwidth(2)
                    destination.setframerate(rate)
                    destination.writeframes(response.content)
            result = {"file": publish(audio)}
        elif operation == "digital-human":
            video = await run_engine(identifier, "musetalk", {key: str(value) for key, value in inputs.items()}, work)
            result = {"file": publish(video)}
        elif operation == "replace":
            engine = "wan-animate" if options["replacement"] == "person" else "vace"
            bindings = {**{key: str(value) for key, value in inputs.items()}, "prompt": str(options.get("prompt", "")), "replacement": options["replacement"], "mask": ""}
            if engine == "vace":
                info = await asyncio.to_thread(metadata, inputs["video"])
                duration = float(info["duration"])
                bindings["frame_count"] = str(math.ceil(duration * 16 / 4) * 4 + 1)
                normalized = work / "edit-source.mp4"
                await ffmpeg(identifier, "-i", inputs["video"], "-r", "16", "-an", "-c:v", "libx264", normalized)
                bindings["video"] = str(normalized)
                if "mask" in inputs:
                    await ffmpeg(identifier, "-i", inputs["mask"], "-vf", f"scale={info['size'][0]}:{info['size'][1]}:flags=neighbor", "-r", "16", "-an", "-t", duration, "-c:v", "libx264", "-pix_fmt", "yuv420p", work / "edit-mask.mp4")
                else:
                    mask = Image.new("L", info["size"])
                    painter = ImageDraw.Draw(mask)
                    for region in options["regions"]:
                        painter.rectangle((region["x"] * mask.width, region["y"] * mask.height, (region["x"] + region["width"]) * mask.width, (region["y"] + region["height"]) * mask.height), fill=255)
                    mask.save(work / "edit-mask.png")
                    await ffmpeg(identifier, "-loop", "1", "-i", work / "edit-mask.png", "-t", duration, "-r", "16", "-c:v", "libx264", "-pix_fmt", "yuv420p", work / "edit-mask.mp4")
                bindings["mask"] = str(work / "edit-mask.mp4")
            video = await run_engine(identifier, engine, bindings, work)
            output = work / "with-audio.mp4"
            await ffmpeg(identifier, "-i", video, "-i", inputs["video"], "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", output)
            result = {"file": publish(output)}
        elif operation == "subtitle-remove":
            video = await repair_frames(identifier, inputs["video"], work, options)
            result = {"file": publish(video)}
        elif operation == "upscale":
            source = inputs["video"]
            info = await asyncio.to_thread(metadata, source)
            frames = work / "input-frames"
            frames.mkdir()
            await ffmpeg(identifier, "-i", source, "-fps_mode", "passthrough", frames / "%08d.png")
            enhanced = await run_engine(identifier, "realesrgan", {"frames": str(frames), "input": str(source), "scale": str(options["scale"])}, work)
            if len(enhanced) != len(list(frames.glob("*.png"))):
                raise RuntimeError("增强帧数量与原视频不一致")
            video = await assemble_frames(identifier, enhanced, source, work, info["fps"])
            if options.get("fps"):
                interpolated = work / "interpolated.mp4"
                await ffmpeg(identifier, "-i", video, "-vf", f"minterpolate=fps={float(options['fps'])}", "-c:v", "libx264", "-c:a", "copy", interpolated)
                video = interpolated
            result = {"file": publish(video)}
        elif operation == "cut":
            source = inputs["video"]
            segments = await transcribe(identifier, source, work)
            if not segments:
                raise ValueError("没有识别到人声，无法自动剪气口")
            parts = []
            for index, segment in enumerate(segments):
                clip = work / f"part-{index}.mp4"
                await ffmpeg(identifier, "-ss", segment["start"], "-i", source, "-t", segment["end"] - segment["start"], "-c:v", "libx264", "-c:a", "aac", clip)
                parts.append(clip)
            listing = work / "concat.txt"
            listing.write_text("\n".join(f"file '{path.name}'" for path in parts), encoding="utf-8")
            output = work / "cut.mp4"
            await ffmpeg(identifier, "-f", "concat", "-safe", "1", "-i", listing, "-c", "copy", output)
            result = {"file": publish(output)}
        elif operation == "compose":
            source = inputs["video"]
            arguments = ["-i", source]
            if "music" in inputs:
                arguments.extend(["-stream_loop", "-1", "-i", inputs["music"]])
            if options.get("subtitles"):
                info = await asyncio.to_thread(metadata, source)
                subtitle = work / "captions.ass"
                write_subtitles(subtitle, options["subtitles"], options, info["size"])
                escaped = str(subtitle).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
                arguments.extend(["-vf", f"ass='{escaped}'"])
            if "music" in inputs:
                volume = float(options.get("musicVolume", 0.3))
                if not 0 <= volume <= 1:
                    raise ValueError("背景音乐音量须为 0 至 1")
                _, diagnostic = await ffmpeg(identifier, "-i", source, "-t", "0", "-f", "null", "-")
                if "Audio:" in diagnostic:
                    arguments.extend(["-filter_complex", f"[1:a]volume={volume}[bg];[0:a][bg]amix=inputs=2:duration=first[a]", "-map", "0:v:0", "-map", "[a]"])
                else:
                    arguments.extend(["-af", f"volume={volume}", "-map", "0:v:0", "-map", "1:a:0", "-shortest"])
            output = work / "final.mp4"
            await ffmpeg(identifier, *arguments, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", output)
            result = {"file": publish(output)}
        if read_job(identifier)["status"] != "cancelled":
            update_job(identifier, status="completed", step="已完成", result=result)
    except asyncio.CancelledError:
        if read_job(identifier)["status"] != "cancelled":
            update_job(identifier, status="cancelled", step="已取消", error="任务已取消")
    except Exception as error:
        if read_job(identifier)["status"] != "cancelled":
            update_job(identifier, status="failed", step="处理失败", error=str(error))
    finally:
        TASKS.pop(identifier, None)
