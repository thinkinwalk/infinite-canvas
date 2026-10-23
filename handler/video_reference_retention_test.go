package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

func TestTemporaryVideoReferenceRetention(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = ":memory:"
	if _, err := repository.DB(); err != nil {
		t.Fatal(err)
	}
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "app.db")
	userID, id := uuid.NewString(), uuid.NewString()
	lease, err := changeTemporaryReference(userID, id, "use", "", "")
	if err != nil || lease.ExpiresAt < time.Now().Add(6*24*time.Hour).UnixMilli() {
		t.Fatalf("new lease = %+v, %v", lease, err)
	}
	lease, err = changeTemporaryReference(userID, id, "review", "", "")
	if err != nil || !lease.Reviewed || lease.ExpiresAt > time.Now().Add(25*time.Hour).UnixMilli() {
		t.Fatalf("review lease = %+v, %v", lease, err)
	}
	lease, err = changeTemporaryReference(userID, id, "keep", "", "")
	if err != nil || !lease.Keep {
		t.Fatalf("keep lease = %+v, %v", lease, err)
	}
	lease, err = changeTemporaryReference(userID, id, "use", "", "")
	if err != nil || !lease.Keep || lease.Reviewed {
		t.Fatalf("renewed pinned lease = %+v, %v", lease, err)
	}
	if _, err := referenceRetentionPath(userID, "../other"); err == nil {
		t.Fatal("unsafe reference ID accepted")
	}

	mediaID := uuid.NewString() + ".mp4"
	if err := os.MkdirAll(referenceMediaDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	managed := filepath.Join(referenceMediaDir(), mediaID)
	historical := filepath.Join(referenceMediaDir(), "historical.mp4")
	for _, file := range []string{managed, historical} {
		if err := os.WriteFile(file, []byte("reference"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := repository.SaveReferenceMediaOwner(model.ReferenceMediaOwner{ID: mediaID, UserID: userID}); err != nil {
		t.Fatal(err)
	}
	lease.Keep, lease.ExpiresAt, lease.Media = false, time.Now().Add(-time.Hour).UnixMilli(), []string{mediaID}
	path, _ := referenceRetentionPath(userID, id)
	data, _ := json.Marshal(lease)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	db, _ := repository.DB()
	task := model.VideoTask{ID: uuid.NewString(), UserID: userID, Status: "running"}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	checkStatus := func(want bool) {
		t.Helper()
		before, _ := os.ReadFile(path)
		request := httptest.NewRequest(http.MethodPost, "/api/v1/video/reference-retention", strings.NewReader(`{"id":"`+id+`","action":"status"}`))
		request = request.WithContext(service.WithUser(request.Context(), model.AuthUser{ID: userID}))
		recorder := httptest.NewRecorder()
		VideoReferenceRetention(recorder, request)
		var payload struct {
			Code int `json:"code"`
			Data struct {
				CanClean bool `json:"canClean"`
			} `json:"data"`
		}
		if json.Unmarshal(recorder.Body.Bytes(), &payload) != nil || payload.Code != 0 || payload.Data.CanClean != want {
			t.Fatalf("status = %s, want canClean=%v", recorder.Body.String(), want)
		}
		after, _ := os.ReadFile(path)
		if string(before) != string(after) {
			t.Fatal("status check changed the retention record")
		}
		if _, err := os.Stat(managed); err != nil {
			t.Fatal("status check deleted the reference")
		}
	}
	checkStatus(false)
	if err := cleanupTemporaryReferences(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(managed); err != nil {
		t.Fatal("active task lost its reference")
	}
	if err := db.Model(&task).Update("status", "completed").Error; err != nil {
		t.Fatal(err)
	}
	checkStatus(true)
	if err := cleanupTemporaryReferences(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(managed); !os.IsNotExist(err) {
		t.Fatalf("expired managed file survived: %v", err)
	}
	if _, err := os.Stat(historical); err != nil {
		t.Fatal("historical file was removed")
	}
	if _, found, err := repository.GetReferenceMediaOwner(mediaID); err != nil || found {
		t.Fatal("expired model URL still authorized")
	}
	if _, err := changeTemporaryReference(userID, id, "use", "", ""); err == nil {
		t.Fatal("cleaned reference was silently resurrected")
	}
}
