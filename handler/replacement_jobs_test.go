package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

func replacementTestStorage(t *testing.T) {
	t.Helper()
	previous := config.Cfg
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "test.db")
	t.Cleanup(func() { config.Cfg = previous })
}

func TestReplacementPlanQuotesShortestSupportedSegmentsOnPinnedChannel(t *testing.T) {
	replacementTestStorage(t)
	config.Cfg.DatabaseDSN = ":memory:"
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, "test") })
	profile := model.VideoModelProfile{Interface: "relay", MaxImages: 1, MaxVideos: 1, Resolutions: []string{"720"}, Seconds: []string{"15", "4", "10"}, BillingMode: "duration_resolution", BillingTiers: map[string]float64{"720": 42}}
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{
		{ID: 711, Name: "pinned", BaseURL: "https://pinned.invalid", APIKey: "test", Enabled: true, Models: []string{"wan30-720p"}, Weight: 1, VideoModels: map[string]model.VideoModelProfile{"wan30-720p": profile}},
		{ID: 712, Name: "other", BaseURL: "https://other.invalid", APIKey: "test", Enabled: true, Models: []string{"wan30-720p"}, Weight: 100},
	}}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEO_WORKER_URL", "http://worker.invalid")
	previous := aiHTTPClient
	t.Cleanup(func() { aiHTTPClient = previous })
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "worker.invalid" {
			t.Fatal("planning called a generation provider")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","result":{"metadata":{"size":[1920,1080],"parts":[{"start":0,"end":2,"inputStart":0,"inputEnd":2,"seconds":15},{"start":2,"end":10,"inputStart":2,"inputEnd":10,"seconds":15}]}}}`))}, nil
	})}
	ctx := service.WithUser(context.Background(), model.AuthUser{ID: "owner", Group: "default"})
	job := replacementJob{ID: uuid.NewString(), UserID: "owner", Source: "source", Model: "wan30-720p", ChannelID: 711, Seconds: "15", Resolution: "720"}
	if err := executeReplacement(ctx, &job, true); err != nil {
		t.Fatal(err)
	}
	if job.Status != "ready" || job.Credits != 588 || job.Parts[0].Seconds != 4 || job.Parts[1].Seconds != 10 || job.AspectRatio != "16:9" {
		t.Fatalf("wrong plan or channel quote: %+v", job)
	}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		var request struct {
			Options map[string]any `json:"options"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Options["preserveScenes"] != false {
			t.Fatalf("Wan30 should pack short scenes: %+v, %v", request, err)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","result":{"metadata":{"size":[720,1280],"parts":[{"start":0,"end":15,"inputStart":0,"inputEnd":15,"seconds":15}]}}}`))}, nil
	})}
	whole := replacementJob{ID: uuid.NewString(), UserID: "owner", Source: "source", Model: "wan30-720p", ChannelID: 711, Seconds: "15", Resolution: "720"}
	if err := executeReplacement(ctx, &whole, true); err != nil || len(whole.Parts) != 1 || whole.Credits != 630 {
		t.Fatalf("15-second whole quote should be 630: %+v, %v", whole, err)
	}
	settings.Private.Channels[0].Enabled = false
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := quoteReplacementPart(ctx, &job, &job.Parts[0]); err == nil {
		t.Fatal("disabled original channel silently switched")
	}
}

func TestReplacementReviewRequiresOwnedCompletedResult(t *testing.T) {
	replacementTestStorage(t)
	job := replacementJob{ID: uuid.NewString(), UserID: "owner", Status: "paused"}
	if err := saveReplacement(&job); err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{"other", "owner"} {
		request := httptest.NewRequest(http.MethodPost, "/review", nil).WithContext(service.WithUser(context.Background(), model.AuthUser{ID: user}))
		ReplacementJobAction(httptest.NewRecorder(), request, job.ID, "review")
		saved, _ := loadReplacement(job.ID, "owner")
		if saved.Reviewed {
			t.Fatal("incomplete/unauthorized job marked reviewed")
		}
	}
	job.Status, job.Result = "completed", "result.mp4"
	if err := saveReplacement(&job); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/review", nil).WithContext(service.WithUser(context.Background(), model.AuthUser{ID: "owner"}))
	ReplacementJobAction(httptest.NewRecorder(), request, job.ID, "review")
	saved, _ := loadReplacement(job.ID, "owner")
	if !saved.Reviewed || saved.Result != job.Result {
		t.Fatal("completed result review was not persisted")
	}
}

