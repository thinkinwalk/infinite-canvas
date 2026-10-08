package service

import (
	"testing"
	"github.com/basketikun/infinite-canvas/model"
)

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
	if result.MaxVideos != 0 || result.MaxAudios != 0 || len(result.Resolutions) != 1 || result.Resolutions[0] != "720" || len(result.Seconds) != 1 || result.Seconds[0] != "6" { t.Fatalf("unsafe capabilities: %+v", result) }
	other.Interface = "ark"
	channels[1].VideoModels["seedance-test"] = other
	if publicVideoProfiles(channels)["seedance-test"].Interface != "unavailable" { t.Fatal("incompatible routes advertised") }
}
