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
		Models: []string{"h3-video"}, Weight: 1, VideoModels: map[string]model.VideoModelProfile{"h3-video": {
			Interface: "sparkcine_h3", MaxImages: 1, MaxVideos: 1, ContentReplacement: &enabled,
			Resolutions: []string{"720", "768"}, Seconds: []string{"5", "15"},
			BillingMode: "duration_resolution", BillingTiers: map[string]float64{"720": 6, "768": 6},
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

func TestReplacementH3AspectPlanAndAssemblyUseFittedSource(t *testing.T) {
	ctx := replacementAspectSetup(t)
	for _, spec := range []struct {
		name, requested, ratio string
		source, fitted         [2]int
	}{
		{"nonstandard portrait", "", "9:16", [2]int{544, 960}, [2]int{558, 992}},
		{"explicit landscape", "16:9", "16:9", [2]int{544, 960}, [2]int{1728, 972}},
		{"explicit ultrawide", "21:9", "21:9", [2]int{544, 960}, [2]int{2268, 972}},
		{"standard portrait", "", "9:16", [2]int{720, 1280}, [2]int{}},
		{"standard ultrawide", "", "21:9", [2]int{2100, 900}, [2]int{}},
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
			job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Source: "original.mp4", Model: "h3-video", ChannelID: 711,
				Seconds: "15", Resolution: "768", RequestedAspectRatio: spec.requested}
			if err := executeReplacement(ctx, &job, true); err != nil {
				t.Fatal(err)
			}
			if !job.Planned || job.Credits != 30 || job.Parts[0].Seconds != 5 || job.AspectRatio != spec.ratio || job.Source != "original.mp4" || job.SourceSize != spec.source {
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

func TestReplacementAspectRecommendationsAndSubmittedProtection(t *testing.T) {
	for _, spec := range []struct {
		width, height int
		ratio         string
	}{{544, 960, "9:16"}, {1920, 1088, "16:9"}, {1000, 1000, "1:1"}, {900, 1200, "3:4"}} {
		if actual := nearestReplacementAspect("768", spec.width, spec.height); actual != spec.ratio {
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
