"""Content-aware plans preserve the source timeline and never invoke paid models."""
import bisect
import json
import math
import re
import sys
from pathlib import Path


def segment_limits(options):
    minimum, maximum, target = (float(options[key]) for key in ("minSeconds", "maxSeconds", "targetSeconds"))
    if not all(math.isfinite(value) for value in (minimum, maximum, target)) or not 1 <= minimum <= target <= maximum <= 30:
        raise ValueError("自动分段时长须满足 1 ≤ 最短 ≤ 目标 ≤ 最长 ≤ 30 秒")
    return minimum, maximum, target


def plan_segments(duration, minimum, maximum, target, cuts=(), pauses=()):
    minimum, maximum, target = segment_limits(dict(minSeconds=minimum, maxSeconds=maximum, targetSeconds=target))
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("无法读取视频时长")
    # Millisecond integers keep all shared boundaries identical after JSON round trips.
    total = math.floor(duration * 1000)
    low, high, wanted = math.ceil(minimum * 1000), math.floor(maximum * 1000), round(target * 1000)
    least, most = (total + high - 1) // high, total // low
    if least > most or most < 1:
        raise ValueError("原视频无法完整分成符合当前最短、最长时长的片段，请调整分段规格")
    count = min(most, max(least, (total + wanted - 1) // wanted))
    scenes = sorted({round(value * 1000) for value in cuts if math.isfinite(value) and 0 < value < duration})
    silence = sorted({round(value * 1000) for value in pauses if math.isfinite(value) and 0 < value < duration})
    parts, start = [], 0
    for index in range(count):
        remaining = count - index - 1
        if not remaining:
            end, boundary = total, "end"
        else:
            lower = max(start + low, total - remaining * high)
            upper = min(start + high, total - remaining * low)
            ideal = min(upper, max(lower, round(start + (total - start) / (remaining + 1))))
            candidates = [(0.35, ideal, "duration")]
            for values, kind, penalty in ((scenes, "scene", 0), (silence, "silence", 0.12)):
                left, right = bisect.bisect_left(values, lower), bisect.bisect_right(values, upper)
                middle = bisect.bisect_left(values, ideal, left, right)
                for position in (middle - 1, middle):
                    if left <= position < right:
                        value = values[position]
                        candidates.append((abs(value - ideal) / high + penalty, value, kind))
            _, end, boundary = min(candidates)
        parts.append({"start": start / 1000, "end": end / 1000, "boundary": boundary})
        start = end
    return parts


def silence_midpoints(log):
    starts = []
    pauses = []
    for match in re.finditer(r"silence_(start|end):\s*([0-9.]+)", log):
        kind, value = match.group(1), float(match.group(2))
        if kind == "start":
            starts.append(value)
        elif starts:
            pauses.append((starts.pop() + value) / 2)
    return pauses


async def analyze(identifier, source, options, *, command, ffmpeg, probe_video, update_job):
    minimum, maximum, target = segment_limits(options)
    info = await probe_video(identifier, source)
    # Reject impossible specifications before decoding the whole source.
    plan_segments(info["duration"], minimum, maximum, target)
    update_job(identifier, step="检测镜头切换")
    raw, _ = await command(identifier, [sys.executable, str(Path(__file__).parent / "adapters" / "detect_scenes.py"), str(source)])
    cuts = json.loads(raw)["cuts"]
    pauses = []
    if info["audio"]:
        update_job(identifier, step="检测音频停顿")
        _, log = await ffmpeg(identifier, "-threads", "1", "-i", source, "-vn",
                              "-af", "silencedetect", "-f", "null", "-")
        pauses = silence_midpoints(log)
    update_job(identifier, step="按时长约束规划片段")
    parts = plan_segments(info["duration"], minimum, maximum, target, cuts, pauses)
    return {"metadata": {"duration": math.floor(info["duration"] * 1000) / 1000,
                         "minSeconds": minimum, "maxSeconds": maximum, "targetSeconds": target,
                         "parts": parts, "sceneCount": len(cuts), "pauseCount": len(pauses)}}
