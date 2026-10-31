package repository

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

func deletionSettings() model.Settings {
	return model.Settings{Private: model.PrivateSetting{
		Channels: []model.ModelChannel{{ID: 81, Name: "unused-channel", Models: []string{"private-video"}}},
		ModelManagement: &model.ModelManagement{Enabled: true, Revision: 4,
			Routes:   []model.ManagedRoute{{ID: "route_unused", ChannelID: 81, Model: "private-video"}},
			Models:   []model.ManagedModel{{ID: "model_unused", DisplayName: "unused", RouteIDs: []string{"route_unused"}}},
			Bindings: []model.FeatureBinding{{FeatureID: "video.generate", ModelID: "model_unused", RouteIDs: []string{"route_unused"}}},
		},
	}}
}

func removeCatalogEntries(settings model.Settings) model.Settings {
	settings.Private.ModelManagement = &model.ModelManagement{Enabled: true, Revision: 4,
		Models: []model.ManagedModel{}, Routes: []model.ManagedRoute{}, Bindings: []model.FeatureBinding{},
	}
	return settings
}

func TestManagedDeletionUnusedCatalogAndChannel(t *testing.T) {
	setupRedemptionTestDB(t)
	saved := deletionSettings()
	if _, err := SaveSettings(saved, "before"); err != nil {
		t.Fatal(err)
	}
	next := removeCatalogEntries(saved)
	next.Private.Channels = nil
	result, err := SaveSettingsChecked(next, saved.Private.ModelManagement, "after")
	if err != nil || result.Private.ModelManagement.Revision != 5 {
		t.Fatalf("unused deletion failed: %+v %v", result, err)
	}
	stored, err := GetSettings()
	if err != nil || len(stored.Private.Channels) != 0 || len(stored.Private.ModelManagement.Models) != 0 {
		t.Fatalf("deletion not persisted: %+v %v", stored, err)
	}
	if _, err := SaveSettingsChecked(next, saved.Private.ModelManagement, "stale"); err == nil {
		t.Fatal("stale editor overwrote deletion")
	}
}

func TestManagedDeletionBlocksActiveTaskReferencesAndRollsBack(t *testing.T) {
	for _, test := range []struct {
		name   string
		record any
		label  string
	}{
		{"running-video", &model.VideoTask{ID: "task", PlatformModelID: "model_unused", Model: "private-video", ChannelID: 81, Status: "running"}, "视频任务"},
		{"cloud", &model.ReplicateTask{ID: "task", PlatformModelID: "model_unused", Status: "uncertain"}, "云模型任务"},
		{"cloud-generated", &model.ReplicateTask{ID: "task", PlatformModelID: "model_unused", Status: "generated"}, "云模型任务"},
		{"unknown-video-status", &model.VideoTask{ID: "task", Model: "private-video", ChannelID: 81, Status: "unknown"}, "视频任务"},
		{"unknown-cloud-status", &model.ReplicateTask{ID: "task", Model: "private-video", ChannelID: 81, Status: "unknown"}, "云模型任务"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupRedemptionTestDB(t)
			saved := deletionSettings()
			if _, err := SaveSettings(saved, "before"); err != nil {
				t.Fatal(err)
			}
			db, _ := DB()
			if err := db.Create(test.record).Error; err != nil {
				t.Fatal(err)
			}
			next := removeCatalogEntries(saved)
			next.Public.ModelChannel.DefaultVideoModel = "must-not-save"
			if _, err := SaveSettingsChecked(next, saved.Private.ModelManagement, "after"); err == nil || !strings.Contains(err.Error(), test.label) {
				t.Fatalf("reference not explained: %v", err)
			}
			stored, err := GetSettings()
			if err != nil || stored.Private.ModelManagement.Revision != 4 || len(stored.Private.ModelManagement.Models) != 1 || stored.Public.ModelChannel.DefaultVideoModel != "" {
				t.Fatalf("rejected deletion changed settings: %+v %v", stored, err)
			}
		})
	}
}

