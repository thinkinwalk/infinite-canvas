package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

type caseRunRequest struct {
	Inputs map[string]any `json:"inputs"`
}

type caseRuntimeConfig struct {
	Kind            string `json:"kind"`
	Model           string `json:"model"`
	PromptTemplate  string `json:"promptTemplate"`
	Count           int    `json:"count"`
	Size            string `json:"size"`
	Quality         string `json:"quality"`
	Seconds         string `json:"seconds"`
	Ratio           string `json:"ratio"`
	Resolution      string `json:"resolution"`
	GenerateAudio   bool   `json:"generateAudio"`
	Watermark       bool   `json:"watermark"`
	BackgroundInput string `json:"backgroundInput"`
	Operation       string `json:"operation"`
}

func CaseRunPrice(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "请先登录")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "案例不存在或尚未发布")
		return
	}
	var runtime caseRuntimeConfig
	if err := json.Unmarshal([]byte(item.RuntimeConfig), &runtime); err != nil {
		Fail(w, "案例运行配置无效")
		return
	}
	if runtime.Operation == "print-file" || runtime.Operation == "upscale-local" {
		OK(w, map[string]any{"modelPoints": 0, "servicePoints": 0, "points": 0, "count": 1})
		return
	}
	if runtime.Operation == "cutout-replicate" || runtime.Operation == "upscale-replicate" {
		key, err := service.ReplicateAPIKey()
		if err != nil {
			FailError(w, err)
			return
		}
		if key == "" {
			Fail(w, "专用图像处理服务未配置，请联系管理员在私有配置中设置 Replicate API Token")
			return
		}
		fee := max(item.PriceCredits, 0)
		OK(w, map[string]any{"modelPoints": 0, "servicePoints": fee, "points": fee, "count": 1})
		return
	}
	modelName, err := resolveCaseModel(runtime.Kind, runtime.Model, user.Group)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	if _, err := service.SelectModelChannelForGroup(modelName, user.Group); err != nil {
		FailError(w, err)
		return
	}
	base, err := service.ModelCost(modelName)
	if err != nil {
		FailError(w, err)
		return
	}
	ratio, err := service.UserGroupRatio(user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	count := 1
	if runtime.Kind == "image" && runtime.Count > 1 {
		count = runtime.Count
	}
	if id == "official-image-variations" {
		count = variationCount(r.URL.Query().Get("count"))
	} else if id == "official-fusion" {
		count = fusionCount(r.URL.Query().Get("count"))
	}
	fee := max(item.PriceCredits, 0)
	if id == "official-image-variations" {
		fee = 0
	}
	modelPoints := int(math.Ceil(float64(base)*ratio)) * count
	OK(w, map[string]any{"modelPoints": modelPoints, "servicePoints": fee, "points": fee + modelPoints, "count": count})
}

func Cases(w http.ResponseWriter, r *http.Request) {
	result, err := service.ListPublishedCases(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func CaseDetail(w http.ResponseWriter, r *http.Request, id string) {
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "案例不存在")
		return
	}
	_ = repository.IncrementCaseView(id)
	OK(w, item)
}

func OwnedCases(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	result, err := service.ListOwnedCases(user.ID, parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func CaseRuns(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	items, total, err := service.ListCaseRuns(user.ID, parseQuery(r), strings.TrimSpace(r.URL.Query().Get("caseId")))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"items": items, "total": total})
}

func CreateCase(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var input service.CaseDraftInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "案例数据格式无效")
		return
	}
	item, err := service.SaveCaseDraft(user.ID, input)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, item)
}

func SubmitCase(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, err := service.SubmitCaseReview(user.ID, id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, item)
}

func AdminCases(w http.ResponseWriter, r *http.Request) {
	result, err := service.ListAllCases(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminCreateCase(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var input service.CaseDraftInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "案例数据格式无效")
		return
	}
	item, err := service.SaveCaseDraft(user.ID, input)
	if err != nil {
		FailError(w, err)
		return
	}
	item, err = service.SetCaseOfficial(item.ID, true)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, item)
}

