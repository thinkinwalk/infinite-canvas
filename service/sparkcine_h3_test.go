package service

import (
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestSparkCineProfileAndPrice(t *testing.T) {
	channel := model.ModelChannel{BaseURL: "https://hi.hi.run/api/openai/v1", APIKey: "test", Enabled: true,
		Models: []string{"h3-video"}, VideoModels: map[string]model.VideoModelProfile{
			"h3-video": {Interface: "relay", MaxImages: 7, BillingMode: "duration_resolution", MinimumCredits: 24, BillingTiers: map[string]float64{"720": 6, "960": 48}},
		}}
	channel = normalizeModelChannel(channel)
	p := publicVideoProfiles([]model.ModelChannel{channel})["h3-video"]
	if p.Interface != SparkCineH3Interface || p.MaxImages != 9 || p.MaxVideos != 1 || p.MaxAudios != 3 || p.ContentReplacement == nil || !*p.ContentReplacement ||
		p.ReferenceVideoMinSeconds != 2 || p.ReferenceVideoMaxSeconds != 15 || len(p.Seconds) != 27 {
		t.Fatalf("incorrect verified capabilities: %+v", p)
	}
	for resolution, want := range map[string]int{"720": 30, "960": 240} {
		if credits, _, ok := VideoQuote(channel, "h3-video", resolution, "5"); !ok || credits != want {
			t.Fatalf("price changed: %d %v", credits, ok)
		}
	}
	disabled := false
	p.ContentReplacement, p.MaxImages, p.Seconds = &disabled, 2, []string{"5"}
	channel.VideoModels["h3-video"] = p
	p = VideoProfile(normalizeModelChannel(channel), "h3-video")
	if *p.ContentReplacement || p.MaxImages != 2 || len(p.Seconds) != 1 {
		t.Fatalf("admin restrictions were overridden: %+v", p)
	}
	channel.BaseURL = "https://unrelated.example/v1"
	channel.VideoModels["h3-video"] = model.VideoModelProfile{Interface: "relay", MaxImages: 12}
	if IsSparkCineH3(channel, "h3-video") || normalizeModelChannel(channel).VideoModels["h3-video"].MaxImages != 12 {
		t.Fatal("unrelated channels changed or generic seven-image cap remains")
	}
}

func TestSparkCineURLsAndSpecCombinations(t *testing.T) {
	for _, base := range []string{"https://hi.hi.run", "https://hi.hi.run/", "https://hi.hi.run/v1", "https://hi.hi.run/api/openai/v1", "https://hi.hi.run/api/h3"} {
		if got := SparkCineH3URL(model.ModelChannel{BaseURL: base}, "/v2/video_generation"); got != "https://hi.hi.run/api/h3/v2/video_generation" {
			t.Fatal(got)
		}
	}
	for _, spec := range []struct {
		resolution, ratio string
		seconds           float64
		valid             bool
	}{
		{"720", "16:9", 30, true}, {"480", "1:1", 30, true}, {"768", "21:9", 20, true}, {"1080", "9:16", 15, true},
		{"720", "1:1", 5, false}, {"768", "21:9", 21, false}, {"960", "16:9", 16, false}, {"1080", "16:9", 16, false},
		{"720", "16:9", 3, false}, {"720", "16:9", 4.5, false}, {"2K", "16:9", 5, false}, {"720", "7:5", 5, false},
	} {
		if err := SparkCineH3SpecError(spec.resolution, spec.ratio, spec.seconds); (err == nil) != spec.valid {
			t.Fatalf("%+v: %v", spec, err)
		}
	}
}

func TestReplacementCapabilityUsesModelIDAndSharedRoutes(t *testing.T) {
	yes, no := true, false
	p := model.VideoModelProfile{DisplayName: "自定义名称", Interface: "relay", MaxImages: 1, MaxVideos: 1}
	channel := model.ModelChannel{BaseURL: "https://a.example", APIKey: "test", Enabled: true, Models: []string{"wan30-720p", "future-video"},
		VideoModels: map[string]model.VideoModelProfile{"wan30-720p": p, "future-video": p}}
	if !*VideoProfile(channel, "wan30-720p").ContentReplacement || *VideoProfile(channel, "future-video").ContentReplacement {
		t.Fatal("replacement default depends on display name")
	}
	p.ContentReplacement = &yes
	channel.VideoModels["future-video"] = p
	other := channel
	other.BaseURL = "https://b.example"
	p.ContentReplacement = &no
	other.VideoModels = map[string]model.VideoModelProfile{"future-video": p}
	result := publicVideoProfiles([]model.ModelChannel{channel, other})["future-video"]
	if *result.ContentReplacement {
		t.Fatal("unsafe replacement capability exposed across weighted routes")
	}
}

func TestExplicitVideoCapabilityDoesNotRequireModelNameKeywords(t *testing.T) {
	yes := true
	channel := normalizeModelChannel(model.ModelChannel{BaseURL: "https://new-provider.example", APIKey: "test", Enabled: true,
		Models: []string{"future-model-123"}, VideoModels: map[string]model.VideoModelProfile{"future-model-123": {
			Interface: "relay", MaxImages: 12, MaxVideos: 1, ContentReplacement: &yes,
		}}})
	profiles := publicVideoProfiles([]model.ModelChannel{channel})
	if profiles["future-model-123"].MaxImages != 12 || !*profiles["future-model-123"].ContentReplacement {
		t.Fatal("explicit video profile was hidden by model-name guessing")
	}
	catalog := publicChannelModels(model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{channel}}}, "default")
	if len(catalog) != 1 || catalog[0].Capabilities[0] != "video" {
		t.Fatalf("incorrect model directory: %+v", catalog)
	}
}
