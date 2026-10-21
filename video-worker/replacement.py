"""Timeline-preserving replacement operations. No model calls or credentials here."""
import json
import math
import re
from pathlib import Path


def plan_segments(duration, seconds, cuts=(), overlap=0.5, preserve_scenes=True):
    if not all(math.isfinite(v) for v in (duration, seconds, overlap)) or duration <= 0 or seconds <= overlap or overlap < 0:
        raise ValueError("视频时长或分段规格不正确")
    boundaries = [0.0, *sorted(set(float(t) for t in cuts if 0 < float(t) < duration)), duration]
    if not preserve_scenes:
        # Pack consecutive detected scenes up to the existing input limit.
        # Keep hard cuts when a group overflows; long continuous shots still overlap.
        grouped = [0.0]
        for start, end in zip(boundaries, boundaries[1:]):
            if end - grouped[-1] > seconds:
                if start > grouped[-1]:
                    grouped.append(start)
                if end - start > seconds:
                    grouped.append(end)
        if grouped[-1] != duration:
            grouped.append(duration)
        boundaries = grouped
    parts = []
    for scene_start, scene_end in zip(boundaries, boundaries[1:]):
        start = scene_start
        while start < scene_end:
            left = min(overlap / 2, start - scene_start)
            remaining = scene_end - start
            end = scene_end if remaining + left <= seconds else start + seconds - left - overlap / 2
            right = min(overlap / 2, scene_end - end)
            parts.append({"start": start, "end": end, "inputStart": start - left,
                          "inputEnd": end + right, "trimStart": left, "seconds": seconds})
            start = end
    return parts


def validate_duration(source, generated):
    for info in (source, generated):
        if not math.isfinite(info["duration"]) or info["duration"] <= 0 or not math.isfinite(info["fps"]) or info["fps"] <= 0:
            raise ValueError("无法读取视频画面时间轴，已停止合成")
    # Only frame quantization is tolerated; never stretch or truncate an edit.
    if abs(source["duration"] - generated["duration"]) > max(1 / source["fps"], 1 / generated["fps"]):
        raise ValueError("生成视频时长与输入不一致，已保留结果并停止合成；不会强行变速或截断")


def validate_timeline(source, generated):
    validate_duration(source, generated)
    sw, sh = source["size"]
    gw, gh = generated["size"]
    if sw * gh != sh * gw:
        raise ValueError("生成视频画幅比例发生变化，已停止合成")


def validate_generated_timeline(source, generated):
    """Audio/caption processing keeps the model canvas; reject orientation changes."""
    validate_duration(source, generated)
    sw, sh = source["size"]
    gw, gh = generated["size"]
    if min(sw, sh, gw, gh) <= 0:
        raise ValueError("无法读取视频画幅尺寸，已停止合成")
    if (sw > sh) != (gw > gh) or (sw == sh) != (gw == gh):
        raise ValueError("生成视频横竖画幅方向发生变化，已保留结果并停止合成")


def validate_masked_generation(source, generated, max_aspect=0.03, max_seconds=0.25):
    """Masked composites only keep the person area, so a model's fixed output
    size and a few padded/dropped frames are tolerated; anything larger stops."""
    for info in (source, generated):
        if not math.isfinite(info["duration"]) or info["duration"] <= 0 or not math.isfinite(info["fps"]) or info["fps"] <= 0:
            raise ValueError("无法读取视频画面时间轴，已停止合成")
    if abs(source["duration"] - generated["duration"]) > max_seconds:
        raise ValueError("生成视频时长与原视频相差过大，已保留结果并停止合成；不会强行变速或截断")
    (sw, sh), (gw, gh) = source["size"], generated["size"]
    if (sw > sh) != (gw > gh) or abs(sw / sh - gw / gh) / (sw / sh) > max_aspect:
        raise ValueError("生成视频画幅比例与原视频相差过大，已停止合成")


def fit_frame_count(frames, count, max_extra):
    """Drop model tail padding or repeat the last frame so every source frame has a match."""
    frames = list(frames)
    if not frames or abs(len(frames) - count) > max_extra:
        raise ValueError("原画面与生成画面帧数相差过大，已停止合成")
    return frames[:count] + [frames[-1]] * (count - len(frames))


async def probe(identifier, path, command, ffprobe):
    raw, _ = await command(identifier, [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)])
    data = json.loads(raw)
    stream = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    if not stream:
        raise ValueError("文件没有视频画面")
    numerator, denominator = map(float, stream["avg_frame_rate"].split("/"))
    duration = stream.get("duration")
    if duration is None and stream.get("duration_ts") is not None:
        a, b = map(float, stream["time_base"].split("/"))
        duration = float(stream["duration_ts"]) * a / b
    # Container duration can include a longer audio track and is not a video duration.
    if duration is None:
        raise ValueError("无法确定视频轨道时长，已停止处理")
    return {"duration": float(duration), "fps": numerator / denominator if denominator else 0,
            "size": (int(stream["width"]), int(stream["height"])),
            "audio": any(s["codec_type"] == "audio" for s in data["streams"])}


