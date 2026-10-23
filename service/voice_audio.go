package service

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

type AudioInfo struct {
	MimeType  string
	Extension string
	Duration  float64
}

// Inspect the demuxer and streams, never the supplied filename or MIME header.
func InspectVoiceAudio(ctx context.Context, path string, reference bool) (AudioInfo, error) {
	binary := os.Getenv("FFPROBE_PATH")
	if binary == "" {
		binary = "ffprobe"
	}
	formatsAllowed := "wav,mp3"
	if !reference {
		formatsAllowed += ",flac,ogg,mov"
	}
	output, err := exec.CommandContext(ctx, binary, "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", formatsAllowed, "-count_frames", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,nb_read_frames", "-of", "json", path).Output()
	if err != nil {
		return AudioInfo{}, fmt.Errorf("无法读取真实音频，请检查文件及 FFprobe 配置")
	}
	var probe struct {
		Format struct {
			Name     string `json:"format_name"`
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			Type   string `json:"codec_type"`
			Codec  string `json:"codec_name"`
			Frames string `json:"nb_read_frames"`
		} `json:"streams"`
	}
	if json.Unmarshal(output, &probe) != nil {
		return AudioInfo{}, fmt.Errorf("音频检测结果无效")
	}
	audio := false
	for _, stream := range probe.Streams {
		if stream.Type == "video" {
			return AudioInfo{}, fmt.Errorf("参考文件不能包含视频或封面流")
		}
		frames, _ := strconv.ParseInt(stream.Frames, 10, 64)
		if stream.Type == "audio" && stream.Codec != "" && frames > 0 {
			audio = true
		}
	}
	duration, _ := strconv.ParseFloat(probe.Format.Duration, 64)
	if !audio || duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return AudioInfo{}, fmt.Errorf("文件没有有效音轨或时长")
	}
	formats := map[string]AudioInfo{
		"wav": {MimeType: "audio/wav", Extension: ".wav"},
		"mp3": {MimeType: "audio/mpeg", Extension: ".mp3"},
	}
	if !reference {
		formats["flac"] = AudioInfo{MimeType: "audio/flac", Extension: ".flac"}
		formats["ogg"] = AudioInfo{MimeType: "audio/ogg", Extension: ".ogg"}
		formats["mov,mp4,m4a,3gp,3g2,mj2"] = AudioInfo{MimeType: "audio/mp4", Extension: ".m4a"}
	}
	info, ok := formats[strings.ToLower(probe.Format.Name)]
	if !ok {
		return AudioInfo{}, fmt.Errorf("音频格式不支持；参考录音请使用真实 MP3 或 WAV")
	}
	info.Duration = duration
	return info, nil
}