func TestReplacementLostCreateResponseDoesNotResubmit(t *testing.T) {
	job := replacementJob{ID: uuid.NewString(), Parts: []replacementPart{{Input: "input", Prepared: "clean", Reference: "https://example.invalid/source", Submitted: true}}}
	previous := aiHTTPClient
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		t.Fatal("ambiguous create must not contact any provider")
		return nil, nil
	})}
	t.Cleanup(func() { aiHTTPClient = previous })
	err := executeReplacementPart(context.Background(), &job, 0)
	if err == nil || !strings.Contains(err.Error(), "不会重新创建") {
		t.Fatalf("lost response was not guarded: %v", err)
	}
}

func TestReplacementDiskRecoveryPreservesOwnershipAndPaidIDs(t *testing.T) {
	replacementTestStorage(t)
	job := replacementJob{ID: uuid.NewString(), UserID: "owner", Status: "running", Parts: []replacementPart{{TaskID: "paid-once", Submitted: true, Generated: "saved-result", Validated: true}}}
	if err := saveReplacement(&job); err != nil {
		t.Fatal(err)
	}
	if _, err := loadReplacement(job.ID, "other-user"); err == nil {
		t.Fatal("another user could read job")
	}
	restored, err := loadReplacement(job.ID, "owner")
	if err != nil {
		t.Fatal(err)
	}
	markReplacementPaused(&restored)
	if restored.Status != "paused" || restored.Parts[0].TaskID != "paid-once" || !restored.Parts[0].Validated {
		t.Fatal("restart lost successful work")
	}
}

func TestReplacementWorkerRecoveryReusesDurableID(t *testing.T) {
	replacementTestStorage(t)
	t.Setenv("VIDEO_WORKER_URL", "http://worker.invalid")
	previous := aiHTTPClient
	t.Cleanup(func() { aiHTTPClient = previous })
	ids := []string{}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		var input struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, input.ID)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"status":"completed","result":{"file":"existing.mp4"}}`)), Header: http.Header{}}, nil
	})}
	job := replacementJob{ID: uuid.NewString(), UserID: "owner"}
	for i := 0; i < 2; i++ {
		if _, err := replacementWorkerStep(context.Background(), &job, "extract-0", "replacement-extract", map[string]any{"video": "source"}, map[string]any{}); err != nil {
			t.Fatal(err)
		}
		var err error
		job, err = loadReplacement(job.ID, "owner")
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(ids) != 2 || ids[0] == "" || ids[0] != ids[1] {
		t.Fatal("worker recovery submitted a new job ID")
	}
}

func TestReplacementInterruptedSubtitlePreparationCannotBeSkippedOnRecovery(t *testing.T) {
	replacementTestStorage(t)
	t.Setenv("VIDEO_WORKER_URL", "http://worker.invalid")
	previous := aiHTTPClient
	t.Cleanup(func() { aiHTTPClient = previous })
	job := replacementJob{ID: uuid.NewString(), UserID: "owner", Subtitles: true, Parts: []replacementPart{{Input: "original.mp4"}}}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		persisted, err := loadReplacement(job.ID, job.UserID)
		if err != nil {
			t.Fatal(err)
		}
		if persisted.Parts[0].Prepared != "" {
			t.Fatal("unprocessed video was marked subtitle-cleaned before worker completion")
		}
		return &http.Response{StatusCode: 503, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"detail":"worker interrupted"}`))}, nil
	})}
	if err := executeReplacementPart(context.Background(), &job, 0); err == nil {
		t.Fatal("worker interruption ignored")
	}
	if job.Parts[0].Prepared != "" || job.Parts[0].Submitted {
		t.Fatal("failure allowed a paid submission")
	}
}

