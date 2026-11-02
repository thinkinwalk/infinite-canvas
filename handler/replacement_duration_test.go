package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

func TestWan30FastReferenceDurationPlanAndSubmission(t *testing.T) {
	ctx := replacementAspectSetup(t)
	settings, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	profile := settings.Private.Channels[0].VideoModels["wan30-1080p-fast"]
	profile.Seconds = nil
	for seconds := 4; seconds <= 30; seconds++ {
		profile.Seconds = append(profile.Seconds, strconv.Itoa(seconds))
	}
	profile.ReferenceVideoMinSeconds, profile.ReferenceVideoMaxSeconds = 4, 15
	profile.BillingTiers["1080"], profile.MinimumCredits = 80, 320
	settings.Private.Channels[0].VideoModels["wan30-1080p-fast"] = profile
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveUser(model.User{ID: "aspect-owner", Username: "aspect-owner", Group: "default", Status: model.UserStatusActive, Credits: 10000}); err != nil {
		t.Fatal(err)
	}
	for _, duration := range []float64{4, 5, 5.2, 15, 16} {
		t.Run(strconv.FormatFloat(duration, 'f', -1, 64), func(t *testing.T) {
			submissions := 0
			aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
				var request map[string]any
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Fatal(err)
				}
				if r.URL.Host != "worker.invalid" {
					submissions++
					expected := strconv.Itoa(int(duration))
					if duration == 5.2 {
						expected = "6"
					}
					if request["model"] != "wan30-1080p-fast" || request["seconds"] != expected {
						t.Fatalf("incorrect upstream duration: %+v", request)
					}
					return &http.Response{StatusCode: 400, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"message":"mock rejection"}}`))}, nil
				}
				if request["operation"] != "replacement-plan" {
					t.Fatalf("whole reference must not be extracted or padded: %+v", request)
				}
				parts := []replacementPart{{Start: 0, End: duration, InputStart: 0, InputEnd: duration, Seconds: 15}}
				if duration > 15 {
					parts = []replacementPart{
						{Start: 0, End: 14.75, InputStart: 0, InputEnd: 15, Seconds: 15},
						{Start: 14.75, End: 16, InputStart: 14.5, InputEnd: 16, TrimStart: .25, Seconds: 15},
					}
				}
				body, _ := json.Marshal(map[string]any{"status": "completed", "result": map[string]any{"metadata": map[string]any{"size": [2]int{720, 1280}, "parts": parts}}})
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
			})}
			job := replacementJob{ID: uuid.NewString(), UserID: "aspect-owner", Source: "source.mp4", Model: "wan30-1080p-fast", ModelAdapter: "video.wan30", ChannelID: 711, Resolution: "1080", Seconds: "15", Image: "https://example.invalid/person.png", Prompt: "replace the person"}
			if err := executeReplacement(ctx, &job, true); err != nil {
				t.Fatal(err)
			}
			if duration > 15 {
				if len(job.Parts) != 2 || job.Parts[0].Seconds != 15 || job.Parts[1].Seconds != 4 || job.Parts[1].ReferenceSeconds != 4 || job.Credits != 1520 {
					t.Fatalf("incorrect long-video plan: %+v", job)
				}
				return
			}
			expected := duration
			if duration == 5.2 {
				expected = 6
			}
			part := &job.Parts[0]
			if len(job.Parts) != 1 || part.Seconds != expected || part.ReferenceSeconds != duration || job.Credits != int(expected)*80 {
				t.Fatalf("incorrect whole-video duration or quote: %+v", job)
			}
			part.Reference = "https://example.invalid/reference.mp4"
			if err := executeReplacementPart(ctx, &job, 0); err == nil || submissions != 1 || part.Input != "source.mp4" {
				t.Fatalf("reference changed or submission not observed: %+v, calls=%d, error=%v", part, submissions, err)
			}
			if err := executeReplacementPart(ctx, &job, 0); err == nil || submissions != 1 {
				t.Fatalf("ambiguous paid request was resent: %v", err)
			}
		})
	}
}

func TestWan30FastOutputRangeWithAndWithoutReference(t *testing.T) {
	profile := model.VideoModelProfile{Interface: "relay", MaxVideos: 5, Resolutions: []string{"1080"}}
	for seconds := 4; seconds <= 30; seconds++ {
		profile.Seconds = append(profile.Seconds, strconv.Itoa(seconds))
	}
	for _, seconds := range []int{4, 5, 15, 16, 30} {
		for _, reference := range []bool{false, true} {
			payload := map[string]any{"model": "wan30-1080p-fast", "seconds": strconv.Itoa(seconds), "resolution": "1080p"}
			if reference {
				payload["reference_videos"] = []string{"https://example.invalid/reference.mp4"}
			}
			err := validateVideoProfileRequest(profile, mustReplacementJSON(payload), "application/json")
			if (err == nil) != (!reference || seconds <= 15) {
				t.Fatalf("seconds=%d reference=%v: %v", seconds, reference, err)
			}
		}
	}
}
