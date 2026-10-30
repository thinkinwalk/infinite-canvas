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
		for _, text := range []string{"图1为模特", "图2为上装", "图3为下装", "图4为姿势", "仅参考身体朝向", "纯白影棚", "构图优先遵循用户补充要求", "穿着图", "半身构图，衣摆自然垂放"} {
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
			"modelImageUrl": picture, "topImageUrl": picture, "bottomImageUrl": picture,
			"poseMode": "reference", "poseImageUrl": picture, "sceneMode": "studio", "prompt": "半身构图，衣摆自然垂放",
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
		{"sceneMode": "library"}, {"garmentMode": "one-piece", "onePieceImageUrl": picture},
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
		{"child model", map[string]any{"modelImageUrl": tryonChildModels[0].URL}, ""},
		{"child thumbnail as model", map[string]any{"modelImageUrl": tryonChildModels[0].Thumb}, "本地"},
		{"child as garment", map[string]any{"topImageUrl": tryonChildModels[0].URL}, "本地"},
		{"child as scene", map[string]any{"sceneMode": "library", "sceneImageUrl": tryonChildModels[0].URL}, "官方素材库"},
		{"missing model", map[string]any{"modelImageUrl": ""}, "模特"},
		{"missing garment", map[string]any{"topImageUrl": ""}, "上装或下装"},
		{"one piece", map[string]any{"garmentMode": "one-piece", "topImageUrl": "", "onePieceImageUrl": picture}, ""},
		{"mixed garments", map[string]any{"garmentMode": "one-piece", "onePieceImageUrl": picture}, "同时提交"},
		{"wrong garment mode", map[string]any{"onePieceImageUrl": picture}, "切换"},
		{"missing pose", map[string]any{"poseMode": "reference"}, "姿势参考"},
		{"pose reference", map[string]any{"poseMode": "reference", "poseImageUrl": picture}, ""},
		{"custom pose text", map[string]any{"poseMode": "reference", "posePrompt": "单手轻扶腰部"}, ""},
		{"blank custom pose text", map[string]any{"poseMode": "reference", "posePrompt": " \n "}, "姿势参考"},
		{"invalid custom pose text", map[string]any{"poseMode": "reference", "posePrompt": []any{"站立"}}, "格式无效"},
		{"invalid display pose", map[string]any{"poseMode": "preset", "poseId": "unknown"}, "展示姿势"},
		{"library pose", map[string]any{"poseMode": "library", "poseId": tryonPresetPoses[0].ID, "poseImageUrl": tryonPresetPoses[0].URL}, ""},
		{"missing library pose", map[string]any{"poseMode": "library"}, "常用姿势"},
		{"mismatched library pose", map[string]any{"poseMode": "library", "poseId": tryonPresetPoses[0].ID, "poseImageUrl": tryonPresetPoses[1].URL}, "常用姿势"},
		{"uploaded library pose", map[string]any{"poseMode": "library", "poseId": tryonPresetPoses[0].ID, "poseImageUrl": picture}, "常用姿势"},
		{"library pose as model", map[string]any{"modelImageUrl": tryonPresetPoses[0].URL}, "本地"},
		{"library pose in upload mode", map[string]any{"poseMode": "reference", "poseImageUrl": tryonPresetPoses[0].URL}, "本地"},
		{"missing scene", map[string]any{"sceneMode": "library"}, "请选择场景"},
		{"library scene", map[string]any{"sceneMode": "library", "sceneImageUrl": scenes[0].URL}, ""},
		{"model used as scene", map[string]any{"sceneMode": "library", "sceneImageUrl": models[0].URL}, "官方素材库"},
		{"external model", map[string]any{"modelImageUrl": "https://example.com/model.png"}, "本地"},
		{"external pose", map[string]any{"poseMode": "reference", "poseImageUrl": "http://127.0.0.1/private"}, "本地"},
		{"garment from model library", map[string]any{"topImageUrl": models[0].URL}, "本地"},
		{"unreadable image", map[string]any{"modelImageUrl": "data:" + "image/png;base64,dGVzdA=="}, "无法解码"},
		{"array model", map[string]any{"modelImageUrl": []any{picture}}, "图片格式"},
		{"invalid pose mode", map[string]any{"poseMode": map[string]any{"value": "original"}}, "选项无效"},
		{"custom framing top", map[string]any{"prompt": "半身构图，突出上衣细节"}, ""},
		{"custom framing trousers", map[string]any{"prompt": "突出裤腰细节", "bottomImageUrl": picture}, ""},
		{"custom framing one piece", map[string]any{"garmentMode": "one-piece", "topImageUrl": "", "onePieceImageUrl": picture, "prompt": "全身构图"}, ""},
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
		"topImageUrl": picture, "modelImageUrl": picture, "poseMode": "original",
		"poseImageUrl":       "https://example.com/stale-pose",
		"poseId":             tryonPresetPoses[0].ID,
		"sceneImageUrl":      "https://example.com/stale-scene",
		"referenceImageUrls": []any{"https://example.com/extra"},
		"framing":            "half",
	}
	if err := normalizeTryonInputs(inputs); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"poseId", "poseImageUrl", "sceneImageUrl", "referenceImageUrls", "framing"} {
		if _, exists := inputs[key]; exists {
			t.Fatalf("inactive reference %s survived normalization", key)
		}
	}
	prompt := tryonPrompt(inputs)
	for _, text := range []string{"图1为模特", "图2为上装", "保持模特原图的身体姿势", "保持模特原图背景", "保持模特原有下装", "模特参考图的取景与目标服装的展示需要"} {
		if !strings.Contains(prompt, text) {
			t.Fatalf("missing preservation instruction: %s", text)
		}
	}
	if strings.Contains(prompt, "采用全身构图") || strings.Contains(prompt, "采用半身构图") {
		t.Fatal("default prompt must not force full-body or half-body framing")
	}
}

