package handler

import (
	"context"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestSpeechRecoveryNeverResubmitsAndRefundsOnce(t *testing.T) {
	previousConfig, previousClient := config.Cfg, aiHTTPClient
	config.Cfg.DatabaseDSN, config.Cfg.StorageDriver = ":memory:", "sqlite"
	t.Cleanup(func() { config.Cfg, aiHTTPClient = previousConfig, previousClient })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "app.db")
	settings, _ := repository.GetSettings()
	t.Cleanup(func() { _, _ = repository.SaveSettings(settings, "test") })
	_, err = repository.SaveSettings(model.Settings{Private: model.PrivateSetting{
		Replicate: model.ReplicateSetting{ChannelsInitialized: true},
		Channels:  []model.ModelChannel{{ID: 812, Protocol: "replicate", APIKey: "mock-recovery-key", Enabled: false}},
	}}, "test")
	if err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "speech-recovery-user", Username: "speech-recovery-user", AffCode: "speech-recovery-user", Credits: 100, Role: model.UserRoleUser, Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.ReplicateTask{})
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Where("user_id = ?", user.ID).Delete(&model.Voice{})
		db.Delete(&user)
	})
	voice := model.Voice{ID: "speech-recovery-voice", UserID: user.ID, Version: "test-version"}
	if err := repository.SaveVoice(voice); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"speech-recovery-lost-submit", "speech-recovery-provider-failed"} {
		task := model.ReplicateTask{ID: id, UserID: user.ID, SpeechVoiceID: voice.ID, SpeechVoiceVersion: voice.Version, Operation: "speech", Model: "qwen/qwen3-tts", ChannelID: 812, Status: "creating", Credits: 10}
		if strings.HasSuffix(id, "failed") {
			task.Status, task.PredictionID = "running", "mock-existing-prediction"
		}
		if err := repository.CreateReplicateTask(task, model.CreditLog{ID: id + "-debit"}); err != nil {
			t.Fatal(err)
		}
	}
	gets := 0
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/predictions/mock-existing-prediction" {
			t.Fatal("recovery created another paid model task")
		}
		gets++
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"id":"mock-existing-prediction","status":"failed","error":"mock failure"}`))}, nil
	})}
	for i := 0; i < 2; i++ {
		if err := recoverSpeechTasks(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	uncertain, _, _ := repository.GetReplicateTask("speech-recovery-lost-submit")
	failed, _, _ := repository.GetReplicateTask("speech-recovery-provider-failed")
	var current model.User
	db.First(&current, "id = ?", user.ID)
	var refunds int64
	db.Model(&model.CreditLog{}).Where("user_id = ? AND type = ?", user.ID, model.CreditLogTypeAIRefund).Count(&refunds)
	if gets != 1 || uncertain.Status != "uncertain" || uncertain.Refunded || failed.Status != "failed" || !failed.Refunded || current.Credits != 90 || refunds != 1 {
		t.Fatalf("unsafe recovery: gets=%d uncertain=%s failed=%s balance=%d refunds=%d", gets, uncertain.Status, failed.Status, current.Credits, refunds)
	}
}
