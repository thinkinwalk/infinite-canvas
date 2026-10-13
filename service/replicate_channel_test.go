package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestReplicateChannelImportPreservesCredentialsPricingAndID(t *testing.T) {
	t.Setenv("REPLICATE_API_TOKEN", "")
	setting := normalizePrivateSetting(model.PrivateSetting{NextChannelID: 8, Channels: []model.ModelChannel{{ID: 4, Protocol: "openai"}}, Replicate: model.ReplicateSetting{APIKey: "old-secret", Pricing: map[string]model.ReplicatePricing{"qwen/qwen3-tts": {Version: "original-version", UnitCredits: 123, Enabled: false}}}})
	channel := setting.Channels[1]
	if channel.ID != 8 || channel.APIKey != "old-secret" || channel.Protocol != "replicate" || len(channel.Models) != 13 {
		t.Fatal("credential import lost the original channel configuration")
	}
	if setting.Replicate.APIKey != "" || setting.Replicate.LegacyChannelID != channel.ID || setting.Replicate.Pricing["qwen/qwen3-tts"].Version != "original-version" || setting.Replicate.Pricing["qwen/qwen3-tts"].UnitCredits != 123 {
		t.Fatal("import changed pinned pricing or retained a second credential")
	}
	setting.Channels = setting.Channels[:1]
	setting = normalizePrivateSetting(setting)
	if len(setting.Channels) != 1 {
		t.Fatal("deleted channel was recreated")
	}
}

func TestReplicateEnvironmentChannelMustBeExplicitlyEnabled(t *testing.T) {
	t.Setenv("REPLICATE_API_TOKEN", "environment-secret")
	setting := normalizePrivateSetting(model.PrivateSetting{})
	if len(setting.Channels) != 1 || !setting.Channels[0].UseEnvironmentKey {
		t.Fatal("existing environment credential was not imported")
	}
	setting.Channels[0].Enabled = false
	if len(replicateChannelsForGroup(setting.Channels, "qwen/qwen3-tts", "default")) != 0 {
		t.Fatal("environment credential bypassed channel disable")
	}
	setting.Channels = nil
	setting = normalizePrivateSetting(setting)
	if len(setting.Channels) != 0 {
		t.Fatal("environment credential recreated a deleted channel")
	}
}

func TestReplicateDirectoryAndRoutingRespectModelGroupAndPricing(t *testing.T) {
	t.Setenv("REPLICATE_API_TOKEN", "")
	settings := normalizeSettings(model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{
		{ID: 1, Protocol: "replicate", Name: "cloud", APIKey: "secret", Enabled: true, Models: []string{"qwen/qwen3-tts", "wan-video/wan-2.7-videoedit", "minimax/hailuo-2.3"}, AllowedGroups: []string{"vip"}},
		{ID: 2, Protocol: "openai", BaseURL: "https://example.test", APIKey: "ordinary", Enabled: true, Models: []string{"plain-text"}},
	}}})
	settings.Private.Replicate.Pricing["qwen/qwen3-tts"] = model.ReplicatePricing{Version: "outdated", Enabled: true}
	if len(replicateChannelsForGroup(settings.Private.Channels, "minimax/hailuo-2.3", "default")) != 0 {
		t.Fatal("group restriction bypassed")
	}
	if len(replicateChannelsForGroup(settings.Private.Channels, "topazlabs/video-upscale", "vip")) != 0 {
		t.Fatal("model membership bypassed")
	}
	if len(modelChannelsForGroup(settings.Private.Channels, "minimax/hailuo-2.3", "vip")) != 0 {
		t.Fatal("Replicate model routed to an OpenAI endpoint")
	}
	catalog := publicChannelModels(settings, "vip")
	for _, item := range catalog {
		if item.Model == "qwen/qwen3-tts" {
			t.Fatal("outdated version advertised")
		}
		if item.Model == "wan-video/wan-2.7-videoedit" && len(item.Operations) != 2 {
			t.Fatal("video editor and subtitle removal were not merged")
		}
	}
	if len(catalog) != 3 || len(publicChannelModels(settings, "default")) != 1 {
		t.Fatalf("incorrect public model visibility: %+v", catalog)
	}
	encoded, _ := json.Marshal(catalog)
	if strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "apiKey") {
		t.Fatal("public directory exposed credentials")
	}
}

