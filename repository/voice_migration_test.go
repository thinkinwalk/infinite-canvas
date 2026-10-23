package repository

import (
	"path/filepath"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestVoiceMigrationPreservesLegacyDataAcrossReopen(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "migration.db")
	database, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := database.DB()
	t.Cleanup(func() { _ = connection.Close() })
	if err := database.AutoMigrate(&model.User{}, &model.CreditLog{}); err != nil {
		t.Fatal(err)
	}
	if err := database.Exec("CREATE TABLE replicate_tasks (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, credits INTEGER)").Error; err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "migration-owner", Username: "migration-owner", AffCode: "migration-owner", Credits: 123}
	if err := database.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Exec("INSERT INTO replicate_tasks (id,user_id,status,credits) VALUES (?,?,?,?)", "legacy-task", user.ID, "completed", 40).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.AutoMigrate(&model.ReplicateTask{}, &model.ClientAPIKey{}, &model.Voice{}); err != nil {
		t.Fatal(err)
	}
	voice := model.Voice{ID: "persisted-voice", UserID: user.ID, Version: "content-version", ReferenceFile: "private.wav", ReferenceText: "fixture"}
	key := model.ClientAPIKey{ID: "persisted-key", UserID: user.ID, Digest: "test-digest", Prefix: "test-prefix"}
	if err := database.Create(&voice).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&key).Error; err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	reopenedConnection, _ := reopened.DB()
	defer reopenedConnection.Close()
	if err := reopened.AutoMigrate(&model.ReplicateTask{}, &model.ClientAPIKey{}, &model.Voice{}); err != nil {
		t.Fatal(err)
	}
	var persistedUser model.User
	var persistedTask model.ReplicateTask
	var persistedVoice model.Voice
	var persistedKey model.ClientAPIKey
	for _, query := range []struct {
		target any
		id     string
	}{{&persistedUser, user.ID}, {&persistedTask, "legacy-task"}, {&persistedVoice, voice.ID}, {&persistedKey, key.ID}} {
		if err := reopened.First(query.target, "id = ?", query.id).Error; err != nil {
			t.Fatal(err)
		}
	}
	if persistedUser.Credits != 123 || persistedTask.Credits != 40 || persistedTask.Status != "completed" || persistedTask.SpeechVoiceID != "" || persistedVoice.Version != voice.Version || persistedVoice.ReferenceFile != voice.ReferenceFile || persistedKey.Digest != key.Digest {
		t.Fatal("migration or reopen changed durable user/task/voice/key data")
	}
	var check string
	if err := reopened.Raw("PRAGMA quick_check").Scan(&check).Error; err != nil || check != "ok" {
		t.Fatalf("database integrity check failed: %s %v", check, err)
	}
}
