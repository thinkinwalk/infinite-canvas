package service

import (
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestCalculateReplicateCreditsByBillingMode(t *testing.T) {
	tests := []struct {
		name    string
		pricing model.ReplicatePricing
		input   map[string]any
		want    int
	}{
		{name: "characters", pricing: model.ReplicatePricing{BillingMode: "input_characters", UnitCredits: 70, MinimumCredits: 100}, input: map[string]any{"text": "一二三四五六七八九十"}, want: 100},
		{name: "output seconds", pricing: model.ReplicatePricing{BillingMode: "output_seconds", UnitCredits: 350, DefaultUnits: 10, MinimumCredits: 100}, input: map[string]any{"durationSeconds": 8}, want: 2800},
		{name: "output tier", pricing: model.ReplicatePricing{BillingMode: "output_count", UnitCredits: 180, Tiers: map[string]int{"base:480p": 180, "base:720p": 390}}, input: map[string]any{"variant": "base", "resolution": "720p"}, want: 390},
		{name: "topaz blocks", pricing: model.ReplicatePricing{BillingMode: "duration_resolution", DefaultUnits: 1, BlockSeconds: 5, Tiers: map[string]int{"1080p:30": 330}}, input: map[string]any{"durationSeconds": 12, "target_resolution": "1080p", "target_fps": 30}, want: 990},
		{name: "missing variant uses base rather than highest tier", pricing: model.ReplicatePricing{BillingMode: "output_count", Tiers: map[string]int{"base:480p": 180, "interpolate:480p": 230, "base:720p": 390, "interpolate:720p": 510}}, input: map[string]any{"resolution": "480p"}, want: 180},
		{name: "actual interpolate flag selects tier", pricing: model.ReplicatePricing{BillingMode: "output_count", Tiers: map[string]int{"base:720p": 390, "interpolate:720p": 510}}, input: map[string]any{"resolution": "720p", "interpolate_output": true}, want: 510},
		{name: "topaz 24 fps uses 30 tier", pricing: model.ReplicatePricing{BillingMode: "duration_resolution", BlockSeconds: 5, Tiers: map[string]int{"1080p:30": 330, "1080p:60": 660}}, input: map[string]any{"durationSeconds": 5.01, "target_resolution": "1080p", "target_fps": 24}, want: 660},
		{name: "topaz 48 fps uses 60 tier", pricing: model.ReplicatePricing{BillingMode: "duration_resolution", BlockSeconds: 5, Tiers: map[string]int{"1080p:30": 330, "1080p:60": 660}}, input: map[string]any{"durationSeconds": 5, "target_resolution": "1080p", "target_fps": 48}, want: 660},
		{name: "fractional seconds round up", pricing: model.ReplicatePricing{BillingMode: "output_seconds", UnitCredits: 70}, input: map[string]any{"durationSeconds": 2.01}, want: 210},
		{name: "unknown duration uses configured fallback", pricing: model.ReplicatePricing{BillingMode: "output_seconds", UnitCredits: 180, DefaultUnits: 60}, input: map[string]any{}, want: 10800},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := calculateReplicateCredits(test.pricing, test.input)
			if err != nil {
				t.Fatalf("calculate credits: %v", err)
			}
			if got != test.want {
				t.Fatalf("credits = %d, want %d", got, test.want)
			}
		})
	}
}

