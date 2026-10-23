package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

func TestSparkCineVideoLifecycleOwnershipAndRefund(t *testing.T) {
	db := setupVideoLogTest(t)
	config.Cfg.PublicBaseURL = "https://platform.example"
	user := model.User{ID: "sparkcine-owner", Username: "sparkcine-owner", AffCode: "sparkcine-owner", Credits: 500, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	video := model.ReferenceMediaOwner{ID: "sparkcine-video.mp4", UserID: user.ID, MimeType: "video/mp4", Bytes: 1000, DurationSeconds: 5}
	if err := repository.SaveReferenceMediaOwner(video); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Where("user_id = ?", user.ID).Delete(&model.VideoTask{})
		db.Where("user_id = ?", user.ID).Delete(&model.ReferenceMediaOwner{})
		db.Where("id = ?", user.ID).Delete(&model.User{})
	})
	channel := model.ModelChannel{ID: 991, Name: "SparkCine", BaseURL: "https://hi.hi.run/api/openai/v1", APIKey: "private-sparkcine-key", Models: []string{"h3-video"}, Enabled: true, Weight: 1,
		VideoModels: map[string]model.VideoModelProfile{"h3-video": {Interface: "relay", BillingMode: "duration_resolution", BillingTiers: map[string]float64{"720": 6}, MinimumCredits: 24}}}
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{channel}}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	status, taskID, postCount, queryCount := "queued", "sparkcine-task-success", 0, 0
	reply := func(body string) *http.Response {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
	}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "hi.hi.run" || r.Header.Get("Authorization") != "Bearer "+channel.APIKey {
			t.Fatalf("lost pinned channel/authentication: %s", r.URL)
		}
		if r.Method == "POST" {
			postCount++
			if r.URL.Path != "/api/h3/v2/video_generation" {
				t.Fatal(r.URL)
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			content := body["content"].([]any)
			if body["resolution"] != "720P" || body["duration"] != float64(5) || body["ratio"] != "16:9" || len(content) != 14 ||
				content[0].(map[string]any)["text"] != "参考 <Picture 1> 人物与 <Video 1> 运镜，使用 <Audio 2>" ||
				content[1].(map[string]any)["role"] != "reference_image" ||
				content[1].(map[string]any)["image_url"].(map[string]any)["url"] != "https://cdn.example/1.png" ||
				content[10].(map[string]any)["url"] != config.Cfg.PublicBaseURL+"/api/media/references/"+video.ID ||
				content[10].(map[string]any)["video_url"] != nil || body["reference_videos"] != nil || body["input_mode"] != nil ||
				body["extra"].(map[string]any)["prompt_expansion_mode"] != "disabled" {
				t.Fatalf("incorrect H3 input: %+v", body)
			}
			return reply(`{"task_id":"` + taskID + `"}`), nil
		}
		queryCount++
		if r.URL.Path != "/api/h3/v2/query/video_generation/"+taskID {
			t.Fatal(r.URL)
		}
		return reply(`{"task":{"id":"` + taskID + `","status":"` + status + `","content":{"url":"https://cdn.example/fresh.mp4"},"error":{"code":"generation_failed","message":"模拟失败"}}}`), nil
	})}
	creditLogVideoClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://cdn.example/fresh.mp4" || r.Header.Get("Authorization") != "" {
			t.Fatalf("invalid CDN request or leaked API key: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(logTestMP4))}, nil
	})}
	request := func(method, path, body, owner string) *http.Request {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Expected-Credits", "30")
		return r.WithContext(service.WithUser(r.Context(), model.AuthUser{ID: owner, Group: "default"}))
	}
	payload := map[string]any{"model": "h3-video", "prompt": "参考 @图片1 人物与 @视频1 运镜，使用 @音频1", "resolution": "720p", "seconds": "5", "aspect_ratio": "16:9", "input_mode": "reference",
		"reference_videos":     []string{config.Cfg.PublicBaseURL + "/api/media/references/" + video.ID},
		"reference_image_urls": []string{"https://cdn.example/1.png", "https://cdn.example/2.png", "https://cdn.example/3.png", "https://cdn.example/4.png", "https://cdn.example/5.png", "https://cdn.example/6.png", "https://cdn.example/7.png", "https://cdn.example/8.png", "https://cdn.example/9.png"},
		"audio_urls":           []string{"https://cdn.example/1.mp3", "https://cdn.example/2.mp3", "https://cdn.example/3.mp3"}}
	makeTask := func() {
		w := httptest.NewRecorder()
		AIVideos(w, request("POST", "/api/v1/videos", string(mustReplacementJSON(payload)), user.ID))
		if videoResponseString(w.Body.Bytes(), "task_id") != taskID {
			t.Fatal(w.Body.String())
		}
	}
	makeTask()
	current, _, _ := repository.GetUserByID(user.ID)
	if current.Credits != 470 {
		t.Fatalf("incorrect charge: %d", current.Credits)
	}
	for _, owner := range []string{"other-owner", user.ID} {
		w := httptest.NewRecorder()
		AIVideo(w, request("GET", "/api/v1/videos/"+taskID, "", owner), taskID)
		if owner != user.ID && (queryCount != 0 || !strings.Contains(w.Body.String(), "不存在")) {
			t.Fatal("another user queried a task")
		}
		if owner == user.ID && videoResponseString(w.Body.Bytes(), "status") != "queued" {
			t.Fatal(w.Body.String())
		}
	}
	// Original tasks remain queryable after disabling a channel.
	settings.Private.Channels[0].Enabled = false
	_, _ = repository.SaveSettings(settings, "test")
	status = "succeeded"
	w := httptest.NewRecorder()
	AIVideoContent(w, request("GET", "/api/v1/videos/"+taskID+"/content", "", user.ID), taskID)
	if !bytes.Equal(w.Body.Bytes(), logTestMP4) || queryCount != 2 {
		t.Fatalf("content did not refresh query/download: %s", w.Body.String())
	}
	settings.Private.Channels[0].Enabled = true
	_, _ = repository.SaveSettings(settings, "test")
	taskID, status = "sparkcine-task-failed", "running"
	makeTask()
	status = "failed"
	for range 2 {
		AIVideo(httptest.NewRecorder(), request("GET", "/api/v1/videos/"+taskID, "", user.ID), taskID)
	}
	current, _, _ = repository.GetUserByID(user.ID)
	if current.Credits != 470 || postCount != 2 {
		t.Fatalf("refund duplicated or task resubmitted: credits=%d posts=%d", current.Credits, postCount)
	}
	// Bad video metadata, excess images and invalid output fail before charging or submission.
	for _, invalid := range []string{"duration", "images", "spec", "price"} {
		p := map[string]any{}
		_ = json.Unmarshal(mustReplacementJSON(payload), &p)
		switch invalid {
		case "duration":
			video.DurationSeconds = 15.001
			if err := db.Model(&model.ReferenceMediaOwner{}).Where("id = ?", video.ID).Update("duration_seconds", video.DurationSeconds).Error; err != nil {
				t.Fatal(err)
			}
		case "images":
			video.DurationSeconds = 5
			if err := db.Model(&model.ReferenceMediaOwner{}).Where("id = ?", video.ID).Update("duration_seconds", video.DurationSeconds).Error; err != nil {
				t.Fatal(err)
			}
			p["image_url"] = "https://cdn.example/10.png"
		case "spec":
			p["aspect_ratio"] = "1:1"
		case "price":
			p["seconds"] = "6"
		}
		w := httptest.NewRecorder()
		AIVideos(w, request("POST", "/api/v1/videos", string(mustReplacementJSON(p)), user.ID))
		if postCount != 2 || !strings.Contains(w.Body.String(), `"code":1`) {
			t.Fatalf("invalid %s submitted: %s", invalid, w.Body.String())
		}
		current, _, _ = repository.GetUserByID(user.ID)
		if current.Credits != 470 {
			t.Fatalf("invalid %s charged", invalid)
		}
	}
}

