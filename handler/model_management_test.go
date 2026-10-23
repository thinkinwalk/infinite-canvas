package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func TestManagedFeatureQuoteChargeAndRecovery(t *testing.T) {
	db := setupVideoLogTest(t)
	user := model.User{ID: "managed-owner", Username: "managed-owner", AffCode: "managed-owner", Credits: 500, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Where("user_id = ?", user.ID).Delete(&model.VideoTask{})
		db.Delete(&user)
	})
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			calls++
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["model"] != "private-video-v1" {
				t.Errorf("upstream model = %v", body["model"])
			}
			_, _ = w.Write([]byte(`{"id":"managed-task","model":"private-video-v1","status":"queued"}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"managed-task","model":"private-video-v1","status":"running"}`))
	}))
	defer upstream.Close()
	profile := model.VideoModelProfile{Interface: "relay", MaxImages: 1, MaxVideos: 1, Resolutions: []string{"720"}, Seconds: []string{"5"}, InputModes: []string{"reference"}}
	settings := model.Settings{Private: model.PrivateSetting{
		Channels: []model.ModelChannel{{ID: 901, Name: "managed-channel", Protocol: "openai", BaseURL: upstream.URL + "/v1", APIKey: "private-secret", Enabled: true, Weight: 1, Models: []string{"private-video-v1"}}},
		ModelManagement: &model.ModelManagement{Enabled: true, Revision: 8,
			Routes:   []model.ManagedRoute{{ID: "route_private", ChannelID: 901, Model: "private-video-v1", Adapter: "video.relay", Capability: "video", Operations: []string{"video"}, Enabled: true, Video: &profile}},
			Models:   []model.ManagedModel{{ID: "model_studio", DisplayName: "工作室视频", DisplayMode: "alias", Enabled: true, RouteIDs: []string{"route_private"}, Pricing: model.ManagedPricing{Configured: true, Credits: 17}}},
			Bindings: []model.FeatureBinding{{FeatureID: "video.generate", ModelID: "model_studio", Enabled: true, Default: true, RouteIDs: []string{"route_private"}}},
		},
	}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	invoke := func(handle http.HandlerFunc, path, body, feature, quote string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Model-Feature", feature)
		r.Header.Set("X-Model-Revision", "8")
		r.Header.Set("X-Model-Quote", quote)
		r.Header.Set("X-Expected-Credits", "17")
		r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
		w := httptest.NewRecorder()
		handle(w, r)
		return w
	}
	request := `{"model":"model_studio","seconds":"5","resolution":"720p","aspect_ratio":"16:9","input_mode":"reference","prompt":"test"}`
	denied := invoke(AIVideos, "/api/v1/videos", request, "replace.person", "")
	if !strings.Contains(denied.Body.String(), "没有可用") || calls != 0 {
		t.Fatalf("unbound submission: %s calls=%d", denied.Body.String(), calls)
	}
	public, err := service.PublicSettingsForGroup("default")
	data, _ := json.Marshal(public)
	if err != nil || strings.Contains(string(data), "private-video-v1") || strings.Contains(string(data), "private-secret") {
		t.Fatalf("public catalog leaked identity: %s %v", data, err)
	}
	price := invoke(ModelQuote, "/api/v1/models/quote", `{"model":"model_studio","resolution":"720","seconds":"5","aspect_ratio":"16:9"}`, "video.generate", "")
	var envelope struct {
		Data struct {
			QuoteToken string `json:"quoteToken"`
			Credits    int    `json:"credits"`
		} `json:"data"`
	}
	if err := json.Unmarshal(price.Body.Bytes(), &envelope); err != nil || envelope.Data.QuoteToken == "" || envelope.Data.Credits != 17 {
		t.Fatalf("quote %s", price.Body.String())
	}
	token := envelope.Data.QuoteToken
	tampered := invoke(AIVideos, "/api/v1/videos", strings.Replace(request, `"5"`, `"10"`, 1), "video.generate", token)
	if calls != 0 || !strings.Contains(tampered.Body.String(), "报价") {
		t.Fatalf("tampered submission: %s", tampered.Body.String())
	}
	created := invoke(AIVideos, "/api/v1/videos", request, "video.generate", token)
	if calls != 1 || strings.Contains(created.Body.String(), "private-video-v1") {
		t.Fatalf("create: %s calls=%d", created.Body.String(), calls)
	}
	current, _, _ := repository.GetUserByID(user.ID)
	if current.Credits != 483 {
		t.Fatalf("balance = %d", current.Credits)
	}
	task, found, err := service.GetVideoTask("managed-task")
	if err != nil || !found || task.Model != "private-video-v1" || task.PlatformModelID != "model_studio" || task.ConfigRevision != 8 {
		t.Fatalf("snapshot: %+v %v", task, err)
	}
	settings.Private.ModelManagement.Revision = 9
	settings.Private.ModelManagement.Bindings[0].Enabled = false
	settings.Private.ModelManagement.Bindings[0].Default = false
	_, _ = repository.SaveSettings(settings, "test")
	invoke(AIVideos, "/api/v1/videos", request, "video.generate", token)
	if calls != 1 {
		t.Fatal("disabled binding reached upstream")
	}
	r := httptest.NewRequest("GET", "/api/v1/videos/managed-task?model=model_studio", nil)
	r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
	w := httptest.NewRecorder()
	AIVideo(w, r, "managed-task")
	if !strings.Contains(w.Body.String(), "running") || strings.Contains(w.Body.String(), "private-video-v1") {
		t.Fatalf("recovery: %s", w.Body.String())
	}
	ctx, err := replacementManagedContext(r.Context(), &replacementJob{Model: task.Model, PlatformModelID: task.PlatformModelID, FeatureID: "video.generate", ConfigRevision: 8, ChannelID: 901})
	if err == nil || ctx == nil {
		t.Fatal("disabled next segment was accepted")
	}
}

