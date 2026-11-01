package service

import (
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestRetiredHeadSwapRejectsNewQuotesAndInputs(t *testing.T) {
	spec, err := FindReplicateModel("head-swap")
	if err != nil || !spec.Retired() || ProviderForModel(spec.Model) != "wavespeed" {
		t.Fatalf("historical provider identity lost: %+v %v", spec, err)
	}
	quote, err := QuoteReplicate(model.AuthUser{ID: "owner"}, spec, nil)
	if err != nil || quote.Available || quote.Credits != 0 || quote.Reason != RetiredHeadSwapMessage || quote.SubmissionBlocked != RetiredHeadSwapMessage {
		t.Fatalf("retired quote accepted: %+v %v", quote, err)
	}
	for _, validate := range []func(string, ReplicateModel, map[string]any) error{ValidateReplicateInput, ValidateReplicateQuoteInput} {
		if err := validate("owner", spec, nil); err == nil || !strings.Contains(err.Error(), RetiredHeadSwapMessage) {
			t.Fatalf("retired input accepted: %v", err)
		}
	}
	for _, name := range []string{"wan30-720p", "wan-video/wan-2.2-animate-replace", "sync/lipsync-2"} {
		if (ReplicateModel{Model: name}).Retired() {
			t.Fatalf("unrelated model retired: %s", name)
		}
	}
}

func TestManagedCatalogRetiresHeadSwapWithoutChangingWan30OrSettings(t *testing.T) {
	previous := config.Cfg
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", ":memory:"
	t.Cleanup(func() { config.Cfg = previous })
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, "restore") })
	settings := model.Settings{Private: model.PrivateSetting{
		Channels: []model.ModelChannel{
			{ID: 14, Protocol: "openai", BaseURL: "https://wan30.invalid", APIKey: "test", Enabled: true, Models: []string{"wan30-720p"}, Weight: 1},
			{ID: 19, Protocol: "wavespeed", BaseURL: WaveSpeedBaseURL, APIKey: "test", Enabled: true, Models: []string{"wavespeed-ai/video-head-swap"}, Weight: 1},
		},
		ModelManagement: &model.ModelManagement{Enabled: true, Revision: 20,
			Routes: []model.ManagedRoute{
				{ID: "wan30", ChannelID: 14, Model: "wan30-720p", Adapter: "video.wan30", Capability: "video", Operations: []string{"video"}, Enabled: true},
				{ID: "face", ChannelID: 19, Model: "wavespeed-ai/video-head-swap", Adapter: "cloud:head-swap", Capability: "video", Operations: []string{"head-swap"}, Enabled: true},
			},
			Models: []model.ManagedModel{
				{ID: "model_wan30", DisplayName: "wan30-720p", Enabled: true, RouteIDs: []string{"wan30"}, Pricing: model.ManagedPricing{Configured: true, Credits: 80}},
				{ID: "model_face", DisplayName: "历史换脸", Enabled: true, RouteIDs: []string{"face"}, Pricing: model.ManagedPricing{Configured: true, Credits: 1120}},
			},
			Bindings: []model.FeatureBinding{
				{FeatureID: "replace.person", ModelID: "model_wan30", RouteIDs: []string{"wan30"}, Enabled: true, Default: true},
				{FeatureID: "replace.head", ModelID: "model_face", RouteIDs: []string{"face"}, Enabled: true, Default: true},
			},
		},
	}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	catalog, err := ManagedPublicCatalog(settings, "default")
	if err != nil || catalog == nil || len(catalog.Bindings) != 2 {
		t.Fatalf("catalog missing: %+v %v", catalog, err)
	}
	if !catalog.Bindings[0].Available || !catalog.Bindings[0].Default || catalog.Bindings[0].Adapter != "video.wan30" || catalog.Bindings[0].Credits != 80 {
		t.Fatalf("Wan30 configuration changed: %+v", catalog.Bindings[0])
	}
	if catalog.Bindings[1].Available || catalog.Bindings[1].Reason != RetiredHeadSwapMessage {
		t.Fatalf("head swap is still offered: %+v", catalog.Bindings[1])
	}
	stored, err := repository.GetSettings()
	if err != nil || !stored.Private.ModelManagement.Bindings[1].Enabled || stored.Private.ModelManagement.Revision != 20 {
		t.Fatalf("public catalog changed stored settings: %v", err)
	}
}
