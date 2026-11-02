package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func TestAdminChannelAPIKeyHTTP(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:", JWTSecret: "channel-key-test"}
	t.Cleanup(func() { config.Cfg = previous })
	t.Setenv("REPLICATE_API_TOKEN", "test-environment-token")
	t.Setenv("WAVESPEED_API_KEY", "test-wavespeed-token")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, "") })
	settings := model.Settings{Private: model.PrivateSetting{
		Replicate: model.ReplicateSetting{ChannelsInitialized: true},
		Channels: []model.ModelChannel{
			{ID: 42, Protocol: "openai", Name: "same", APIKey: "second-channel-secret"},
			{ID: 14, Protocol: "openai", Name: "same", APIKey: "first-channel-secret"},
			{ID: 43, Protocol: "openai"},
			{ID: 44, Protocol: "replicate", UseEnvironmentKey: true},
			{ID: 45, Protocol: "wavespeed", UseEnvironmentKey: true},
			{ID: 46, Protocol: "replicate", APIKey: "explicit-token", UseEnvironmentKey: true},
		},
	}}
	if _, err := repository.SaveSettings(settings, ""); err != nil {
		t.Fatal(err)
	}
	tokenFor := func(role model.UserRole) string {
		t.Helper()
		id := uuid.NewString()
		user := model.User{ID: id, Username: id, AffCode: id, Role: role, Status: model.UserStatusActive, Group: "default"}
		if err := db.Create(&user).Error; err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Where("id = ?", id).Delete(&model.User{}) })
		token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{
			UserID: id, Username: id, Role: role,
			RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))},
		}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	admin, user := tokenFor(model.UserRoleAdmin), tokenFor(model.UserRoleUser)
	server := New()
	call := func(method, path, token, body string) (*httptest.ResponseRecorder, opsResponse) {
		t.Helper()
		request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		result := httptest.NewRecorder()
		server.ServeHTTP(result, request)
		var response opsResponse
		if err := json.Unmarshal(result.Body.Bytes(), &response); err != nil {
			t.Fatal("invalid API response")
		}
		return result, response
	}
	path := "/api/admin/settings/channel-key"
	for _, token := range []string{"", "invalid-token", user} {
		_, response := call(http.MethodPost, path, token, `{"channelId":14}`)
		if response.Code == 0 || bytes.Contains(response.Data, []byte("secret")) {
			t.Fatal("non-administrator could read a channel key")
		}
	}
	for _, test := range []struct{ body, expected string }{
		{`{"channelId":14}`, "first-channel-secret"},
		{`{"channelId":42}`, "second-channel-secret"},
		{`{"channelId":44}`, "test-environment-token"},
		{`{"channelId":45}`, "test-wavespeed-token"},
		{`{"channelId":46}`, "explicit-token"},
	} {
		result, response := call(http.MethodPost, path, admin, test.body)
		var key string
		_ = json.Unmarshal(response.Data, &key)
		if response.Code != 0 || key != test.expected {
			t.Fatal("administrator received the wrong channel key")
		}
		if result.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("channel key response can be cached")
		}
	}
	for _, body := range []string{`{`, `{}`, `{"channelId":0}`, `{"channelId":-1}`, `{"channelId":999}`, `{"channelId":43}`} {
		_, response := call(http.MethodPost, path, admin, body)
		if response.Code == 0 || string(response.Data) != "null" {
			t.Fatal("invalid channel request exposed a key or succeeded")
		}
	}
	_, response := call(http.MethodGet, "/api/admin/settings", admin, "")
	var redacted model.Settings
	if err := json.Unmarshal(response.Data, &redacted); err != nil || response.Code != 0 {
		t.Fatal("could not read redacted settings")
	}
	for _, channel := range redacted.Private.Channels {
		if channel.APIKey != "" || channel.ID != 43 && !channel.APIKeyConfigured {
			t.Fatal("regular settings leaked a key or lost its configured status")
		}
	}
	after, err := repository.GetSettings()
	if err != nil || !reflect.DeepEqual(after, settings) {
		t.Fatal("viewing channel keys changed stored settings")
	}
}
