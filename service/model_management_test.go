package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestManagedConfigurationValidationRevisionAndBackup(t *testing.T) {
	previous := config.Cfg
	config.Cfg.DatabaseDSN, config.Cfg.StorageDriver = ":memory:", "sqlite"
	t.Cleanup(func() { config.Cfg = previous })
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	db, _ := repository.DB()
	t.Cleanup(func() {
		_, _ = repository.SaveSettings(saved, "restore")
		db.Where("key = ?", "model-management-original").Delete(&model.Setting{})
	})
	db.Where("key = ?", "model-management-original").Delete(&model.Setting{})
	disabled := false
	settings := model.Settings{Private: model.PrivateSetting{PromptSync: model.PromptSyncSetting{Enabled: &disabled}, Channels: []model.ModelChannel{{ID: 701, Name: "managed", Protocol: "openai", APIKey: "secret", BaseURL: "https://example.invalid/v1", Enabled: true, Weight: 1, Models: []string{"private-text"}}}}}
	_, _ = repository.SaveSettings(settings, "test")
	settings.Private.ModelManagement = &model.ModelManagement{Enabled: true,
		Routes:   []model.ManagedRoute{{ID: "route_text", ChannelID: 701, Model: "private-text", Adapter: "text.openai", Capability: "text", Operations: []string{"text"}, Enabled: true}},
		Models:   []model.ManagedModel{{ID: "model_text", DisplayName: "文案助手", DisplayMode: "alias", Enabled: true, RouteIDs: []string{"route_text"}, Pricing: model.ManagedPricing{Configured: true, Credits: 5}}},
		Bindings: []model.FeatureBinding{{FeatureID: "prompt.enhance", ModelID: "model_text", RouteIDs: []string{"route_text"}, Enabled: true, Default: true}},
	}
	result, err := SaveSettings(settings)
	if err != nil {
		t.Fatal(err)
	}
	if result.Private.ModelManagement.Revision != 1 {
		t.Fatal("revision was not incremented")
	}
	var backup model.Setting
	if err := db.Where("key = ?", "model-management-original").First(&backup).Error; err != nil {
		t.Fatal("missing transactional original settings backup", err)
	}
	var original model.Settings
	if json.Unmarshal(backup.Value, &original) != nil || original.Private.Channels[0].APIKey != "secret" || original.Private.ModelManagement != nil {
		t.Fatal("original backup corrupted")
	}
	if _, err := SaveSettings(settings); err == nil || !strings.Contains(err.Error(), "修改") {
		t.Fatal("stale editor overwrote catalog")
	}
	selected, err := ResolveManagedModel("prompt.enhance", "model_text", "default", 0)
	if err != nil || selected.Route.Model != "private-text" {
		t.Fatal(selected, err)
	}
	if _, err := ResolveManagedModel("image.generate", "model_text", "default", 0); err == nil {
		t.Fatal("cross-feature model accepted")
	}
	stored, _ := repository.GetSettings()
	stored.Private.ModelManagement.Models[0].DisplayName = "新名字"
	if _, err := SaveSettings(stored); err != nil {
		t.Fatal(err)
	}
	renamed, err := ResolveManagedModel("prompt.enhance", "model_text", "default", 0)
	if err != nil || renamed.Route.Model != "private-text" || renamed.Model.ID != selected.Model.ID {
		t.Fatal("rename changed identity")
	}
	proof := SignManagedQuote("owner", renamed, map[string]any{"seconds": "5"})
	if _, err := VerifyManagedQuote(proof, "other", map[string]any{"seconds": "5"}); err == nil {
		t.Fatal("quote accepted for another user")
	}
	if _, err := VerifyManagedQuote(proof, "owner", map[string]any{"seconds": "10"}); err == nil {
		t.Fatal("quote accepted modified input")
	}
	stored, _ = repository.GetSettings()
	stored.Private.ModelManagement.Models[0].Pricing.Configured = false
	if err := ValidateModelManagement(stored); err == nil {
		t.Fatal("unpriced enabled model accepted")
	}
}

