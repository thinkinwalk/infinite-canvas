package service

import (
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestChannelIDsSurviveRenameReorderAndDeletion(t *testing.T) {
	setting := normalizePrivateSetting(model.PrivateSetting{Channels: []model.ModelChannel{
		{Name: "first"}, {Name: "second"},
	}})
	firstID, secondID := setting.Channels[0].ID, setting.Channels[1].ID
	if firstID <= 0 || secondID <= firstID {
		t.Fatalf("channel IDs must be positive and increasing: %d, %d", firstID, secondID)
	}
	setting.Channels[0].Name = "renamed"
	setting.Channels[0], setting.Channels[1] = setting.Channels[1], setting.Channels[0]
	setting = normalizePrivateSetting(setting)
	if setting.Channels[0].ID != secondID || setting.Channels[1].ID != firstID {
		t.Fatal("renaming or reordering changed channel IDs")
	}
	setting.Channels = append(setting.Channels[1:], model.ModelChannel{Name: "third"})
	setting = normalizePrivateSetting(setting)
	if setting.Channels[0].ID != firstID || setting.Channels[1].ID <= secondID {
		t.Fatal("deleting the highest ID changed an existing ID or reused a deleted ID")
	}
	thirdID := setting.Channels[1].ID
	setting.Channels = nil
	setting = normalizePrivateSetting(setting)
	setting.Channels = []model.ModelChannel{{Name: "fourth"}}
	setting = normalizePrivateSetting(setting)
	if setting.Channels[0].ID <= thirdID {
		t.Fatal("deleting every channel reset the channel ID sequence")
	}
}

func TestChannelAPIKeysFollowIDWhenNamesAndOrderChange(t *testing.T) {
	saved := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{
		{ID: 1, Name: "same", BaseURL: "https://example.com", APIKey: "first-key"},
		{ID: 2, Name: "same", BaseURL: "https://example.com", APIKey: "second-key"},
	}}}
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{
		{ID: 2, Name: "renamed", BaseURL: "https://example.com"},
		{ID: 1, Name: "same", BaseURL: "https://example.com"},
		{ID: 3, Name: "same", BaseURL: "https://example.com"},
	}}}
	keepPrivateAPIKeys(&settings, saved)
	if settings.Private.Channels[0].APIKey != "second-key" || settings.Private.Channels[1].APIKey != "first-key" {
		t.Fatal("channel API keys followed names or positions instead of IDs")
	}
	if settings.Private.Channels[2].APIKey != "" {
		t.Fatal("a new channel inherited another channel's API key")
	}
}
