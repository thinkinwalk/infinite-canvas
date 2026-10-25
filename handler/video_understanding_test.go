package handler

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func TestGeminiVideoRequestUsesNativePartsAndChannelPrefix(t *testing.T) {
	for _, prefix := range []string{"", "/v1", "/v1beta", "/v1beta/openai"} {
		r := httptest.NewRequest("POST", "/", nil)
		channel := model.ModelChannel{BaseURL: "https://relay.invalid" + prefix, APIKey: "test-secret"}
		body := []byte(`{"prompt":"分析动作与声音","video":{"mimeType":"video/quicktime","data":"dmlkZW8="}}`)
		request, err := geminiVideoRequest(r, channel, "private-gemini", body)
		if err != nil {
			t.Fatal(err)
		}
		if request.URL.String() != "https://relay.invalid/v1beta/models/private-gemini:generateContent" || request.Header.Get("x-goog-api-key") != "test-secret" || request.Header.Get("Authorization") != "Bearer test-secret" {
			t.Fatalf("native request: %s %v", request.URL, request.Header)
		}
		payload, _ := io.ReadAll(request.Body)
		if !strings.Contains(string(payload), `"inlineData":{"data":"dmlkZW8=","mimeType":"video/mov"}`) || !strings.Contains(string(payload), `"systemInstruction"`) || strings.Contains(string(payload), "private-gemini") {
			t.Fatalf("native parts = %s", payload)
		}
	}
}

func TestVideoUnderstandingQuoteScopeChargeAndRefund(t *testing.T) {
	db := setupVideoLogTest(t)
	user := model.User{ID: "video-analysis-owner", Username: "video-analysis-owner", AffCode: "video-analysis-owner", Credits: 500, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Delete(&user)
	})
	calls, status := 0, 200
	answer := `{"candidates":[{"content":{"parts":[{"thought":true,"text":"private reasoning"},{"text":"00:00 人物转身，伴随口播"}]},"finishReason":"STOP"}]}`
	video := base64.StdEncoding.EncodeToString(logTestMP4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1beta/models/private-gemini:generateContent" {
			t.Errorf("path = %s", r.URL.Path)
		}
		var payload struct {
			Contents []struct {
				Parts []struct {
					InlineData struct {
						Data     string `json:"data"`
						MimeType string `json:"mimeType"`
					} `json:"inlineData"`
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"contents"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if len(payload.Contents) != 1 || len(payload.Contents[0].Parts) != 2 || payload.Contents[0].Parts[0].InlineData.Data != video || payload.Contents[0].Parts[1].Text != "分析动作与口播" {
			t.Errorf("video or prompt was dropped: %+v", payload)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, answer)
	}))
	defer upstream.Close()
	settings := model.Settings{Private: model.PrivateSetting{
		Channels: []model.ModelChannel{{ID: 987, Name: "gemini-test", Protocol: "openai", BaseURL: upstream.URL + "/v1", APIKey: "secret", Enabled: true, Weight: 1, Models: []string{"private-gemini"}}},
		ModelManagement: &model.ModelManagement{Enabled: true, Revision: 9,
			Routes:   []model.ManagedRoute{{ID: "route_gemini_video", ChannelID: 987, Model: "private-gemini", Adapter: "text.gemini-video", Capability: "text", Operations: []string{"video-understand"}, Enabled: true}},
			Models:   []model.ManagedModel{{ID: "model_video_analysis", DisplayName: "视频分析", DisplayMode: "alias", Enabled: true, RouteIDs: []string{"route_gemini_video"}, Pricing: model.ManagedPricing{Configured: true, Credits: 7}}},
			Bindings: []model.FeatureBinding{{FeatureID: "viral-recreate.video-analyze", ModelID: "model_video_analysis", RouteIDs: []string{"route_gemini_video"}, Enabled: true, Default: true}},
		},
	}}
	if err := service.ValidateModelManagement(settings); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	invoke := func(handle http.HandlerFunc, body, feature, quote, revision string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/v1/video-understanding", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Model-Feature", feature)
		r.Header.Set("X-Model-Revision", revision)
		r.Header.Set("X-Model-Quote", quote)
		r.Header.Set("X-Expected-Credits", "7")
		r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
		w := httptest.NewRecorder()
		handle(w, r)
		return w
	}
	quoteResponse := invoke(ModelQuote, `{"model":"model_video_analysis","count":1}`, "viral-recreate.video-analyze", "", "9")
	var quote struct {
		Data struct {
			QuoteToken string `json:"quoteToken"`
			Credits    int    `json:"credits"`
		} `json:"data"`
	}
	_ = json.Unmarshal(quoteResponse.Body.Bytes(), &quote)
	if quote.Data.QuoteToken == "" || quote.Data.Credits != 7 {
		t.Fatalf("quote: %s", quoteResponse.Body.String())
	}
	input := `{"model":"model_video_analysis","prompt":"分析动作与口播","video":{"mimeType":"video/mp4","data":"` + video + `"}}`
	feature, proof := "viral-recreate.video-analyze", quote.Data.QuoteToken
	for _, item := range []struct{ body, feature, proof, revision string }{
		{input, feature, "", "9"},
		{input, "viral-recreate.script", proof, "9"},
		{input, feature, proof, "8"},
		{strings.Replace(input, "video/mp4", "text/plain", 1), feature, proof, "9"},
		{strings.Replace(input, video, "***", 1), feature, proof, "9"},
	} {
		result := invoke(AIVideoUnderstanding, item.body, item.feature, item.proof, item.revision)
		var envelope struct{ Code int }
		_ = json.Unmarshal(result.Body.Bytes(), &envelope)
		if envelope.Code != 1 || calls != 0 {
			t.Fatalf("invalid request reached upstream: %s calls=%d", result.Body.String(), calls)
		}
	}
	current, _, _ := repository.GetUserByID(user.ID)
	if current.Credits != 500 {
		t.Fatalf("invalid request charged %d", current.Credits)
	}
	success := invoke(AIVideoUnderstanding, input, feature, proof, "9")
	if !strings.Contains(success.Body.String(), "人物转身") || strings.Contains(success.Body.String(), "private reasoning") || calls != 1 {
		t.Fatalf("success: %s calls=%d", success.Body.String(), calls)
	}
	current, _, _ = repository.GetUserByID(user.ID)
	if current.Credits != 493 {
		t.Fatalf("successful analysis balance = %d", current.Credits)
	}
	for _, item := range []struct {
		status int
		answer string
	}{
		{400, `{"error":{"message":"video unsupported"}}`},
		{200, `{"promptFeedback":{"blockReason":"SAFETY"}}`},
		{200, `{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"truncated"}]}}]}`},
		{200, `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"thought":true,"text":"private"}]}}]}`},
		{200, `<html>not a native endpoint</html>`},
	} {
		status, answer = item.status, item.answer
		result := invoke(AIVideoUnderstanding, input, feature, proof, "9")
		var envelope struct{ Code int }
		_ = json.Unmarshal(result.Body.Bytes(), &envelope)
		current, _, _ = repository.GetUserByID(user.ID)
		if envelope.Code != 1 || current.Credits != 493 {
			t.Fatalf("failed analysis not refunded: %s balance=%d", result.Body.String(), current.Credits)
		}
	}
	cross := invoke(AIResponses, `{"model":"model_video_analysis","input":"绕过视频步骤"}`, feature, proof, "9")
	if !strings.Contains(cross.Body.String(), "不支持") || calls != 6 {
		t.Fatalf("native adapter accepted ordinary text: %s calls=%d", cross.Body.String(), calls)
	}
}