func TestSparkCineImageMentionsUseDocumentedPictureTokens(t *testing.T) {
	for _, nested := range []bool{false, true} {
		payload := map[string]any{
			"model": "h3-video", "resolution": "768p", "seconds": "5", "aspect_ratio": "9:16",
		}
		prompt := "以@图片1替换人物，图片9提供服装，保留<Picture 2>。"
		if nested {
			payload["content"] = []any{
				map[string]any{"type": "text", "text": prompt},
				map[string]any{"type": "image_url", "image_url": map[string]string{"url": "https://cdn.example/person.png"}, "role": "reference_image"},
			}
		} else {
			payload["prompt"], payload["image_url"] = prompt, "https://cdn.example/person.png"
		}
		body, err := sparkCineH3Body(mustReplacementJSON(payload), "owner")
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Content []struct {
				Text     string `json:"text"`
				Role     string `json:"role"`
				ImageURL struct {
					URL string `json:"url"`
				} `json:"image_url"`
			} `json:"content"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Content) != 2 || result.Content[0].Text != "以<Picture 1>替换人物，<Picture 9>提供服装，保留<Picture 2>。" ||
			result.Content[1].Role != "reference_image" || result.Content[1].ImageURL.URL != "https://cdn.example/person.png" {
			t.Fatalf("incorrect picture binding (nested=%t): %s", nested, body)
		}
	}
}

func TestSparkCineReplacementPlanKeepsReferenceWithinFifteenSeconds(t *testing.T) {
	setupVideoLogTest(t)
	config.Cfg.DatabaseDSN = t.TempDir() + "/app.db"
	channel := model.ModelChannel{ID: 992, Name: "spark-plan", BaseURL: "https://hi.hi.run/api/openai/v1", APIKey: "test", Enabled: true, Weight: 1,
		Models: []string{"h3-video"}, VideoModels: map[string]model.VideoModelProfile{"h3-video": {
			Interface: "relay", BillingMode: "duration_resolution", BillingTiers: map[string]float64{"720": 6, "1080": 64},
		}}}
	if _, err := repository.SaveSettings(model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{channel}}}, "test"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEO_WORKER_URL", "http://spark-worker.invalid")
	shape, end := `[1920,1080]`, `15`
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "spark-worker.invalid" {
			t.Fatal("planning submitted to a paid provider")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(
			`{"status":"completed","result":{"metadata":{"size":` + shape + `,"parts":[{"start":0,"end":` + end + `,"inputStart":0,"inputEnd":` + end + `,"seconds":30}]}}}`))}, nil
	})}
	ctx := service.WithUser(t.Context(), model.AuthUser{ID: "spark-plan-owner", Group: "default"})
	for _, scenario := range []struct {
		id, size, end, resolution string
		valid                     bool
	}{
		{"spark-plan-valid", `[1920,1080]`, `15`, "720", true},
		{"spark-plan-short", `[1080,1920]`, `1.1`, "1080", true},
		{"spark-plan-long", `[1920,1080]`, `15.001`, "720", false},
		{"spark-plan-square", `[1080,1080]`, `5`, "720", false},
		{"spark-plan-odd-ratio", `[1000,700]`, `5`, "480", false},
	} {
		shape, end = scenario.size, scenario.end
		job := replacementJob{ID: uuid.NewString(), UserID: "spark-plan-owner", Source: "source", Model: "h3-video", ChannelID: channel.ID, Seconds: "15", Resolution: scenario.resolution}
		err := executeReplacement(ctx, &job, true)
		if (err == nil) != scenario.valid {
			t.Fatalf("%s: %v", scenario.id, err)
		}
		if scenario.valid && (job.Parts[0].Seconds > 15 || job.Parts[0].Seconds < 4 || job.Credits <= 0 || job.Status != "ready") {
			t.Fatalf("invalid plan: %+v", job)
		}
	}
}

func TestSparkCineUnknownTasksAndUnverifiedReferences(t *testing.T) {
	setupVideoLogTest(t)
	config.Cfg.PublicBaseURL = "https://platform.example"
	for _, video := range []string{"http://cdn.example/a.mp4", "https://cdn.example/a.mp4", "https://platform.example/api/media/references/missing.mp4"} {
		if err := validateSparkCineReference("video", video, "owner"); err == nil {
			t.Fatal("unverified reference accepted", video)
		}
	}
	for _, address := range []string{"http://cdn.example/a.mp4", "https://user:secret@cdn.example/a.mp4", "file:///video.mp4"} {
		if _, err := sparkCineDownloadRequest(t.Context(), address); err == nil {
			t.Fatal("unsafe download accepted", address)
		}
	}
}