func TestValidateManagedReferencesExplainsRemovedChannelModelDependency(t *testing.T) {
	saved := model.Settings{
		Private: model.PrivateSetting{
			Channels: []model.ModelChannel{{ID: 714, Name: "grok", Protocol: "openai", BaseURL: "https://example.invalid/v1", Enabled: true, Models: []string{"grok-imagine-video"}}},
			ModelManagement: &model.ModelManagement{
				Routes:   []model.ManagedRoute{{ID: "route_grok", ChannelID: 714, Model: "grok-imagine-video", Adapter: "video.relay", Capability: "video", Operations: []string{"video"}, Enabled: true}},
				Models:   []model.ManagedModel{{ID: "model_grok", DisplayName: "Grok 视频", RouteIDs: []string{"route_grok"}}},
				Bindings: []model.FeatureBinding{{FeatureID: "video.generate", ModelID: "model_grok", RouteIDs: []string{"route_grok"}, Enabled: true}},
			},
		},
	}
	next := saved
	next.Private.Channels = []model.ModelChannel{{ID: 714, Name: "grok", Protocol: "openai", BaseURL: "https://example.invalid/v1", Enabled: true, Models: []string{}}}

	err := validateManagedReferences(saved, next)
	if err == nil || !strings.Contains(err.Error(), "渠道模型 grok-imagine-video 仍被平台模型 Grok 视频 引用") {
		t.Fatalf("expected actionable model dependency error, got %v", err)
	}
}

func TestManagedPinnedRouteKeepsCommonSpecifications(t *testing.T) {
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, "restore") })
	profile := model.VideoModelProfile{Interface: "relay", MaxImages: 2, InputModes: []string{"reference"}, Resolutions: []string{"480", "720"}, Seconds: []string{"5", "10"}}
	other := profile
	other.Resolutions, other.Seconds = []string{"720"}, []string{"5"}
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{
		{ID: 710, Name: "first", Protocol: "openai", BaseURL: "https://first.invalid", APIKey: "fake", Models: []string{"private-video"}, Enabled: true, Weight: 1},
		{ID: 711, Name: "second", Protocol: "openai", BaseURL: "https://second.invalid", APIKey: "fake", Models: []string{"private-video"}, Enabled: true, Weight: 1},
	}, ModelManagement: &model.ModelManagement{Enabled: true, Revision: 2,
		Routes:   []model.ManagedRoute{{ID: "route_a", ChannelID: 710, Model: "private-video", Adapter: "video.relay", Capability: "video", Operations: []string{"video"}, Enabled: true, Video: &profile}, {ID: "route_b", ChannelID: 711, Model: "private-video", Adapter: "video.relay", Capability: "video", Operations: []string{"video"}, Enabled: true, Video: &other}},
		Models:   []model.ManagedModel{{ID: "model_video", DisplayName: "流光", DisplayMode: "alias", Enabled: true, RouteIDs: []string{"route_a", "route_b"}, Pricing: model.ManagedPricing{Configured: true, Credits: 5}}},
		Bindings: []model.FeatureBinding{{FeatureID: "video.generate", ModelID: "model_video", RouteIDs: []string{"route_a", "route_b"}, Enabled: true}},
	}}}
	_, _ = repository.SaveSettings(settings, "test")
	selected, err := ResolveManagedModel("video.generate", "model_video", "default", 710)
	if err != nil || selected == nil || selected.Channel.ID != 710 || strings.Join(selected.Profile.Seconds, ",") != "5" || strings.Join(selected.Profile.Resolutions, ",") != "720" {
		t.Fatalf("pinned route widened specs: %+v %v", selected, err)
	}
	if _, err := ResolveManagedModel("video.generate", "model_video", "default", 799); err == nil {
		t.Fatal("unknown quoted channel accepted")
	}
}

