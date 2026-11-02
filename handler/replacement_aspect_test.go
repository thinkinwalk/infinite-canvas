package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

func replacementAspectSetup(t *testing.T) context.Context {
	t.Helper()
	replacementTestStorage(t)
	config.Cfg.DatabaseDSN = ":memory:"
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, "test") })
	enabled := true
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{{
		ID: 711, Name: "pinned-h3", BaseURL: "https://hi.hi.run", APIKey: "test", Enabled: true,
		Models: []string{"h3-video", "minimax-h3", "wan30-720p", "wan30-1080p-fast", "custom-real-video"}, Weight: 1, VideoModels: map[string]model.VideoModelProfile{"h3-video": {
			Interface: "sparkcine_h3", MaxImages: 1, MaxVideos: 1, ContentReplacement: &enabled,
			Resolutions: []string{"720", "768"}, Seconds: []string{"5", "15"},
			BillingMode: "duration_resolution", BillingTiers: map[string]float64{"720": 6, "768": 6},
		}, "minimax-h3": {
			Interface: "relay", MaxImages: 9, MaxVideos: 3, ContentReplacement: &enabled,
			Resolutions: []string{"768"}, Seconds: []string{"5", "15"},
			BillingMode: "duration_resolution", BillingTiers: map[string]float64{"768": 6},
		}, "wan30-720p": {
			Interface: "relay", MaxImages: 1, MaxVideos: 1, ContentReplacement: &enabled,
			Resolutions: []string{"720"}, Seconds: []string{"5", "15"},
			BillingMode: "duration_resolution", BillingTiers: map[string]float64{"720": 6},
		}, "wan30-1080p-fast": {
			Interface: "relay", MaxImages: 1, MaxVideos: 1, ContentReplacement: &enabled,
			Resolutions: []string{"1080"}, Seconds: []string{"5", "15"},
			BillingMode: "duration_resolution", BillingTiers: map[string]float64{"1080": 6},
		}, "custom-real-video": {
			Interface: "relay", MaxImages: 1, MaxVideos: 1, ContentReplacement: &enabled,
			Resolutions: []string{"1080"}, Seconds: []string{"5", "15"},
			BillingMode: "duration_resolution", BillingTiers: map[string]float64{"1080": 6},
		}},
	}}}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEO_WORKER_URL", "http://worker.invalid")
	previous := aiHTTPClient
	t.Cleanup(func() { aiHTTPClient = previous })
	return service.WithUser(context.Background(), model.AuthUser{ID: "aspect-owner", Group: "default"})
}

