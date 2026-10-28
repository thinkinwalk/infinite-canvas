package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func tryonTestImage(t *testing.T) string {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		t.Fatal(err)
	}
	return "data:" + "image/png;base64," + base64.StdEncoding.EncodeToString(buffer.Bytes())
}

func TestTryonCloudEditQuotePayloadAndRefund(t *testing.T) {
	db := setupVideoLogTest(t)
	config.Cfg.CreditLogThumbnailDir = t.TempDir()
	user := model.User{ID: "tryon-cloud-owner", Username: "tryon-cloud-owner", AffCode: "tryon-cloud-owner", Group: "default", Credits: 100, Status: model.UserStatusActive}
	item := model.CaseApp{ID: "official-tryon", Title: "试衣测试", Status: model.CaseStatusPublished, PublishedVersion: 1, PriceCredits: 3,
		PublicSchema:  `{"fields":[{"key":"modelImageUrl","required":true}]}`,
		RuntimeConfig: `{"kind":"image","operation":"image-edit","model":"default","promptTemplate":"tryon","size":"1024x1536","quality":"high"}`}
	var old model.CaseApp
	hadOld := db.First(&old, "id = ?", item.ID).Error == nil
	if err := db.Save(&item).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Where("user_id = ?", user.ID).Delete(&model.CaseRun{})
		db.Delete(&user)
		if hadOld {
			db.Save(&old)
		} else {
			db.Delete(&item)
		}
	})
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{
		{ID: 818, Name: "cloud-test", Protocol: "openai", BaseURL: "https://tryon-cloud.example/v1", APIKey: "test-only", Models: []string{"tryon-cloud-test"}, Enabled: true, Weight: 1},
	}, ModelManagement: &model.ModelManagement{Enabled: true, Revision: 4,
		Routes:   []model.ManagedRoute{{ID: "route_tryon", ChannelID: 818, Model: "tryon-cloud-test", Adapter: "image.openai", Capability: "image", Operations: []string{"image"}, Enabled: true}},
		Models:   []model.ManagedModel{{ID: "model_tryon", DisplayName: "云端试穿", DisplayMode: "alias", RouteIDs: []string{"route_tryon"}, Enabled: true, Pricing: model.ManagedPricing{Configured: true, Credits: 7}}},
		Bindings: []model.FeatureBinding{{FeatureID: "case:official-tryon:image", ModelID: "model_tryon", RouteIDs: []string{"route_tryon"}, Default: true, Enabled: true}},
	}}}
	if err := service.ValidateModelManagement(settings); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/cases/official-tryon/run-price", nil)
	request = request.WithContext(service.WithUser(request.Context(), model.PublicUser(user)))
	priced := httptest.NewRecorder()
	CaseRunPrice(priced, request, item.ID)
	var quote struct {
		Code int `json:"code"`
		Data struct {
			Points int    `json:"points"`
			Token  string `json:"quoteToken"`
		} `json:"data"`
	}
	if json.Unmarshal(priced.Body.Bytes(), &quote) != nil || quote.Code != 0 || quote.Data.Points != 10 || quote.Data.Token == "" {
		t.Fatalf("wrong cloud quote: %s", priced.Body)
	}
	calls, fail := 0, false
	picture := tryonTestImage(t)
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://tryon-cloud.example/v1/images/edits" || r.Header.Get("Authorization") != "Bearer test-only" {
			t.Fatalf("wrong cloud endpoint: %s", r.URL)
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Fatal(err)
		}
		defer r.MultipartForm.RemoveAll()
		fields := r.MultipartForm.Value
		if len(fields) != 4 || r.FormValue("model") != "tryon-cloud-test" || r.FormValue("size") != "1024x1536" || r.FormValue("quality") != "high" {
			t.Fatalf("wrong cloud edit fields: %v", fields)
		}
		for _, text := range []string{"图1为模特", "图2为上装", "图3为下装", "图4为姿势", "仅参考身体朝向", "纯白影棚", "全身构图", "穿着图", "衣摆自然垂放"} {
			if !strings.Contains(r.FormValue("prompt"), text) {
				t.Fatalf("cloud prompt missing instruction: %s", text)
			}
		}
		files := r.MultipartForm.File["image[]"]
		if len(files) != 4 || files[0].Filename != "modelImageUrl.png" || files[1].Filename != "topImageUrl.png" || files[2].Filename != "bottomImageUrl.png" || files[3].Filename != "poseImageUrl.png" {
			t.Fatalf("wrong cloud attachments: %v", files)
		}
		for _, file := range files {
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			_, _, decodeErr := image.Decode(reader)
			reader.Close()
			if decodeErr != nil {
				t.Fatalf("cloud attachment is not an image: %v", decodeErr)
			}
		}
		status, body := http.StatusOK, `{"data":[{"b64_json":"`+strings.SplitN(picture, ",", 2)[1]+`"}]}`
		if fail {
			status, body = http.StatusInternalServerError, `{"error":{"message":"inference failed"}}`
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	run := func(patch map[string]any, token string) map[string]any {
		inputs := map[string]any{
			"modelImageUrl": picture, "topImageUrl": picture, "bottomImageUrl": picture, "garmentPhotoType": "person",
			"poseMode": "reference", "poseImageUrl": picture, "sceneMode": "studio", "framing": "full", "prompt": "衣摆自然垂放",
		}
		for key, value := range patch {
			inputs[key] = value
		}
		body, _ := json.Marshal(caseRunRequest{Inputs: inputs})
		r := httptest.NewRequest(http.MethodPost, "/api/cases/official-tryon/run", bytes.NewReader(body))
		r.Header.Set("X-Case-Quote", token)
		r = r.WithContext(service.WithUser(r.Context(), model.PublicUser(user)))
		w := httptest.NewRecorder()
		RunCase(w, r, item.ID)
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	balance := func() int {
		var current model.User
		if err := db.First(&current, "id = ?", user.ID).Error; err != nil {
			t.Fatal(err)
		}
		return current.Credits
	}
	for _, patch := range []map[string]any{
		{"modelImageUrl": ""}, {"topImageUrl": "", "bottomImageUrl": ""}, {"poseImageUrl": ""},
		{"sceneMode": "library"}, {"framing": "half"}, {"garmentMode": "one-piece", "onePieceImageUrl": picture},
	} {
		if run(patch, quote.Data.Token)["code"] == float64(0) || balance() != 100 || calls != 0 {
			t.Fatal("invalid cloud input reached upstream or consumed credits")
		}
	}
	if run(nil, "")["code"] == float64(0) || calls != 0 || balance() != 100 {
		t.Fatal("unquoted cloud call accepted")
	}
	if result := run(nil, quote.Data.Token); result["code"] != float64(0) || calls != 1 || balance() != 90 {
		t.Fatalf("cloud success or cost incorrect: %v, calls=%d balance=%d", result, calls, balance())
	}
	fail = true
	if result := run(nil, quote.Data.Token); result["code"] == float64(0) || calls != 2 || balance() != 90 {
		t.Fatalf("failure was retried or not refunded: %v, calls=%d balance=%d", result, calls, balance())
	}
	settings.Private.ModelManagement.Revision++
	_, _ = repository.SaveSettings(settings, "test-change")
	if run(nil, quote.Data.Token)["code"] == float64(0) || calls != 2 || balance() != 90 {
		t.Fatal("stale quote reached upstream or consumed credits")
	}
}

func TestTryonValidatesInputsBeforeGeneration(t *testing.T) {
	picture := tryonTestImage(t)
	models, scenes := tryonLibrary()
	for _, test := range []struct {
		name   string
		patch  map[string]any
		errMsg string
	}{
		{"uploaded model", nil, ""},
		{"library model", map[string]any{"modelImageUrl": models[0].URL}, ""},
		{"missing model", map[string]any{"modelImageUrl": ""}, "模特"},
		{"missing garment", map[string]any{"topImageUrl": ""}, "上装或下装"},
		{"one piece", map[string]any{"garmentMode": "one-piece", "topImageUrl": "", "onePieceImageUrl": picture}, ""},
		{"mixed garments", map[string]any{"garmentMode": "one-piece", "onePieceImageUrl": picture}, "同时提交"},
		{"wrong garment mode", map[string]any{"onePieceImageUrl": picture}, "切换"},
		{"missing pose", map[string]any{"poseMode": "reference"}, "姿势参考"},
		{"pose reference", map[string]any{"poseMode": "reference", "poseImageUrl": picture}, ""},
		{"missing scene", map[string]any{"sceneMode": "library"}, "请选择场景"},
		{"library scene", map[string]any{"sceneMode": "library", "sceneImageUrl": scenes[0].URL}, ""},
		{"model used as scene", map[string]any{"sceneMode": "library", "sceneImageUrl": models[0].URL}, "官方素材库"},
		{"external model", map[string]any{"modelImageUrl": "https://example.com/model.png"}, "本地"},
		{"external pose", map[string]any{"poseMode": "reference", "poseImageUrl": "http://127.0.0.1/private"}, "本地"},
		{"garment from model library", map[string]any{"topImageUrl": models[0].URL}, "本地"},
		{"unreadable image", map[string]any{"modelImageUrl": "data:" + "image/png;base64,dGVzdA=="}, "无法解码"},
		{"array model", map[string]any{"modelImageUrl": []any{picture}}, "图片格式"},
		{"invalid pose mode", map[string]any{"poseMode": map[string]any{"value": "original"}}, "选项无效"},
		{"half body trousers", map[string]any{"framing": "half", "bottomImageUrl": picture}, "全身"},
	} {
		t.Run(test.name, func(t *testing.T) {
			inputs := map[string]any{"topImageUrl": picture, "modelImageUrl": picture}
			for key, value := range test.patch {
				inputs[key] = value
			}
			err := normalizeTryonInputs(inputs)
			if test.errMsg == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), test.errMsg) {
				t.Fatalf("got %v, want error containing %q", err, test.errMsg)
			}
		})
	}
}