func TestManagedWriterHandlesSplitSSEAndMedia(t *testing.T) {
	selected := &service.ManagedSelection{Model: model.ManagedModel{ID: "model_public", DisplayName: "创作模型", DisplayMode: "alias"}, Route: model.ManagedRoute{Model: "provider-secret"}}
	recorder := httptest.NewRecorder()
	writer := &managedResponseWriter{ResponseWriter: recorder, selected: selected}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Content-Length", "100")
	writer.WriteHeader(200)
	_, _ = writer.Write([]byte(`data: {"model":"provider-`))
	_, _ = writer.Write([]byte("secret\",\"delta\":\"hello\"}\n\n"))
	_, _ = writer.Write([]byte("data: {\"delta\":\"provider-secret is quoted content\"}\n\n"))
	writer.finish()
	if recorder.Header().Get("Content-Length") != "" || strings.Contains(recorder.Body.String(), `"model":"provider-secret"`) || !strings.Contains(recorder.Body.String(), "model_public") || !strings.Contains(recorder.Body.String(), "provider-secret is quoted content") {
		t.Fatal(recorder.Body.String())
	}
}

func TestManagedFixedQuoteBindsQuantityAndCaseRoute(t *testing.T) {
	db := setupVideoLogTest(t)
	user := model.User{ID: "managed-fixed", Username: "managed-fixed", AffCode: "managed-fixed", Credits: 100, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{}); db.Delete(&user) })
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"secret-text","output_text":"secret-text remains in authored content"}`))
	}))
	defer upstream.Close()
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{{ID: 902, Name: "original", Protocol: "openai", BaseURL: upstream.URL + "/v1", APIKey: "fake", Enabled: true, Weight: 1, Models: []string{"secret-text"}}}, ModelManagement: &model.ModelManagement{Enabled: true, Revision: 3,
		Routes:   []model.ManagedRoute{{ID: "route_text", ChannelID: 902, Model: "secret-text", Adapter: "text.openai", Capability: "text", Operations: []string{"text"}, Enabled: true}},
		Models:   []model.ManagedModel{{ID: "model_text", DisplayName: "写作助手", DisplayMode: "alias", Enabled: true, RouteIDs: []string{"route_text"}, Pricing: model.ManagedPricing{Configured: true, Credits: 7}}},
		Bindings: []model.FeatureBinding{{FeatureID: "prompt.enhance", ModelID: "model_text", RouteIDs: []string{"route_text"}, Enabled: true, Default: true}},
	}}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	selected, err := service.ResolveManagedModel("prompt.enhance", "model_text", "default", 0)
	if err != nil {
		t.Fatal(err)
	}
	proof := service.SignManagedQuote(user.ID, selected, map[string]any{"count": 1})
	invoke := func(count int) *httptest.ResponseRecorder {
		body := `{"model":"model_text","messages":[]}`
		if count == 2 {
			body = `{"model":"model_text","messages":[],"n":2}`
		}
		r := httptest.NewRequest("POST", "/api/v1/chat/completions", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Model-Feature", "prompt.enhance")
		r.Header.Set("X-Model-Revision", "3")
		r.Header.Set("X-Model-Quote", proof)
		r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
		w := httptest.NewRecorder()
		AIChatCompletions(w, r)
		return w
	}
	if w := invoke(2); calls != 0 || !strings.Contains(w.Body.String(), "报价") {
		t.Fatal(w.Body.String())
	}
	user.Group = "VIP"
	if w := invoke(1); calls != 0 || !strings.Contains(w.Body.String(), "分组") {
		t.Fatal("changed group reused confirmed quote", w.Body.String())
	}
	user.Group = "default"
	if w := invoke(1); calls != 1 || !strings.Contains(w.Body.String(), `"model":"model_text"`) || !strings.Contains(w.Body.String(), "secret-text remains") {
		t.Fatal(w.Body.String())
	}
	logs, err := service.ListUserCreditLogs(user.ID, model.Query{})
	if err != nil || len(logs.Items) != 1 || strings.Contains(logs.Items[0].Extra, "secret-text") || !strings.Contains(logs.Items[0].Remark, "写作助手") {
		t.Fatalf("public logs: %+v %v", logs, err)
	}
	settings.Private.Channels[0].Name = "renamed"
	_, _ = repository.SaveSettings(settings, "test")
	channel, err := service.ResolveModelChannelForTask("original", upstream.URL+"/v1", 902)
	if err != nil || channel.Name != "renamed" {
		t.Fatal("renamed channel lost task identity", err)
	}
	item := model.CaseApp{ID: "managed-case-test", Title: "测试案例", Status: model.CaseStatusPublished, RuntimeConfig: `{"kind":"text","model":"default","promptTemplate":"test"}`}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Delete(&item) })
	feature := service.CaseModelFeature(item.ID, "text")
	settings.Private.ModelManagement.Bindings = append(settings.Private.ModelManagement.Bindings, model.FeatureBinding{FeatureID: feature, ModelID: "model_text", RouteIDs: []string{"route_text"}, Enabled: true, Default: true})
	_, _ = repository.SaveSettings(settings, "test")
	r := httptest.NewRequest("GET", "/api/cases/"+item.ID+"/run-price", nil)
	r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
	w := httptest.NewRecorder()
	CaseRunPrice(w, r, item.ID)
	var price struct {
		Data struct {
			Token string `json:"quoteToken"`
		} `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &price) != nil || price.Data.Token == "" {
		t.Fatal(w.Body.String())
	}
	submit := httptest.NewRequest("POST", "/api/cases/"+item.ID+"/run", nil)
	submit = submit.WithContext(service.WithUser(submit.Context(), model.PublicUser(user)))
	submit.Header.Set("X-Case-Quote", price.Data.Token)
	caseRoute, err := resolveManagedCase(submit, feature, user.Group)
	if err != nil || caseRoute.Channel.ID != 902 {
		t.Fatal("case quote lost channel", err)
	}
	item.PriceCredits = 50
	if err := db.Save(&item).Error; err != nil {
		t.Fatal(err)
	}
	changed := httptest.NewRequest("POST", "/api/cases/"+item.ID+"/run", nil)
	changed = changed.WithContext(service.WithUser(changed.Context(), model.PublicUser(user)))
	changed.Header.Set("X-Case-Quote", price.Data.Token)
	if _, err := resolveManagedCase(changed, feature, user.Group); err == nil {
		t.Fatal("changed case price reused confirmed quote")
	}
	item.PriceCredits = 0
	if err := db.Save(&item).Error; err != nil {
		t.Fatal(err)
	}
	settings.Private.ModelManagement.Revision++
	_, _ = repository.SaveSettings(settings, "test")
	replay := httptest.NewRequest("POST", "/api/cases/"+item.ID+"/run", nil)
	replay = replay.WithContext(service.WithUser(replay.Context(), model.PublicUser(user)))
	replay.Header.Set("X-Case-Quote", price.Data.Token)
	if _, err := resolveManagedCase(replay, feature, user.Group); err == nil {
		t.Fatal("stale case quote accepted")
	}
}