func AdminReviewCase(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		Status model.CaseStatus `json:"status"`
		Note   string           `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "审核数据格式无效")
		return
	}
	item, err := service.ReviewCase(id, payload.Status, payload.Note)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, item)
}

func RunCase(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "案例不存在或尚未发布")
		return
	}
	var input caseRunRequest
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "案例输入格式无效")
		return
	}
	if input.Inputs == nil {
		input.Inputs = map[string]any{}
	}
	if item.ID == "official-tryon" && firstNonEmptyInput(input.Inputs, "topImageUrl", "bottomImageUrl") == "" {
		Fail(w, "请先上传上装或下装")
		return
	}
	if item.ID == "official-tryon" {
		for _, source := range []struct{ key, role string }{{"topImageUrl", "上装"}, {"bottomImageUrl", "下装"}} {
			value := strings.TrimSpace(stringInput(input.Inputs, source.key))
			if value != "" && !strings.HasPrefix(value, "data:image/") {
				Fail(w, "请上传本地"+source.role+"图片")
				return
			}
		}
		for _, source := range []struct{ key, role string }{{"modelImageUrl", "模特"}, {"sceneImageUrl", "场景"}} {
			value := strings.TrimSpace(stringInput(input.Inputs, source.key))
			if value != "" && !validTryonLibraryURL(value, source.role) {
				Fail(w, source.role+"素材不在官方素材库中")
				return
			}
		}
	}
	if item.ID == "official-image-variations" {
		runImageVariations(w, r, user, item, input.Inputs)
		return
	}
	if err := validateCaseInputs(item.PublicSchema, input.Inputs); err != nil {
		Fail(w, err.Error())
		return
	}
	var runtime caseRuntimeConfig
	if err := json.Unmarshal([]byte(item.RuntimeConfig), &runtime); err != nil {
		Fail(w, "案例运行配置无效")
		return
	}
	if runtime.Operation != "print-file" && runtime.Operation != "upscale-local" && runtime.Operation != "cutout-replicate" && runtime.Operation != "upscale-replicate" && (strings.TrimSpace(runtime.Model) == "" || strings.TrimSpace(runtime.PromptTemplate) == "") {
		Fail(w, "案例尚未配置模型和提示词模板")
		return
	}
	if runtime.Operation != "print-file" && runtime.Operation != "upscale-local" && runtime.Operation != "cutout-replicate" && runtime.Operation != "upscale-replicate" {
		runtime.Model, err = resolveCaseModel(runtime.Kind, runtime.Model, user.Group)
		if err != nil {
			FailError(w, err)
			return
		}
	}
	if item.ID == "official-fusion" {
		runtime.Count = fusionCount(stringInput(input.Inputs, "count"))
		runtime.Size, runtime.Quality = fusionOutputSettings(stringInput(input.Inputs, "aspectRatio"), stringInput(input.Inputs, "outputMode"))
	}
	if item.ID == "official-print-extract" {
		runtime.Size, runtime.Quality = printExtractOutputSettings(stringInput(input.Inputs, "aspectRatio"), stringInput(input.Inputs, "quality"))
	}
	if item.ID == "official-garment-extract" {
		runtime.Quality = garmentExtractQuality(stringInput(input.Inputs, "detail"))
	}
	if item.ID == "official-garment-3d" {
		runtime.Size = garment3DOutputSize(stringInput(input.Inputs, "imageResolution"))
	}
	if runtime.Operation == "print-file" {
		payload, printErr := runPrintFile(input.Inputs)
		if printErr != nil {
			Fail(w, printErr.Error())
			return
		}
		responseBody, _ := json.Marshal(payload)
		_ = repository.SaveCaseRun(model.CaseRun{ID: fmt.Sprintf("case-run-%d", time.Now().UnixNano()), CaseID: item.ID, UserID: user.ID, Version: item.PublishedVersion, Status: "succeeded", ResponseBody: string(responseBody), CreatedAt: serviceNow(), UpdatedAt: serviceNow()})
		_ = repository.IncrementCaseRun(item.ID)
		OK(w, payload)
		return
	}
	if runtime.Operation == "upscale-local" {
		payload, upscaleErr := runUpscaleLocal(input.Inputs)
		if upscaleErr != nil {
			Fail(w, upscaleErr.Error())
			return
		}
		responseBody, _ := json.Marshal(payload)
		_ = repository.SaveCaseRun(model.CaseRun{ID: fmt.Sprintf("case-run-%d", time.Now().UnixNano()), CaseID: item.ID, UserID: user.ID, Version: item.PublishedVersion, Status: "succeeded", ResponseBody: string(responseBody), CreatedAt: serviceNow(), UpdatedAt: serviceNow()})
		_ = repository.IncrementCaseRun(item.ID)
		OK(w, payload)
		return
	}
	if runtime.Operation == "cutout-replicate" || runtime.Operation == "upscale-replicate" {
		key, err := service.ReplicateAPIKey()
		if err != nil {
			FailError(w, err)
			return
		}
		if key == "" {
			Fail(w, "专用图像处理服务未配置，请联系管理员在私有配置中设置 Replicate API Token")
			return
		}
		fee := item.PriceCredits
		if fee < 0 {
			fee = 0
		}
		if fee > 0 {
			if err := service.ConsumeUserCredits(user.ID, "case:"+item.ID, fee, "/cases/"+item.ID); err != nil {
				FailError(w, err)
				return
			}
		}
		payload, processErr := runReplicateTool(r, runtime.Operation, input.Inputs)
		if processErr != nil {
			refundCaseFee(user.ID, item.ID, fee)
			Fail(w, processErr.Error())
			return
		}
		responseBody, _ := json.Marshal(payload)
		_ = repository.SaveCaseRun(model.CaseRun{ID: fmt.Sprintf("case-run-%d", time.Now().UnixNano()), CaseID: item.ID, UserID: user.ID, Version: item.PublishedVersion, Status: "succeeded", ChargedCredits: fee, ResponseBody: string(responseBody), CreatedAt: serviceNow(), UpdatedAt: serviceNow()})
		_ = repository.IncrementCaseRun(item.ID)
		OK(w, payload)
		return
	}
	prompt := renderCasePrompt(runtime.PromptTemplate, input.Inputs)
	if item.ID == "official-tryon" {
		roles := []string{}
		for _, source := range []struct{ key, description string }{
			{"topImageUrl", "上装，保留衣服版型、颜色和细节"},
			{"bottomImageUrl", "下装，保留衣服版型、颜色和细节"},
			{"modelImageUrl", "模特，保留同一人的面容、体型和肤色"},
			{"sceneImageUrl", "场景，参考背景和光线"},
		} {
			if stringInput(input.Inputs, source.key) != "" {
				roles = append(roles, fmt.Sprintf("图%d为%s", len(roles)+1, source.description))
			}
		}
		prompt += "。输入图顺序：" + strings.Join(roles, "；") + "。"
	}
	if item.ID == "official-garment-extract" && !strings.Contains(runtime.PromptTemplate, "{{detail}}") {
		prompt += " 保留细节级别：" + stringInput(input.Inputs, "detail") + "。"
	}
	if prompt == "" {
		Fail(w, "案例提示词为空")
		return
	}

	fee := item.PriceCredits
	if fee < 0 {
		fee = 0
	}
	run := model.CaseRun{ID: fmt.Sprintf("case-run-%d", time.Now().UnixNano()), CaseID: item.ID, UserID: user.ID, Version: item.PublishedVersion, Status: "pending", ChargedCredits: fee}
	if fee > 0 {
		if err := service.ConsumeUserCredits(user.ID, "case:"+item.ID, fee, "/cases/"+item.ID); err != nil {
			FailError(w, err)
			return
		}
	}
	run.AuthorCredits = fee * item.RevenueSharePercent / 100
	run.PlatformCredits = fee - run.AuthorCredits
	_ = repository.SaveCaseRun(run)

	var payload map[string]any
	if runtime.Kind == "image" && runtime.Count > 1 {
		count := runtime.Count
		runtime.Count = 1
		results := []any{}
		failed := 0
		for i := 0; i < count; i++ {
			imagePrompt := fmt.Sprintf("%s\n本次生成第 %d/%d 张变体，采用与其他变体不同的构图或场景。只输出一张完整图片，不要拼图。", prompt, i+1, count)
			var output map[string]any
			var callErr error
			if runtime.Operation == "inpaint" || runtime.Operation == "image-edit" {
				output, callErr = executeCaseEdit(r, user, runtime, imagePrompt, input.Inputs)
			} else {
				output, callErr = executeCaseAI(r, user, runtime, imagePrompt, input.Inputs)
			}
			if callErr != nil {
				failed++
				err = callErr
				continue
			}
			results = append(results, output)
		}
		if len(results) > 0 {
			payload = map[string]any{"data": results, "total": count, "failed": failed}
			err = nil
		}
	} else {
		if runtime.Operation == "inpaint" || runtime.Operation == "image-edit" {
			payload, err = executeCaseEdit(r, user, runtime, prompt, input.Inputs)
		} else {
			payload, err = executeCaseAI(r, user, runtime, prompt, input.Inputs)
		}
	}
	if err != nil {
		refundCaseFee(user.ID, item.ID, fee)
		run.Status = "failed"
		run.ErrorMessage = err.Error()
		_ = repository.SaveCaseRun(run)
		Fail(w, run.ErrorMessage)
		return
	}
	payload = persistVariationOutput(payload)
	run.Status = "succeeded"
	responseBody, _ := json.Marshal(payload)
	run.ResponseBody = string(responseBody)
	run.UpdatedAt = serviceNow()
	_ = repository.SaveCaseRun(run)
	_ = repository.IncrementCaseRun(item.ID)
	OK(w, payload)
}

func variationCount(value string) int {
	count := 1
	if parsed, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
		count = parsed
	}
	switch count {
	case 2, 4, 8:
		return count
	default:
		return 1
	}
}

func fusionCount(value string) int {
	switch strings.TrimSpace(value) {
	case "2":
		return 2
	case "4":
		return 4
	default:
		return 1
	}
}

func stringInput(inputs map[string]any, key string) string {
	value, _ := inputs[key].(string)
	return value
}

func fusionOutputSettings(ratio string, mode string) (string, string) {
	sizes := map[string]string{
		"1:1":  "1024x1024",
		"3:4":  "768x1024",
		"4:3":  "1024x768",
		"16:9": "1536x864",
		"9:16": "864x1536",
	}
	qualities := map[string]string{"基础": "low", "标准": "medium", "高阶": "high"}
	size := sizes[strings.TrimSpace(ratio)]
	if size == "" {
		size = sizes["1:1"]
	}
	quality := qualities[strings.TrimSpace(mode)]
	if quality == "" {
		quality = qualities["标准"]
	}
	return size, quality
}

func printExtractOutputSettings(ratio string, quality string) (string, string) {
	sizes := map[string]string{
		"自动":   "1024x1024",
		"1:1":  "1024x1024",
		"3:4":  "768x1024",
		"4:3":  "1024x768",
		"16:9": "1536x864",
		"9:16": "864x1536",
	}
	qualities := map[string]string{"标准": "medium", "高清": "high"}
	size := sizes[strings.TrimSpace(ratio)]
	if size == "" {
		size = sizes["自动"]
	}
	outputQuality := qualities[strings.TrimSpace(quality)]
	if outputQuality == "" {
		outputQuality = qualities["标准"]
	}
	return size, outputQuality
}

func garment3DOutputSize(resolution string) string {
	switch resolution {
	case "2K":
		return "1360x2048"
	case "4K":
		return "2336x3520"
	default:
		return "1024x1536"
	}
}

func garmentExtractQuality(detail string) string {
	if detail == "精细" {
		return "high"
	}
	return "medium"
}

func variationAssistModel(r *http.Request, id string) (model.AuthUser, string, error) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		return user, "", errors.New("请先登录")
	}
	item, exists, err := service.GetCase(id, true)
	if err != nil {
		return user, "", err
	}
	if !exists || item.ID != "official-image-variations" {
		return user, "", errors.New("图裂变案例不存在")
	}
	var runtime caseRuntimeConfig
	if err := json.Unmarshal([]byte(item.RuntimeConfig), &runtime); err != nil {
		return user, "", errors.New("图裂变运行配置无效")
	}
	name, err := resolveCaseModel("text", runtime.Model, user.Group)
	if err != nil {
		return user, "", err
	}
	if _, err := service.SelectModelChannelForGroup(name, user.Group); err != nil {
		return user, "", err
	}
	return user, name, nil
}

func VariationAssistPrice(w http.ResponseWriter, r *http.Request, id string) {
	user, name, err := variationAssistModel(r, id)
	if err != nil {
		FailError(w, err)
		return
	}
	base, err := service.ModelCost(name)
	if err != nil {
		FailError(w, err)
		return
	}
	ratio, err := service.UserGroupRatio(user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"points": int(math.Ceil(float64(base) * ratio))})
}

func VariationAssist(w http.ResponseWriter, r *http.Request, id string) {
	user, name, err := variationAssistModel(r, id)
	if err != nil {
		FailError(w, err)
		return
	}
	var input struct {
		ImageURL string `json:"imageUrl"`
		Mode     string `json:"mode"`
		Prompt   string `json:"prompt"`
		Action   string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil || strings.TrimSpace(input.ImageURL) == "" {
		Fail(w, "请先上传参考图")
		return
	}
	if input.Action != "write" && input.Action != "optimize" {
		Fail(w, "AI 帮写操作无效")
		return
	}
	if input.Action == "optimize" && strings.TrimSpace(input.Prompt) == "" {
		Fail(w, "请先输入需要优化的描述")
		return
	}
	requestText := fmt.Sprintf("你是电商视觉设计师。根据用户上传的图片与裂变方向，为图片裂变工具写一段简洁、可直接编辑的中文补充描述。裂变方向：%s。用户已有描述：%s。任务：%s。只返回用户可见的补充描述，不要标题、引号或解释，不要虚构商品信息。", variationModeHint(input.Mode), strings.TrimSpace(input.Prompt), input.Action)
	content := []any{map[string]any{"type": "text", "text": requestText}, map[string]any{"type": "image_url", "image_url": map[string]string{"url": input.ImageURL}}}
	body, _ := json.Marshal(map[string]any{"model": name, "messages": []any{map[string]any{"role": "user", "content": content}}})
	request := httptest.NewRequest(http.MethodPost, "/chat/completions", bytes.NewReader(body)).WithContext(service.WithUser(r.Context(), user))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	proxyAIRequest(recorder, request, "/chat/completions")
	answer, message, ok := parseProductSetTextResponse(recorder.Code, recorder.Body.Bytes())
	if !ok {
		Fail(w, message)
		return
	}
	OK(w, map[string]any{"prompt": answer})
}

func variationModeHint(mode string) string {
	switch mode {
	case "print":
		return "Treat the reference as a flat print or graphic design. Create a fresh theme, motif and colour story while keeping it a clean standalone design."
	case "background":
		return "Keep the product shape, colour, material and logo unchanged. Replace only the background scene, environment and props."
	case "surface":
		return "Keep the product shape and silhouette unchanged. Change only the surface pattern, print or graphics applied to the product."
	case "both":
		return "Reimagine the product styling and the background scene together, while keeping the same product category and recognisable identity."
	case "subject":
		return "Keep the background and scene unchanged. Vary the product subject styling, colourway and details."
	default:
		return "Create a polished, commercially useful variation of the reference product image."
	}
}

func variationSimilarityHint(value string) string {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 50 {
		parsed = 80
	}
	if parsed >= 90 {
		return "Stay very close to the original, with only subtle minimal changes."
	}
	if parsed >= 75 {
		return "Apply moderate variation while keeping the same product clearly recognisable."
	}
	if parsed >= 60 {
		return "Apply noticeable creative variation while preserving the product identity."
	}
	return "Boldly reinterpret the reference with dramatic but commercially coherent changes."
}

func runImageVariations(w http.ResponseWriter, r *http.Request, user model.AuthUser, item model.CaseApp, inputs map[string]any) {
	imageURL, _ := inputs["imageUrl"].(string)
	imageURL = strings.TrimSpace(imageURL)
	if imageURL == "" {
		Fail(w, "请先上传参考图")
		return
	}
	mode, _ := inputs["splitMode"].(string)
	if mode == "" {
		mode = "print"
	}
	if mode != "print" && mode != "background" && mode != "surface" && mode != "both" && mode != "subject" && mode != "custom" {
		Fail(w, "裂变模式无效")
		return
	}
	promptText, _ := inputs["prompt"].(string)
	if mode == "custom" && strings.TrimSpace(promptText) == "" {
		Fail(w, "请填写自定义裂变要求")
		return
	}
	similarity, _ := inputs["similarity"].(string)
	countValue, _ := inputs["count"].(string)
	count := variationCount(countValue)
	var runtime caseRuntimeConfig
	if err := json.Unmarshal([]byte(item.RuntimeConfig), &runtime); err != nil {
		Fail(w, "图裂变运行配置无效")
		return
	}
	modelName, err := resolveCaseModel("image", runtime.Model, user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	if _, err := service.SelectModelChannelForGroup(modelName, user.Group); err != nil {
		FailError(w, err)
		return
	}
	sourceURL := imageURL
	if strings.HasPrefix(imageURL, "data:image/") {
		saved, saveErr := saveVariationImage(imageURL)
		if saveErr != nil {
			Fail(w, "参考图保存失败，请重新上传")
			return
		}
		sourceURL = saved
	}
	run := model.CaseRun{ID: fmt.Sprintf("case-run-%d", time.Now().UnixNano()), CaseID: item.ID, UserID: user.ID, Version: item.PublishedVersion, Status: "pending", ChargedCredits: 0, CreatedAt: serviceNow(), UpdatedAt: serviceNow()}
	_ = repository.SaveCaseRun(run)
	runtime.Kind = "image"
	runtime.Model = modelName
	runtime.Count = 1
	if runtime.Size == "" {
		runtime.Size = "1024x1024"
	}
	if runtime.Quality == "" {
		runtime.Quality = "high"
	}
	basePrompt := "Create exactly one standalone full-frame e-commerce image from the uploaded reference. Never create a collage, grid, split screen or multiple versions. Preserve important product and brand details, use no watermark and add no text that is not requested."
	prompt := strings.TrimSpace(strings.Join([]string{basePrompt, variationModeHint(mode), variationSimilarityHint(similarity), strings.TrimSpace(promptText)}, " "))
	stream := r.URL.Query().Get("stream") == "1"
	if stream {
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		writeProductSetEvent(w, map[string]any{"type": "start", "total": count})
	}
	results := make([]any, 0, count)
	failed := 0
	for index := 0; index < count; index++ {
		output, callErr := executeCaseAI(r, user, runtime, fmt.Sprintf("%s This is variation %d of %d; make its composition or scene meaningfully different from the other outputs.", prompt, index+1, count), map[string]any{"imageUrl": imageURL})
		var result any
		if callErr != nil {
			failed++
			result = map[string]any{"error": callErr.Error()}
		} else {
			result = persistVariationOutput(output)
		}
		results = append(results, result)
		run.ResponseBody = mustJSON(map[string]any{"data": results, "total": count, "failed": failed, "sourceUrl": sourceURL, "prompt": strings.TrimSpace(promptText), "splitMode": mode, "similarity": similarity})
		run.UpdatedAt = serviceNow()
		_ = repository.SaveCaseRun(run)
		if stream {
			writeProductSetEvent(w, map[string]any{"type": "item", "item": result, "completed": index + 1, "total": count})
		}
	}
	payload := map[string]any{"data": results, "total": count, "failed": failed, "sourceUrl": sourceURL, "prompt": strings.TrimSpace(promptText), "splitMode": mode, "similarity": similarity}
	responseBody, _ := json.Marshal(payload)
	run.ResponseBody = string(responseBody)
	run.UpdatedAt = serviceNow()
	if failed == count {
		run.Status = "failed"
		run.ErrorMessage = "图裂变生成失败，请检查图片模型配置后重试"
	} else {
		run.Status = "succeeded"
		if failed > 0 {
			run.Status = "partial"
		}
		_ = repository.IncrementCaseRun(item.ID)
	}
	_ = repository.SaveCaseRun(run)
	if stream {
		writeProductSetEvent(w, map[string]any{"type": "done", "total": count, "failed": failed})
		return
	}
	if failed == count {
		Fail(w, run.ErrorMessage)
		return
	}
	OK(w, payload)
}

func persistVariationOutput(output map[string]any) map[string]any {
	data, ok := output["data"].([]any)
	if !ok {
		return output
	}
	for index, value := range data {
		image, ok := value.(map[string]any)
		if !ok {
			continue
		}
		encoded, _ := image["b64_json"].(string)
		if encoded == "" {
			continue
		}
		url, err := saveVariationImage("data:image/png;base64," + encoded)
		if err != nil {
			continue
		}
		delete(image, "b64_json")
		image["url"] = url
		data[index] = image
	}
	return output
}

func saveVariationImage(dataURL string) (string, error) {
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 || !strings.HasSuffix(parts[0], ";base64") {
		return "", errors.New("图片格式无效")
	}
	mimeType := strings.TrimPrefix(strings.TrimSuffix(parts[0], ";base64"), "data:")
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mimeType]
	if ext == "" {
		return "", errors.New("图片格式不支持")
	}
	content, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil || len(content) == 0 || len(content) > 30<<20 {
		return "", errors.New("图片数据无效")
	}
	if err := os.MkdirAll(referenceMediaDir(), 0o755); err != nil {
		return "", err
	}
	id := uuid.NewString() + ext
	if err := os.WriteFile(filepath.Join(referenceMediaDir(), id), content, 0o644); err != nil {
		return "", err
	}
	return "/api/media/references/" + id, nil
}

func executeCaseAI(r *http.Request, user model.AuthUser, runtime caseRuntimeConfig, prompt string, inputs map[string]any) (map[string]any, error) {
	path, body, err := buildCaseAIRequest(runtime, prompt, inputs)
	if err != nil {
		return nil, err
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body)).WithContext(service.WithUser(r.Context(), user))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	proxyAIRequest(recorder, request, path)
	var payload map[string]any
	decodeErr := json.Unmarshal(recorder.Body.Bytes(), &payload)
	failed := decodeErr != nil || recorder.Code >= http.StatusBadRequest || payload == nil || payload["error"] != nil
	if code, ok := payload["code"].(float64); ok && code != 0 {
		failed = true
	}
	if failed {
		if msg, ok := payload["msg"].(string); ok && msg != "" {
			return nil, errors.New(msg)
		}
		return nil, errors.New("案例模型返回异常，请重试")
	}
	if _, enveloped := payload["code"]; enveloped {
		if data, ok := payload["data"].(map[string]any); ok {
			return data, nil
		}
		return map[string]any{"data": payload["data"]}, nil
	}
	return payload, nil
}

func validateCaseInputs(schema string, inputs map[string]any) error {
	var config struct {
		Fields []struct {
			Key      string `json:"key"`
			Label    string `json:"label"`
			Type     string `json:"type"`
			Required bool   `json:"required"`
		} `json:"fields"`
	}
	if err := json.Unmarshal([]byte(schema), &config); err != nil {
		return errors.New("案例输入配置无效")
	}
	for _, field := range config.Fields {
		value := inputs[field.Key]
		filled := false
		if field.Type == "images" {
			if images, ok := value.([]any); ok {
				filled = len(images) > 0
				for _, image := range images {
					text, ok := image.(string)
					if !ok || strings.TrimSpace(text) == "" {
						return fmt.Errorf("%s包含无效图片", field.Label)
					}
				}
			}
		} else if text, ok := value.(string); ok {
			filled = strings.TrimSpace(text) != ""
		}
		if field.Required && !filled {
			return fmt.Errorf("请填写%s", field.Label)
		}
		if !filled && !field.Required {
			inputs[field.Key] = ""
		}
	}
	return nil
}

func refundCaseFee(userID string, caseID string, fee int) {
	if fee > 0 {
		_ = service.RefundUserCredits(userID, "case:"+caseID, fee, "/cases/"+caseID)
	}
}

func renderCasePrompt(template string, inputs map[string]any) string {
	result := template
	for key, value := range inputs {
		text, ok := value.(string)
		if !ok {
			encoded, _ := json.Marshal(value)
			text = string(encoded)
		}
		result = strings.ReplaceAll(result, "{{"+key+"}}", text)
	}
	return strings.TrimSpace(result)
}

func buildCaseAIRequest(runtime caseRuntimeConfig, prompt string, inputs map[string]any) (string, []byte, error) {
	payload := map[string]any{"model": runtime.Model, "prompt": prompt}
	if runtime.Kind == "image" && runtime.Count > 0 {
		payload["n"] = runtime.Count
	}
	if runtime.Size != "" {
		payload["size"] = runtime.Size
	}
	if runtime.Quality != "" {
		payload["quality"] = runtime.Quality
	}
	if runtime.BackgroundInput != "" {
		payload["background"] = "opaque"
		if inputs[runtime.BackgroundInput] == "透明" {
			payload["background"] = "transparent"
		}
		payload["output_format"] = "png"
	}
	if runtime.Seconds != "" {
		payload["seconds"] = runtime.Seconds
	}
	if runtime.Ratio != "" {
		payload["ratio"] = runtime.Ratio
	}
	if runtime.Resolution != "" {
		payload["resolution"] = runtime.Resolution
	}
	if runtime.GenerateAudio {
		payload["generate_audio"] = true
	}
	if runtime.Watermark {
		payload["watermark"] = true
	}
	if imageURL, ok := inputs["imageUrl"].(string); ok && strings.TrimSpace(imageURL) != "" {
		payload["image_url"] = strings.TrimSpace(imageURL)
	}
	if references, ok := inputs["referenceImageUrls"]; ok {
		payload["reference_image_urls"] = references
	}
	kind := strings.ToLower(strings.TrimSpace(runtime.Kind))
	path := "/images/generations"
	switch kind {
	case "video":
		path = "/videos"
	case "text":
		path = "/chat/completions"
		content := []any{map[string]any{"type": "text", "text": prompt}}
		if image, ok := inputs["imageUrl"].(string); ok && strings.TrimSpace(image) != "" {
			content = append(content, map[string]any{"type": "image_url", "image_url": map[string]string{"url": image}})
		}
		if images, ok := inputs["referenceImageUrls"].([]any); ok {
			for _, image := range images {
				content = append(content, map[string]any{"type": "image_url", "image_url": map[string]any{"url": image}})
			}
		}
		payload = map[string]any{"model": runtime.Model, "messages": []any{map[string]any{"role": "user", "content": content}}}
	case "image", "":
	default:
		return "", nil, errors.New("案例运行类型不支持")
	}
	body, err := json.Marshal(payload)
	return path, body, err
}

func resolveCaseModel(kind string, configured string, group string) (string, error) {
	configured = strings.TrimSpace(configured)
	if configured != "" && configured != "default" {
		return configured, nil
	}
	settings, err := service.PublicSettingsForGroup(group)
	if err != nil {
		return "", err
	}
	modelName := settings.ModelChannel.DefaultModel
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		modelName = settings.ModelChannel.DefaultImageModel
	case "video":
		modelName = settings.ModelChannel.DefaultVideoModel
	case "text":
		modelName = settings.ModelChannel.DefaultTextModel
	}
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("案例没有可用的默认模型，请先在配置中设置对应模型")
	}
	return modelName, nil
}

func truncateCaseResponse(value string) string {
	if len(value) <= 4000 {
		return value
	}
	return value[:4000]
}

func serviceNow() string {
	return time.Now().UTC().Format(time.RFC3339)
}
