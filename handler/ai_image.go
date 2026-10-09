package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func isImageResponsesRequest(path string, body []byte) bool {
	if path != "/responses" {
		return false
	}
	var payload struct {
		Tools []struct {
			Type string `json:"type"`
		} `json:"tools"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return false
	}
	for _, tool := range payload.Tools {
		if tool.Type == "image_generation" {
			return true
		}
	}
	return false
}

func proxyAIImageRequest(w http.ResponseWriter, r *http.Request, path string, body []byte, contentType, modelName string, user model.AuthUser, credits int) {
	channels, err := service.SelectModelChannelsForGroup(modelName, user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	channel := channels[0]
	entry, err := service.ConsumeUserCreditsWithLog(user.ID, modelName, credits, path, channel)
	if err != nil {
		FailError(w, err)
		return
	}
	failed := true
	defer func() {
		if channel.ID != channels[0].ID {
			if err := service.UpdateCreditLogChannel(entry, channel); err != nil {
				log.Printf("AI image update credit channel failed: user=%s model=%s err=%v", user.ID, modelName, err)
			}
		}
		if failed {
			if err := service.RefundUserCredits(user.ID, modelName, credits, path, channel); err != nil {
				log.Printf("AI image refund credits failed: user=%s model=%s credits=%d err=%v", user.ID, modelName, credits, err)
			}
		}
	}()
	fail := func(message string) {
		if path == "/responses" {
			failAIResponses(w, body, message, nil)
		} else {
			Fail(w, message)
		}
	}
	for i, candidate := range channels {
		if r.Context().Err() != nil {
			return
		}
		channel = candidate
		logAIImageUpstreamParams(channel, path, modelName, body, contentType)
		response, canSwitch, err := requestAIImage(r.Context(), channel, path, body, contentType, modelName)
		if err != nil {
			log.Printf("AI image request failed: channel=%d model=%s err=%v", channel.ID, modelName, err)
			fail("AI 生图请求失败或响应中断，请检查生成记录后重试")
			return
		}
		if response.StatusCode >= http.StatusBadRequest {
			errorBody, readErr := io.ReadAll(io.LimitReader(response.Body, 4096))
			response.Body.Close()
			retry := readErr == nil && canSwitch && retryableImageRejection(response.StatusCode, errorBody)
			log.Printf("AI image channel rejected: channel=%d name=%s model=%s attempt=%d status=%d switch=%t error=%s", channel.ID, channel.Name, modelName, i+1, response.StatusCode, retry && i+1 < len(channels), aiUpstreamErrorDetail(errorBody))
			if retry && i+1 < len(channels) {
				continue
			}
			message := aiUpstreamStatusMessage(response.StatusCode, errorBody)
			if retry && len(channels) > 1 {
				message = "所有可用生图渠道均调用失败，最后原因：" + message
			}
			fail(message)
			return
		}
		// Once accepted, never replay a stream or an uncertain response on another channel.
		failed = false
		copyNativeAIResponses(w, service.BuildModelChannelURL(channel, path), response, func() { failed = true })
		return
	}
}

// Only explicit pre-generation rejections can be replayed. A 5xx or transport
// failure can occur after generation started and must not create another image.
func retryableImageRejection(status int, body []byte) bool {
	if status < 400 || status >= 500 {
		return false
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
			Type string `json:"type"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &payload)
	codes := strings.ToLower(payload.Error.Code + " " + payload.Error.Type)
	for _, marker := range []string{"content_policy", "content_filter", "safety", "moderation", "sensitive", "invalid_parameter", "invalid_value", "invalid_prompt"} {
		if strings.Contains(codes, marker) {
			return false
		}
	}
	for _, code := range []string{payload.Error.Code, payload.Error.Type} {
		switch strings.ToLower(code) {
		case "insufficient_quota", "quota_exceeded", "billing_hard_limit_reached", "invalid_api_key", "invalid_authentication", "rate_limit_exceeded", "model_not_found", "model_not_available", "model_not_supported", "permission_denied", "insufficient_permissions", "model_access_denied":
			return true
		}
	}
	// Providers also use invalid_request_error with explicit quota/model codes.
	if strings.Contains(codes, "invalid_request") {
		return false
	}
	switch status {
	case http.StatusUnauthorized, http.StatusPaymentRequired, http.StatusNotFound, http.StatusTooManyRequests:
		return true
	}
	return false
}

func requestAIImage(ctx context.Context, channel model.ModelChannel, path string, body []byte, contentType, modelName string) (*http.Response, bool, error) {
	if useLingzhouResponsesImageProxy(channel, modelName, path, contentType) {
		return requestLingzhouImageResponses(ctx, channel, body, readAIRequestCount(body, contentType))
	}
	request, err := newAIResponsesRequest(channel, path, body, contentType)
	if err != nil {
		return nil, false, err
	}
	if path != "/responses" {
		request.Header.Set("Accept", "application/json")
	}
	response, err := aiHTTPClient.Do(request.WithContext(ctx))
	return response, true, err
}

func requestLingzhouImageResponses(ctx context.Context, channel model.ModelChannel, body []byte, count int) (*http.Response, bool, error) {
	converted, err := buildLingzhouImageResponsesBody(body)
	if err != nil {
		return nil, false, fmt.Errorf("生图参数无效")
	}
	results := make([]map[string]string, 0, count)
	for i := 0; i < max(1, count); i++ {
		request, err := newAIResponsesRequest(channel, "/responses", converted, "application/json")
		if err != nil {
			return nil, false, err
		}
		request.Header.Set("Accept", "application/json")
		response, err := aiHTTPClient.Do(request.WithContext(ctx))
		if err != nil {
			return nil, false, err
		}
		if response.StatusCode >= http.StatusBadRequest {
			return response, len(results) == 0, nil
		}
		responseBody, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil {
			return nil, false, fmt.Errorf("生图响应读取中断")
		}
		image, err := readLingzhouResponsesImage(responseBody)
		if err != nil {
			return nil, false, fmt.Errorf("接口没有返回有效图片")
		}
		results = append(results, map[string]string{"b64_json": image})
	}
	result, err := json.Marshal(map[string]any{"data": results})
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(bytes.NewReader(result))}, false, err
}