func TestTryonReferenceRolesAndModes(t *testing.T) {
	picture := tryonTestImage(t)
	inputs := map[string]any{
		"garmentMode": "one-piece", "onePieceImageUrl": picture, "modelImageUrl": picture,
		"poseMode": "reference", "poseImageUrl": picture, "sceneMode": "studio",
		"prompt": "全身构图，衣摆自然垂放",
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

func TestTryonGarmentReferencesUseOnlyAssignedClothing(t *testing.T) {
	picture := tryonTestImage(t)
	for _, test := range []struct {
		name    string
		garment map[string]any
	}{
		{"top", map[string]any{"topImageUrl": picture}},
		{"bottom", map[string]any{"bottomImageUrl": picture}},
		{"separates", map[string]any{"topImageUrl": picture, "bottomImageUrl": picture}},
		{"one piece", map[string]any{"garmentMode": "one-piece", "onePieceImageUrl": picture}},
	} {
		t.Run(test.name, func(t *testing.T) {
			inputs := map[string]any{"modelImageUrl": picture, "poseMode": "original"}
			for key, value := range test.garment {
				inputs[key] = value
			}
			if err := normalizeTryonInputs(inputs); err != nil {
				t.Fatal(err)
			}
			prompt := tryonPrompt(inputs)
			for _, text := range []string{
				"平铺图、挂拍图或穿着图", "各张图片只提取其指定的目标服装",
				"不复制参考图中人物的面容、发型、肤色、体型、动作或背景",
				"保持模特原图的身体姿势", "保持模特原图背景",
			} {
				if !strings.Contains(prompt, text) {
					t.Fatalf("missing reference instruction: %s", text)
				}
			}
			for key, instruction := range map[string]string{
				"topImageUrl": "保持模特原有上装", "bottomImageUrl": "保持模特原有下装",
			} {
				keep := stringInput(inputs, key) == "" && stringInput(inputs, "onePieceImageUrl") == ""
				if strings.Contains(prompt, instruction) != keep {
					t.Fatalf("wrong preservation instruction: %s", instruction)
				}
			}
		})
	}
}

func TestTryonEditSendsActualRoleOrderedImages(t *testing.T) {
	db := setupVideoLogTest(t)
	childContent, _, err := caseImageBytes(tryonChildModels[0].URL)
	if err != nil {
		t.Fatal(err)
	}
	childImage, _, err := image.Decode(bytes.NewReader(childContent))
	if err != nil {
		t.Fatal(err)
	}
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
			dimensions, _, err := image.DecodeConfig(bytes.NewReader(content))
			if err != nil {
				t.Fatalf("attachment is not an image: %v", err)
			}
			if part.FileName() == "poseImageUrl.png" && dimensions.Width <= 2 {
				t.Fatal("built-in pose attachment was replaced by an upload fixture")
			}
			if part.FileName() == "modelImageUrl.png" {
				attachment, _, err := image.Decode(bytes.NewReader(content))
				if err != nil || attachment.Bounds() != childImage.Bounds() {
					t.Fatal("child model attachment must use the original image")
				}
				r, g, b, _ := attachment.At(100, 100).RGBA()
				wantR, wantG, wantB, _ := childImage.At(100, 100).RGBA()
				if r != wantR || g != wantG || b != wantB {
					t.Fatal("child model pixels changed before reaching upstream")
				}
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
		"garmentMode": "one-piece", "onePieceImageUrl": picture, "modelImageUrl": tryonChildModels[0].URL,
		"poseMode": "library", "poseId": tryonPresetPoses[0].ID, "poseImageUrl": tryonPresetPoses[0].URL,
	}
	if err := normalizeTryonInputs(inputs); err != nil {
		t.Fatal(err)
	}
	result, err := executeCaseEdit(httptest.NewRequest(http.MethodPost, "/", nil), model.PublicUser(user), caseRuntimeConfig{Kind: "image", Model: "tryon-image-test", Operation: "image-edit", Size: "1024x1536", Quality: "high"}, tryonPrompt(inputs), inputs)
	if err != nil || result["data"] == nil {
		t.Fatalf("role-ordered edit failed: %v %v", result, err)
	}
}

func TestTryonDisplayPosesAndCustomInstructions(t *testing.T) {
	picture := tryonTestImage(t)
	for _, pose := range []struct{ id, instruction string }{
		{"front", "正对镜头自然站立"},
		{"side", "头部与身体朝向一致"},
		{"back", "没有背面参考时不凭空添加"},
		{"walking", "自然迈出一小步"},
	} {
		t.Run(pose.id, func(t *testing.T) {
			inputs := map[string]any{
				"topImageUrl": picture, "modelImageUrl": picture,
				"poseMode": "preset", "poseId": pose.id,
				"poseImageUrl": picture, "posePrompt": "旧的自定义要求",
			}
			if err := normalizeTryonInputs(inputs); err != nil {
				t.Fatal(err)
			}
			prompt := tryonPrompt(inputs)
			if !strings.Contains(prompt, pose.instruction) || strings.Contains(prompt, "保持模特原图的身体姿势") || strings.Contains(prompt, "图3为姿势") || strings.Contains(prompt, "旧的自定义要求") {
				t.Fatalf("wrong display pose prompt: %s", prompt)
			}
			if _, exists := inputs["poseImageUrl"]; exists {
				t.Fatal("display pose must not attach an unrelated reference")
			}
		})
	}
	defaults := map[string]any{"topImageUrl": picture, "modelImageUrl": picture}
	if err := normalizeTryonInputs(defaults); err != nil || defaults["poseMode"] != "preset" || defaults["poseId"] != "front" {
		t.Fatalf("front pose must be the default: %v %v", defaults, err)
	}
	custom := map[string]any{"topImageUrl": picture, "modelImageUrl": picture, "poseMode": "reference", "posePrompt": " 单手轻扶腰部 "}
	if err := normalizeTryonInputs(custom); err != nil {
		t.Fatal(err)
	}
	prompt := tryonPrompt(custom)
	if custom["posePrompt"] != "单手轻扶腰部" || !strings.Contains(prompt, "自定义姿势要求") || !strings.Contains(prompt, "单手轻扶腰部") || strings.Contains(prompt, "保持模特原图的身体姿势") || strings.Contains(prompt, "根据姿势图") {
		t.Fatalf("text-only pose contains contradictory or missing instructions: %s", prompt)
	}
	custom["poseImageUrl"] = picture
	if err := normalizeTryonInputs(custom); err != nil {
		t.Fatal(err)
	}
	prompt = tryonPrompt(custom)
	if !strings.Contains(prompt, "图3为姿势") || !strings.Contains(prompt, "与姿势参考图动作冲突时以此描述为准") {
		t.Fatal("custom pose image and text must both reach the prompt")
	}
}

func TestTryonEmbeddedPoseAssets(t *testing.T) {
	for _, pose := range tryonPresetPoses {
		content, mime, err := caseImageBytes(pose.URL)
		if err != nil || mime != "image/jpeg" || len(content) == 0 {
			t.Fatalf("missing pose %s: %v", pose.ID, err)
		}
		if _, _, err := image.Decode(bytes.NewReader(content)); err != nil {
			t.Fatalf("unreadable pose %s: %v", pose.ID, err)
		}
		w := httptest.NewRecorder()
		TryonAsset(w, httptest.NewRequest(http.MethodGet, pose.URL, nil))
		if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), content) {
			t.Fatalf("pose URL and edit attachment differ: %s", pose.ID)
		}
	}
	for _, path := range []string{"/api/tryon/assets/../provenance.json", "/api/tryon/assets/provenance.json", "/api/tryon/assets/missing.jpg"} {
		w := httptest.NewRecorder()
		TryonAsset(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("unregistered asset exposed: %s", path)
		}
		if _, _, err := caseImageBytes(path); err == nil {
			t.Fatalf("unregistered attachment accepted: %s", path)
		}
	}
}