func TestReplacementWan30AspectPlanAndSubmission(t *testing.T) {
	ctx := replacementAspectSetup(t)
	if _, err := repository.SaveUser(model.User{ID: "aspect-owner", Username: "aspect-owner", Group: "default", Status: model.UserStatusActive, Credits: 1000}); err != nil {
		t.Fatal(err)
	}
	for _, spec := range []struct {
		name, model, adapter, resolution, ratio string
		source, fitted                          [2]int
	}{
		{"fast portrait screenshot", "wan30-1080p-fast", "video.wan30", "1080", "9:16", [2]int{480, 848}, [2]int{486, 864}},
		{"fast portrait legacy", "wan30-1080p-fast", "", "1080", "9:16", [2]int{480, 848}, [2]int{486, 864}},
		{"legacy portrait", "wan30-720p", "", "720", "9:16", [2]int{480, 848}, [2]int{486, 864}},
		{"nonstandard landscape", "wan30-1080p-fast", "video.wan30", "1080", "16:9", [2]int{848, 480}, [2]int{864, 486}},
		{"standard portrait", "wan30-1080p-fast", "video.wan30", "1080", "9:16", [2]int{720, 1280}, [2]int{}},
		{"standard landscape", "wan30-720p", "", "720", "16:9", [2]int{1920, 1080}, [2]int{}},
		{"standard square", "wan30-1080p-fast", "video.wan30", "1080", "1:1", [2]int{960, 960}, [2]int{}},
		{"standard four by three", "wan30-1080p-fast", "video.wan30", "1080", "4:3", [2]int{960, 720}, [2]int{}},
		{"nonstandard square", "wan30-1080p-fast", "video.wan30", "1080", "1:1", [2]int{960, 964}, [2]int{964, 964}},
		{"configured adapter identity", "custom-real-video", "video.wan30", "1080", "9:16", [2]int{480, 848}, [2]int{486, 864}},
	} {
		t.Run(spec.name, func(t *testing.T) {
			fits, submissions := 0, 0
			aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
				var request map[string]any
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Fatal(err)
				}
				if r.URL.Host != "worker.invalid" {
					submissions++
					if r.Method != "POST" || r.URL.Path != "/v1/videos" || request["model"] != spec.model || request["aspect_ratio"] != spec.ratio || request["resolution"] != spec.resolution+"p" || request["seconds"] != "5" {
						t.Fatalf("incorrect upstream request: %s %s %+v", r.Method, r.URL, request)
					}
					references, _ := request["reference_videos"].([]any)
					if len(references) != 1 || references[0] != "https://example.invalid/prepared.mp4" || request["image_url"] != "https://example.invalid/person.png" {
						t.Fatalf("reference inputs changed: %+v", request)
					}
					// Stop after observing the real proxy payload; no paid provider is used.
					return &http.Response{StatusCode: 400, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"message":"mock rejection","code":"test_rejection"}}`))}, nil
				}
				result := map[string]any{}
				switch request["operation"] {
				case "replacement-plan":
					result["metadata"] = map[string]any{"size": spec.source, "parts": []map[string]any{{"start": 0, "end": 5, "inputStart": 0, "inputEnd": 5, "seconds": 15}}}
				case "replacement-fit":
					fits++
					inputs := request["inputs"].(map[string]any)
					options := request["options"].(map[string]any)
					if spec.fitted[0] == 0 || inputs["video"] != "original.mp4" || options["aspectRatio"] != spec.ratio {
						t.Fatalf("incorrect fit request: %+v", request)
					}
					result["file"], result["metadata"] = "fitted.mp4", map[string]any{"size": spec.fitted}
				default:
					t.Fatalf("unexpected worker operation: %+v", request)
				}
				data, _ := json.Marshal(map[string]any{"status": "completed", "result": result})
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
			})}
			job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Source: "original.mp4", Image: "https://example.invalid/person.png",
				Model: spec.model, ModelAdapter: spec.adapter, ChannelID: 711, Seconds: "15", Resolution: spec.resolution, Prompt: "replace the person"}
			if err := executeReplacement(ctx, &job, true); err != nil {
				t.Fatal(err)
			}
			if !job.Planned || job.AspectRatio != spec.ratio || job.SourceSize != spec.source || job.Source != "original.mp4" || job.Credits != 30 || submissions != 0 {
				t.Fatalf("incorrect plan: %+v, submissions=%d", job, submissions)
			}
			expectedInput := "original.mp4"
			if spec.fitted[0] > 0 {
				expectedInput = "fitted.mp4"
				if fits != 1 || job.FittedSource != expectedInput {
					t.Fatalf("nonstandard source was not fitted: %+v", job)
				}
			} else if fits != 0 || job.FittedSource != "" {
				t.Fatalf("standard source was unnecessarily re-encoded: %+v", job)
			}
			job.Parts[0].Reference = "https://example.invalid/prepared.mp4"
			if err := executeReplacementPart(ctx, &job, 0); err == nil || submissions != 1 || job.Parts[0].Input != expectedInput {
				t.Fatalf("proxy path was not exercised: %+v, submissions=%d, error=%v", job, submissions, err)
			}
			if err := executeReplacementPart(ctx, &job, 0); err == nil || submissions != 1 {
				t.Fatalf("ambiguous submission was resent: submissions=%d, error=%v", submissions, err)
			}
		})
	}
}

func TestReplacementWan30UnfittedPlanRejectedBeforeSubmission(t *testing.T) {
	ctx := replacementAspectSetup(t)
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		t.Fatal("invalid old plan must not call a worker or provider", r.URL)
		return nil, nil
	})}
	for _, ratio := range []string{"30:53", "9:16"} {
		job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Model: "wan30-1080p-fast", ModelAdapter: "video.wan30",
			AspectRatio: ratio, SourceSize: [2]int{480, 848}, Source: "original.mp4", Planned: true, Parts: []replacementPart{{}}}
		if err := saveReplacement(&job); err != nil {
			t.Fatal(err)
		}
		if err := executeReplacementPart(ctx, &job, 0); err == nil || !strings.Contains(err.Error(), "新建任务重新分析") || job.Parts[0].Submitted {
			t.Fatalf("invalid plan advanced: %+v, %v", job, err)
		}
		saved, err := loadReplacement(job.ID, job.UserID)
		if err != nil || saved.Parts[0].Submitted || saved.Parts[0].Input != "" {
			t.Fatalf("invalid plan was mutated: %+v, %v", saved, err)
		}
	}
}

func TestReplacementWan30InvalidFitStopsBeforeQuote(t *testing.T) {
	ctx := replacementAspectSetup(t)
	for _, size := range [][2]int{{}, {480, 848}} {
		aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Host != "worker.invalid" {
				t.Fatal("invalid fit contacted a model provider", r.URL)
			}
			var request struct {
				Operation string `json:"operation"`
			}
			_ = json.NewDecoder(r.Body).Decode(&request)
			var result map[string]any
			if request.Operation == "replacement-plan" {
				result = map[string]any{"metadata": map[string]any{"size": [2]int{480, 848}, "parts": []map[string]any{{"start": 0, "end": 5, "inputStart": 0, "inputEnd": 5}}}}
			} else if request.Operation == "replacement-fit" {
				result = map[string]any{"file": "bad-fit.mp4", "metadata": map[string]any{"size": size}}
			} else {
				t.Fatalf("unexpected worker operation: %s", request.Operation)
			}
			data, _ := json.Marshal(map[string]any{"status": "completed", "result": result})
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
		})}
		job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Model: "wan30-1080p-fast", ModelAdapter: "video.wan30",
			Source: "original.mp4", ChannelID: 711, Resolution: "1080", Seconds: "15"}
		if err := executeReplacement(ctx, &job, true); err == nil || !strings.Contains(err.Error(), "处理服务未返回所选画幅") || job.Planned || job.Credits != 0 || job.Parts[0].Submitted || job.FittedSource != "" {
			t.Fatalf("bad fitted dimensions advanced: %+v, %v", job, err)
		}
	}
}

func TestReplacementWan30RequiresFitCapability(t *testing.T) {
	ctx := replacementAspectSetup(t)
	config.Cfg.PublicBaseURL = "https://studio.example.invalid"
	if err := saveWorkerOwner("aspect-owner", "media", "original.mp4"); err != nil {
		t.Fatal(err)
	}
	if err := repository.SaveReferenceMediaOwner(model.ReferenceMediaOwner{ID: "person.png", UserID: "aspect-owner", MimeType: "image/png"}); err != nil {
		t.Fatal(err)
	}
	for _, available := range []bool{false, true} {
		aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Host != "worker.invalid" || r.URL.Path != "/health" || r.Method != "GET" {
				t.Fatal("capability check must not submit processing or generation", r.URL)
			}
			capabilities := []map[string]any{}
			for _, name := range []string{"replacement-plan", "replacement-extract", "replacement-validate", "replacement-assemble", "replacement-segment", "replacement-finish"} {
				capabilities = append(capabilities, map[string]any{"name": name, "available": true})
			}
			capabilities = append(capabilities, map[string]any{"name": "replacement-fit", "available": available})
			data, _ := json.Marshal(map[string]any{"capabilities": capabilities})
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
		})}
		job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Model: "wan30-1080p-fast", ModelAdapter: "video.wan30",
			Source: "original.mp4", Image: config.Cfg.PublicBaseURL + "/api/media/references/person.png", ChannelID: 711, Resolution: "1080", Seconds: "15"}
		err := validateReplacementRequest(ctx, &job)
		if available && err != nil || !available && (err == nil || !strings.Contains(err.Error(), "replacement-fit")) {
			t.Fatalf("fit capability available=%t: %v", available, err)
		}
	}
}

func TestReplacementH3AspectPlanAndAssemblyUseFittedSource(t *testing.T) {
	ctx := replacementAspectSetup(t)
	for _, spec := range []struct {
		name, requested, ratio, model string
		source, fitted                [2]int
	}{
		{"nonstandard portrait", "", "9:16", "h3-video", [2]int{544, 960}, [2]int{558, 992}},
		{"explicit landscape", "16:9", "16:9", "h3-video", [2]int{544, 960}, [2]int{1728, 972}},
		{"explicit ultrawide", "21:9", "21:9", "h3-video", [2]int{544, 960}, [2]int{2268, 972}},
		{"standard portrait", "", "9:16", "h3-video", [2]int{720, 1280}, [2]int{}},
		{"standard ultrawide", "", "21:9", "h3-video", [2]int{2100, 900}, [2]int{}},
		{"minimax original failure", "", "9:16", "minimax-h3", [2]int{480, 848}, [2]int{486, 864}},
		{"minimax nonstandard 2:3", "", "2:3", "minimax-h3", [2]int{600, 904}, [2]int{604, 906}},
		{"minimax standard 3:2", "", "3:2", "minimax-h3", [2]int{900, 600}, [2]int{}},
	} {
		t.Run(spec.name, func(t *testing.T) {
			operations := []string{}
			aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "worker.invalid" {
					t.Fatal("planning unexpectedly called a paid provider", r.URL)
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
				result := map[string]any{"file": request.Operation + ".mp4"}
				switch request.Operation {
				case "replacement-plan":
					result["metadata"] = map[string]any{"size": spec.source, "parts": []map[string]any{{"start": 0, "end": 5, "inputStart": 0, "inputEnd": 5, "seconds": 15}}}
				case "replacement-fit":
					if request.Inputs["video"] != "original.mp4" || request.Options["aspectRatio"] != spec.ratio {
						t.Fatal(request)
					}
					result["metadata"] = map[string]any{"size": spec.fitted}
				case "replacement-segment", "replacement-assemble", "replacement-finish":
					expected := "original.mp4"
					if spec.fitted[0] > 0 {
						expected = "replacement-fit.mp4"
					}
					key := "source"
					if request.Operation == "replacement-assemble" {
						key = "video"
					}
					if request.Inputs[key] != expected {
						t.Fatalf("output used the wrong canvas: %+v", request)
					}
				default:
					t.Fatalf("unexpected operation: %s", request.Operation)
				}
				data, _ := json.Marshal(map[string]any{"status": "completed", "result": result})
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
			})}
			job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Source: "original.mp4", Model: spec.model, ChannelID: 711,
				Seconds: "15", Resolution: "768", Prompt: "replace the person", RequestedAspectRatio: spec.requested}
			if err := executeReplacement(ctx, &job, true); err != nil {
				t.Fatal(err)
			}
			if !job.Planned || job.PreviewRequired || job.Credits != 30 || job.Parts[0].Seconds != 5 || job.AspectRatio != spec.ratio || job.Source != "original.mp4" || job.SourceSize != spec.source {
				t.Fatalf("incorrect plan: %+v", job)
			}
			if len(operations) != 1 && spec.fitted[0] == 0 || len(operations) != 2 && spec.fitted[0] > 0 {
				t.Fatal(operations)
			}
			job.Parts[0].Validated, job.Parts[0].Generated, job.Parts[0].Input = true, "generated.mp4", "input.mp4"
			job.SelectionMode, job.SelectedParts = true, []int{0}
			if err := executeReplacement(ctx, &job, false); err != nil {
				t.Fatal(err)
			}
			if job.Status != "completed" || job.Parts[0].Result == "" || job.Result == "" {
				t.Fatalf("assembly failed: %+v", job)
			}
		})
	}
}

func TestReplacementMiniMaxRejectsInvalidSpecBeforeQuoteOrSubmission(t *testing.T) {
	ctx := replacementAspectSetup(t)
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "worker.invalid" {
			t.Fatal("invalid plan called a model provider")
		}
		var input struct {
			Operation string `json:"operation"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.Operation != "replacement-plan" {
			t.Fatalf("invalid prompt must fail before fitting: %s", input.Operation)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","result":{"metadata":{"size":[480,848],"parts":[{"start":0,"end":5,"inputStart":0,"inputEnd":5,"seconds":15}]}}}`))}, nil
	})}
	job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Source: "original.mp4", Model: "minimax-h3", ChannelID: 711, Seconds: "15", Resolution: "768"}
	err := executeReplacement(ctx, &job, true)
	if err == nil || !strings.Contains(err.Error(), "提示词不能为空") || job.Planned || job.Parts[0].Submitted {
		t.Fatalf("invalid request advanced: %+v, %v", job, err)
	}
}