func TestManagedPreviewExcludesH3OnlyFromPersonReplacement(t *testing.T) {
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, "restore") })
	allowed := true
	profile := model.VideoModelProfile{Interface: "sparkcine_h3", ContentReplacement: &allowed, MaxImages: 9, MaxVideos: 1, InputModes: []string{"reference"}, Resolutions: []string{"720"}, Seconds: []string{"5"}}
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{{ID: 720, Name: "H3", Protocol: "openai", BaseURL: "https://example.invalid", APIKey: "fake", Enabled: true, Weight: 1, Models: []string{"h3-video"}, VideoModels: map[string]model.VideoModelProfile{"h3-video": profile}}}}, Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{ModelCosts: []model.ModelCost{{Model: "h3-video", Credits: 12}}}}}
	_, _ = repository.SaveSettings(settings, "test")
	preview, err := PreviewModelManagement()
	if err != nil {
		t.Fatal(err)
	}
	foundVideo := false
	for _, binding := range preview.Management.Bindings {
		if binding.FeatureID == "replace.person" {
			t.Fatal("H3 was imported for person replacement")
		}
		if binding.FeatureID == "video.generate" {
			foundVideo = true
		}
	}
	if !foundVideo || preview.Management.Enabled {
		t.Fatal("preview removed other H3 uses or activated automatically")
	}
	current, _ := repository.GetSettings()
	if current.Private.ModelManagement != nil {
		t.Fatal("preview wrote configuration")
	}
}

func TestManagedCloudVersionRejectsUnsupportedPinnedVersion(t *testing.T) {
	spec, err := FindReplicateModel("speech")
	if err != nil {
		t.Fatal(err)
	}
	settings := model.Settings{Private: model.PrivateSetting{
		Channels: []model.ModelChannel{{ID: 730, Protocol: "replicate", Models: []string{spec.Model}}},
		ModelManagement: &model.ModelManagement{Routes: []model.ManagedRoute{{
			ID: "route_speech", ChannelID: 730, Model: spec.Model, Version: "unsupported-version",
			Adapter: "cloud:speech", Capability: "audio", Operations: []string{"speech"}, Enabled: true,
		}}},
	}}
	if err := ValidateModelManagement(settings); err == nil {
		t.Fatal("unsupported pinned cloud version accepted")
	}
	settings.Private.ModelManagement.Routes[0].Version = spec.Version
	if err := ValidateModelManagement(settings); err != nil {
		t.Fatal(err)
	}
}

func TestManagedUnusedDeletionThroughSettingsService(t *testing.T) {
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	previous := config.Cfg
	config.Cfg.DatabaseDSN = t.TempDir() + "/test.db"
	t.Cleanup(func() {
		config.Cfg = previous
		_, _ = repository.SaveSettings(saved, "restore")
	})
	disabled := false
	settings := model.Settings{Private: model.PrivateSetting{
		PromptSync: model.PromptSyncSetting{Enabled: &disabled},
		Channels:   []model.ModelChannel{{ID: 761, Name: "unused", Protocol: "openai", APIKey: "fake", BaseURL: "https://example.invalid", Models: []string{"unused-text"}}},
		ModelManagement: &model.ModelManagement{Enabled: true, Revision: 4,
			Routes: []model.ManagedRoute{{ID: "route_unused", ChannelID: 761, Model: "unused-text", Adapter: "text.openai", Capability: "text", Operations: []string{"text"}}},
			Models: []model.ManagedModel{{ID: "model_unused", DisplayName: "unused", DisplayMode: "real", RouteIDs: []string{"route_unused"}}},
		},
	}}
	if _, err := repository.SaveSettings(settings, "before"); err != nil {
		t.Fatal(err)
	}
	settings.Private.ModelManagement.Routes[0].Model = "changed-identity"
	settings.Private.Channels[0].Models = []string{"changed-identity"}
	if _, err := SaveSettings(settings); err == nil || !strings.Contains(err.Error(), "真实身份不可") {
		t.Fatalf("identity protection changed: %v", err)
	}
	settings.Private.ModelManagement = &model.ModelManagement{Enabled: true, Revision: 4}
	settings.Private.Channels = nil
	result, err := SaveSettings(settings)
	if err != nil || result.Private.ModelManagement.Revision != 5 || len(result.Private.Channels) != 0 {
		t.Fatalf("unused model/route/channel could not be deleted through service: %+v %v", result, err)
	}
}
