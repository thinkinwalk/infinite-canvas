package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

func TestRetiredHeadSwapSubmissionAndHistoricalRecovery(t *testing.T) {
	previousConfig, previousClient := config.Cfg, aiHTTPClient
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", ":memory:"
	t.Cleanup(func() { config.Cfg, aiHTTPClient = previousConfig, previousClient })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "media.db")
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, "restore") })
	spec, _ := service.FindReplicateModel("head-swap")
	settings := model.Settings{Private: model.PrivateSetting{
		Replicate: model.ReplicateSetting{ChannelsInitialized: true},
		Channels:  []model.ModelChannel{{ID: 19, Name: "historical", Protocol: "wavespeed", BaseURL: service.WaveSpeedBaseURL, APIKey: "test", Enabled: true, Models: []string{spec.Model}, Weight: 1}},
	}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: uuid.NewString(), Username: uuid.NewString(), AffCode: uuid.NewString(), Credits: 2000, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.ReplicateTask{})
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Delete(&user)
	})
	polls := 0
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || r.URL.Host != "api.wavespeed.ai" || !strings.Contains(r.URL.Path, "existing-prediction") {
			t.Fatalf("retirement created an unexpected provider request: %s %s", r.Method, r.URL)
		}
		polls++
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"code":200,"data":{"id":"existing-prediction","status":"processing"}}`))}, nil
	})}
	invoke := func(handler func(http.ResponseWriter, *http.Request), payload any) *httptest.ResponseRecorder {
		encoded, _ := json.Marshal(payload)
		r := httptest.NewRequest(http.MethodPost, "/api/v1/replicate/tasks", bytes.NewReader(encoded))
		r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
		w := httptest.NewRecorder()
		handler(w, r)
		return w
	}
	input := map[string]any{"video": "https://test.invalid/original.mp4", "face_image": "https://test.invalid/person.png", "resolution": "720p"}
	payload := map[string]any{"id": "retired-new-" + user.ID, "operation": "head-swap", "input": input, "expectedCredits": 1120}
	for _, handler := range []func(http.ResponseWriter, *http.Request){ReplicatePrice, CreateReplicateTask} {
		w := invoke(handler, payload)
		if !strings.Contains(w.Body.String(), service.RetiredHeadSwapMessage) || polls != 0 {
			t.Fatalf("new head swap accepted: %s", w.Body.String())
		}
	}
	w := invoke(ReplicateCatalog, nil)
	if strings.Contains(w.Body.String(), `"operation":"head-swap"`) {
		t.Fatal("public catalog still exposes head swap")
	}
	encoded, _ := json.Marshal(map[string]any{"operation": "head-swap", "input": input})
	hash := sha256.Sum256(encoded)
	task := model.ReplicateTask{ID: "retired-existing-" + user.ID, UserID: user.ID, Operation: "head-swap", Model: spec.Model, Version: spec.Version, ChannelID: 19, Status: "running", PredictionID: "existing-prediction", Credits: 1120, RequestHash: hex.EncodeToString(hash[:])}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	w = invoke(func(w http.ResponseWriter, r *http.Request) { ReadReplicateTask(w, r, task.ID) }, nil)
	if !strings.Contains(w.Body.String(), `"status":"running"`) || polls != 1 {
		t.Fatalf("historical polling failed: %s polls=%d", w.Body.String(), polls)
	}
	payload["id"] = task.ID
	w = invoke(CreateReplicateTask, payload)
	if !strings.Contains(w.Body.String(), `"code":0`) || polls != 1 {
		t.Fatalf("idempotent recovery failed: %s", w.Body.String())
	}
	task.Status, task.ResultFile, task.MimeType = "completed", "existing.mp4", "video/mp4"
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(referenceDataDir(), "replicate-results")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, task.ResultFile), []byte("existing-video"), 0600); err != nil {
		t.Fatal(err)
	}
	w = invoke(func(w http.ResponseWriter, r *http.Request) {
		r.Method = http.MethodGet
		ReplicateTaskContent(w, r, task.ID)
	}, nil)
	if w.Code != 200 || w.Body.String() != "existing-video" || polls != 1 {
		t.Fatalf("historical content lost: %d %s", w.Code, w.Body.String())
	}
	t.Setenv("VIDEO_WORKER_URL", "http://worker.invalid")
	workerCalls := 0
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "worker.invalid" || r.Method != http.MethodPost {
			t.Fatalf("batch recovery called a generation provider: %s %s", r.Method, r.URL)
		}
		workerCalls++
		body := `{"id":"recovered.mp4"}`
		if r.URL.Path == "/jobs" {
			var input struct {
				Operation string `json:"operation"`
			}
			if json.NewDecoder(r.Body).Decode(&input) != nil || input.Operation != "replacement-validate" {
				t.Fatal("recovery restarted generation or extraction")
			}
			body = `{"status":"completed","result":{}}`
		} else if r.URL.Path != "/media" {
			t.Fatalf("unexpected worker path: %s", r.URL.Path)
		} else {
			_, _ = io.Copy(io.Discard, r.Body)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	job := replacementJob{ID: uuid.NewString(), UserID: user.ID, Model: spec.Model, Planned: true, Status: "paused", Parts: []replacementPart{{Input: "original.mp4", Prepared: "original.mp4", Reference: "existing-reference", TaskID: task.ID, Submitted: true}}}
	if err := saveReplacement(&job); err != nil {
		t.Fatal(err)
	}
	if err := executeReplacementPart(service.WithUser(context.Background(), model.PublicUser(user)), &job, 0); err != nil || !job.Parts[0].Validated || job.Parts[0].Generated != "recovered.mp4" || workerCalls != 2 {
		t.Fatalf("submitted batch recovery failed: %+v calls=%d err=%v", job.Parts[0], workerCalls, err)
	}
	var current model.User
	var logs, newTasks int64
	db.First(&current, "id = ?", user.ID)
	db.Model(&model.CreditLog{}).Where("user_id = ?", user.ID).Count(&logs)
	db.Model(&model.ReplicateTask{}).Where("id = ?", "retired-new-"+user.ID).Count(&newTasks)
	if current.Credits != 2000 || logs != 0 || newTasks != 0 {
		t.Fatalf("retired requests changed billing: credits=%d logs=%d tasks=%d", current.Credits, logs, newTasks)
	}
}

func TestRetiredHeadSwapReplacementPartsOnlyRecoverExistingWork(t *testing.T) {
	job := replacementJob{ID: uuid.NewString(), UserID: "owner", Model: "wavespeed-ai/video-head-swap", Planned: true, Status: "paused", Parts: []replacementPart{{Credits: 1120}}}
	if err := validateReplacementRequest(context.Background(), &job); err == nil || err.Error() != service.RetiredHeadSwapMessage {
		t.Fatalf("new batch accepted: %v", err)
	}
	if _, err := quoteReplacementPart(context.Background(), &job, &job.Parts[0]); err == nil || err.Error() != service.RetiredHeadSwapMessage {
		t.Fatalf("paid redo accepted: %v", err)
	}
	if err := selectReplacementParts(&job, []int{0}, 1120); err == nil {
		t.Fatal("unsubmitted head segment accepted")
	}
	if err := executeReplacementPart(context.Background(), &job, 0); err == nil || err.Error() != service.RetiredHeadSwapMessage {
		t.Fatalf("new segment reached worker: %v", err)
	}
	job.Parts[0].Submitted, job.Parts[0].TaskID = true, "paid-once"
	if err := selectReplacementParts(&job, []int{0}, 0); err != nil {
		t.Fatalf("submitted segment recovery rejected: %v", err)
	}
	job.Parts[0].TaskID = ""
	if err := selectReplacementParts(&job, []int{0}, 0); err == nil {
		t.Fatal("unknown task identity accepted")
	}
}
