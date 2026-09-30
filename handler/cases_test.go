package handler

import (
	"encoding/json"
	"testing"
)

func TestCaseTextRequestIncludesVisualInputs(t *testing.T) {
	path, body, err := buildCaseAIRequest(caseRuntimeConfig{Kind: "text", Model: "vision-model"}, "inspect product", map[string]any{
		"imageUrl":           "data:image/png;base64,primary",
		"referenceImageUrls": []any{"https://example.com/reference.png"},
	})
	if err != nil || path != "/chat/completions" {
		t.Fatalf("unexpected request path=%s err=%v", path, err)
	}
	var request struct {
		Messages []struct {
			Content []struct {
				Type     string `json:"type"`
				ImageURL struct {
					URL string `json:"url"`
				} `json:"image_url"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatal(err)
	}
	if len(request.Messages) != 1 || len(request.Messages[0].Content) != 3 || request.Messages[0].Content[1].ImageURL.URL != "data:image/png;base64,primary" || request.Messages[0].Content[2].ImageURL.URL != "https://example.com/reference.png" {
		t.Fatalf("missing visual inputs: %s", body)
	}
}

func TestTryonLibraryMatchesReferenceCatalog(t *testing.T) {
	models, scenes := tryonLibrary()
	if len(models) != 51 || len(scenes) != 14 {
		t.Fatalf("try-on catalog = %d models/%d scenes, want 51/14", len(models), len(scenes))
	}
}

func TestCaseImageRequestKeepsCountAndTransparency(t *testing.T) {
	_, body, err := buildCaseAIRequest(caseRuntimeConfig{Kind: "image", Model: "image-model", Count: 4, BackgroundInput: "background"}, "extract subject", map[string]any{"imageUrl": "source", "background": "透明"})
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["n"] != float64(4) || payload["image_url"] != "source" || payload["background"] != "transparent" || payload["output_format"] != "png" {
		t.Fatalf("image request lost parameters: %s", body)
	}
	converted, err := buildLingzhouImageResponsesBody(body)
	if err != nil {
		t.Fatal(err)
	}
	var responses struct {
		Tools []map[string]any `json:"tools"`
	}
	if err := json.Unmarshal(converted, &responses); err != nil {
		t.Fatal(err)
	}
	if len(responses.Tools) != 1 || responses.Tools[0]["background"] != "transparent" || responses.Tools[0]["output_format"] != "png" {
		t.Fatalf("converted request lost output format: %s", converted)
	}
}

func TestCaseRequiredImageAndOptionalPrompt(t *testing.T) {
	schema := `{"fields":[{"key":"imageUrl","label":"商品图","type":"image","required":true},{"key":"prompt","label":"补充要求","required":false}]}`
	if err := validateCaseInputs(schema, map[string]any{}); err == nil {
		t.Fatal("missing image must be rejected before charging")
	}
	inputs := map[string]any{"imageUrl": "source"}
	if err := validateCaseInputs(schema, inputs); err != nil {
		t.Fatal(err)
	}
	if prompt := renderCasePrompt("details {{prompt}}", inputs); prompt != "details" {
		t.Fatalf("optional placeholder leaked to model: %q", prompt)
	}
}

func TestVariationChoices(t *testing.T) {
	for _, test := range []struct {
		input string
		want  int
	}{{"1", 1}, {"2", 2}, {"4", 4}, {"8", 8}, {"3", 1}, {"0", 1}} {
		if got := variationCount(test.input); got != test.want {
			t.Fatalf("variationCount(%q) = %d, want %d", test.input, got, test.want)
		}
	}
	if variationModeHint("background") == variationModeHint("surface") {
		t.Fatal("background and surface modes must produce different instructions")
	}
	if variationSimilarityHint("90") == variationSimilarityHint("50") {
		t.Fatal("similarity range must change the model instruction")
	}
}

func TestFusionOutputChoices(t *testing.T) {
	for _, test := range []struct {
		input string
		want  int
	}{{"1", 1}, {"2", 2}, {"4", 4}, {"8", 1}, {"", 1}} {
		if got := fusionCount(test.input); got != test.want {
			t.Fatalf("fusionCount(%q) = %d, want %d", test.input, got, test.want)
		}
	}
	size, quality := fusionOutputSettings("9:16", "高阶")
	if size != "864x1536" || quality != "high" {
		t.Fatalf("fusion settings = %s/%s", size, quality)
	}
	size, quality = fusionOutputSettings("invalid", "invalid")
	if size != "1024x1024" || quality != "medium" {
		t.Fatalf("fusion defaults = %s/%s", size, quality)
	}
}

func TestPrintExtractOutputChoices(t *testing.T) {
	size, quality := printExtractOutputSettings("3:4", "高清")
	if size != "768x1024" || quality != "high" {
		t.Fatalf("print extract settings = %s/%s", size, quality)
	}
	size, quality = printExtractOutputSettings("invalid", "invalid")
	if size != "1024x1024" || quality != "medium" {
		t.Fatalf("print extract defaults = %s/%s", size, quality)
	}
	if size, _ = printExtractOutputSettings("16:9", "标准"); size != "1536x864" {
		t.Fatalf("print extract landscape size = %s", size)
	}
	if size, _ = printExtractOutputSettings("9:16", "标准"); size != "864x1536" {
		t.Fatalf("print extract portrait size = %s", size)
	}
}

func TestGarmentExtractPromptIncludesDetailAndShape(t *testing.T) {
	template := "提取{{shape}}服装，细节级别：{{detail}}。要求：{{prompt}}"
	got := renderCasePrompt(template, map[string]any{"shape": "平铺", "detail": "精细", "prompt": "保留纽扣"})
	if got != "提取平铺服装，细节级别：精细。要求：保留纽扣" {
		t.Fatalf("garment options were not rendered: %q", got)
	}
	if garmentExtractQuality("标准") != "medium" || garmentExtractQuality("精细") != "high" {
		t.Fatal("garment detail must change image quality")
	}
}