func TestReplicatePricingUsesOwnedMediaDuration(t *testing.T) {
	previous := config.Cfg
	config.Cfg.DatabaseDSN = ":memory:"
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.PublicBaseURL = "https://test.example"
	t.Cleanup(func() { config.Cfg = previous })
	for _, item := range []model.ReferenceMediaOwner{
		{ID: "voice.wav", UserID: "user", MimeType: "audio/wav", DurationSeconds: 7.25},
		{ID: "video.mp4", UserID: "user", MimeType: "video/mp4", DurationSeconds: 10.1},
		{ID: "other.mp4", UserID: "other", MimeType: "video/mp4", DurationSeconds: 120},
		{ID: "photo.png", UserID: "user", MimeType: "image/png"},
	} {
		if err := repository.SaveReferenceMediaOwner(item); err != nil {
			t.Fatal(err)
		}
	}
	input := map[string]any{"audio": "https://test.example/api/media/references/voice.wav", "video": "https://test.example/api/media/references/video.mp4"}
	pricingInput, duration := replicatePricingInput("user", ReplicateModel{Operation: "lipsync"}, input)
	if duration != 10.1 || pricingInput["durationSeconds"] != 10.1 {
		t.Fatalf("unexpected duration: %v", duration)
	}
	if input["durationSeconds"] != nil {
		t.Fatal("pricing metadata must not mutate upstream input")
	}
	_, duration = replicatePricingInput("user", ReplicateModel{Operation: "digital-human"}, input)
	if duration != 7.25 {
		t.Fatalf("photo speech must use audio duration: %v", duration)
	}
	_, duration = replicatePricingInput("user", ReplicateModel{Operation: "upscale"}, map[string]any{"video": "https://test.example/api/media/references/other.mp4"})
	if duration != 0 {
		t.Fatal("another user's media must never supply billing duration")
	}
	config.Cfg.PublicBaseURL = "http://127.0.0.1:8080"
	spec, _ := FindReplicateModel("digital-human")
	localInput := map[string]any{"prompt": "speaking", "audio": config.Cfg.PublicBaseURL + "/api/media/references/voice.wav", "image": config.Cfg.PublicBaseURL + "/api/media/references/photo.png"}
	if err := ValidateReplicateQuoteInput("user", spec, localInput); err != nil {
		t.Fatalf("owned local uploads must support quotes: %v", err)
	}
	if err := ValidateReplicateInput("user", spec, localInput); err == nil {
		t.Fatal("cloud submission must still reject HTTP uploads")
	}
	if err := ValidateReplicateQuoteInput("other", spec, localInput); err == nil {
		t.Fatal("quotes must retain ownership checks")
	}
}

func TestNormalizeReplicatePricingIncludesPinnedModels(t *testing.T) {
	settings := normalizeReplicatePricing(model.ReplicateSetting{})
	for _, spec := range ReplicateModels() {
		pricing, ok := settings.Pricing[spec.Model]
		if !ok || pricing.Model != spec.Model || pricing.Version != spec.Version {
			t.Fatalf("missing pinned pricing for %s: %+v", spec.Model, pricing)
		}
	}
	if settings.Pricing["prunaai/vace-14b"].Enabled {
		t.Fatal("VACE should remain disabled until runtime billing is verified")
	}
}

func TestHailuoPricingAndSupportedSpecifications(t *testing.T) {
	spec, err := FindReplicateModel("hailuo-video")
	if err != nil {
		t.Fatal(err)
	}
	pricing := defaultReplicatePricing(spec)
	for _, item := range []struct {
		resolution string
		seconds    float64
		credits    int
	}{
		{"768p", 6, 800}, {"768p", 10, 1600}, {"1080p", 6, 1400},
	} {
		input := map[string]any{"prompt": "商品展示", "resolution": item.resolution, "duration": item.seconds}
		if err := ValidateReplicateInput("user", spec, input); err != nil {
			t.Fatal(err)
		}
		got, err := calculateReplicateCredits(pricing, input)
		if err != nil || got != item.credits {
			t.Fatalf("%v: credits %d, error %v", item, got, err)
		}
	}
	for _, input := range []map[string]any{
		{"prompt": "test", "resolution": "1080p", "duration": float64(10)},
		{"prompt": "test", "resolution": "720p", "duration": float64(6)},
		{"prompt": "test", "resolution": "768p", "duration": float64(5)},
		{"prompt": "test", "resolution": "768p", "duration": float64(6), "image": "https://example.com/test.png"},
	} {
		if err := ValidateReplicateInput("user", spec, input); err == nil {
			t.Fatalf("unsupported fields accepted: %v", input)
		}
	}
}
