package repository

import (
	"encoding/json"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestOfficialTryonSeedUsesSupplementaryFraming(t *testing.T) {
	setupRedemptionTestDB(t)
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&model.CaseApp{}).Where("id = ?", "official-tryon").Update("public_schema", `{"fields":[{"key":"framing","defaultValue":"full"}]}`).Error; err != nil {
		t.Fatal(err)
	}
	if err := seedOfficialCases(database); err != nil {
		t.Fatal(err)
	}
	item, ok, err := GetCaseByID("official-tryon")
	if err != nil || !ok {
		t.Fatalf("try-on case missing: found=%v err=%v", ok, err)
	}
	var schema struct {
		Fields []struct {
			Key         string `json:"key"`
			Placeholder string `json:"placeholder"`
			Default     string `json:"defaultValue"`
		} `json:"fields"`
	}
	if err := json.Unmarshal([]byte(item.PublicSchema), &schema); err != nil {
		t.Fatal(err)
	}
	promptFound := false
	poseDefaults := map[string]string{}
	for _, field := range schema.Fields {
		if field.Key == "framing" {
			t.Fatal("standalone framing survived reseeding")
		}
		if field.Key == "prompt" {
			promptFound = field.Placeholder != ""
		}
		poseDefaults[field.Key] = field.Default
	}
	if len(schema.Fields) != 12 || !promptFound {
		t.Fatal("try-on schema must keep supplementary instructions with an example")
	}
	if poseDefaults["poseMode"] != "preset" || poseDefaults["poseId"] != "front" {
		t.Fatal("try-on schema must default to front display pose")
	}
	if _, exists := poseDefaults["posePrompt"]; !exists {
		t.Fatal("try-on schema must support custom pose text")
	}
}

func TestOfficialProductSetSeedRemovesBatchFee(t *testing.T) {
	setupRedemptionTestDB(t)
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&model.CaseApp{}).Where("id = ?", "official-product-grid").Updates(map[string]any{
		"price_credits": 8, "member_price_credits": 6,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := seedOfficialCases(database); err != nil {
		t.Fatal(err)
	}
	productSet, ok, err := GetCaseByID("official-product-grid")
	if err != nil || !ok || productSet.PriceCredits != 0 || productSet.MemberPriceCredits != 0 {
		t.Fatalf("product-set batch fee should be removed: case=%+v found=%v err=%v", productSet, ok, err)
	}
	fashion, ok, err := GetCaseByID("official-fashion-scenes")
	if err != nil || !ok || fashion.PriceCredits != 3 {
		t.Fatalf("other case prices should remain unchanged: case=%+v found=%v err=%v", fashion, ok, err)
	}
}

func TestOfficialDetailPageSeedIsPublished(t *testing.T) {
	setupRedemptionTestDB(t)
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := seedOfficialCases(database); err != nil {
		t.Fatal(err)
	}
	item, ok, err := GetCaseByID("official-detail-page")
	if err != nil || !ok || item.Status != model.CaseStatusPublished || item.RuntimeConfig == "" || item.PriceCredits != 0 {
		t.Fatalf("detail page seed is unavailable: case=%+v found=%v err=%v", item, ok, err)
	}
}

func TestOfficialImageCaseIsRetired(t *testing.T) {
	setupRedemptionTestDB(t)
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := seedOfficialCases(database); err != nil {
		t.Fatal(err)
	}
	item, ok, err := GetCaseByID("official-ai-image")
	if err != nil || !ok {
		t.Fatalf("legacy image case should remain available for history: found=%v err=%v", ok, err)
	}
	if item.Status != model.CaseStatusOffline {
		t.Fatalf("legacy image case should be offline, got %s", item.Status)
	}
	items, _, err := ListPublishedCases(model.Query{PageSize: 60})
	if err != nil {
		t.Fatal(err)
	}
	for _, published := range items {
		if published.ID == "official-ai-image" {
			t.Fatal("retired AI image case must not be published")
		}
	}
}