func TestTryonOriginalModesDiscardUnusedReferences(t *testing.T) {
	picture := tryonTestImage(t)
	inputs := map[string]any{
		"topImageUrl": picture, "modelImageUrl": picture,
		"poseImageUrl":       "https://example.com/stale-pose",
		"sceneImageUrl":      "https://example.com/stale-scene",
		"referenceImageUrls": []any{"https://example.com/extra"},
	}
	if err := normalizeTryonInputs(inputs); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"poseImageUrl", "sceneImageUrl", "referenceImageUrls"} {
		if _, exists := inputs[key]; exists {
			t.Fatalf("inactive reference %s survived normalization", key)
		}
	}
	prompt := tryonPrompt(inputs)
	for _, text := range []string{"图1为模特", "图2为上装", "保持模特原图的身体姿势", "保持模特原图背景", "保持模特原有下装"} {
		if !strings.Contains(prompt, text) {
			t.Fatalf("missing preservation instruction: %s", text)
		}
	}
}

func TestTryonReferenceRolesAndModes(t *testing.T) {
	picture := tryonTestImage(t)
	inputs := map[string]any{
		"garmentMode": "one-piece", "onePieceImageUrl": picture, "modelImageUrl": picture,
		"poseMode": "reference", "poseImageUrl": picture, "sceneMode": "studio",
		"garmentPhotoType": "person", "framing": "full", "prompt": "衣摆自然垂放",
	}
	if err := normalizeTryonInputs(inputs); err != nil {
		t.Fatal(err)
	}
	prompt := tryonPrompt(inputs)
	for _, text := range []string{"图1为模特", "图2为连体装", "图3为姿势", "仅参考身体朝向", "纯白影棚", "全身构图", "穿着图", "衣摆自然垂放"} {
		if !strings.Contains(prompt, text) {
			t.Fatalf("missing role or option: %s", text)
		}
	}
	if strings.Contains(prompt, "保持模特原有下装") || strings.Contains(prompt, "图4") {
		t.Fatal("one-piece prompt contains an unrelated clothing instruction or reference")
	}
	if !hasTryonImages(inputs) || hasTryonImages(map[string]any{"imageUrl": picture}) {
		t.Fatal("try-on input detection must not change ordinary image edits")
	}
}