func TestReplicateTaskKeepsOriginalChannelAndGuardsDeletion(t *testing.T) {
	previous := config.Cfg
	config.Cfg.DatabaseDSN, config.Cfg.StorageDriver = ":memory:", "sqlite"
	t.Cleanup(func() { config.Cfg = previous })
	t.Setenv("REPLICATE_API_TOKEN", "")
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, now()) })
	settings := normalizeSettings(model.Settings{Private: model.PrivateSetting{Replicate: model.ReplicateSetting{ChannelsInitialized: true, LegacyChannelID: 51}, Channels: []model.ModelChannel{
		{ID: 51, Protocol: "replicate", Name: "original", APIKey: "original-key", Enabled: false, Models: []string{"qwen/qwen3-tts"}},
		{ID: 52, Protocol: "replicate", Name: "other", APIKey: "other-key", Enabled: true, Models: []string{"qwen/qwen3-tts"}},
	}}})
	if _, err := repository.SaveSettings(settings, now()); err != nil {
		t.Fatal(err)
	}
	task := model.ReplicateTask{ID: "channel-recovery-task", UserID: "owner", ChannelID: 51, ChannelName: "original", Status: "running"}
	db, _ := repository.DB()
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Delete(&task) })
	for _, id := range []int{51, 0} {
		channel, err := ResolveReplicateTaskChannel(model.ReplicateTask{ChannelID: id})
		if err != nil || channel.ID != 51 || channel.APIKey != "original-key" {
			t.Fatal("task changed accounts after channel disable")
		}
	}
	if _, err := ResolveReplicateTaskChannel(model.ReplicateTask{ChannelID: 999}); err == nil {
		t.Fatal("missing original channel silently switched accounts")
	}
	if err := validateReplicateChannels(settings.Private.Channels[1:], settings.Private); err == nil {
		t.Fatal("unfinished task channel was deleted")
	}
	selected, err := SelectReplicateChannel("qwen/qwen3-tts", "default")
	if err != nil || selected.ID != 52 {
		t.Fatal("new task used disabled channel")
	}
	settings.Private.Channels[0].Name = "renamed"
	if _, err := repository.SaveSettings(settings, now()); err != nil {
		t.Fatal(err)
	}
	channel, err := ResolveReplicateTaskChannel(task)
	if err != nil || channel.ID != 51 || task.ChannelName != "original" {
		t.Fatal("rename broke recovery or changed snapshot")
	}
}

func TestReplicateChannelSecretsFollowIDAndExplicitClear(t *testing.T) {
	saved := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{{ID: 1, Protocol: "replicate", APIKey: "first"}, {ID: 2, Protocol: "replicate", APIKey: "second"}}}}
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{{ID: 2, Protocol: "replicate"}, {ID: 1, Protocol: "replicate", ClearAPIKey: true}}}}
	keepPrivateAPIKeys(&settings, saved)
	if settings.Private.Channels[0].APIKey != "second" || settings.Private.Channels[1].APIKey != "" {
		t.Fatal("secret kept by position or clear request ignored")
	}
	if settings.Private.Channels[1].ClearAPIKey {
		t.Fatal("transient clear flag persisted")
	}
}

func TestReplicateChannelImportPersistsOnSaveWithoutLosingSecret(t *testing.T) {
	previous := config.Cfg
	config.Cfg.DatabaseDSN, config.Cfg.StorageDriver = ":memory:", "sqlite"
	t.Setenv("REPLICATE_API_TOKEN", "")
	t.Cleanup(func() { config.Cfg = previous })
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, now()) })
	disabled := false
	legacy := model.Settings{Private: model.PrivateSetting{NextChannelID: 75, PromptSync: model.PromptSyncSetting{Enabled: &disabled}, Replicate: model.ReplicateSetting{APIKey: "legacy-token"}}}
	if _, err := repository.SaveSettings(legacy, now()); err != nil {
		t.Fatal(err)
	}
	admin, err := AdminSettings()
	if err != nil || len(admin.Private.Channels) != 1 || admin.Private.Channels[0].APIKey != "" {
		t.Fatal("imported secret exposed to admin browser")
	}
	if _, err := SaveSettings(admin); err != nil {
		t.Fatal(err)
	}
	stored, _ := repository.GetSettings()
	if len(stored.Private.Channels) != 1 || stored.Private.Channels[0].ID != 75 || stored.Private.Channels[0].APIKey != "legacy-token" || stored.Private.Replicate.APIKey != "" {
		t.Fatal("saving redacted settings lost or duplicated legacy credentials")
	}
	admin, _ = AdminSettings()
	admin.Private.Channels[0].Models = []string{"unsupported/arbitrary-model"}
	if _, err := SaveSettings(admin); err == nil {
		t.Fatal("unsupported model was accepted")
	}
	admin, _ = AdminSettings()
	admin.Private.Channels[0].ClearAPIKey = true
	if _, err := SaveSettings(admin); err != nil {
		t.Fatal(err)
	}
	admin, _ = AdminSettings()
	if len(admin.Private.Channels) != 1 || admin.Private.Channels[0].APIKeyConfigured {
		t.Fatal("cleared credential was silently recreated")
	}
}
