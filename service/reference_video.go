package service

import (
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
)

// Original videos and model-ready references have different storage budgets.
const OriginalVideoMaxBytes int64 = 300 << 20

func PrepareModelReferenceVideo(ctx context.Context, source, target string, maxBytes int64) error {
	duration := ProbeMediaDuration(ctx, source)
	if duration <= 0 {
		return fmt.Errorf("无法读取参考视频时长，请检查视频或 FFprobe 配置")
	}
	// Reserve space for the audio track and container; validate the actual output too.
	bitrate := math.Floor(float64(maxBytes)*8*0.9/duration) - 128000
	if bitrate <= 0 {
		return fmt.Errorf("参考视频过长，无法准备模型输入，请先选择需要的片段")
	}
	binary := os.Getenv("FFMPEG_PATH")
	if binary == "" {
		binary = "ffmpeg"
	}
	rate := strconv.FormatInt(int64(bitrate), 10)
	args := []string{"-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", source,
		"-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=w='min(iw,if(gte(iw,ih),1920,1080))':h='min(ih,if(gte(iw,ih),1080,1920))':force_original_aspect_ratio=decrease:force_divisible_by=2",
		"-c:v", "libx264", "-b:v", rate, "-maxrate", rate, "-bufsize", strconv.FormatInt(int64(bitrate)*2, 10),
		"-pix_fmt", "yuv420p", "-passlogfile", target + ".pass"}
	defer os.Remove(target + ".pass-0.log")
	defer os.Remove(target + ".pass-0.log.mbtree")
	first := append(append([]string{}, args...), "-pass", "1", "-an", "-f", "null", os.DevNull)
	second := append(append([]string{}, args...), "-pass", "2", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", target)
	if err := exec.CommandContext(ctx, binary, first...).Run(); err != nil {
		return fmt.Errorf("参考视频自动压缩失败，请检查 FFmpeg 或裁剪后重试，原视频已保留")
	}
	if err := exec.CommandContext(ctx, binary, second...).Run(); err != nil {
		return fmt.Errorf("参考视频自动压缩失败，请检查 FFmpeg 或裁剪后重试，原视频已保留")
	}
	info, err := os.Stat(target)
	if err != nil || info.Size() == 0 || info.Size() > maxBytes || ProbeMediaDuration(ctx, target) <= 0 {
		return fmt.Errorf("压缩后的参考视频仍不符合模型输入大小要求，请选择较短片段，原视频已保留")
	}
	return nil
}
