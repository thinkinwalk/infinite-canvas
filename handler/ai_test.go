package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestBuildAIProxyGetURLPreservesQuery(t *testing.T) {
	upstreamURL, err := buildAIProxyGetURL(model.ModelChannel{BaseURL: "https://new.dszyym.com/v1"}, "/videos/task_123", url.Values{"model": {"grok-imagine-1.0-video"}})
	if err != nil {
		t.Fatalf("build url failed: %v", err)
	}
	if upstreamURL != "https://new.dszyym.com/v1/videos/task_123?model=grok-imagine-1.0-video" {
		t.Fatalf("url = %q", upstreamURL)
	}
}

func TestFallbackOpenAIVideoStatusUsesContentEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/videos/task_123/content" {
			t.Fatalf("content path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte("video"))
	}))
	defer server.Close()
	request := httptest.NewRequest(http.MethodGet, server.URL+"/v1/videos/task_123?model=grok-imagine-1.0-video", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	if !fallbackOpenAIVideoStatus(response, request, http.StatusForbidden) {
		t.Fatal("fallback did not handle forbidden status")
	}
	if response.Body.String() != `{"id":"task_123","status":"completed"}` {
		t.Fatalf("body = %q", response.Body.String())
	}
}

func TestFallbackOpenAIVideoStatusTreatsForbiddenContentAsRunning(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not ready", http.StatusForbidden)
	}))
	defer server.Close()
	request := httptest.NewRequest(http.MethodGet, server.URL+"/v1/videos/task_123?model=grok-imagine-1.0-video", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	if !fallbackOpenAIVideoStatus(response, request, http.StatusForbidden) {
		t.Fatal("fallback did not handle forbidden status")
	}
	if response.Body.String() != `{"id":"task_123","status":"running"}` {
		t.Fatalf("body = %q", response.Body.String())
	}
}

func TestFallbackOpenAIVideoStatusTreatsAnyContentErrorAsRunning(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not ready", http.StatusBadRequest)
	}))
	defer server.Close()
	request := httptest.NewRequest(http.MethodGet, server.URL+"/v1/videos/task_123?model=grok-imagine-1.0-video", nil)
	response := httptest.NewRecorder()
	if !fallbackOpenAIVideoStatus(response, request, http.StatusForbidden) {
		t.Fatal("fallback did not handle forbidden status")
	}
	if response.Body.String() != `{"id":"task_123","status":"running"}` {
		t.Fatalf("body = %q", response.Body.String())
	}
}

func TestAIUpstreamErrorDetail(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InvalidParameter","message":"reference video fps is invalid"}}`))
	if got != "InvalidParameter reference video fps is invalid" {
		t.Fatalf("detail = %q", got)
	}
}

func TestUseLingzhouResponsesImageProxy(t *testing.T) {
	channel := model.ModelChannel{BaseURL: "https://image.lingzhouai.com"}
	if useLingzhouResponsesImageProxy(channel, "gpt-image-2-4k", "/images/generations", "application/json") {
		t.Fatal("Lingzhou 4k mapped model should preserve the images generation endpoint")
	}
	if useLingzhouResponsesImageProxy(channel, "gpt-image-2-2k", "/images/generations", "application/json") {
		t.Fatal("Lingzhou 2k mapped model should preserve the images generation endpoint")
	}
	if !useLingzhouResponsesImageProxy(channel, "gpt-image-2", "/images/generations", "application/json") {
		t.Fatal("Lingzhou base gpt-image generation should keep using the responses proxy")
	}
	if useLingzhouResponsesImageProxy(model.ModelChannel{BaseURL: "https://example.com"}, "gpt-image-2-4k", "/images/generations", "application/json") {
		t.Fatal("non-Lingzhou channel should not use responses proxy")
	}
	if useLingzhouResponsesImageProxy(model.ModelChannel{BaseURL: "https://image.lingzhouai.com"}, "gpt-image-2-4k", "/images/edits", "multipart/form-data") {
		t.Fatal("image edits should not use responses proxy")
	}
}

func TestBuildLingzhouImageResponsesBody(t *testing.T) {
	body, err := buildLingzhouImageResponsesBody([]byte(`{"model":"gpt-image-2-4k","prompt":"cat","size":"2160x3840","quality":"high"}`))
	if err != nil {
		t.Fatalf("build responses body failed: %v", err)
	}
	if string(body) != `{"input":"cat","model":"gpt-image-2-4k","tools":[{"quality":"high","size":"2160x3840","type":"image_generation"}]}` {
		t.Fatalf("body = %s", body)
	}
}

func TestReadLingzhouResponsesImage(t *testing.T) {
	got, err := readLingzhouResponsesImage([]byte(`{"output":[{"type":"message","content":[]},{"type":"image_generation_call","result":"abc123"}]}`))
	if err != nil {
		t.Fatalf("read image failed: %v", err)
	}
	if got != "abc123" {
		t.Fatalf("image = %q", got)
	}
}

func TestAIUpstreamErrorDetailExplainsSensitiveVideo(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation","message":"The request failed because the input video may contain real person."}}`))
	if !strings.Contains(got, "参考视频疑似包含真人") || !strings.Contains(got, "asset://") {
		t.Fatalf("detail = %q", got)
	}
}

func TestSafeUpstreamTextTruncates(t *testing.T) {
	got := safeUpstreamText(strings.Repeat("错", 320))
	if len([]rune(got)) != 303 {
		t.Fatalf("truncated rune length = %d", len([]rune(got)))
	}
}
