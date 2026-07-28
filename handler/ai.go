package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

var aiHTTPClient = &http.Client{Timeout: 15 * time.Minute}

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/generations")
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/edits")
}

func AIChatCompletions(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/chat/completions")
}

func AIAudioSpeech(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/audio/speech")
}

func AIVideos(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/videos")
}

func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	proxyAIGetRequest(w, r, "/videos/"+id)
}

func AIVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	proxyAIGetRequest(w, r, "/videos/"+id+"/content")
}

func proxyAIGetRequest(w http.ResponseWriter, r *http.Request, path string) {
	modelName := r.URL.Query().Get("model")
	if strings.TrimSpace(modelName) == "" {
		modelName = "grok-imagine-1.0-video"
	}
	channel, err := service.SelectModelChannel(modelName)
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	path = resolveAIProxyPath(channel.BaseURL, modelName, path)
	upstreamURL, err := buildAIProxyGetURL(channel, path, r.URL.Query())
	if err != nil {
		Fail(w, "AI 接口请求失败")
		return
	}
	request, err := http.NewRequest(http.MethodGet, upstreamURL, nil)
	if err != nil {
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	copyAIResponse(w, request, nil)
}

func proxyAIRequest(w http.ResponseWriter, r *http.Request, path string) {
	body, contentType, modelName, err := readAIRequest(r)
	if err != nil {
		log.Printf("AI proxy request read failed: %v", err)
		Fail(w, "AI 接口请求失败")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	credits, err := service.ModelCost(modelName)
	if err != nil {
		log.Printf("AI proxy read model cost failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	credits *= readAIRequestCount(body, contentType)
	channel, err := service.SelectModelChannel(modelName)
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	path = resolveAIProxyPath(channel.BaseURL, modelName, path)
	if useLingzhouResponsesImageProxy(channel, modelName, path, contentType) {
		responsesBody, err := buildLingzhouImageResponsesBody(body)
		if err != nil {
			log.Printf("AI proxy build Lingzhou responses request failed: model=%s err=%v", modelName, err)
			Fail(w, "AI 鎺ュ彛璇锋眰澶辫触")
			return
		}
		if err := service.ConsumeUserCredits(user.ID, modelName, credits, path); err != nil {
			FailError(w, err)
			return
		}
		copyLingzhouImageResponses(w, channel, responsesBody, readAIRequestCount(body, contentType), func() {
			if err := service.RefundUserCredits(user.ID, modelName, credits, path); err != nil {
				log.Printf("AI proxy refund credits failed: user=%s model=%s credits=%d err=%v", user.ID, modelName, credits, err)
			}
		})
		return
	}
	logAIImageUpstreamParams(channel, path, modelName, body, contentType)
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, path), bytes.NewReader(body))
	if err != nil {
		log.Printf("AI proxy build request failed: url=%s err=%v", service.BuildModelChannelURL(channel, path), err)
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if err := service.ConsumeUserCredits(user.ID, modelName, credits, path); err != nil {
		FailError(w, err)
		return
	}
	copyAIResponse(w, request, func() {
		if err := service.RefundUserCredits(user.ID, modelName, credits, path); err != nil {
			log.Printf("AI proxy refund credits failed: user=%s model=%s credits=%d err=%v", user.ID, modelName, credits, err)
		}
	})
}

func copyAIResponse(w http.ResponseWriter, request *http.Request, onFailure func()) {
	response, err := aiHTTPClient.Do(request)
	if err != nil {
		log.Printf("AI proxy request failed: url=%s err=%v", request.URL.String(), err)
		if onFailure != nil {
			onFailure()
		}
		Fail(w, "AI 接口请求失败")
		return
	}
	defer response.Body.Close()

	if response.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		if fallbackOpenAIVideoStatus(w, request, response.StatusCode) {
			return
		}
		log.Printf("AI upstream error: url=%s status=%d body=%s", request.URL.String(), response.StatusCode, safeUpstreamText(string(body)))
		if onFailure != nil {
			onFailure()
		}
		Fail(w, aiUpstreamStatusMessage(response.StatusCode, body))
		return
	}

	for key, values := range response.Header {
		if strings.EqualFold(key, "Content-Length") {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func useLingzhouResponsesImageProxy(channel model.ModelChannel, modelName string, path string, contentType string) bool {
	baseURL := strings.ToLower(channel.BaseURL)
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	if modelName == "gpt-image-2-2k" || modelName == "gpt-image-2-4k" {
		return false
	}
	return path == "/images/generations" &&
		strings.Contains(baseURL, "lingzhouai.com") &&
		strings.HasPrefix(modelName, "gpt-image") &&
		!strings.HasPrefix(contentType, "multipart/form-data")
}

func logAIImageUpstreamParams(channel model.ModelChannel, path string, modelName string, body []byte, contentType string) {
	if path != "/images/generations" && path != "/images/edits" {
		return
	}
	var size string
	var quality string
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err == nil {
			form, formErr := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
			if formErr == nil {
				defer form.RemoveAll()
				if values := form.Value["size"]; len(values) > 0 {
					size = values[0]
				}
				if values := form.Value["quality"]; len(values) > 0 {
					quality = values[0]
				}
			}
		}
	} else {
		var payload struct {
			Size    string `json:"size"`
			Quality string `json:"quality"`
		}
		if err := json.Unmarshal(body, &payload); err == nil {
			size = payload.Size
			quality = payload.Quality
		}
	}
	log.Printf("AI image upstream request params: url=%s model=%s size=%s quality=%s", service.BuildModelChannelURL(channel, path), modelName, size, quality)
}

func buildLingzhouImageResponsesBody(body []byte) ([]byte, error) {
	var payload struct {
		Model   string `json:"model"`
		Prompt  string `json:"prompt"`
		Size    string `json:"size"`
		Quality string `json:"quality"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if strings.TrimSpace(payload.Model) == "" || strings.TrimSpace(payload.Prompt) == "" {
		return nil, errMissingModel
	}
	tool := map[string]any{"type": "image_generation"}
	if strings.TrimSpace(payload.Size) != "" {
		tool["size"] = strings.TrimSpace(payload.Size)
	}
	if strings.TrimSpace(payload.Quality) != "" {
		tool["quality"] = strings.TrimSpace(payload.Quality)
	}
	log.Printf("AI Lingzhou responses request params: model=%s size=%s quality=%s", payload.Model, payload.Size, payload.Quality)
	return json.Marshal(map[string]any{
		"model": payload.Model,
		"input": payload.Prompt,
		"tools": []map[string]any{tool},
	})
}

func copyLingzhouImageResponses(w http.ResponseWriter, channel model.ModelChannel, body []byte, count int, onFailure func()) {
	if count < 1 {
		count = 1
	}
	results := make([]map[string]string, 0, count)
	upstreamURL := service.BuildModelChannelURL(channel, "/responses")
	for i := 0; i < count; i++ {
		responseBody, statusCode, err := callLingzhouImageResponses(channel, upstreamURL, body)
		if err != nil {
			log.Printf("AI proxy Lingzhou responses request failed: url=%s err=%v", upstreamURL, err)
			if onFailure != nil {
				onFailure()
			}
			Fail(w, "AI 鎺ュ彛璇锋眰澶辫触")
			return
		}
		if statusCode >= http.StatusBadRequest {
			log.Printf("AI Lingzhou responses upstream error: url=%s status=%d body=%s", upstreamURL, statusCode, safeUpstreamText(string(responseBody)))
			if onFailure != nil {
				onFailure()
			}
			Fail(w, aiUpstreamStatusMessage(statusCode, responseBody))
			return
		}
		image, err := readLingzhouResponsesImage(responseBody)
		if err != nil {
			log.Printf("AI Lingzhou responses parse failed: url=%s err=%v body=%s", upstreamURL, err, safeUpstreamText(string(responseBody)))
			if onFailure != nil {
				onFailure()
			}
			Fail(w, "鎺ュ彛娌℃湁杩斿洖鍥剧墖")
			return
		}
		results = append(results, map[string]string{"b64_json": image})
	}
	writeJSON(w, map[string]any{"data": results})
}

func callLingzhouImageResponses(channel model.ModelChannel, upstreamURL string, body []byte) ([]byte, int, error) {
	request, err := http.NewRequest(http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := aiHTTPClient.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	return responseBody, response.StatusCode, nil
}

func readLingzhouResponsesImage(body []byte) (string, error) {
	var payload struct {
		Output []struct {
			Type   string `json:"type"`
			Result string `json:"result"`
		} `json:"output"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", err
	}
	for _, item := range payload.Output {
		if item.Result != "" && (item.Type == "" || item.Type == "image_generation_call") {
			return item.Result, nil
		}
	}
	return "", fmt.Errorf("missing image result")
}

func fallbackOpenAIVideoStatus(w http.ResponseWriter, request *http.Request, statusCode int) bool {
	if statusCode != http.StatusUnauthorized && statusCode != http.StatusForbidden {
		return false
	}
	path := request.URL.Path
	if !strings.Contains(path, "/videos/") || strings.HasSuffix(path, "/content") {
		return false
	}
	taskID := path[strings.LastIndex(path, "/videos/")+len("/videos/"):]
	if taskID == "" || strings.Contains(taskID, "/") {
		return false
	}
	contentURL := *request.URL
	contentURL.Path = strings.TrimRight(request.URL.Path, "/") + "/content"
	contentRequest, err := http.NewRequest(http.MethodGet, contentURL.String(), nil)
	if err != nil {
		return false
	}
	contentRequest.Header.Set("Authorization", request.Header.Get("Authorization"))
	contentResponse, err := aiHTTPClient.Do(contentRequest)
	if err != nil {
		return false
	}
	defer contentResponse.Body.Close()
	if contentResponse.StatusCode >= http.StatusOK && contentResponse.StatusCode < http.StatusBadRequest {
		_, _ = io.Copy(io.Discard, contentResponse.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"id":%q,"status":"completed"}`, taskID)
		return true
	}
	if contentResponse.StatusCode >= http.StatusBadRequest {
		_, _ = io.Copy(io.Discard, contentResponse.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"id":%q,"status":"running"}`, taskID)
		return true
	}
	return false
}

func readAIRequest(r *http.Request) ([]byte, string, string, error) {
	contentType := r.Header.Get("Content-Type")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, "", "", err
	}
	modelName := ""
	if strings.HasPrefix(contentType, "multipart/form-data") {
		modelName = readMultipartModel(body, contentType)
	} else {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &payload)
		modelName = payload.Model
	}
	if strings.TrimSpace(modelName) == "" {
		return nil, "", "", errMissingModel
	}
	return body, contentType, modelName, nil
}

func readMultipartModel(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	form, err := reader.ReadForm(32 << 20)
	if err != nil {
		return ""
	}
	defer form.RemoveAll()
	if values := form.Value["model"]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func readAIRequestCount(body []byte, contentType string) int {
	count := 1
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return count
		}
		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
		if err != nil {
			return count
		}
		defer form.RemoveAll()
		if values := form.Value["n"]; len(values) > 0 {
			_, _ = fmt.Sscan(values[0], &count)
		}
	} else {
		var payload struct {
			N int `json:"n"`
		}
		_ = json.Unmarshal(body, &payload)
		count = payload.N
	}
	if count < 1 {
		return 1
	}
	return count
}