func TestReplacementNewSubtitleFlowPreservesCleanVideoWhenTranscriptionFails(t *testing.T) {
	replacementTestStorage(t)
	t.Setenv("VIDEO_WORKER_URL", "http://worker.invalid")
	previous := aiHTTPClient
	t.Cleanup(func() { aiHTTPClient = previous })
	operations := []string{}
	job := replacementJob{ID: uuid.NewString(), UserID: "owner", Source: "original.mp4", Subtitles: true, SubtitleMethod: "audio-after-generation", SubtitleOutput: "editable", Planned: true,
		Parts: []replacementPart{{Generated: "paid-output.mp4", Start: 0, End: 3, InputEnd: 3, Seconds: 3}}}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "worker.invalid" {
			t.Fatal("must not submit a paid generation")
		}
		var request struct {
			Operation string         `json:"operation"`
			Inputs    map[string]any `json:"inputs"`
			Options   map[string]any `json:"options"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		operations = append(operations, request.Operation)
		file := ""
		switch request.Operation {
		case "replacement-prepare":
			if request.Inputs["video"] != "original.mp4" || request.Options["subtitleMethod"] != job.SubtitleMethod {
				t.Fatalf("bad prepare: %+v", request)
			}
			file = "whole-clean.mp4"
		case "replacement-extract":
			if request.Inputs["video"] != "whole-clean.mp4" {
				t.Fatal("extract used unclean source")
			}
			file = "clean-part.mp4"
		case "replacement-validate":
		case "replacement-assemble":
			file = "assembled.mp4"
		case "replacement-finish":
			if request.Inputs["source"] != "original.mp4" || request.Inputs["video"] != "assembled.mp4" || request.Options["subtitleMethod"] != job.SubtitleMethod || request.Options["subtitleOutput"] != "editable" || len(request.Options["subtitles"].([]any)) != 0 {
				t.Fatalf("bad finish: %+v", request)
			}
			file = "clean-with-audio.mp4"
		case "replacement-transcribe":
			if request.Inputs["video"] != "original.mp4" {
				t.Fatalf("recognition must use original audio: %+v", request)
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"failed","error":"ASR failed"}`))}, nil
		default:
			t.Fatalf("unexpected operation %s", request.Operation)
		}
		body, _ := json.Marshal(map[string]any{"status": "completed", "result": map[string]any{"file": file, "metadata": map[string]any{"subtitleMethod": job.SubtitleMethod, "subtitleOutput": job.SubtitleOutput}}})
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}
	if err := executeReplacement(context.Background(), &job, false); err != nil {
		t.Fatalf("ASR failure should not fail the clean video delivery: %v", err)
	}
	if strings.Join(operations, ",") != "replacement-prepare,replacement-extract,replacement-validate,replacement-assemble,replacement-finish,replacement-transcribe" {
		t.Fatalf("wrong order: %v", operations)
	}
	saved, err := loadReplacement(job.ID, job.UserID)
	if err != nil || saved.Status != "completed" || saved.Result != "clean-with-audio.mp4" || saved.CaptionStatus != "failed" || saved.Assembled != "assembled.mp4" || saved.Parts[0].Generated != "paid-output.mp4" || !saved.Parts[0].Validated || saved.PreparedSource != "whole-clean.mp4" {
		t.Fatalf("results lost: %+v, %v", saved, err)
	}
	operations = nil
	if err := executeReplacement(context.Background(), &saved, false); err != nil || strings.Join(operations, ",") != "replacement-finish,replacement-transcribe" {
		t.Fatalf("resume should only rerun reversible post-processing: %v %v", operations, err)
	}
}

