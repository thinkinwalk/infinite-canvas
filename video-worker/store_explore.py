"""Store video finishing with separate narration and verified media timelines."""
import json
import math
from replacement import validate_timeline
from subtitle_matching import validate_segments


async def audio_info(identifier, source, command, ffprobe):
    raw, _ = await command(identifier, [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)])
    data = json.loads(raw)
    stream = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    if not stream:
        raise ValueError("所选文件没有音轨")
    duration = float(stream.get("duration") or data.get("format", {}).get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("无法读取实际音频时长")
    return duration


def validate_options(inputs, options):
    if not isinstance(inputs.get("video"), str):
        raise ValueError("请提供原视频")
    if options.get("audioMode", "source") not in ("source", "narration", "mute"):
        raise ValueError("声音模式不正确")
    if options.get("audioMode") == "narration" and not isinstance(inputs.get("narration"), str):
        raise ValueError("请先生成旁白")
    volume = float(options.get("musicVolume", 0.3))
    if not math.isfinite(volume) or not 0 <= volume <= 1:
        raise ValueError("音乐音量须为 0 至 1")
    validate_segments(options.get("subtitles", []))


def validate_captions(segments, duration):
    end = 0
    for segment in segments:
        start, next_end = float(segment["start"]), float(segment["end"])
        if not all(math.isfinite(v) for v in (start, next_end)) or start < end or next_end <= start or next_end > duration or not str(segment["text"]).strip():
            raise ValueError("字幕时间须连续有序、不重叠且不超出原视频")
        end = next_end


async def compose(identifier, inputs, options, work, *, command, ffprobe, ffmpeg, probe_video, write_subtitles, publish):
    info = await probe_video(identifier, inputs["video"])
    duration = info["duration"]
    validate_captions(options.get("subtitles", []), duration)
    mode = options.get("audioMode", "source")
    args = ["-i", inputs["video"]]
    tracks, filters = [], []
    next_input = 1
    if mode == "narration":
        voice_duration = await audio_info(identifier, inputs["narration"], command, ffprobe)
        if voice_duration > duration:
            raise ValueError(f"旁白实际 {voice_duration:.2f} 秒，超过视频 {duration:.2f} 秒；请缩短文案重新配音，不会截断末句")
        args += ["-i", inputs["narration"]]
        filters.append(f"[{next_input}:a:0]apad,atrim=duration={duration},asetpts=PTS-STARTPTS[voice]")
        tracks.append("[voice]")
        next_input += 1
    elif mode == "source" and info["audio"]:
        filters.append(f"[0:a:0]apad,atrim=duration={duration},asetpts=PTS-STARTPTS[voice]")
        tracks.append("[voice]")
    if "music" in inputs:
        await audio_info(identifier, inputs["music"], command, ffprobe)
        args += ["-stream_loop", "-1", "-i", inputs["music"]]
        filters.append(f"[{next_input}:a:0]volume={float(options.get('musicVolume', 0.3))},atrim=duration={duration},asetpts=PTS-STARTPTS[music]")
        tracks.append("[music]")
    if tracks:
        filters.append(f"{''.join(tracks)}amix=inputs={len(tracks)}:duration=longest:normalize=0,alimiter=level=false[audio]")
        args += ["-filter_complex", ";".join(filters)]
    args += ["-map", "0:v:0"]
    args += ["-map", "[audio]"] if tracks else ["-an"]
    if options.get("subtitles"):
        captions = work / "store-captions.ass"
        write_subtitles(captions, options["subtitles"], options, info["size"])
        escaped = str(captions).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        args += ["-vf", f"ass='{escaped}'"]
    output = work / "store-final.mp4"
    await ffmpeg(identifier, *args, "-t", duration, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", output)
    final = await probe_video(identifier, output)
    validate_timeline(info, final)
    if bool(final["audio"]) != bool(tracks):
        raise ValueError("成片音轨校验失败，原视频已保留")
    return {"file": publish(output), "metadata": {"duration": final["duration"], "audio": final["audio"], "size": final["size"]}}