var errMissingModel = &aiError{"缺少模型名称"}

func buildAIProxyGetURL(channel model.ModelChannel, path string, query url.Values) (string, error) {
	upstreamURL := service.BuildModelChannelURL(channel, path)
	if len(query) == 0 {
		return upstreamURL, nil
	}
	parsed, err := url.Parse(upstreamURL)
	if err != nil {
		return "", err
	}
	upstreamQuery := parsed.Query()
	for key, values := range query {
		for _, value := range values {
			upstreamQuery.Add(key, value)
		}
	}
	parsed.RawQuery = upstreamQuery.Encode()
	return parsed.String(), nil
}

func resolveAIProxyPath(baseURL string, modelName string, path string) string {
	if !isArkSeedanceVideo(baseURL, modelName) {
		return path
	}
	if path == "/videos" {
		return "/contents/generations/tasks"
	}
	if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
		return "/contents/generations/tasks/" + strings.TrimPrefix(path, "/videos/")
	}
	return path
}

func isArkSeedanceVideo(baseURL string, modelName string) bool {
	base := strings.ToLower(baseURL)
	model := strings.ToLower(modelName)
	return strings.Contains(model, "seedance") || strings.Contains(model, "doubao-seedance") || strings.Contains(base, "/api/plan/v3")
}

