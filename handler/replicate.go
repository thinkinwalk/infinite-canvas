package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var replicateSubmitting sync.Map

type replicateRequest struct {
	ID              string         `json:"id"`
	Operation       string         `json:"operation"`
	Input           map[string]any `json:"input"`
	ExpectedCredits *int           `json:"expectedCredits"`
}
type cloudPrediction struct {
	Model   string         `json:"model"`
	Version string         `json:"version"`
	Input   map[string]any `json:"input"`
	ID      string         `json:"id"`
	Status  string         `json:"status"`
	Output  any            `json:"output"`
	Error   any            `json:"error"`
	Metrics map[string]any `json:"metrics"`
}

func ReplicateCatalog(w http.ResponseWriter, r *http.Request) {
	user, _ := service.UserFromContext(r.Context())
	items := []service.ReplicateQuote{}
	for _, spec := range service.ReplicateModels() {
		quote, err := service.QuoteReplicate(user, spec, nil)
		if err != nil {
			FailError(w, err)
			return
		}
		items = append(items, quote)
	}
	OK(w, items)
}
func ReplicatePrice(w http.ResponseWriter, r *http.Request) {
	user, _ := service.UserFromContext(r.Context())
	var input replicateRequest
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		Fail(w, "请求格式不正确")
		return
	}
	spec, err := service.FindReplicateModel(input.Operation)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	if err := service.ValidateReplicateQuoteInput(user.ID, spec, input.Input); err != nil {
		Fail(w, err.Error())
		return
	}
	if spec.Operation == "image-to-video" {
		if err := validateWanVideoFrames(input.Input); err != nil {
			Fail(w, err.Error())
			return
		}
	}
	quote, err := service.QuoteReplicate(user, spec, input.Input)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, quote)
}
func CreateReplicateTask(w http.ResponseWriter, r *http.Request) {
	user, _ := service.UserFromContext(r.Context())
	var input replicateRequest
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.ID == "" || input.ExpectedCredits == nil {
		Fail(w, "需要任务编号和已确认的算力点报价")
		return
	}
	spec, err := service.FindReplicateModel(input.Operation)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	encoded, _ := json.Marshal(map[string]any{"operation": input.Operation, "input": input.Input})
	fingerprint := sha256.Sum256(encoded)
	hash := hex.EncodeToString(fingerprint[:])
	existing, found, err := repository.GetReplicateTask(input.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	if found {
		if existing.UserID != user.ID || existing.RequestHash != hash {
			Fail(w, "任务编号已被使用")
			return
		}
		// Return the first task even if a previous client lost its response.
		OK(w, existing)
		return
	}
	if err := service.ValidateReplicateInput(user.ID, spec, input.Input); err != nil {
		Fail(w, err.Error())
		return
	}
	if spec.Operation == "image-to-video" {
		if err := validateWanVideoFrames(input.Input); err != nil {
			Fail(w, err.Error())
			return
		}
	}
	quote, err := service.QuoteReplicate(user, spec, input.Input)
	if err != nil {
		FailError(w, err)
		return
	}
	if !quote.Available {
		Fail(w, quote.Reason)
		return
	}
	if quote.Credits != *input.ExpectedCredits {
		Fail(w, "算力点报价已变化，请重新确认")
		return
	}
	channel, err := replacementModelChannel(r.Context(), spec.Model, user.Group, true)
	if err != nil {
		FailError(w, err)
		return
	}
	token := channel.APIKey
	cacheKey := user.ID + ":" + input.ID
	if _, active := replicateSubmitting.LoadOrStore(cacheKey, true); active {
		Fail(w, "任务正在提交，请恢复查询")
		return
	}
	defer replicateSubmitting.Delete(cacheKey)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	task := model.ReplicateTask{ChannelID: channel.ID, ChannelName: channel.Name, ID: input.ID, UserID: user.ID, Operation: spec.Operation, Model: spec.Model, Version: spec.Version, RequestHash: hash, Status: "creating", Credits: quote.Credits, PricingSnapshot: quote.PricingSnapshot, CreatedAt: now, UpdatedAt: now}
	extra, _ := json.Marshal(map[string]any{"model": task.Model, "operation": task.Operation, "taskId": task.ID, "chargedCredits": task.Credits, "channelId": task.ChannelID, "channelName": task.ChannelName})
	err = repository.CreateReplicateTask(task, model.CreditLog{ID: uuid.NewString(), Remark: "云模型 " + spec.Label, Extra: string(extra)})
	if err != nil {
		first, found, readErr := repository.GetReplicateTask(input.ID)
		if readErr == nil && found && first.UserID == user.ID && first.RequestHash == hash {
			OK(w, first)
			return
		}
		if errors.Is(err, repository.ErrReplicateCredits) {
			Fail(w, "算力点不足")
			return
		}
		FailError(w, err)
		return
	}
	// Persist the provider ID even after the browser stops waiting.
	ctx := context.WithoutCancel(r.Context())
	prediction, status, err := createProviderTask(ctx, spec, token, input.Input)
	task.PredictionID = prediction.ID
	if err != nil {
		if prediction.ID == "" && (status == 400 || status == 401 || status == 402 || status == 403 || status == 404 || status == 422 || status == 429) {
			task.Status = "failed"
			task.Error = err.Error()
			if err := refundReplicateTask(&task); err != nil {
				FailError(w, err)
				return
			}
		} else {
			task.Status = "uncertain"
			task.Error = "提交结果未确认，请管理员核对上游任务；恢复查询不会重新创建收费任务"
			if err := repository.UpdateReplicateTask(task); err != nil {
				FailError(w, err)
				return
			}
		}
		OK(w, task)
		return
	}
	task.PredictionID = prediction.ID
	if task.PredictionID == "" {
		task.Status = "uncertain"
		task.Error = "上游没有返回任务编号，请管理员核对"
		_ = repository.UpdateReplicateTask(task)
		OK(w, task)
		return
	}
	if err := applyReplicatePrediction(&task, prediction); err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func ReadReplicateTask(w http.ResponseWriter, r *http.Request, id string) {
	task, ok := ownedReplicateTask(w, r, id)
	if !ok {
		return
	}
	if task.Status == "completed" || task.Status == "failed" || task.Status == "cancelled" || task.Status == "uncertain" {
		OK(w, task)
		return
	}
	if task.PredictionID == "" {
		if _, active := replicateSubmitting.Load(task.UserID + ":" + task.ID); !active {
			task.Status = "uncertain"
			task.Error = "服务重启或提交中断，尚未确认上游任务，请管理员核对后再执行"
			if err := repository.UpdateReplicateTask(task); err != nil {
				FailError(w, err)
				return
			}
		}
		OK(w, task)
		return
	}
	if task.Status != "generated" {
		channel, err := service.ResolveReplicateTaskChannel(task)
		if err != nil {
			FailError(w, err)
			return
		}
		prediction, _, err := pollProviderTask(r.Context(), service.ProviderForModel(task.Model), channel.APIKey, task.PredictionID)
		if err != nil {
			Fail(w, "任务查询暂时失败，可恢复查询；不会重新创建模型任务")
			return
		}
		if err := applyReplicatePrediction(&task, prediction); err != nil {
			FailError(w, err)
			return
		}
	}
	if task.Status == "generated" {
		if err := saveReplicateMedia(r.Context(), &task); err != nil {
			task.Error = err.Error()
			OK(w, task)
			return
		}
		task.Status = "completed"
		task.Error = ""
		task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := persistReplicateTask(&task); err != nil {
			FailError(w, err)
			return
		}
	}
	OK(w, task)
}
func CancelReplicateTask(w http.ResponseWriter, r *http.Request, id string) {
	task, ok := ownedReplicateTask(w, r, id)
	if !ok {
		return
	}
	if task.Status == "failed" || task.Status == "cancelled" || task.Status == "completed" || task.Status == "generated" {
		OK(w, task)
		return
	}
	if task.PredictionID == "" {
		Fail(w, "上游任务编号尚未确认，当前不能取消，请先恢复查询")
		return
	}
	channel, err := service.ResolveReplicateTaskChannel(task)
	if err != nil {
		FailError(w, err)
		return
	}
	if service.ProviderForModel(task.Model) == "wavespeed" {
		Fail(w, "WaveSpeed 任务不支持上游取消，可恢复查询直到完成")
		return
	}
	prediction, _, err := callReplicate(r.Context(), channel.APIKey, http.MethodPost, "/predictions/"+url.PathEscape(task.PredictionID)+"/cancel", []byte("{}"))
	if err != nil {
		Fail(w, "上游取消未确认，请恢复查询核对状态")
		return
	}
	if err := applyReplicatePrediction(&task, prediction); err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}
func ReplicateTaskContent(w http.ResponseWriter, r *http.Request, id string) {
	task, ok := ownedReplicateTask(w, r, id)
	if !ok {
		return
	}
	if task.Status == "completed" && task.Operation == "transcribe" && task.ResultJSON != "" {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "private, no-store")
		_, _ = w.Write([]byte(task.ResultJSON))
		return
	}
	if task.Status != "completed" || task.ResultFile == "" {
		http.Error(w, "作品尚未保存，请恢复查询", http.StatusConflict)
		return
	}
	file, err := os.Open(filepath.Join(referenceDataDir(), "replicate-results", task.ResultFile))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", task.MimeType)
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, task.ResultFile, info.ModTime(), file)
}
func ownedReplicateTask(w http.ResponseWriter, r *http.Request, id string) (model.ReplicateTask, bool) {
	user, _ := service.UserFromContext(r.Context())
	task, found, err := repository.GetReplicateTask(id)
	if err != nil {
		FailError(w, err)
		return task, false
	}
	if !found || task.UserID != user.ID {
		w.WriteHeader(http.StatusNotFound)
		Fail(w, "任务不存在或无权访问")
		return task, false
	}
	return task, true
}

