package service

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestFetchAdminChannelModelsParsesOpenAIModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"z-model"},{"id":"a-model"},{"id":""}]}`))
	}))
	defer server.Close()

	models, err := fetchAdminChannelModels(model.ModelChannel{
		BaseURL: server.URL,
		APIKey:  "test-key",
	})
	if err != nil {
		t.Fatalf("fetchAdminChannelModels returned error: %v", err)
	}
	if want := []string{"a-model", "z-model"}; !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

func TestFetchAdminChannelModelsReportsArkPlanModelsUnsupported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/plan/v3/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	_, err := fetchAdminChannelModels(model.ModelChannel{
		BaseURL: server.URL + "/api/plan/v3/contents/generations/tasks",
		APIKey:  "test-key",
	})
	if err == nil {
		t.Fatal("expected unsupported /models error")
	}
	if !strings.Contains(err.Error(), "Agent Plan 未提供 OpenAI /models") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestAdminTextModelUsesResponsesEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`))
	}))
	defer server.Close()

	result, err := testAdminChannelModel(model.ModelChannel{BaseURL: server.URL, APIKey: "test-key"}, "gpt-test")
	if err != nil {
		t.Fatalf("testAdminChannelModel returned error: %v", err)
	}
	if result != "ok" {
		t.Fatalf("result = %q", result)
	}
}

func TestAdminTextModelFallsBackToChatCompletions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/responses":
			http.NotFound(w, r)
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	result, err := testAdminChannelModel(model.ModelChannel{BaseURL: server.URL, APIKey: "test-key"}, "gpt-test")
	if err != nil {
		t.Fatalf("testAdminChannelModel returned error: %v", err)
	}
	if !strings.Contains(result, "/chat/completions 兼容测试") || !strings.Contains(result, "自动转换") {
		t.Fatalf("result = %q", result)
	}
}

func TestTestVideoChannelModelUsesModelsEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/chat/completions" {
			t.Fatal("video model test should not call chat completions")
		}
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"grok-imagine-1.0-video"},{"id":"grok-imagine-video-1.5-fast"}]}`))
	}))
	defer server.Close()

	result, err := testVideoChannelModel(model.ModelChannel{
		BaseURL: server.URL,
		APIKey:  "test-key",
	}, "grok-imagine-video-1.5-fast")
	if err != nil {
		t.Fatalf("testVideoChannelModel returned error: %v", err)
	}
	if !strings.Contains(result, "/models") || !strings.Contains(result, "不会消耗额度") {
		t.Fatalf("result = %q", result)
	}
}

func TestAdminTestSeedanceOpenAICompatibleUsesModelsEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/chat/completions" {
			t.Fatal("Seedance OpenAI-compatible model test should not call chat completions")
		}
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"seedance-2.0-mini"}]}`))
	}))
	defer server.Close()

	result, err := AdminTestChannelModel(nil, model.ModelChannel{
		BaseURL: server.URL,
		APIKey:  "test-key",
	}, "seedance-2.0-mini")
	if err != nil {
		t.Fatalf("AdminTestChannelModel returned error: %v", err)
	}
	if !strings.Contains(result, "/models") || !strings.Contains(result, "不会消耗额度") {
		t.Fatalf("result = %q", result)
	}
}

func TestTestVideoChannelModelReportsMissingModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"other-video"}]}`))
	}))
	defer server.Close()

	_, err := testVideoChannelModel(model.ModelChannel{
		BaseURL: server.URL,
		APIKey:  "test-key",
	}, "grok-imagine-video-1.5-fast")
	if err == nil {
		t.Fatal("expected missing model error")
	}
	if !strings.Contains(err.Error(), "未返回模型 grok-imagine-video-1.5-fast") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestBuildModelChannelURLNormalizesArkPlanTaskPath(t *testing.T) {
	got := BuildModelChannelURL(model.ModelChannel{BaseURL: "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks?debug=1"}, "/models")
	want := "https://ark.cn-beijing.volces.com/api/plan/v3/models"
	if got != want {
		t.Fatalf("BuildModelChannelURL = %q, want %q", got, want)
	}
}

func TestNormalizeSettingsPublishesEnabledChannelModelsAndRepairsDefaults(t *testing.T) {
	settings := normalizeSettings(model.Settings{
		Public: model.PublicSetting{
			ModelChannel: model.PublicModelChannelSetting{
				AvailableModels:   []string{"grok-imagine-1.0-video", "disabled-model"},
				DefaultModel:      "grok-imagine-1.0-video",
				DefaultTextModel:  "missing-text",
				DefaultImageModel: "doubao-seedance-2.0-fast",
				DefaultVideoModel: "doubao-seedream-5.0-lite",
			},
		},
		Private: model.PrivateSetting{
			Channels: []model.ModelChannel{
				{Enabled: true, Models: []string{"gpt-5.5", "doubao-seedream-5.0-lite", "doubao-seedance-2.0-fast", "gpt-5.5"}},
				{Enabled: false, Models: []string{"disabled-model"}},
			},
		},
	})

	channel := settings.Public.ModelChannel
	wantModels := []string{"gpt-5.5", "doubao-seedream-5.0-lite", "doubao-seedance-2.0-fast"}
	if !reflect.DeepEqual(channel.AvailableModels, wantModels) {
		t.Fatalf("available models = %#v, want %#v", channel.AvailableModels, wantModels)
	}
	if channel.DefaultModel != "gpt-5.5" {
		t.Fatalf("default model = %q, want text model", channel.DefaultModel)
	}
	if channel.DefaultTextModel != "gpt-5.5" {
		t.Fatalf("default text model = %q, want text model", channel.DefaultTextModel)
	}
	if channel.DefaultImageModel != "doubao-seedream-5.0-lite" {
		t.Fatalf("default image model = %q, want seedream", channel.DefaultImageModel)
	}
	if channel.DefaultVideoModel != "doubao-seedance-2.0-fast" {
		t.Fatalf("default video model = %q, want seedance", channel.DefaultVideoModel)
	}
}

func TestNormalizeSettingsRecognizesNamedVideoModels(t *testing.T) {
	settings := normalizeSettings(model.Settings{
		Public: model.PublicSetting{
			ModelChannel: model.PublicModelChannelSetting{
				DefaultVideoModel: "missing-video",
			},
		},
		Private: model.PrivateSetting{
			Channels: []model.ModelChannel{
				{Enabled: true, Models: []string{"gpt-5.5", "tejiasd-mini-720p"}},
			},
		},
	})

	channel := settings.Public.ModelChannel
	if channel.DefaultVideoModel != "tejiasd-mini-720p" {
		t.Fatalf("default video model = %q, want tejiasd-mini-720p", channel.DefaultVideoModel)
	}
	if channel.DefaultTextModel != "gpt-5.5" {
		t.Fatalf("default text model = %q, want gpt-5.5", channel.DefaultTextModel)
	}
}

func TestModelChannelsForGroupFiltersRestrictedChannels(t *testing.T) {
	channels := []model.ModelChannel{
		{Enabled: true, BaseURL: "https://default.example.com", APIKey: "key", Models: []string{"video-model"}, AllowedGroups: []string{"default"}},
		{Enabled: true, BaseURL: "https://vip.example.com", APIKey: "key", Models: []string{"video-model", "vip-only"}, AllowedGroups: []string{"vip"}},
		{Enabled: true, BaseURL: "https://shared.example.com", APIKey: "key", Models: []string{"shared-model"}},
	}

	if got := modelChannelsForGroup(channels, "video-model", "vip"); len(got) != 1 || got[0].BaseURL != "https://vip.example.com" {
		t.Fatalf("VIP channels = %#v", got)
	}
	if got := enabledChannelModels(modelChannelsForGroup(channels, "", "vip")); !reflect.DeepEqual(got, []string{"video-model", "vip-only", "shared-model"}) {
		t.Fatalf("VIP models = %#v", got)
	}
}

func TestModelGroupAccessErrorIncludesGroupAndContact(t *testing.T) {
	err := modelGroupAccessError(
		"grok-imagine-video-1.5-preview",
		"vip",
		map[string]model.UserGroup{"vip": {Name: "VIP 用户", Enabled: true}},
		model.AdminContactSetting{QQ: "123456", Note: "工作日在线"},
	)
	message := err.Error()
	for _, expected := range []string{"grok-imagine-video-1.5-preview", "VIP 用户（vip）", "工作日在线", "管理员 QQ：123456"} {
		if !strings.Contains(message, expected) {
			t.Fatalf("error %q does not include %q", message, expected)
		}
	}
	if _, ok := err.(interface{ SafeMessage() string }); !ok {
		t.Fatalf("error does not expose a safe message: %T", err)
	}
}