async def process(operation, identifier, inputs, options, work, *, ffmpeg, probe_video, publish):
    source = inputs["video"]
    if operation == "replacement-plan":
        info = await probe_video(identifier, source)
        seconds = float(options["seconds"])
        # FFmpeg's scdet detector uses its documented default threshold.
        _, log = await ffmpeg(identifier, "-i", source, "-an", "-vf", "scdet,metadata=print", "-f", "null", "-")
        cuts = [float(t) for t in re.findall(r"lavfi\.scd\.time=([0-9.]+)", log)]
        preserve_scenes = options.get("preserveScenes", True)
        parts = plan_segments(info["duration"], seconds, cuts, preserve_scenes=preserve_scenes)
        return {"metadata": {**info, "parts": parts, "overlap": 0.5, "preserveScenes": preserve_scenes, "identityChecked": False}}
    if operation == "replacement-extract":
        info = await probe_video(identifier, source)
        start, end, seconds = (float(options[k]) for k in ("inputStart", "inputEnd", "seconds"))
        if not all(math.isfinite(v) for v in (start, end, seconds)) or start < 0 or end <= start or end > info["duration"] or seconds < end - start:
            raise ValueError("分段范围不正确")
        output = work / "input.mp4"
        # Snap the sampling rate to an integer frame count for the selected
        # duration (29.97 fps at 10 s would otherwise become 10.01 s and be
        # billed as 11 seconds). This samples frames without changing speed.
        frame_count = max(1, round(seconds * info["fps"]))
        input_fps = frame_count / seconds
        # Pad only the input tail when the API requires a fixed output duration.
        # That padding is explicitly excluded by the final assembly manifest.
        clipped = work / "clipped.mp4"
        # Materialize the cut first: trim -> tpad in one filter graph does not
        # consistently propagate EOF/padding in supported FFmpeg builds.
        await ffmpeg(identifier, "-ss", start, "-i", source, "-t", end - start,
                     "-map", "0:v:0", "-map", "0:a?", "-r", input_fps, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clipped)
        await ffmpeg(identifier, "-i", clipped, "-vf", f"tpad=stop_mode=clone:stop_duration={seconds}", "-af", "apad",
                     "-t", seconds, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                     "-r", input_fps, "-frames:v", frame_count, "-c:a", "aac", "-movflags", "+faststart", output)
        return {"file": publish(output)}
    if operation == "replacement-validate":
        original = await probe_video(identifier, inputs["source"])
        generated = await probe_video(identifier, source)
        validate_generated_timeline(original, generated)
        return {"metadata": {"timelineChecked": True, "identityChecked": False}}
    if operation == "replacement-assemble":
        info = await probe_video(identifier, source)
        parts, videos = options["parts"], inputs["parts"]
        if not parts or len(parts) != len(videos):
            raise ValueError("分段结果不完整")
        cursor = 0.0
        files = []
        for index, (part, video) in enumerate(zip(parts, videos)):
            if part["start"] != cursor or part["end"] <= cursor:
                raise ValueError("分段时间轴有缺口或重复")
            cursor = part["end"]
            current = await probe_video(identifier, video)
            validate_generated_timeline({**info, "duration": float(part["seconds"])}, current)
            output = work / f"part-{index}.mp4"
            await ffmpeg(identifier, "-i", video, "-an", "-vf",
                         f"trim=start={part['trimStart']},setpts=PTS-STARTPTS,scale={info['size'][0]}:{info['size'][1]}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={info['size'][0]}:{info['size'][1]}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={info['fps']}",
                         "-frames:v", round(part["end"] * info["fps"]) - round(part["start"] * info["fps"]),
                         "-c:v", "libx264", "-pix_fmt", "yuv420p", output)
            files.append(output)
        if cursor != info["duration"]:
            raise ValueError("分段没有覆盖完整原片")
        listing = work / "concat.txt"
        listing.write_text("\n".join(f"file '{p.name}'" for p in files), encoding="utf-8")
        output = work / "assembled.mp4"
        await ffmpeg(identifier, "-f", "concat", "-safe", "1", "-i", listing, "-c", "copy", output)
        validate_timeline(info, await probe_video(identifier, output))
        return {"file": publish(output), "metadata": {"timelineChecked": True, "identityChecked": False}}
    raise ValueError("未知长视频操作")
