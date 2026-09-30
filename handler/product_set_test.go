package handler

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseProductSetImageResponse(t *testing.T) {
	data, message, ok := parseProductSetImageResponse(200, []byte(`{"data":[{"url":"https://example.com/result.png"}]}`))
	if !ok || message != "" || data == nil {
		t.Fatalf("透传图片响应解析失败: ok=%v message=%q data=%v", ok, message, data)
	}
	_, message, ok = parseProductSetImageResponse(200, []byte(`{"code":1,"msg":"模型未配置"}`))
	if ok || message != "模型未配置" {
		t.Fatalf("内部错误包装解析失败: ok=%v message=%q", ok, message)
	}
	_, message, ok = parseProductSetImageResponse(200, []byte(`{"code":1,"msg":"AI 接口请求失败：<html>504 Gateway Time-out</html>"}`))
	if ok || message != "图片服务响应超时，可单张重试" {
		t.Fatalf("upstream timeout should be readable: ok=%v message=%q", ok, message)
	}
}

func TestProductSetStreamEvents(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeProductSetEvent(recorder, map[string]any{"type": "start", "total": 2})
	writeProductSetEvent(recorder, map[string]any{"type": "item", "completed": 1, "item": productSetResult{CardID: "white-background", Title: "白底图"}})
	productSetRunDone(recorder, true, []productSetResult{{CardID: "white-background"}}, 0)
	decoder := json.NewDecoder(recorder.Body)
	for _, want := range []string{"start", "item", "done"} {
		var event struct {
			Type string `json:"type"`
		}
		if err := decoder.Decode(&event); err != nil || event.Type != want {
			t.Fatalf("stream event = %q, err=%v; want %q", event.Type, err, want)
		}
	}
}

func TestParseProductSetTextResponse(t *testing.T) {
	text, message, ok := parseProductSetTextResponse(200, []byte(`{"choices":[{"message":{"content":"真皮通勤女包，轻便耐磨"}}]}`))
	if !ok || message != "" || text != "真皮通勤女包，轻便耐磨" {
		t.Fatalf("透传文本响应解析失败: ok=%v message=%q text=%q", ok, message, text)
	}
	text, message, ok = parseProductSetTextResponse(200, []byte(`{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-5.6","choices":[{"message":{"role":"assistant","content":"{\"productBrief\":\"轻便通勤背包\",\"styles\":[{\"title\":\"都市极简\",\"description\":\"自然光\"}]}"}}]}`))
	if !ok || message != "" || text != `{"productBrief":"轻便通勤背包","styles":[{"title":"都市极简","description":"自然光"}]}` {
		t.Fatalf("模型元数据被误当正文: ok=%v message=%q text=%q", ok, message, text)
	}
	text, message, ok = parseProductSetTextResponse(200, []byte(`{"code":0,"msg":"ok","data":{"model":"gpt-5.6","choices":[{"message":{"content":"模型正文"}}]}}`))
	if !ok || message != "" || text != "模型正文" {
		t.Fatalf("包装响应正文提取失败: ok=%v message=%q text=%q", ok, message, text)
	}
	_, message, ok = parseProductSetTextResponse(200, []byte(`{"model":"gpt-5.6","choices":[{"message":{"content":null}}]}`))
	if ok || message != "商品分析没有返回文本" {
		t.Fatalf("无正文时应拒绝模型元数据: ok=%v message=%q", ok, message)
	}
}

func TestParseProductSetStyleSuggestions(t *testing.T) {
	styles, err := parseProductSetStyleSuggestions("```json\n{\"styles\":[{\"title\":\"清爽电商\",\"description\":\"白色背景，突出商品\"}]}\n```")
	if err != nil || len(styles) != 1 || styles[0].ID != "ai-style-1" || styles[0].Title != "清爽电商" {
		t.Fatalf("style suggestions not parsed: styles=%+v err=%v", styles, err)
	}
	if _, err := parseProductSetStyleSuggestions(`{"styles":[{"title":"","description":"无效"}]}`); err == nil {
		t.Fatal("empty style title should be rejected")
	}
}

