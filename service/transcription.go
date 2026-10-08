package service

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
)

// Extract speech input without loading a recognition model on the website server.
func PrepareTranscriptionAudio(ctx context.Context, source, target string) error {
	binary := os.Getenv("FFMPEG_PATH")
	if binary == "" {
		binary = "ffmpeg"
	}
	output, err := exec.CommandContext(ctx, binary, "-hide_banner", "-loglevel", "error", "-i", source, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", target).CombinedOutput()
	if err == nil {
		return nil
	}
	log.Printf("transcription audio preparation: %v: %s", err, output)
	if strings.Contains(string(output), "matches no streams") {
		return fmt.Errorf("参考视频没有音轨，无法识别口播原文。请上传带清晰人声的视频，或手动粘贴文案")
	}
	if _, ok := err.(*exec.Error); ok {
		return fmt.Errorf("服务器尚未安装 FFmpeg，无法准备识别音频")
	}
	return fmt.Errorf("无法读取素材音频，请确认素材含有可正常播放的人声")
}
