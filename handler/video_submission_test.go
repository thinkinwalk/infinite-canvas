package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func TestManagedStoreH3PreflightAndSubmission(t *testing.T) {
	db := setupVideoLogTest(t)
	user := model.User{ID: "h3-preflight", Username: "h3-preflight", AffCode: "h3-preflight", Credits: 1000, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Where("user_id = ?", user.ID).Delete(&model.VideoTask{})
		db.Delete(&user)
	})
	const modelID = "model_b617338acd514d489e5ca0fb40ba7022"
	profile := model.VideoModelProfile{
		Interface: service.SparkCineH3Interface, MaxImages: 9, MaxVideos: 1, MaxAudios: 3,
		InputModes: []string{"reference"}, Resolutions: []string{"720", "768"}, Seconds: []string{"15"},
		BillingMode: "duration_resolution", UnitCredits: 6, MinimumCredits: 24, BillingTiers: map[string]float64{"720": 6, "768": 6},
	}
	settings := model.Settings{Private: model.PrivateSetting{
		Channels: []model.ModelChannel{{ID: 16, Name: "H3 test", Protocol: "openai", BaseURL: "https://hi.hi.run/api/openai/v1", APIKey: "test-only", Enabled: true, Weight: 1, Models: []string{"h3-video"}}},
		ModelManagement: &model.ModelManagement{Enabled: true, Revision: 30,
			Routes: []model.ManagedRoute{{ID: "h3-route", ChannelID: 16, Model: "h3-video", Adapter: "video.sparkcine_h3", Capability: "video", Operations: []string{"video"}, Enabled: true, Video: &profile}},
			Models: []model.ManagedModel{{ID: modelID, DisplayName: "MiniMax H3 Video", DisplayMode: "both", Enabled: true, RouteIDs: []string{"h3-route"}, Pricing: model.ManagedPricing{Configured: true, Credits: 24, Video: &profile}}},
			Bindings: []model.FeatureBinding{{FeatureID: "store-explore.video", ModelID: modelID, RouteIDs: []string{"h3-route"}, Enabled: true}},
		},
	}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	posts := 0
	upstreamBody, upstreamStatus := "", http.StatusOK
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		posts++
		if r.Method != http.MethodPost || r.URL.String() != "https://hi.hi.run/api/h3/v2/video_generation" || r.Header.Get("Authorization") != "Bearer test-only" {
			t.Fatalf("wrong H3 route: %s %s", r.Method, r.URL)
		}
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["model"] != "h3-video" || payload["duration"] != float64(15) || payload["ratio"] != "9:16" || len(payload["content"].([]any)) != 4 || payload["seconds"] != nil {
			t.Fatalf("wrong H3 canonical conversion: %+v", payload)
		}
		body := upstreamBody
		if body == "" {
			body = fmt.Sprintf(`{"task_id":"h3-preflight-%d","status":"queued"}`, posts)
		}
		return &http.Response{StatusCode: upstreamStatus, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	invoke := func(handle http.HandlerFunc, body []byte, quote string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/v1/videos", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Model-Feature", "store-explore.video")
		r.Header.Set("X-Model-Revision", "30")
		r.Header.Set("X-Model-Quote", quote)
		r.Header.Set("X-Expected-Credits", "90")
		r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
		w := httptest.NewRecorder()
		handle(w, r)
		return w
	}
	for _, resolution := range []string{"720", "768"} {
		t.Run(resolution, func(t *testing.T) {
			price := invoke(ModelQuote, mustReplacementJSON(map[string]any{"model": modelID, "resolution": resolution, "seconds": "15", "aspect_ratio": "9:16"}), "")
			var envelope struct {
				Data struct {
					QuoteToken string `json:"quoteToken"`
					Credits int `json:"credits"`
				} `json:"data"`
			}
			if json.Unmarshal(price.Body.Bytes(), &envelope) != nil || envelope.Data.QuoteToken == "" || envelope.Data.Credits != 90 {
				t.Fatal(price.Body.String())
			}
			payload := map[string]any{"model": modelID, "prompt": "参考 @图片1 门头与 @图片2 环境、@图片3 商品", "seconds": "15", "aspect_ratio": "9:16", "resolution": resolution + "p", "input_mode": "reference",
				"image_url": "https://cdn.example/door.jpg", "reference_image_urls": []string{"https://cdn.example/inside.webp", "https://cdn.example/product.webp"}}
			body := mustReplacementJSON(payload)
			beforePosts := posts
			before, _, _ := repository.GetUserByID(user.ID)
			preflight := invoke(AIVideosValidate, body, envelope.Data.QuoteToken)
			after, _, _ := repository.GetUserByID(user.ID)
			if preflight.Header().Get("X-Video-Submission") != "validated" || !strings.Contains(preflight.Body.String(), `"validated":true`) || posts != beforePosts || before.Credits != after.Credits {
				t.Fatalf("preflight generated/charged or rejected valid input: %s", preflight.Body.String())
			}
			created := invoke(AIVideos, body, envelope.Data.QuoteToken)
			if created.Header().Get("X-Video-Submission") != "accepted" || posts != beforePosts+1 {
				t.Fatalf("H3 create failed: %s", created.Body.String())
			}
			after, _, _ = repository.GetUserByID(user.ID)
			if after.Credits != before.Credits-90 {
				t.Fatalf("quote/charge differ: %d -> %d", before.Credits, after.Credits)
			}
			for _, invalid := range []string{"quote", "references"} {
				payload["seconds"] = "15"
				payload["image_url"] = "https://cdn.example/door.jpg"
				if invalid == "quote" {
					payload["seconds"] = "14"
				} else {
					payload["image_url"] = "http://cdn.example/door.jpg"
				}
				for _, handle := range []http.HandlerFunc{AIVideosValidate, AIVideos} {
					rejected := invoke(handle, mustReplacementJSON(payload), envelope.Data.QuoteToken)
					if rejected.Header().Get("X-Video-Submission") != "rejected" || rejected.Header().Get("X-Video-Stage") != invalid || rejected.Header().Get("X-Request-ID") == "" || posts != beforePosts+1 {
						t.Fatalf("wrong %s rejection: headers=%v body=%s", invalid, rejected.Header(), rejected.Body.String())
					}
				}
			}
			payload["image_url"] = "https://cdn.example/door.jpg"
			for _, failure := range []struct{ status int; body, outcome string }{
				{200, `{"code":400,"message":"reference rejected"}`, "rejected"},
				{422, `{"error":{"message":"unsupported reference"}}`, "rejected"},
				{502, `{"error":{"message":"upstream unavailable"}}`, "unknown"},
				{200, `{}`, "unknown"},
			} {
				upstreamStatus, upstreamBody = failure.status, failure.body
				rejected := invoke(AIVideos, mustReplacementJSON(payload), envelope.Data.QuoteToken)
				if rejected.Header().Get("X-Video-Submission") != failure.outcome || rejected.Header().Get("X-Video-Stage") != "upstream" || !strings.Contains(rejected.Body.String(), `"code":1`) {
					t.Fatalf("wrong upstream outcome: headers=%v body=%s", rejected.Header(), rejected.Body.String())
				}
			}
			upstreamStatus, upstreamBody = 200, ""
		})
	}
}