func TestReplacementNewSubtitleFlowRejectsOldWorkerBeforeGeneration(t *testing.T) {
	replacementTestStorage(t)
	t.Setenv("VIDEO_WORKER_URL", "http://worker.invalid")
	previous := aiHTTPClient
	t.Cleanup(func() { aiHTTPClient = previous })
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "worker.invalid" {
			t.Fatal("must not charge")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","result":{"file":"legacy.mp4"}}`))}, nil
	})}
	job := replacementJob{ID: uuid.NewString(), UserID: "owner", Source: "source.mp4", Subtitles: true, SubtitleMethod: "audio-after-generation", Parts: []replacementPart{{}}}
	if err := executeReplacement(context.Background(), &job, false); err == nil || job.PreparedSource != "" || job.Parts[0].Submitted {
		t.Fatalf("old worker accepted: %+v, %v", job, err)
	}
}

func TestReplacementCaptionEditsAreOwnedVersionedAndRenderedWithoutPaidModel(t *testing.T) {
	replacementTestStorage(t)
	t.Setenv("VIDEO_WORKER_URL", "http://worker.invalid")
	previous := aiHTTPClient
	t.Cleanup(func() { aiHTTPClient = previous })
	job := replacementJob{ID: uuid.NewString(), UserID: "owner", Source: "original.mp4", Result: "clean.mp4", Status: "completed", SubtitleOutput: "editable", CaptionStatus: "draft", CaptionRevision: 1,
		Parts: []replacementPart{{End: 3}}}
	if err := saveReplacement(&job); err != nil {
		t.Fatal(err)
	}
	input := `{"revision":1,"segments":[{"start":0.2,"end":1.5,"text":"人工校对"}],"size":38,"color":"#ffff00","bottom":0.12,"font":"Noto Sans CJK SC"}`
	for _, owner := range []string{"other", "owner"} {
		request := httptest.NewRequest(http.MethodPost, "/save-captions", strings.NewReader(input)).WithContext(service.WithUser(context.Background(), model.AuthUser{ID: owner}))
		ReplacementJobAction(httptest.NewRecorder(), request, job.ID, "save-captions")
		saved, _ := loadReplacement(job.ID, "owner")
		if owner == "other" && saved.CaptionRevision != 1 {
			t.Fatal("other user changed captions")
		}
		if owner == "owner" && (saved.CaptionRevision != 2 || saved.CaptionSegments[0].Text != "人工校对") {
			t.Fatalf("caption draft not saved: %+v", saved)
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/save-captions", strings.NewReader(input)).WithContext(service.WithUser(context.Background(), model.AuthUser{ID: "owner"}))
	ReplacementJobAction(httptest.NewRecorder(), request, job.ID, "save-captions")
	saved, _ := loadReplacement(job.ID, "owner")
	if saved.CaptionRevision != 2 {
		t.Fatal("stale edit overwrote new captions")
	}
	for _, action := range []string{"render-captions", "recognize-captions"} {
		request := httptest.NewRequest(http.MethodPost, "/"+action, strings.NewReader(`{"revision":1}`)).WithContext(service.WithUser(context.Background(), model.AuthUser{ID: "owner"}))
		response := httptest.NewRecorder()
		ReplacementJobAction(response, request, job.ID, action)
		if !strings.Contains(response.Body.String(), "字幕已在其他页面更新") {
			t.Fatalf("stale action accepted: %s", response.Body.String())
		}
	}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "worker.invalid" {
			t.Fatal("caption render called paid generation")
		}
		var request struct {
			Operation string         `json:"operation"`
			Inputs    map[string]any `json:"inputs"`
			Options   map[string]any `json:"options"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Operation != "replacement-render-captions" || request.Inputs["video"] != "clean.mp4" || request.Inputs["source"] != "original.mp4" || request.Options["subtitleBottom"] != 0.12 || request.Options["subtitleFont"] != "Noto Sans CJK SC" {
			t.Fatalf("wrong render: %+v", request)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","result":{"file":"captioned.mp4","metadata":{"subtitleOutput":"burned-in"}}}`))}, nil
	})}
	runReplacementCaptionRender(context.Background(), saved)
	saved, _ = loadReplacement(job.ID, "owner")
	if saved.CaptionResult != "captioned.mp4" || saved.Result != "clean.mp4" || saved.CaptionStatus != "completed" || saved.CaptionRevision != 2 {
		t.Fatalf("caption render changed clean result or draft: %+v", saved)
	}
}
