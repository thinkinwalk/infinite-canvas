package handler

import (
	"bytes"
	"context"
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
	"gorm.io/gorm"
)

var logTestMP4 = []byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")

func setupVideoLogTest(t *testing.T) *gorm.DB {
	t.Helper()
	previousConfig, previousAI, previousMedia := config.Cfg, aiHTTPClient, creditLogVideoClient
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: "file:video-log-tests?mode=memory&cache=shared"}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "app.db")
	settings, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := repository.SaveSettings(settings, "test-restore"); err != nil {
			t.Error(err)
		}
		config.Cfg, aiHTTPClient, creditLogVideoClient = previousConfig, previousAI, previousMedia
	})
	return db
}

func videoLogRequest(role model.UserRole) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/admin/credit-logs/test/video", nil)
	return r.WithContext(service.WithUser(r.Context(), model.AuthUser{ID: "video-log-admin", Role: role}))
}

func TestVideoCreditLogCreatePollAndRead(t *testing.T) {
	db := setupVideoLogTest(t)
	user := model.User{ID: "video-log-owner", Username: "video-log-owner", AffCode: "video-log-owner", Credits: 500, Group: "default", Status: model.UserStatusActive}
	channel := model.ModelChannel{ID: 414, Name: "video-log-channel", BaseURL: "https://video-log.example/v1", APIKey: "private-channel-key", Models: []string{"seedance-2.0-mini"}, Enabled: true, Weight: 1}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Where("user_id = ?", user.ID).Delete(&model.VideoTask{})
		db.Where("id = ?", user.ID).Delete(&model.User{})
	})
	if _, err := repository.SaveSettings(model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{channel}}}, "test"); err != nil {
		t.Fatal(err)
	}
	entry, err := service.ConsumeUserCreditsWithLog(user.ID, "seedance-2.0-mini", 200, "/videos", channel)
	if err != nil {
		t.Fatal(err)
	}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		body := `{"id":"video-log-created","status":"queued"}`
		if r.Method == http.MethodGet {
			if r.Header.Get("Authorization") != "Bearer "+channel.APIKey || r.URL.Path != "/v1/videos/video-log-created" {
				t.Fatalf("incorrect upstream request: %s", r.URL)
			}
			body = `{"data":{"status":"succeeded","content":{"video_url":"https://cdn.example/result.mp4?signature=private"}}}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	created := httptest.NewRecorder()
	request, err := http.NewRequest(http.MethodPost, channel.BaseURL+"/videos", nil)
	if err != nil {
		t.Fatal(err)
	}
	copyAIVideoCreateResponse(created, request, model.VideoTask{UserID: user.ID, Model: "seedance-2.0-mini", Credits: 200, Path: "/videos", ChannelID: channel.ID, ChannelName: channel.Name, ChannelBaseURL: channel.BaseURL}, entry.ID, func() { t.Fatal("unexpected refund") })
	linked, found, err := repository.GetCreditLog(entry.ID)
	if err != nil || !found || linked.RelatedID != "video-log-created" {
		t.Fatalf("task was not linked: %#v err=%v", linked, err)
	}
	pollRequest := httptest.NewRequest(http.MethodGet, "/api/v1/videos/video-log-created", nil)
	pollRequest = pollRequest.WithContext(service.WithUser(pollRequest.Context(), model.AuthUser{ID: user.ID, Role: model.UserRoleUser}))
	AIVideo(httptest.NewRecorder(), pollRequest, linked.RelatedID)
	task, found, err := repository.GetVideoTask(linked.RelatedID)
	if err != nil || !found || task.Status != "completed" || task.OutputURL != "https://cdn.example/result.mp4?signature=private" {
		t.Fatalf("result not persisted: %#v err=%v", task, err)
	}
	metadata := httptest.NewRecorder()
	AdminCreditLogVideo(metadata, videoLogRequest(model.UserRoleAdmin), entry.ID)
	if !strings.Contains(metadata.Body.String(), `"available":true`) || strings.Contains(metadata.Body.String(), "signature") || strings.Contains(metadata.Body.String(), channel.APIKey) {
		t.Fatalf("incorrect metadata: %s", metadata.Body.String())
	}
	creditLogVideoClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "" || r.URL.String() != task.OutputURL {
			t.Fatal("CDN request leaked channel credentials or used the wrong video")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/octet-stream"}}, Body: io.NopCloser(bytes.NewReader(logTestMP4))}, nil
	})}
	content := httptest.NewRecorder()
	AdminCreditLogVideoContent(content, videoLogRequest(model.UserRoleAdmin), entry.ID)
	if content.Code != 200 || content.Header().Get("Content-Type") != "video/mp4" || !bytes.Equal(content.Body.Bytes(), logTestMP4) {
		t.Fatalf("incorrect content: status=%d headers=%v body=%q", content.Code, content.Header(), content.Body.Bytes())
	}
	current, _, _ := repository.GetUserByID(user.ID)
	if current.Credits != 300 {
		t.Fatalf("viewing changed billing: credits=%d", current.Credits)
	}
}

func TestAdminVideoLogAccessAndStates(t *testing.T) {
	db := setupVideoLogTest(t)
	cases := []struct {
		name       string
		status     string
		owner      string
		related    bool
		wantStatus int
	}{
		{"pending", "pending", "video-log-user", true, http.StatusConflict},
		{"running", "running", "video-log-user", true, http.StatusConflict},
		{"failed", "failed", "video-log-user", true, http.StatusConflict},
		{"cancelled", "cancelled", "video-log-user", true, http.StatusConflict},
		{"expired", "expired", "video-log-user", true, http.StatusConflict},
		{"legacy", "completed", "video-log-user", false, http.StatusNotFound},
		{"wrong-owner", "completed", "another-user", true, http.StatusNotFound},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			id := "video-log-" + tt.name
			task := model.VideoTask{ID: id, UserID: tt.owner, Status: tt.status}
			entry := model.CreditLog{ID: id, UserID: "video-log-user", Type: model.CreditLogTypeAIConsume}
			if tt.related {
				entry.RelatedID = task.ID
			}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := repository.SaveCreditLog(entry); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				db.Where("id = ?", id).Delete(&model.CreditLog{})
				db.Where("id = ?", id).Delete(&model.VideoTask{})
			})
			for _, role := range []model.UserRole{model.UserRoleGuest, model.UserRoleUser} {
				for _, handler := range []func(http.ResponseWriter, *http.Request, string){AdminCreditLogVideo, AdminCreditLogVideoContent} {
					response := httptest.NewRecorder()
					handler(response, videoLogRequest(role), id)
					if response.Code != http.StatusForbidden {
						t.Fatalf("%s accessed media: status=%d", role, response.Code)
					}
				}
			}
			response := httptest.NewRecorder()
			AdminCreditLogVideoContent(response, videoLogRequest(model.UserRoleAdmin), id)
			if response.Code != tt.wantStatus {
				t.Fatalf("status=%d want=%d", response.Code, tt.wantStatus)
			}
		})
	}
}

func TestAdminVideoLogReadsCloudFileAndRejectsNonVideo(t *testing.T) {
	db := setupVideoLogTest(t)
	directory := filepath.Join(referenceDataDir(), "replicate-results")
	if err := os.MkdirAll(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "video-log.mp4"), logTestMP4, 0600); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"head-swap", "speech", "transcribe"} {
		id := "cloud-video-log-" + operation
		task := model.ReplicateTask{ID: id, UserID: "cloud-video-owner", Operation: operation, Status: "completed", ResultFile: "video-log.mp4", MimeType: "video/mp4"}
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		if _, err := repository.SaveCreditLog(model.CreditLog{ID: id, UserID: task.UserID, Type: model.CreditLogTypeAIConsume, RelatedID: id}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			db.Where("id = ?", id).Delete(&model.CreditLog{})
			db.Where("id = ?", id).Delete(&model.ReplicateTask{})
		})
		response := httptest.NewRecorder()
		AdminCreditLogVideoContent(response, videoLogRequest(model.UserRoleAdmin), id)
		if operation == "head-swap" {
			if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), logTestMP4) {
				t.Fatalf("could not read cloud video: %d", response.Code)
			}
		} else if response.Code != http.StatusNotFound {
			t.Fatalf("non-video task was exposed: %s", operation)
		}
	}
}

func TestAdminVideoLogRejectsUpstreamErrorsAndPrivateMedia(t *testing.T) {
	db := setupVideoLogTest(t)
	id := "video-log-invalid-upstream"
	if err := db.Create(&model.VideoTask{ID: id, UserID: id, Status: "completed", OutputURL: "https://cdn.example/error.mp4"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveCreditLog(model.CreditLog{ID: id, UserID: id, Type: model.CreditLogTypeAIConsume, RelatedID: id}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("id = ?", id).Delete(&model.CreditLog{})
		db.Where("id = ?", id).Delete(&model.VideoTask{})
	})
	for _, body := range []string{`{"error":"upstream-key"}`, "<html>expired</html>"} {
		creditLogVideoClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"video/mp4"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
		})}
		response := httptest.NewRecorder()
		AdminCreditLogVideoContent(response, videoLogRequest(model.UserRoleAdmin), id)
		if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), body) {
			t.Fatalf("invalid video was returned: %d %s", response.Code, response.Body.String())
		}
	}
	client := newCreditLogVideoClient()
	transport := client.Transport.(*http.Transport)
	for _, address := range []string{"127.0.0.1:80", "[::1]:80", "10.0.0.1:80", "100.64.0.1:80"} {
		conn, err := transport.DialContext(context.Background(), "tcp", address)
		if err == nil {
			conn.Close()
			t.Fatalf("connected to private media address %q", address)
		}
	}
}

func TestVideoResponseOutputURL(t *testing.T) {
	for _, payload := range []string{
		`{"video_url":"https://cdn.example/a.mp4"}`,
		`{"data":{"content":{"video_url":"https://cdn.example/a.mp4"}}}`,
		`{"video":{"url":"https://cdn.example/a.mp4"}}`,
		`{"result_url":"https://cdn.example/a.mp4"}`,
		`{"content":"https://cdn.example/a.mp4"}`,
	} {
		if got := videoResponseOutputURL([]byte(payload)); got != "https://cdn.example/a.mp4" {
			t.Fatalf("output URL for %s = %q", payload, got)
		}
	}
	data, err := json.Marshal(model.VideoTask{OutputURL: "private-signed-url"})
	if err != nil || bytes.Contains(data, []byte("private-signed-url")) {
		t.Fatalf("task exposed output URL: %s", data)
	}
}

func TestCreditLogVideoUsesAuthenticatedContentRoute(t *testing.T) {
	setupVideoLogTest(t)
	channel := model.ModelChannel{ID: 418, Name: "video-content-route", BaseURL: "https://video-log.example/v1", APIKey: "content-only-key"}
	if _, err := repository.SaveSettings(model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{channel}}}, "test"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"seedance-2.0-mini", "grok-imagine-video-1.5-preview", "grok-imagine-video-1.5-fast", "grok-imagine-1.0-video"} {
		task := model.VideoTask{ID: "authenticated-video", Model: name, ChannelName: channel.Name, ChannelBaseURL: channel.BaseURL}
		if strings.HasPrefix(name, "grok") {
			task.OutputURL = "https://cdn.example/unreliable.mp4"
		}
		request, client, err := creditLogVideoRequest(videoLogRequest(model.UserRoleAdmin), task)
		if err != nil {
			t.Fatal(err)
		}
		if client != aiHTTPClient || request.URL.Path != "/v1/videos/authenticated-video/content" || request.URL.Query().Get("model") != name || request.Header.Get("Authorization") != "Bearer "+channel.APIKey {
			t.Fatalf("wrong content route for %s: %s", name, request.URL)
		}
	}
}
