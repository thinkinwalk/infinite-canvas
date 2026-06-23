package handler

import (
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

func TestAIUpstreamErrorDetail(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InvalidParameter","message":"reference video fps is invalid"}}`))
	if got != "InvalidParameter reference video fps is invalid" {
		t.Fatalf("detail = %q", got)
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