func TestTryonChildModelAssetsAndRoles(t *testing.T) {
	models, _ := tryonLibrary()
	children, genders := 0, map[string]int{}
	for _, item := range models {
		if !item.Child {
			continue
		}
		children++
		genders[item.Gender]++
		for _, url := range []string{item.URL, item.Thumb} {
			content, mime, err := caseImageBytes(url)
			if err != nil || mime != "image/jpeg" {
				t.Fatalf("missing child asset %s: %v", url, err)
			}
			if _, _, err := image.Decode(bytes.NewReader(content)); err != nil {
				t.Fatalf("unreadable child asset %s: %v", url, err)
			}
			w := httptest.NewRecorder()
			TryonAsset(w, httptest.NewRequest(http.MethodGet, url, nil))
			if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), content) {
				t.Fatalf("child preview and edit bytes differ: %s", url)
			}
		}
		if !validTryonLibraryURL(item.URL, "模特") || validTryonLibraryURL(item.Thumb, "模特") || validTryonLibraryURL(item.URL, "场景") {
			t.Fatalf("incorrect child asset role: %s", item.ID)
		}
	}
	if children != 12 || genders["m"] != 6 || genders["f"] != 6 {
		t.Fatalf("child catalog must include both genders: %d, %v", children, genders)
	}
}
