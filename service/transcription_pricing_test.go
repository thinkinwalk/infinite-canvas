package service

import (
	"github.com/basketikun/infinite-canvas/model"
	"testing"
)

func TestTranscriptionPricingRequiresAdministratorActivation(t *testing.T) {
	spec, err := FindReplicateModel("transcribe")
	if err != nil {
		t.Fatal(err)
	}
	pricing := defaultReplicatePricing(spec)
	if pricing.Enabled || pricing.UnitCredits != 0 || pricing.MinimumCredits != 0 || pricing.BillingMode != "input_seconds" {
		t.Fatalf("cloud recognition must not silently introduce a tariff: %+v", pricing)
	}
	credits, err := calculateReplicateCredits(model.ReplicatePricing{BillingMode: "input_seconds", UnitCredits: 2}, map[string]any{"durationSeconds": 10.1})
	if err != nil || credits != 22 {
		t.Fatalf("input audio duration quote: %d, %v", credits, err)
	}
}