// Provider request shapes differ: Replicate wraps input in a versioned
// prediction, WaveSpeed posts the model's own flat input to /{model}.
func createProviderTask(ctx context.Context, spec service.ReplicateModel, token string, input map[string]any) (cloudPrediction, int, error) {
	if spec.ProviderName() == "wavespeed" {
		payload, _ := json.Marshal(input)
		return callWaveSpeed(ctx, token, http.MethodPost, "/"+spec.Model, payload)
	}
	payload, _ := json.Marshal(map[string]any{"version": spec.Version, "input": input})
	return callReplicate(ctx, token, http.MethodPost, "/predictions", payload)
}

func pollProviderTask(ctx context.Context, provider, token, predictionID string) (cloudPrediction, int, error) {
	if provider == "wavespeed" {
		return callWaveSpeed(ctx, token, http.MethodGet, "/predictions/"+url.PathEscape(predictionID)+"/result", nil)
	}
	return callReplicate(ctx, token, http.MethodGet, "/predictions/"+url.PathEscape(predictionID), nil)
}

func callReplicate(ctx context.Context, token, method, path string, body []byte) (cloudPrediction, int, error) {
	request, err := http.NewRequestWithContext(ctx, method, "https://api.replicate.com/v1"+path, bytes.NewReader(body))
	if err != nil {
		return cloudPrediction{}, 0, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := aiHTTPClient.Do(request)
	if err != nil {
		return cloudPrediction{}, 0, err
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		return cloudPrediction{}, response.StatusCode, readErr
	}
	if response.StatusCode == http.StatusTooManyRequests {
		return cloudPrediction{}, response.StatusCode, fmt.Errorf("Replicate 暂时限制创建频率，本次未创建模型任务，请稍后重试")
	}
	if response.StatusCode >= 400 {
		message := fmt.Sprintf("Replicate 请求未接受（%d），请检查参数、余额和模型权限", response.StatusCode)
		if detail := replicateErrorDetail(responseBody); detail != "" {
			message += "：" + detail
		}
		return cloudPrediction{}, response.StatusCode, errors.New(message)
	}
	var prediction cloudPrediction
	if err := json.Unmarshal(responseBody, &prediction); err != nil {
		return prediction, response.StatusCode, err
	}
	return prediction, response.StatusCode, nil
}

// WaveSpeed uses its own task shape: POST /api/v3/{model} then poll
// /api/v3/predictions/{id}/result. Map it onto the Replicate prediction shape so
// task storage, billing and refunds stay unchanged.
func callWaveSpeed(ctx context.Context, token, method, path string, body []byte) (cloudPrediction, int, error) {
	request, err := http.NewRequestWithContext(ctx, method, service.WaveSpeedBaseURL+path, bytes.NewReader(body))
	if err != nil {
		return cloudPrediction{}, 0, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := aiHTTPClient.Do(request)
	if err != nil {
		return cloudPrediction{}, 0, err
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		return cloudPrediction{}, response.StatusCode, readErr
	}
	if response.StatusCode == http.StatusTooManyRequests {
		return cloudPrediction{}, response.StatusCode, fmt.Errorf("WaveSpeed 暂时限制创建频率，本次未创建模型任务，请稍后重试")
	}
	if response.StatusCode >= 400 {
		message := fmt.Sprintf("WaveSpeed 请求未接受（%d），请检查参数、余额和模型权限", response.StatusCode)
		if detail := replicateErrorDetail(responseBody); detail != "" {
			message += "：" + detail
		}
		return cloudPrediction{}, response.StatusCode, errors.New(message)
	}
	var payload struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			ID      string   `json:"id"`
			Status  string   `json:"status"`
			Outputs []string `json:"outputs"`
			Error   string   `json:"error"`
		} `json:"data"`
	}
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return cloudPrediction{}, response.StatusCode, err
	}
	prediction := cloudPrediction{ID: payload.Data.ID, Input: map[string]any{}}
	switch payload.Data.Status {
	case "completed":
		prediction.Status = "succeeded"
	case "failed", "cancelled", "canceled", "timeout":
		prediction.Status = "failed"
	case "processing", "running":
		prediction.Status = "processing"
	default:
		prediction.Status = "starting"
	}
	if len(payload.Data.Outputs) == 1 {
		prediction.Output = payload.Data.Outputs[0]
	} else if len(payload.Data.Outputs) > 1 {
		outputs := make([]any, 0, len(payload.Data.Outputs))
		for _, item := range payload.Data.Outputs {
			outputs = append(outputs, item)
		}
		prediction.Output = outputs
	}
	if payload.Code != 0 && payload.Code != 200 && payload.Data.ID == "" {
		message := "WaveSpeed 请求未接受"
		if payload.Message != "" {
			message += "：" + safeUpstreamText(payload.Message)
		}
		return cloudPrediction{}, http.StatusBadRequest, errors.New(message)
	}
	if payload.Data.Error != "" {
		prediction.Error = payload.Data.Error
	} else if payload.Code != 0 && payload.Code != 200 && payload.Message != "" {
		prediction.Error = payload.Message
	}
	return prediction, response.StatusCode, nil
}