func TestManagedVideoAdapterUsesConfiguredIdentity(t *testing.T) {
	db := setupVideoLogTest(t)
	user := model.User{ID: "adapter-owner", Username: "adapter-owner", AffCode: "adapter-owner", Credits: 100, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Where("user_id = ?", user.ID).Delete(&model.VideoTask{})
		db.Delete(&user)
	})
	for _, adapter := range []string{"video.minimax-h3", "video.sparkcine_h3", "video.h3-2k"} {
		t.Run(adapter, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["model"] != "custom-real-video" {
					t.Errorf("adapter replaced configured identity: %v", body)
				}
				if adapter == "video.minimax-h3" && (body["size"] != "1376x768" || body["aspect_ratio"] != nil) {
					t.Errorf("MiniMax conversion: %v", body)
				}
				if adapter == "video.sparkcine_h3" && (r.URL.Path != "/api/h3/v2/video_generation" || body["content"] == nil) {
					t.Errorf("H3 protocol: %s %v", r.URL.Path, body)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"id":"task-` + strings.TrimPrefix(adapter, "video.") + `","model":"custom-real-video","status":"queued"}`))
			}))
			defer upstream.Close()
			interfaceName := "relay"
			if adapter == "video.sparkcine_h3" {
				interfaceName = "sparkcine_h3"
			}
			profile := model.VideoModelProfile{Interface: interfaceName, InputModes: []string{"reference"}, Resolutions: []string{"768"}, Seconds: []string{"5"}}
			settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{{ID: 903, Name: "adapter", Protocol: "openai", BaseURL: upstream.URL + "/v1", APIKey: "fake", Enabled: true, Weight: 1, Models: []string{"custom-real-video"}}}, ModelManagement: &model.ModelManagement{Enabled: true, Revision: 4,
				Routes:   []model.ManagedRoute{{ID: "route_adapter", ChannelID: 903, Model: "custom-real-video", Adapter: adapter, Capability: "video", Operations: []string{"video"}, Enabled: true, Video: &profile}},
				Models:   []model.ManagedModel{{ID: "model_adapter", DisplayName: "创作视频", DisplayMode: "alias", Enabled: true, RouteIDs: []string{"route_adapter"}, Pricing: model.ManagedPricing{Configured: true, Credits: 3}}},
				Bindings: []model.FeatureBinding{{FeatureID: "video.generate", ModelID: "model_adapter", RouteIDs: []string{"route_adapter"}, Enabled: true}},
			}}}
			if _, err := repository.SaveSettings(settings, "test"); err != nil {
				t.Fatal(err)
			}
			selected, err := service.ResolveManagedModel("video.generate", "model_adapter", "default", 0)
			if err != nil {
				t.Fatal(err)
			}
			proof := service.SignManagedQuote(user.ID, selected, managedVideoParameters("768", "5", "16:9", false))
			r := httptest.NewRequest("POST", "/api/v1/videos", strings.NewReader(`{"model":"model_adapter","prompt":"test","resolution":"768p","seconds":"5","aspect_ratio":"16:9","input_mode":"reference"}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-Model-Feature", "video.generate")
			r.Header.Set("X-Model-Revision", "4")
			r.Header.Set("X-Model-Quote", proof)
			r.Header.Set("X-Expected-Credits", "3")
			r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
			w := httptest.NewRecorder()
			AIVideos(w, r)
			if calls != 1 || strings.Contains(w.Body.String(), "custom-real-video") {
				t.Fatalf("configured adapter: %s calls=%d", w.Body.String(), calls)
			}
		})
	}
}
