package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type AnalysisFrame struct {
	Time float64 `json:"time"`
	Data string  `json:"data"`
}

type AnalysisWindow struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type AnalysisVideo struct {
	Path     string
	Duration float64
	FPS      float64
	HasAudio bool
}

func PrepareAnalysisVideo(ctx context.Context, data string) (*AnalysisVideo, func(), error) {
	dir, err := os.MkdirTemp("", "canvas-analysis-")
	if err != nil {
		return nil, func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	fail := func() (*AnalysisVideo, func(), error) {
		cleanup()
		return nil, func() {}, fmt.Errorf("视频读取失败，原片与已有结果已保留")
	}
	bytes, err := base64.StdEncoding.DecodeString(data)
	if err != nil || len(bytes) == 0 {
		return fail()
	}
	path := filepath.Join(dir, "source")
	if os.WriteFile(path, bytes, 0600) != nil {
		return fail()
	}
	binary := os.Getenv("FFPROBE_PATH")
	if binary == "" {
		binary = "ffprobe"
	}
	output, err := exec.CommandContext(ctx, binary, "-v", "error", "-protocol_whitelist", "file,pipe",
		"-show_entries", "format=duration:stream=codec_type,avg_frame_rate", "-of", "json", path).Output()
	var metadata struct {
		Format  struct{ Duration string } `json:"format"`
		Streams []struct {
			Type string `json:"codec_type"`
			Rate string `json:"avg_frame_rate"`
		} `json:"streams"`
	}
	if err != nil || json.Unmarshal(output, &metadata) != nil {
		return fail()
	}
	duration, _ := strconv.ParseFloat(metadata.Format.Duration, 64)
	if duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return fail()
	}
	video := &AnalysisVideo{Path: path, Duration: duration}
	for _, stream := range metadata.Streams {
		video.HasAudio = video.HasAudio || stream.Type == "audio"
		if stream.Type == "video" && video.FPS == 0 {
			parts := strings.Split(stream.Rate, "/")
			if len(parts) == 2 {
				n, _ := strconv.ParseFloat(parts[0], 64)
				d, _ := strconv.ParseFloat(parts[1], 64)
				if n > 0 && d > 0 {
					video.FPS = n / d
				}
			}
		}
	}
	if video.FPS <= 0 || math.IsInf(video.FPS, 0) || math.IsNaN(video.FPS) {
		return fail()
	}
	return video, cleanup, nil
}

func (video *AnalysisVideo) Frames(ctx context.Context, times []float64) ([]AnalysisFrame, error) {
	binary := os.Getenv("FFMPEG_PATH")
	if binary == "" {
		binary = "ffmpeg"
	}
	frames := make([]AnalysisFrame, 0, len(times))
	for _, time := range times {
		time = math.Max(0, math.Min(time, math.Max(0, video.Duration-1/video.FPS)))
		data, err := exec.CommandContext(ctx, binary, "-nostdin", "-v", "error",
			"-protocol_whitelist", "file,pipe", "-ss", strconv.FormatFloat(time, 'f', -1, 64),
			"-i", video.Path, "-map", "0:v:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1").Output()
		if err != nil || len(data) == 0 {
			return nil, fmt.Errorf("视频画面读取失败，已有结果已保留")
		}
		frames = append(frames, AnalysisFrame{Time: time, Data: base64.StdEncoding.EncodeToString(data)})
	}
	return frames, nil
}

func AnalysisSampleTimes(duration float64, count int) []float64 {
	times := make([]float64, count)
	for i := range times {
		times[i] = duration * float64(i) / float64(count)
	}
	return times
}

func NormalizeAnalysisWindows(duration float64, windows []AnalysisWindow) []AnalysisWindow {
	valid := []AnalysisWindow{}
	for _, window := range windows {
		if math.IsNaN(window.Start) || math.IsNaN(window.End) || math.IsInf(window.Start, 0) || math.IsInf(window.End, 0) {
			continue
		}
		window.Start, window.End = math.Max(0, window.Start), math.Min(duration, window.End)
		if window.End > window.Start {
			valid = append(valid, window)
		}
	}
	sort.Slice(valid, func(i, j int) bool { return valid[i].Start < valid[j].Start })
	merged := []AnalysisWindow{}
	for _, window := range valid {
		if len(merged) > 0 && window.Start <= merged[len(merged)-1].End {
			merged[len(merged)-1].End = math.Max(window.End, merged[len(merged)-1].End)
		} else {
			merged = append(merged, window)
		}
	}
	return merged
}

// Spend a bounded second-pass sampling budget inside model-selected intervals.
// Without usable intervals, interleave the samples across the whole video.
func AnalysisDetailTimes(duration float64, count int, windows []AnalysisWindow) []float64 {
	return AnalysisDetailTimesAvoiding(duration, count, windows, nil, 0)
}

func AnalysisDetailTimesAvoiding(duration float64, count int, windows []AnalysisWindow, existing []float64, minGap float64) []float64 {
	if duration <= 0 || count <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return nil
	}
	merged := NormalizeAnalysisWindows(duration, windows)
	if len(merged) == 0 {
		merged = []AnalysisWindow{{Start: 0, End: duration}}
	}
	total := 0.0
	for _, window := range merged {
		total += window.End - window.Start
	}
	if total <= 0 {
		return nil
	}
	gap := math.Max(0, minGap)
	times := make([]float64, 0, count)
	for attempt := 0; attempt < 16 && len(times) < count; attempt++ {
		for i := 0; i < count && len(times) < count; i++ {
			fraction := (float64(i) + 0.5 + float64(attempt)/16) / float64(count)
			if fraction >= 1 {
				fraction--
			}
			position := total * fraction
			candidate := 0.0
			for _, window := range merged {
				if position < window.End-window.Start {
					candidate = window.Start + position
					break
				}
				position -= window.End - window.Start
			}
			duplicate := false
			for _, previous := range existing {
				if math.Abs(candidate-previous) < gap || gap == 0 && candidate == previous {
					duplicate = true
					break
				}
			}
			if !duplicate {
				for _, previous := range times {
					if math.Abs(candidate-previous) < gap || gap == 0 && candidate == previous {
						duplicate = true
						break
					}
				}
			}
			if !duplicate {
				times = append(times, candidate)
			}
		}
	}
	return times
}