func TestManagedDeletionAllowsTerminalTaskHistoryAndBilling(t *testing.T) {
	for _, test := range []struct {
		name   string
		record any
	}{
		{"video-completed", &model.VideoTask{ID: "video-completed", PlatformModelID: "model_unused", Status: "completed"}},
		{"video-failed", &model.VideoTask{ID: "video-failed", Model: "private-video", ChannelID: 81, Status: "failed"}},
		{"cloud-completed", &model.ReplicateTask{ID: "cloud-completed", PlatformModelID: "model_unused", Status: "completed"}},
		{"cloud-failed", &model.ReplicateTask{ID: "cloud-failed", Model: "private-video", ChannelID: 81, Status: "failed"}},
		{"billing-consume", &model.CreditLog{ID: "consume", Type: model.CreditLogTypeAIConsume, Extra: `{"platformModelId":"model_unused","model":"private-video","channelId":81}`}},
		{"billing-refund", &model.CreditLog{ID: "refund", Type: model.CreditLogTypeAIRefund, Extra: `{"model":"private-video","channelId":81}`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupRedemptionTestDB(t)
			saved := deletionSettings()
			if _, err := SaveSettings(saved, "before"); err != nil {
				t.Fatal(err)
			}
			db, _ := DB()
			if err := db.Create(test.record).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := SaveSettingsChecked(removeCatalogEntries(saved), saved.Private.ModelManagement, "after"); err != nil {
				t.Fatalf("terminal history blocked deletion: %v", err)
			}
		})
	}
}

func TestManagedDeletionHandlesNullLegacyTaskFields(t *testing.T) {
	for _, test := range []struct {
		name   string
		record any
		table  string
		id     string
	}{
		{"video", &model.VideoTask{ID: "legacy-video", PlatformModelID: "model_unused", Model: "private-video", ChannelID: 81, Status: "completed"}, "video_tasks", "legacy-video"},
		{"cloud", &model.ReplicateTask{ID: "legacy-cloud", PlatformModelID: "model_unused", Model: "private-video", ChannelID: 81, Status: "completed"}, "replicate_tasks", "legacy-cloud"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupRedemptionTestDB(t)
			saved := deletionSettings()
			if _, err := SaveSettings(saved, "before"); err != nil {
				t.Fatal(err)
			}
			db, _ := DB()
			if err := db.Create(test.record).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Table(test.table).Where("id = ?", test.id).Updates(map[string]any{
				"platform_model_id": nil,
				"model":             nil,
				"channel_id":        nil,
				"status":            nil,
			}).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := SaveSettingsChecked(removeCatalogEntries(saved), saved.Private.ModelManagement, "after"); err != nil {
				t.Fatalf("nullable legacy history blocked deletion: %v", err)
			}
		})
	}
}

func TestManagedDeletionAllowsTerminalReplacementHistory(t *testing.T) {
	for _, data := range []string{
		`{"platformModelId":"model_unused","model":"private-video","channelId":81,"status":"completed"}`,
		`{"model":"private-video","channelId":81,"status":"failed"}`,
	} {
		t.Run(data, func(t *testing.T) {
			setupRedemptionTestDB(t)
			saved := deletionSettings()
			if _, err := SaveSettings(saved, "before"); err != nil {
				t.Fatal(err)
			}
			directory := filepath.Join(config.DataDir(), "replacement-jobs")
			if err := os.MkdirAll(directory, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory, "job.json"), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := SaveSettingsChecked(removeCatalogEntries(saved), saved.Private.ModelManagement, "after"); err != nil {
				t.Fatalf("terminal replacement history blocked deletion: %v", err)
			}
		})
	}
}

func TestManagedDeletionProtectsActiveOrUnreadableReplacementFiles(t *testing.T) {
	for _, data := range []string{
		`{"model":"private-video","channelId":81,"status":"paused"}`,
		`{"model":"private-video","channelId":81,"status":"completed","captionStatus":"rendering"}`,
		`{"invalid":`,
	} {
		t.Run(data, func(t *testing.T) {
			setupRedemptionTestDB(t)
			saved := deletionSettings()
			if _, err := SaveSettings(saved, "before"); err != nil {
				t.Fatal(err)
			}
			directory := filepath.Join(config.DataDir(), "replacement-jobs")
			if err := os.MkdirAll(directory, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory, "job.json"), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := SaveSettingsChecked(removeCatalogEntries(saved), saved.Private.ModelManagement, "after"); err == nil || !strings.Contains(err.Error(), "整片替换任务") {
				t.Fatalf("active or unreadable replacement job not protected: %v", err)
			}
		})
	}
}