func aiStatusMessage(statusCode int) string {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "AI 接口鉴权失败，请检查 API Key、套餐权限或模型权限"
	case http.StatusTooManyRequests:
		return "AI 接口限流或额度不足，请稍后重试或检查额度"
	default:
		return "AI 接口请求失败"
	}
}

func aiUpstreamStatusMessage(statusCode int, body []byte) string {
	base := aiStatusMessage(statusCode)
	detail := aiUpstreamErrorDetail(body)
	if detail == "" {
		return base
	}
	return base + "：" + detail
}

func aiUpstreamErrorDetail(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	var payload struct {
		Msg     string `json:"msg"`
		Message string `json:"message"`
		Error   struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		if payload.Error.Message != "" {
			if detail := friendlyUpstreamError(payload.Error.Code, payload.Error.Message); detail != "" {
				return safeUpstreamText(detail)
			}
			if payload.Error.Code != "" {
				return safeUpstreamText(payload.Error.Code + " " + payload.Error.Message)
			}
			return safeUpstreamText(payload.Error.Message)
		}
		if payload.Msg != "" {
			return safeUpstreamText(payload.Msg)
		}
		if payload.Message != "" {
			return safeUpstreamText(payload.Message)
		}
	}
	return safeUpstreamText(text)
}

func friendlyUpstreamError(code string, message string) string {
	lowerCode := strings.ToLower(strings.TrimSpace(code))
	if strings.Contains(lowerCode, "inputvideosensitivecontentdetected") || strings.Contains(lowerCode, "privacyinformation") {
		return strings.TrimSpace(code + " 参考视频疑似包含真人或隐私信息，火山方舟拒绝使用普通 URL 作为真人视频参考；请改用不含真人的视频、官方允许的模型产物，或已授权的 asset:// 素材。原始错误：" + message)
	}
	return ""
}

func safeUpstreamText(text string) string {
	text = strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	runes := []rune(text)
	if len(runes) > 300 {
		return string(runes[:300]) + "..."
	}
	return text
}

type aiError struct {
	message string
}

func (err *aiError) Error() string {
	return err.message
}
