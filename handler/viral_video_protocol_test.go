package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func TestAnalysisFramePartsUsesStandardJPEGDataURL(t *testing.T) {
	parts := analysisFrameParts([]service.AnalysisFrame{{Time: 1.25, Data: "YWJj"}})
	if len(parts) != 2 {
		t.Fatalf("parts=%#v", parts)
	}
	image, ok := parts[1].(map[string]any)
	if !ok || image["image_url"] != "data:image/jpeg;base64,YWJj" {
		t.Fatalf("image part=%#v", parts[1])
	}
}

func TestCallViralAnalysisFramesSendsJPEGDataURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Errorf("path=%s", r.URL.Path)
		}
		var payload struct {
			Input []struct {
				Content []struct {
					Type     string `json:"type"`
					ImageURL string `json:"image_url"`
				} `json:"content"`
			} `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if len(payload.Input) != 1 || len(payload.Input[0].Content) != 3 ||
			payload.Input[0].Content[0].Type != "input_text" ||
			payload.Input[0].Content[1].Type != "input_image" ||
			payload.Input[0].Content[1].ImageURL != "data:image/jpeg;base64,YWJj" {
			t.Errorf("request input=%+v", payload.Input)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"分析完成"}]}]}`))
	}))
	defer server.Close()

	request := httptest.NewRequest(http.MethodPost, "/", nil)
	text, err := callViralAnalysis(request, model.ModelChannel{BaseURL: server.URL, APIKey: "test"}, "text-model",
		viralAnalysisInput{Mode: "frames"}, []service.AnalysisFrame{{Time: 1, Data: "YWJj"}}, "分析")
	if err != nil || text != "分析完成" {
		t.Fatalf("text=%q err=%v", text, err)
	}
}

func TestCallViralAnalysisVideoKeepsGeminiNativePayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models/gemini-test:generateContent" {
			t.Errorf("path=%s", r.URL.Path)
		}
		var payload struct {
			Contents []struct {
				Parts []struct {
					Text       string `json:"text"`
					InlineData struct {
						MimeType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"contents"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if len(payload.Contents) != 1 || len(payload.Contents[0].Parts) != 4 ||
			payload.Contents[0].Parts[0].InlineData.MimeType != "video/mp4" ||
			payload.Contents[0].Parts[0].InlineData.Data != "dmlkZW8=" ||
			payload.Contents[0].Parts[2].InlineData.MimeType != "image/jpeg" {
			t.Errorf("native request parts=%+v", payload.Contents)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"分析完成"}]}}]}`))
	}))
	defer server.Close()

	request := httptest.NewRequest(http.MethodPost, "/", nil)
	input := viralAnalysisInput{Mode: "video"}
	input.Video.MimeType, input.Video.Data = "video/mp4", "dmlkZW8="
	text, err := callViralAnalysis(request, model.ModelChannel{BaseURL: server.URL, APIKey: "test"}, "gemini-test",
		input, []service.AnalysisFrame{{Time: 1, Data: "YWJj"}}, "分析")
	if err != nil || text != "分析完成" {
		t.Fatalf("text=%q err=%v", text, err)
	}
}

func TestViralReviewRequiredForSkirtFanConfusion(t *testing.T) {
	document := viralObservationDocument{Analysis: "长裙裙摆展开呈巨型折扇形状"}
	if !viralReviewRequired(document) {
		t.Fatal("skirt and fan-shaped description should trigger an internal review")
	}
}