func TestReplacementMiniMaxInvalidSubmissionKeepsPartUnsubmitted(t *testing.T) {
	ctx := replacementAspectSetup(t)
	if _, err := repository.SaveUser(model.User{ID: "aspect-owner", Username: "aspect-owner", Group: "default", Status: model.UserStatusActive, Credits: 100}); err != nil {
		t.Fatal(err)
	}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		t.Fatal("invalid submission must not contact a worker or provider", r.URL)
		return nil, nil
	})}
	for _, spec := range []struct {
		name, ratio, prompt, message string
	}{
		{"unsupported source ratio", "30:53", "replace the person", "不支持画幅"},
		{"empty prompt", "9:16", "", "提示词不能为空"},
	} {
		t.Run(spec.name, func(t *testing.T) {
			job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Source: "original.mp4", Model: "minimax-h3", ChannelID: 711,
				Seconds: "15", Resolution: "768", AspectRatio: spec.ratio, Prompt: spec.prompt, Planned: true, Credits: 30,
				Parts: []replacementPart{{Start: 0, End: 5, InputEnd: 5, Seconds: 5, Credits: 30, Input: "original.mp4", Prepared: "original.mp4", Reference: "https://example.invalid/source.mp4"}}}
			if err := saveReplacement(&job); err != nil {
				t.Fatal(err)
			}
			err := executeReplacementPart(ctx, &job, 0)
			if err == nil || !strings.Contains(err.Error(), spec.message) || job.Parts[0].Submitted || job.Parts[0].TaskID != "" {
				t.Fatalf("invalid request advanced: %+v, %v", job, err)
			}
			saved, err := loadReplacement(job.ID, job.UserID)
			if err != nil || saved.Parts[0].Submitted || saved.Parts[0].TaskID != "" {
				t.Fatalf("invalid request was persisted as submitted: %+v, %v", saved, err)
			}
		})
	}
}

