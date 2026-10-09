package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func TestImageChannelFailover(t *testing.T) {
	previousConfig, previousClient := config.Cfg, aiHTTPClient
	t.Cleanup(func() { config.Cfg, aiHTTPClient = previousConfig, previousClient })
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: "file:image-failover-test?mode=memory&cache=shared"}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)

	tests := []struct {
		name           string
		path           string
		status         int
		code           string
		wantCalls      int
		failAll        bool
		transportError bool
		lingzhou       bool
		partial        bool
		single         bool
		stream         bool
		cancel         bool
	}{
		{name: "quota switches", status: 429, code: "insufficient_quota", wantCalls: 2},
		{name: "edit auth switches", path: "/images/edits", status: 401, code: "invalid_api_key", wantCalls: 2},
		{name: "missing model switches", status: 400, code: "model_not_found", wantCalls: 2},
		{name: "responses image tool switches", path: "/responses", status: 429, code: "rate_limit_exceeded", stream: true, wantCalls: 2},
		{name: "all channels rejected", status: 429, code: "insufficient_quota", failAll: true, wantCalls: 2},
		{name: "one eligible channel", status: 429, code: "insufficient_quota", failAll: true, single: true, wantCalls: 1},
		{name: "invalid parameters stop", status: 400, code: "invalid_value", failAll: true, wantCalls: 1},
		{name: "content policy stops", status: 403, code: "content_policy_violation", failAll: true, wantCalls: 1},
		{name: "server outcome uncertain stops", status: 503, failAll: true, wantCalls: 1},
		{name: "timeout stops", transportError: true, wantCalls: 1},
		{name: "cancelled request stops", cancel: true},
		{name: "first channel success", wantCalls: 1},
		{name: "responses adapter switches", lingzhou: true, status: 429, code: "insufficient_quota", wantCalls: 2},
		{name: "partially generated batch stops", lingzhou: true, partial: true, status: 429, code: "insufficient_quota", wantCalls: 2},
	}
	for index, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := tt.path
			if path == "" {
				path = "/images/generations"
			}
			count := 1
			if tt.partial {
				count = 2
			}
			userID := fmt.Sprintf("image-user-%d", index)
			user := model.User{ID: userID, Username: userID, AffCode: userID, Group: "default", Credits: 100, Status: model.UserStatusActive}
			if err := db.Create(&user).Error; err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				db.Where("user_id = ?", userID).Delete(&model.CreditLog{})
				db.Where("id = ?", userID).Delete(&model.User{})
			})
			channels := []model.ModelChannel{
				{ID: 1, Name: "first", BaseURL: "https://first.example.com", APIKey: "test-first", Models: []string{"gpt-image-2"}, Weight: 1, Enabled: true},
				{ID: 2, Name: "second", BaseURL: "https://second.example.com", APIKey: "test-second", Models: []string{"gpt-image-2"}, Weight: 1, Enabled: !tt.single},
				{ID: 3, Name: "disabled", BaseURL: "https://disabled.example.com", APIKey: "test-disabled", Models: []string{"gpt-image-2"}},
				{ID: 4, Name: "other model", BaseURL: "https://other.example.com", APIKey: "test-other", Models: []string{"other-model"}, Enabled: true},
				{ID: 5, Name: "restricted", BaseURL: "https://vip.example.com", APIKey: "test-vip", Models: []string{"gpt-image-2"}, AllowedGroups: []string{"vip"}, Enabled: true},
			}
			if tt.lingzhou {
				channels[0].BaseURL, channels[1].BaseURL = "https://first.lingzhouai.com", "https://second.lingzhouai.com"
			}
			settings := model.Settings{Private: model.PrivateSetting{Channels: channels}, Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{ModelCosts: []model.ModelCost{{Model: "gpt-image-2", Credits: 7}}}}}
			if _, err := repository.SaveSettings(settings, "test"); err != nil {
				t.Fatal(err)
			}
			body := []byte(fmt.Sprintf(`{"model":"gpt-image-2","prompt":"draw a cat","n":%d}`, count))
			contentType := "application/json"
			if path == "/responses" {
				body = []byte(`{"model":"gpt-image-2","input":"draw a cat","tools":[{"type":"image_generation"}],"stream":true}`)
			}
			if path == "/images/edits" {
				var form bytes.Buffer
				writer := multipart.NewWriter(&form)
				_ = writer.WriteField("model", "gpt-image-2")
				_ = writer.WriteField("prompt", "draw a cat")
				file, err := writer.CreateFormFile("image", "cat.png")
				if err != nil {
					t.Fatal(err)
				}
				_, _ = file.Write([]byte("reference-image-bytes"))
				_ = writer.Close()
				body, contentType = form.Bytes(), writer.FormDataContentType()
			}
			var attempted []int
			aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(request *http.Request) (*http.Response, error) {
				var current model.User
				if err := db.First(&current, "id = ?", userID).Error; err != nil {
					t.Fatal(err)
				}
				if current.Credits != 100-7*count {
					t.Fatalf("balance during attempt = %d", current.Credits)
				}
				channelID := 0
				for _, channel := range channels[:2] {
					if request.Header.Get("Authorization") == "Bearer "+channel.APIKey {
						channelID = channel.ID
					}
				}
				if channelID == 0 {
					t.Fatal("used disabled, restricted or different-model channel")
				}
				attempted = append(attempted, channelID)
				actualBody, err := io.ReadAll(request.Body)
				if err != nil {
					t.Fatal(err)
				}
				if tt.lingzhou {
					if request.URL.Path != "/v1/responses" || !bytes.Contains(actualBody, []byte(`"image_generation"`)) {
						t.Fatalf("invalid converted request: %s %s", request.URL.Path, actualBody)
					}
				} else if request.URL.Path != "/v1"+path || !bytes.Equal(actualBody, body) || request.Header.Get("Content-Type") != contentType {
					t.Fatalf("retry changed request body, path or content type: %s", actualBody)
				}
				if path != "/responses" && request.Header.Get("Accept") != "application/json" {
					t.Fatal("image request unexpectedly negotiates streaming")
				}
				if tt.transportError {
					return nil, context.DeadlineExceeded
				}
				status, result := http.StatusOK, `{"data":[{"b64_json":"aW1hZ2U="}]}`
				if tt.lingzhou {
					result = `{"output":[{"type":"image_generation_call","result":"aW1hZ2U="}]}`
				}
				header := http.Header{"Content-Type": {"application/json"}}
				if tt.stream {
					header.Set("Content-Type", "text/event-stream")
					result = "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"image_generation_call\",\"result\":\"aW1hZ2U=\"}]}}\n\n"
				}
				reject := tt.status > 0 && (tt.failAll || len(attempted) == 1)
				if tt.partial {
					reject = len(attempted) == 2
				}
				if reject {
					status = tt.status
					result = fmt.Sprintf(`{"error":{"code":%q,"message":"upstream rejected"}}`, tt.code)
				}
				return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(result))}, nil
			})}
			request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
			request.Header.Set("Content-Type", contentType)
			ctx := service.WithUser(request.Context(), model.PublicUser(user))
			if tt.cancel {
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			}
			recorder := httptest.NewRecorder()
			proxyAIRequest(recorder, request.WithContext(ctx), path)
			if len(attempted) != tt.wantCalls {
				t.Fatalf("attempts = %v, want %d", attempted, tt.wantCalls)
			}
			if len(attempted) == 2 && (attempted[0] == attempted[1]) != tt.partial {
				t.Fatalf("repeated failed channel: %v", attempted)
			}
			failed := tt.failAll || tt.transportError || tt.partial || tt.cancel
			wantCredits, wantLogs := 100-7*count, 1
			if failed {
				wantCredits, wantLogs = 100, 2
			}
			var finalUser model.User
			if err := db.First(&finalUser, "id = ?", userID).Error; err != nil {
				t.Fatal(err)
			}
			if finalUser.Credits != wantCredits {
				t.Fatalf("final balance = %d, want %d", finalUser.Credits, wantCredits)
			}
			var logs []model.CreditLog
			if err := db.Where("user_id = ?", userID).Find(&logs).Error; err != nil {
				t.Fatal(err)
			}
			if len(logs) != wantLogs {
				t.Fatalf("credit logs = %d, want %d", len(logs), wantLogs)
			}
			for _, entry := range logs {
				var extra struct {
					ChannelID   int    `json:"channelId"`
					ChannelName string `json:"channelName"`
				}
				if err := json.Unmarshal([]byte(entry.Extra), &extra); err != nil {
					t.Fatal(err)
				}
				if len(attempted) > 0 && (extra.ChannelID != attempted[len(attempted)-1] || extra.ChannelName != channels[extra.ChannelID-1].Name) {
					t.Fatalf("credit log attributed to wrong channel: %s", entry.Extra)
				}
				if strings.Contains(entry.Extra, "test-first") || strings.Contains(entry.Extra, "test-second") {
					t.Fatal("credit log contains API key")
				}
			}
			if !failed && !strings.Contains(recorder.Body.String(), "aW1hZ2U=") {
				t.Fatalf("missing generated image: %s", recorder.Body.String())
			}
			if tt.failAll && len(attempted) > 1 && !strings.Contains(recorder.Body.String(), "所有可用生图渠道") {
				t.Fatalf("missing exhausted-channel message: %s", recorder.Body.String())
			}
		})
	}
}

func TestImageRejectionClassification(t *testing.T) {
	for _, tt := range []struct {
		status int
		body   string
		want   bool
	}{
		{429, `{"error":{"code":"insufficient_quota","type":"invalid_request_error"}}`, true},
		{403, `{"error":{"code":"model_access_denied"}}`, true},
		{404, "endpoint not found", true},
		{403, `{"error":{"message":"unknown forbidden reason"}}`, false},
		{429, `{"error":{"code":"content_policy_violation"}}`, false},
		{400, `{"error":{"code":"invalid_value"}}`, false},
		{404, `{"error":{"code":"invalid_prompt","type":"invalid_request_error"}}`, false},
		{429, `{"error":{"type":"invalid_request_error"}}`, false},
		{500, `{"error":{"code":"insufficient_quota"}}`, false},
		{200, `{"error":{"code":"insufficient_quota"}}`, false},
	} {
		if got := retryableImageRejection(tt.status, []byte(tt.body)); got != tt.want {
			t.Errorf("status=%d body=%s: retry=%t", tt.status, tt.body, got)
		}
	}
	if isImageResponsesRequest("/responses", []byte(`{"tools":[{"type":"web_search"}]}`)) {
		t.Fatal("text request classified as image generation")
	}
}