func TestTryonEditSendsActualRoleOrderedImages(t *testing.T) {
	db := setupVideoLogTest(t)
	user := model.User{ID: "tryon-edit-owner", Username: "tryon-edit-owner", AffCode: "tryon-edit-owner", Group: "default", Credits: 100, Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Delete(&user)
	})
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{
		{ID: 817, Name: "tryon-test", BaseURL: "https://tryon-test.example", APIKey: "test-only", Models: []string{"tryon-image-test"}, Enabled: true, Weight: 1},
	}}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/images/edits" {
			t.Fatalf("unexpected upstream path: %s", request.URL.Path)
		}
		reader, err := request.MultipartReader()
		if err != nil {
			t.Fatal(err)
		}
		var filenames []string
		var prompt string
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			content, err := io.ReadAll(part)
			if err != nil {
				t.Fatal(err)
			}
			if part.FormName() == "prompt" {
				prompt = string(content)
			}
			if part.FileName() == "" {
				continue
			}
			if part.FormName() != "image[]" {
				t.Fatalf("wrong image field: %s", part.FormName())
			}
			if _, _, err := image.DecodeConfig(bytes.NewReader(content)); err != nil {
				t.Fatalf("attachment is not an image: %v", err)
			}
			filenames = append(filenames, part.FileName())
		}
		if strings.Join(filenames, ",") != "modelImageUrl.png,onePieceImageUrl.png,poseImageUrl.png" {
			t.Fatalf("attachment roles are out of order: %v", filenames)
		}
		if !strings.Contains(prompt, "图3为姿势") {
			t.Fatal("pose reference missing from prompt")
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"data":[{"url":"https://tryon-test.example/result.png"}]}`))}, nil
	})}
	picture := tryonTestImage(t)
	inputs := map[string]any{
		"garmentMode": "one-piece", "onePieceImageUrl": picture, "modelImageUrl": picture,
		"poseMode": "reference", "poseImageUrl": picture,
	}
	if err := normalizeTryonInputs(inputs); err != nil {
		t.Fatal(err)
	}
	result, err := executeCaseEdit(httptest.NewRequest(http.MethodPost, "/", nil), model.PublicUser(user), caseRuntimeConfig{Kind: "image", Model: "tryon-image-test", Operation: "image-edit", Size: "1024x1536", Quality: "high"}, tryonPrompt(inputs), inputs)
	if err != nil || result["data"] == nil {
		t.Fatalf("role-ordered edit failed: %v %v", result, err)
	}
}