func TestManagedDeletionAllowsIndependentSharedModel(t *testing.T) {
	setupRedemptionTestDB(t)
	saved := deletionSettings()
	_, _ = SaveSettings(saved, "before")
	db, _ := DB()
	if err := db.Create(&model.VideoTask{ID: "shared", PlatformModelID: "model_other", Model: "private-video", ChannelID: 81}).Error; err != nil {
		t.Fatal(err)
	}
	next := saved
	catalog := *saved.Private.ModelManagement
	catalog.Models, catalog.Bindings = nil, nil
	next.Private.ModelManagement = &catalog
	if _, err := SaveSettingsChecked(next, saved.Private.ModelManagement, "model-only"); err != nil {
		t.Fatalf("different stable model blocked independent deletion: %v", err)
	}
	stored, _ := GetSettings()
	catalog = *stored.Private.ModelManagement
	catalog.Routes = nil
	next = stored
	next.Private.ModelManagement = &catalog
	if _, err := SaveSettingsChecked(next, stored.Private.ModelManagement, "route"); err == nil || !strings.Contains(err.Error(), "视频任务") {
		t.Fatalf("shared upstream route not protected: %v", err)
	}
}

func TestManagedDeletionConfigurationReferences(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*model.Settings)
		want string
	}{
		{"enabled-model", func(s *model.Settings) { s.Private.ModelManagement.Models[0].Enabled = true }, "先保存停用平台模型"},
		{"enabled-route", func(s *model.Settings) { s.Private.ModelManagement.Routes[0].Enabled = true }, "先保存停用渠道模型"},
		{"enabled-channel", func(s *model.Settings) { s.Private.Channels[0].Enabled = true }, "先保存停用渠道"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupRedemptionTestDB(t)
			saved := deletionSettings()
			test.edit(&saved)
			_, _ = SaveSettings(saved, "before")
			next := removeCatalogEntries(saved)
			next.Private.Channels = nil
			if _, err := SaveSettingsChecked(next, saved.Private.ModelManagement, "after"); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("enabled configuration deletion accepted: %v", err)
			}
		})
	}
	t.Run("retained-model", func(t *testing.T) {
		setupRedemptionTestDB(t)
		saved := deletionSettings()
		_, _ = SaveSettings(saved, "before")
		catalog := *saved.Private.ModelManagement
		catalog.Routes = nil
		next := saved
		next.Private.ModelManagement = &catalog
		if _, err := SaveSettingsChecked(next, saved.Private.ModelManagement, "after"); err == nil || !strings.Contains(err.Error(), "仍被平台模型") {
			t.Fatalf("referenced route deletion accepted: %v", err)
		}
	})
}

func TestManagedDeletionIgnoresUnrelatedHistory(t *testing.T) {
	setupRedemptionTestDB(t)
	saved := deletionSettings()
	_, _ = SaveSettings(saved, "before")
	db, _ := DB()
	if err := db.Create(&model.VideoTask{ID: "other-channel", Model: "private-video", ChannelID: 82}).Error; err != nil {
		t.Fatal(err)
	}
	extra, _ := json.Marshal(map[string]any{"model": "another-model", "channelId": 82})
	if err := db.Create(&model.CreditLog{ID: "other-log", Type: model.CreditLogTypeAIConsume, Extra: string(extra)}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := SaveSettingsChecked(removeCatalogEntries(saved), saved.Private.ModelManagement, "after"); err != nil {
		t.Fatalf("unrelated history blocked deletion: %v", err)
	}
}

func TestManagedDeletionProtectsLegacyCloudChannel(t *testing.T) {
	setupRedemptionTestDB(t)
	saved := deletionSettings()
	saved.Private.Replicate.LegacyChannelID = 81
	_, _ = SaveSettings(saved, "before")
	db, _ := DB()
	if err := db.Create(&model.ReplicateTask{ID: "legacy", Status: "running"}).Error; err != nil {
		t.Fatal(err)
	}
	next := removeCatalogEntries(saved)
	next.Private.Channels = nil
	if _, err := SaveSettingsChecked(next, saved.Private.ModelManagement, "after"); err == nil || !strings.Contains(err.Error(), "云模型任务") {
		t.Fatalf("legacy credential channel was deleted: %v", err)
	}
}