func replicateErrorDetail(body []byte) string {
	var payload struct {
		Detail  any    `json:"detail"`
		Error   any    `json:"error"`
		Message string `json:"message"`
		Title   string `json:"title"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	for _, value := range []any{payload.Detail, payload.Error, payload.Message, payload.Title} {
		switch detail := value.(type) {
		case string:
			if text := safeUpstreamText(detail); text != "" {
				return text
			}
		case []any:
			encoded, _ := json.Marshal(detail)
			if text := safeUpstreamText(string(encoded)); text != "" {
				return text
			}
		}
	}
	return ""
}
func applyReplicatePrediction(task *model.ReplicateTask, prediction cloudPrediction) error {
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	task.Error = ""
	encoded, _ := json.Marshal(prediction.Metrics)
	task.Metrics = string(encoded)
	switch prediction.Status {
	case "starting", "processing":
		task.Status = "running"
	case "succeeded":
		if task.Operation == "transcribe" {
			result, err := normalizeTranscriptionOutput(prediction.Output)
			if err != nil {
				task.Status, task.Error = "failed", err.Error()
				return refundReplicateTask(task)
			}
			task.ResultJSON, task.MimeType, task.Status = result, "application/json", "completed"
			return persistReplicateTask(task)
		}
		task.Status = "generated"
		switch output := prediction.Output.(type) {
		case string:
			task.OutputURL = output
		case []any:
			urls := make([]string, 0, len(output))
			for _, item := range output {
				if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
					urls = append(urls, value)
				}
			}
			if len(urls) > 0 {
				task.OutputURL = urls[0]
				encoded, _ := json.Marshal(urls)
				task.OutputURLs = string(encoded)
			}
		}
		if task.OutputURL == "" {
			task.Status = "failed"
			task.Error = "模型完成但没有返回媒体文件"
			return refundReplicateTask(task)
		}
	case "failed", "canceled":
		task.Status = "failed"
		if prediction.Status == "canceled" {
			task.Status = "cancelled"
		}
		task.Error = "模型执行失败"
		if prediction.Error != nil {
			task.Error = safeUpstreamText(fmt.Sprint(prediction.Error))
		}
		return refundReplicateTask(task)
	default:
		task.Status = "running"
	}
	return persistReplicateTask(task)
}
func refundReplicateTask(task *model.ReplicateTask) error {
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	extra, _ := json.Marshal(map[string]any{"model": task.Model, "operation": task.Operation, "taskId": task.ID, "predictionId": task.PredictionID, "status": task.Status, "channelId": task.ChannelID, "channelName": task.ChannelName})
	if err := repository.FailReplicateTask(*task, model.CreditLog{ID: uuid.NewString(), Remark: "云模型失败返还 " + task.Model, Extra: string(extra)}); err != nil {
		return err
	}
	current, found, err := repository.GetReplicateTask(task.ID)
	if err != nil {
		return err
	}
	if found {
		*task = current
	}
	return nil
}
func replicateDeliveryAllowed(address *url.URL) bool {
	if address.Scheme != "https" || address.User != nil {
		return false
	}
	host := address.Hostname()
	return host == "replicate.delivery" || strings.HasSuffix(host, ".replicate.delivery") ||
		host == "wavespeed.ai" || strings.HasSuffix(host, ".wavespeed.ai") ||
		// WaveSpeed 的成品和素材都通过 CloudFront 分发。
		host == "d2h7xmz5gqybh9.cloudfront.net"
}
func saveReplicateMedia(ctx context.Context, task *model.ReplicateTask) error {
	urls := []string{task.OutputURL}
	if strings.TrimSpace(task.OutputURLs) != "" {
		var stored []string
		if err := json.Unmarshal([]byte(task.OutputURLs), &stored); err != nil || len(stored) == 0 {
			return fmt.Errorf("模型文件列表无法解析，请恢复查询")
		}
		urls = stored
	}
	if len(urls) == 0 || strings.TrimSpace(urls[0]) == "" {
		return fmt.Errorf("模型文件地址无法验证，请联系管理员")
	}
	client := *aiHTTPClient
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("too many redirects")
		}
		if !replicateDeliveryAllowed(request.URL) {
			return fmt.Errorf("模型文件重定向地址无法验证")
		}
		return nil
	}
	known := map[string]string{".mp4": "video/mp4", ".webm": "video/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
	directory := filepath.Join(referenceDataDir(), "replicate-results")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	fingerprint := sha256.Sum256([]byte(task.ID))
	base := hex.EncodeToString(fingerprint[:])
	filename := base + ".mp4"
	target := filepath.Join(directory, filename)
	if _, err := os.Stat(target); err == nil {
		task.ResultFile, task.MimeType = filename, "video/mp4"
		if task.Operation == "speech" {
			task.MimeType = "audio/mpeg"
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if len(urls) > 1 {
		return fmt.Errorf("模型返回了多个掩膜文件；当前要求 SAM 2 开启视频输出后返回单个视频地址")
	}
	temporary, err := os.CreateTemp(directory, "download-*")
	if err != nil {
		return err
	}
	tempName := temporary.Name()
	if err := temporary.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	defer os.Remove(tempName)
	mimeType, extension, err := downloadReplicateFile(ctx, client, urls[0], tempName, known)
	if err != nil {
		return err
	}
	if task.Operation == "speech" {
		if !strings.HasPrefix(mimeType, "audio/") {
			return fmt.Errorf("模型返回了不支持的媒体类型")
		}
		filename = base + extension
		target = filepath.Join(directory, filename)
	} else {
		if !strings.HasPrefix(mimeType, "video/") {
			return fmt.Errorf("模型返回了不支持的视频媒体类型")
		}
		// All video results are normalized to a browser-safe MP4 path, including
		// SAM 2's binary mask video.
		if err := normalizeReplicateVideo(tempName); err != nil {
			return fmt.Errorf("生成文件转码失败，可恢复查询：%w", err)
		}
		mimeType = "video/mp4"
	}
	if err := os.Rename(tempName, target); err != nil {
		if _, existingErr := os.Stat(target); existingErr != nil {
			return err
		}
	}
	task.ResultFile, task.MimeType = filename, mimeType
	return nil
}

func downloadReplicateFile(ctx context.Context, client http.Client, address, target string, known map[string]string) (string, string, error) {
	parsed, err := url.Parse(address)
	if err != nil || !replicateDeliveryAllowed(parsed) {
		return "", "", fmt.Errorf("模型文件地址无法验证，请联系管理员")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return "", "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", "", fmt.Errorf("模型已生成，文件下载暂时失败，可恢复查询")
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return "", "", fmt.Errorf("模型已生成，文件下载失败，可恢复查询")
	}
	mimeType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	extension := strings.ToLower(filepath.Ext(parsed.Path))
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = known[extension]
	}
	if extension == "" || known[extension] == "" {
		for ext, typ := range known {
			if typ == mimeType {
				extension = ext
				break
			}
		}
	}
	if known[extension] == "" {
		return "", "", fmt.Errorf("模型媒体格式无法识别")
	}
	temporary, err := os.OpenFile(target, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", "", err
	}
	count, copyErr := io.Copy(temporary, response.Body)
	closeErr := temporary.Close()
	if copyErr != nil || closeErr != nil || count == 0 {
		return "", "", fmt.Errorf("生成文件保存失败，可恢复查询")
	}
	return mimeType, extension, nil
}

func normalizeReplicateVideo(path string) error {
	codecOutput, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", path).Output()
	if err != nil {
		return nil
	}
	codec := strings.TrimSpace(string(codecOutput))
	if codec == "" || codec == "h264" {
		return nil
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), "transcode-*.mp4")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryName)
		return err
	}
	defer os.Remove(temporaryName)
	command := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", temporaryName)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg: %s: %w", safeUpstreamText(string(output)), err)
	}
	original := path + ".raw"
	if err := os.Rename(path, original); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, path); err != nil {
		_ = os.Rename(original, path)
		return err
	}
	if err := os.Remove(original); err != nil {
		return err
	}
	return nil
}

// Admin recovery never creates another paid prediction or assumes a refund.
func AdminReconcileReplicateTask(w http.ResponseWriter, r *http.Request, id string) {
	task, found, err := repository.GetReplicateTask(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !found {
		http.NotFound(w, r)
		return
	}
	var input struct {
		PredictionID string `json:"predictionId"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.PredictionID == "" {
		Fail(w, "请提供已在 Replicate 核对的任务编号")
		return
	}
	if _, active := replicateSubmitting.Load(task.UserID + ":" + task.ID); active {
		Fail(w, "任务仍在提交，请稍后核对")
		return
	}
	if task.Status != "uncertain" {
		Fail(w, "只有提交结果未确认的任务可进行关联")
		return
	}
	if service.ProviderForModel(task.Model) == "wavespeed" {
		Fail(w, "WaveSpeed 任务不返回输入指纹，无法自动核对；请在 WaveSpeed 后台核对后手动处理")
		return
	}
	channel, err := service.ResolveReplicateTaskChannel(task)
	if err != nil {
		FailError(w, err)
		return
	}
	prediction, _, err := callReplicate(r.Context(), channel.APIKey, http.MethodGet, "/predictions/"+url.PathEscape(input.PredictionID), nil)
	if err != nil {
		FailError(w, err)
		return
	}
	encoded, _ := json.Marshal(map[string]any{"operation": task.Operation, "input": prediction.Input})
	fingerprint := sha256.Sum256(encoded)
	if prediction.ID != input.PredictionID || prediction.Model != task.Model || hex.EncodeToString(fingerprint[:]) != task.RequestHash || (prediction.Version != "hidden" && prediction.Version != task.Version) {
		Fail(w, "上游模型、版本或输入与原任务不一致，拒绝关联")
		return
	}
	if task.PredictionID == "" {
		if err := repository.AttachReplicatePrediction(task.ID, prediction.ID); err != nil {
			FailError(w, err)
			return
		}
		task.PredictionID = prediction.ID
	} else if task.PredictionID != prediction.ID {
		Fail(w, "任务已关联另一个上游编号")
		return
	}
	if err := applyReplicatePrediction(&task, prediction); err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func persistReplicateTask(task *model.ReplicateTask) error {
	if err := repository.UpdateReplicateTask(*task); err != nil {
		return err
	}
	current, found, err := repository.GetReplicateTask(task.ID)
	if err != nil {
		return err
	}
	if found {
		*task = current
	}
	return nil
}
