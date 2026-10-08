package handler

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

type transcriptionSegment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}
type transcriptionResult struct {
	Text     string                 `json:"text"`
	Segments []transcriptionSegment `json:"segments"`
}

func normalizeTranscriptionOutput(output any) (string, error) {
	encoded, err := json.Marshal(output)
	if err != nil {
		return "", err
	}
	var raw struct {
		Text   string `json:"text"`
		Chunks []struct {
			Text      string     `json:"text"`
			Timestamp []*float64 `json:"timestamp"`
		} `json:"chunks"`
	}
	if err := json.Unmarshal(encoded, &raw); err != nil {
		return "", fmt.Errorf("语音识别结果格式不正确")
	}
	result := transcriptionResult{Text: strings.TrimSpace(raw.Text), Segments: []transcriptionSegment{}}
	if result.Text == "" {
		return "", fmt.Errorf("没有识别到口播文字，请检查人声或手动粘贴文案")
	}
	for _, chunk := range raw.Chunks {
		if len(chunk.Timestamp) != 2 || chunk.Timestamp[0] == nil || chunk.Timestamp[1] == nil {
			continue
		}
		start, end := *chunk.Timestamp[0], *chunk.Timestamp[1]
		text := strings.TrimSpace(chunk.Text)
		if text != "" && start >= 0 && end > start && !math.IsNaN(start) && !math.IsNaN(end) && !math.IsInf(start, 0) && !math.IsInf(end, 0) {
			result.Segments = append(result.Segments, transcriptionSegment{Start: start, End: end, Text: text})
		}
	}
	if len(result.Segments) == 0 {
		return "", fmt.Errorf("语音识别未返回有效时间轴，请检查素材中的人声")
	}
	encoded, err = json.Marshal(result)
	return string(encoded), err
}