func TestParseProductSetOneClickResult(t *testing.T) {
	brief, styles, err := parseProductSetOneClickResult("```json\n{\"productBrief\":\"  轻便通勤背包  \",\"styles\":[{\"title\":\"都市极简\",\"description\":\"自然光，白色背景\"}]}\n```")
	if err != nil || brief != "轻便通勤背包" || len(styles) != 1 || styles[0].Description != "自然光，白色背景" {
		t.Fatalf("one-click result not parsed: brief=%q styles=%+v err=%v", brief, styles, err)
	}
	if _, _, err := parseProductSetOneClickResult(`{"productBrief":"","styles":[{"title":"都市极简","description":"白色背景"}]}`); err == nil {
		t.Fatal("empty product brief should be rejected")
	}
}

func TestNormalizedProductSetCountSupportsCustomRange(t *testing.T) {
	if got := normalizedProductSetCount(6); got != 7 {
		t.Fatalf("minimum product set count = %d, want 7", got)
	}
	if got := normalizedProductSetCount(16); got != 16 {
		t.Fatalf("maximum product set count = %d, want 16", got)
	}
	if got := normalizedProductSetCount(20); got != 16 {
		t.Fatalf("clamped product set count = %d, want 16", got)
	}
}

func TestCustomProductSetCardsFollowRequestedMix(t *testing.T) {
	input := productSetInput{LayoutMode: "custom", TargetImageCount: 9, CustomLayout: `{"whiteBackground":2,"scene":3,"sellingPoint":3,"other":1}`, CardIDs: []string{"scene-2", "other-1"}}
	cards := plannedProductSetCards(input)
	if len(cards) != 9 || cards[0].ID != "white-background-1" || cards[8].ID != "other-1" {
		t.Fatalf("custom plan does not follow requested mix: %+v", cards)
	}
	selected := selectedProductSetCards(input)
	if len(selected) != 2 || selected[0].ID != "scene-2" || selected[1].ID != "other-1" {
		t.Fatalf("selected cards do not match custom plan: %+v", selected)
	}
}

func TestParseProductSetPlanPreservesCardIdentity(t *testing.T) {
	base := productSetCards[:2]
	cards, err := parseProductSetPlan("```json\n"+`{"cards":[{"title":" 商品白底图 ","description":" 居中展示商品 "},{"title":"品牌场景","description":"自然光与品牌色"}]}`+"\n```", base)
	if err != nil || len(cards) != 2 || cards[0].ID != base[0].ID || cards[0].Title != "商品白底图" || cards[0].Description != "居中展示商品" || cards[1].AspectRatio != base[1].AspectRatio {
		t.Fatalf("plan cards lost base identity or model content: cards=%+v err=%v", cards, err)
	}
	if _, err := parseProductSetPlan(`{"cards":[{"title":"只有一张","description":"不完整"}]}`, base); err == nil {
		t.Fatal("incomplete plan should be rejected")
	}
}

func TestSelectedProductSetCardsUsePreviewDescriptions(t *testing.T) {
	input := productSetInput{
		TargetImageCount: 8,
		CardIDs:          []string{"white-background", "brand-hero"},
		PlanCards: []productSetCard{
			{ID: "white-background", Title: "预览主图", Description: "主体居中，纯白背景"},
			{ID: "unknown", Title: "外部卡片", Description: "不应进入生成"},
		},
	}
	cards := selectedProductSetCards(input)
	if len(cards) != 2 || cards[0].Title != "预览主图" || cards[0].Description != "主体居中，纯白背景" || cards[1].Title != productSetCards[1].Title {
		t.Fatalf("selected cards did not use preview plan: %+v", cards)
	}
}

func TestProductSetPromptKeepsCategoryAndReferenceRoles(t *testing.T) {
	input := productSetInput{Images: []string{"product"}, StyleReferenceImages: []string{"style"}, ProductBrief: "商品资料", StyleText: "自然光", CustomLayout: `{"scene":3}`, CardIDs: []string{"material-structure"}, PlanCards: []productSetCard{{ID: "material-structure", Title: "外观解读", Description: "局部细节放大"}}}
	card := selectedProductSetCards(input)[0]
	prompt := productSetPrompt(card, input)
	for _, expected := range []string{"材质与结构说明图", "局部细节放大", "连线标注", "前1张是商品身份参考", "之后1张仅为风格和排版参考"} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("prompt missing %q: %s", expected, prompt)
		}
	}
	if strings.Contains(prompt, input.CustomLayout) {
		t.Fatal("batch category counts must not be sent as image layout instructions")
	}
	if got := productSetCategoryRequirements("white-background-2"); !strings.Contains(got, "不加文字") {
		t.Fatalf("custom white background requirement = %q", got)
	}
}
