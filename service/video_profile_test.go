package service

import (
	"github.com/basketikun/infinite-canvas/model"
	"testing"
)

func TestVideoQuoteUsesResolutionAndDurationRate(t *testing.T) {
	channel := model.ModelChannel{VideoModels: map[string]model.VideoModelProfile{
		"h3-video": {Interface: "relay", BillingMode: "duration_resolution", MinimumCredits: 6, BillingTiers: map[string]float64{"720": 1.5, "960": 12}},
	}}
	if got, _, ok := VideoQuote(channel, "h3-video", "720p", "5"); !ok || got != 8 {
		t.Fatalf("720p quote = %d, %v; want 8, true", got, ok)
	}
	if got, _, ok := VideoQuote(channel, "h3-video", "960", "5"); !ok || got != 60 {
		t.Fatalf("960p quote = %d, %v; want 60, true", got, ok)
	}
}

func TestH3Video2KOverridesStaleSpecsAndUsesFixedModelCost(t *testing.T) {
	channel := model.ModelChannel{VideoModels: map[string]model.VideoModelProfile{"H3video-2k": {Interface: "openai", Resolutions: []string{"1080"}, Seconds: []string{"5"}, BillingMode: "duration_resolution", BillingTiers: map[string]float64{"2K": 360}}}}
	profile := VideoProfile(channel, "H3video-2k")
	if profile.Interface != "relay" || len(profile.Resolutions) != 2 || profile.Resolutions[0] != "2K" || len(profile.Seconds) != 3 || profile.Seconds[0] != "15" || profile.MaxImages != 9 || profile.MaxVideos != 3 || profile.MaxAudios != 3 {
		t.Fatalf("incorrect H3 profile: %+v", profile)
	}
	for _, seconds := range []string{"5", "10", "15"} {
		if _, _, ok := VideoQuote(channel, "H3video-2k", "2K", seconds); ok {
			t.Fatal("H3 must use the configured per-request model price")
		}
	}
}

func TestWeightedVideoRoutesOnlyPublishSharedCapabilities(t *testing.T) {
	profile := model.VideoModelProfile{Interface: "relay", MaxImages: 7, MaxVideos: 3, MaxAudios: 3, Resolutions: []string{"480", "720"}, Seconds: []string{"5", "6"}}
	other := profile
	other.MaxVideos, other.MaxAudios = 0, 0
	other.Resolutions, other.Seconds = []string{"720"}, []string{"6"}
	channels := []model.ModelChannel{
		{Name: "A", BaseURL: "https://a.example", APIKey: "test", Enabled: true, Models: []string{"seedance-test"}, VideoModels: map[string]model.VideoModelProfile{"seedance-test": profile}},
		{Name: "B", BaseURL: "https://b.example", APIKey: "test", Enabled: true, Models: []string{"seedance-test"}, VideoModels: map[string]model.VideoModelProfile{"seedance-test": other}},
	}
	result := publicVideoProfiles(channels)["seedance-test"]
	if result.MaxVideos != 0 || result.MaxAudios != 0 || len(result.Resolutions) != 1 || result.Resolutions[0] != "720" || len(result.Seconds) != 1 || result.Seconds[0] != "6" {
		t.Fatalf("unsafe capabilities: %+v", result)
	}
	other.Interface = "ark"
	channels[1].VideoModels["seedance-test"] = other
	if publicVideoProfiles(channels)["seedance-test"].Interface != "unavailable" {
		t.Fatal("incompatible routes advertised")
	}
}