func TestReplacementAspectRecommendationsAndSubmittedProtection(t *testing.T) {
	for _, spec := range []struct {
		width, height int
		ratio         string
	}{{544, 960, "9:16"}, {1920, 1088, "16:9"}, {1000, 1000, "1:1"}, {900, 1200, "3:4"}} {
		if actual := nearestReplacementAspect(service.SparkCineH3AspectRatios("768"), spec.width, spec.height); actual != spec.ratio {
			t.Fatalf("%+v: %s", spec, actual)
		}
	}
	for _, part := range []replacementPart{{Submitted: true}, {TaskID: "uncertain"}, {Generated: "done"}, {Validated: true}, {PreviousTasks: []string{"old"}}} {
		job := replacementJob{Parts: []replacementPart{part}}
		if canChangeReplacementAspect(&job) {
			t.Fatalf("paid or uncertain part can be overwritten: %+v", part)
		}
	}
	if !canChangeReplacementAspect(&replacementJob{Parts: []replacementPart{{Input: "reversible-input.mp4"}}}) {
		t.Fatal("unsubmitted input should allow replanning")
	}
}

func TestReplacementAspectReplanClearsOldQuoteAndRejectsSubmittedJobs(t *testing.T) {
	ctx := replacementAspectSetup(t)
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		// A failed reversible analysis keeps the reset state without calling a model.
		return &http.Response{StatusCode: 400, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"detail":"test analysis stopped"}`))}, nil
	})}
	for _, submitted := range []bool{true, false} {
		job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Source: "original.mp4", Model: "h3-video", ChannelID: 711,
			Seconds: "15", Resolution: "768", Status: "paused", AspectRatio: "17:30", Credits: 123,
			WorkerStep: "old-plan", WorkerID: "old-worker", Parts: []replacementPart{{Start: 0, End: 5, Submitted: submitted, Credits: 123}}}
		if err := saveReplacement(&job); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest("POST", "/", strings.NewReader(`{"aspectRatio":"9:16"}`)).WithContext(ctx)
		response := httptest.NewRecorder()
		ReplacementJobAction(response, request, job.ID, "set-aspect-ratio")
		if submitted {
			if !strings.Contains(response.Body.String(), "已有片段提交生成") {
				t.Fatal(response.Body.String())
			}
		} else {
			deadline := time.Now().Add(3 * time.Second)
			for replacementControlFor(job.ID).running.Load() && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if replacementControlFor(job.ID).running.Load() {
				t.Fatal("replanning did not finish")
			}
		}
		saved, err := loadReplacement(job.ID, job.UserID)
		if err != nil {
			t.Fatal(err)
		}
		if submitted && (saved.AspectRatio != "17:30" || saved.Credits != 123 || !saved.Parts[0].Submitted) {
			t.Fatalf("submitted task was modified: %+v", saved)
		}
		if !submitted && (saved.RequestedAspectRatio != "9:16" || saved.Credits != 0 || saved.Planned || len(saved.Parts) != 0 || saved.WorkerID == "old-worker") {
			t.Fatalf("old analysis survived replanning: %+v", saved)
		}
	}
}
