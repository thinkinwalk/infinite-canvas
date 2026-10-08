package handler

import (
	"encoding/json"
	"testing"
)

func TestTranscriptionKeepsTextWithPartialTimestamps(t *testing.T) {
	var output any
	if err := json.Unmarshal([]byte(`{"text":" 欢迎来到咖啡店。 ","chunks":[{"text":"欢迎","timestamp":[0,1]},{"text":"来到","timestamp":[1,null]},{"text":"咖啡店。","timestamp":[1,3]}]}`), &output); err != nil {
		t.Fatal(err)
	}
	encoded, err := normalizeTranscriptionOutput(output)
	if err != nil {
		t.Fatal(err)
	}
	var result transcriptionResult
	if err := json.Unmarshal([]byte(encoded), &result); err != nil {
		t.Fatal(err)
	}
	if result.Text != "欢迎来到咖啡店。" || len(result.Segments) != 2 || result.Segments[1].End != 3 {
		t.Fatalf("text or valid timestamps lost: %s", encoded)
	}
}

func TestTranscriptionRejectsEmptyAndUnexpectedOutput(t *testing.T) {
	for _, output := range []any{nil, "https://replicate.delivery/not-a-transcript.mp4", map[string]any{"text": " "}, map[string]any{"text": "有文字但没有时间轴"}} {
		if _, err := normalizeTranscriptionOutput(output); err == nil {
			t.Fatalf("invalid output accepted: %#v", output)
		}
	}
}
