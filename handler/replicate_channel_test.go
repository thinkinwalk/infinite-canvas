package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func TestReplicateChannelTaskLifecycle(t *testing.T) {
	previousConfig, previousClient := config.Cfg, aiHTTPClient
	config.Cfg.DatabaseDSN, config.Cfg.StorageDriver = ":memory:", "sqlite"
	t.Setenv("REPLICATE_API_TOKEN", "")
	t.Cleanup(func() { config.Cfg, aiHTTPClient = previousConfig, previousClient })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := repository.GetSettings()
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, "test") })
	user := model.User{ID: "replicate-channel-user", Username: "replicate-channel-user", AffCode: "replicate-channel-user", Credits: 100, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.ReplicateTask{})
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Delete(&user)
	})
	spec, _ := service.FindReplicateModel("text-to-video")
	settings := model.Settings{Private: model.PrivateSetting{Replicate: model.ReplicateSetting{ChannelsInitialized: true, Pricing: map[string]model.ReplicatePricing{spec.Model: {Model: spec.Model, Version: spec.Version, BillingMode: "output_count", UnitCredits: 10, Tiers: map[string]int{"480p": 10}, Enabled: true}}}, Channels: []model.ModelChannel{{ID: 901, Name: "original-channel", Protocol: "replicate", APIKey: "original-token", Enabled: true, Models: []string{spec.Model}, Weight: 1}}}}
	settings.Public.ModelChannel.ModelCosts = []model.ModelCost{{Model: spec.Model, Credits: 5}}
	settings.Private.Channels = append(settings.Private.Channels, model.ModelChannel{ID: 903, Protocol: "openai", Name: "same-model-openai", BaseURL: "https://ordinary.example", APIKey: "ordinary-key", Enabled: true, Weight: 1, Models: []string{spec.Model}})
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	calls, creates := 0, 0
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.URL.Host != "api.replicate.com" || request.Header.Get("Authorization") != "Bearer original-token" {
			t.Fatal("task used another provider or credential")
		}
		body := `{"id":"prediction-channel-test","status":"processing"}`
		if request.Method == http.MethodPost && request.URL.Path == "/v1/predictions" {
			creates++
		}
		if strings.HasSuffix(request.URL.Path, "/cancel") {
			body = `{"id":"prediction-channel-test","status":"canceled"}`
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	invoke := func(handler func(http.ResponseWriter, *http.Request), payload any) response {
		encoded, _ := json.Marshal(payload)
		request := httptest.NewRequest(http.MethodPost, "/api/v1/replicate/tasks", bytes.NewReader(encoded))
		request = request.WithContext(service.WithUser(request.Context(), model.PublicUser(user)))
		writer := httptest.NewRecorder()
		handler(writer, request)
		var result response
		if err := json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	for protocol, credits := range map[string]float64{"openai": 5, "replicate": 10} {
		result := invoke(ModelQuote, map[string]any{"protocol": protocol, "model": spec.Model, "resolution": "480", "seconds": "5"})
		if result.Code != 0 || result.Data.(map[string]any)["credits"] != credits {
			t.Fatal("same model name quoted the wrong protocol")
		}
	}
	input := map[string]any{"id": "replicate-channel-task", "operation": "text-to-video", "input": map[string]any{"prompt": "a product", "resolution": "480p", "num_frames": 81}, "expectedCredits": 10}
	if result := invoke(CreateReplicateTask, input); result.Code != 0 {
		t.Fatalf("create rejected: %s", result.Msg)
	}
	if result := invoke(CreateReplicateTask, input); result.Code != 0 || creates != 1 {
		t.Fatal("duplicate submission created a second prediction")
	}
	task, found, _ := repository.GetReplicateTask("replicate-channel-task")
	if !found || task.ChannelID != 901 || task.ChannelName != "original-channel" || task.PricingSnapshot == "" {
		t.Fatal("task lost its original channel or price snapshot")
	}
	settings.Private.Channels[0].Enabled = false
	settings.Private.Channels[0].Name = "renamed-channel"
	settings.Private.Channels = append(settings.Private.Channels, model.ModelChannel{ID: 902, Protocol: "replicate", Name: "another-account", APIKey: "another-token", Enabled: true, Models: []string{spec.Model}, AllowedGroups: []string{"vip"}})
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	if result := invoke(func(w http.ResponseWriter, r *http.Request) { ReadReplicateTask(w, r, task.ID) }, nil); result.Code != 0 {
		t.Fatal("disabled channel prevented recovery")
	}
	for i := 0; i < 2; i++ {
		if result := invoke(func(w http.ResponseWriter, r *http.Request) { CancelReplicateTask(w, r, task.ID) }, nil); result.Code != 0 {
			t.Fatal("original task cancellation failed")
		}
	}
	var current model.User
	db.First(&current, "id = ?", user.ID)
	var logs []model.CreditLog
	db.Where("user_id = ?", user.ID).Find(&logs)
	if current.Credits != 100 || len(logs) != 2 || calls != 3 {
		t.Fatalf("wrong refund or extra provider calls: balance=%d logs=%d calls=%d", current.Credits, len(logs), calls)
	}
	for _, log := range logs {
		var extra map[string]any
		_ = json.Unmarshal([]byte(log.Extra), &extra)
		if extra["channelId"] != float64(901) || extra["channelName"] != "original-channel" || strings.Contains(log.Extra, "token") {
			t.Fatal("charge/refund channel snapshot changed or exposed a secret")
		}
	}
	input["id"] = "replicate-channel-blocked-task"
	if result := invoke(CreateReplicateTask, input); result.Code == 0 || calls != 3 {
		t.Fatal("disabled/restricted channels accepted a new task")
	}
	db.First(&current, "id = ?", user.ID)
	if current.Credits != 100 {
		t.Fatal("unavailable channel charged credits")
	}
}
