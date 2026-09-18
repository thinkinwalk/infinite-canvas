package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestBuildChatCompletionsBodyConvertsResponsesTextAndImageInput(t *testing.T) {
	body, stream, err := buildChatCompletionsBody([]byte(`{
		"model":"gpt-test",
		"instructions":"be concise",
		"stream":true,
		"input":[{"role":"user","content":[{"type":"input_text","text":"describe"},{"type":"input_image","image_url":"https://example.com/a.png"}]}]
	}`))
	if err != nil {
		t.Fatalf("build chat body: %v", err)
	}
	if !stream {
		t.Fatal("stream should be preserved")
	}
	var payload struct {
		Model    string `json:"model"`
		Stream   bool   `json:"stream"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unmarshal chat body: %v", err)
	}
	if payload.Model != "gpt-test" || !payload.Stream || len(payload.Messages) != 2 {
		t.Fatalf("payload = %s", body)
	}
	if payload.Messages[0].Role != "system" || string(payload.Messages[0].Content) != `"be concise"` {
		t.Fatalf("system message = %s", payload.Messages[0].Content)
	}
	if payload.Messages[1].Role != "user" || !strings.Contains(string(payload.Messages[1].Content), `"type":"image_url"`) {
		t.Fatalf("user message = %s", payload.Messages[1].Content)
	}
}

func TestCopyChatCompletionAsResponseBuildsResponsesOutput(t *testing.T) {
	recorder := httptest.NewRecorder()
	err := copyChatCompletionAsResponse(recorder, strings.NewReader(`{
		"id":"chatcmpl-123","created":42,"model":"gpt-test",
		"choices":[{"message":{"content":"hello"}}],
		"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}
	}`), model.ModelChannel{})
	if err != nil {
		t.Fatalf("convert chat completion: %v", err)
	}
	var payload struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Output []struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal responses payload: %v", err)
	}
	if payload.ID != "resp_123" || payload.Status != "completed" || len(payload.Output) != 1 || len(payload.Output[0].Content) != 1 || payload.Output[0].Content[0].Type != "output_text" || payload.Output[0].Content[0].Text != "hello" {
		t.Fatalf("responses payload = %s", recorder.Body.String())
	}
}

func TestCopyChatCompletionsStreamAsResponsesBuildsTypedEvents(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"id":"chatcmpl-123","created":42,"model":"gpt-test","choices":[{"delta":{"content":"你"}}]}`,
		"",
		`data: {"id":"chatcmpl-123","created":42,"model":"gpt-test","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}`,
		"",
		"data: [DONE]",
		"",
	}, "\n")
	recorder := httptest.NewRecorder()
	copyChatCompletionsStreamAsResponses(recorder, &http.Response{Body: io.NopCloser(strings.NewReader(stream))}, model.ModelChannel{}, nil)
	body := recorder.Body.String()
	for _, expected := range []string{`"type":"response.created"`, `"type":"response.output_text.delta"`, `"delta":"你"`, `"delta":"好"`, `"type":"response.completed"`, `"text":"你好"`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("stream missing %s: %s", expected, body)
		}
	}
}
