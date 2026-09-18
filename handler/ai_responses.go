package handler

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

type responsesRequest struct {
	Model           string          `json:"model"`
	Input           json.RawMessage `json:"input"`
	Instructions    string          `json:"instructions"`
	Stream          bool            `json:"stream"`
	MaxOutputTokens json.RawMessage `json:"max_output_tokens"`
	Temperature     json.RawMessage `json:"temperature"`
	TopP            json.RawMessage `json:"top_p"`
	Tools           json.RawMessage `json:"tools"`
}

type chatStreamChunk struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content json.RawMessage `json:"content"`
		} `json:"delta"`
		FinishReason any `json:"finish_reason"`
	} `json:"choices"`
	Usage map[string]any `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func copyAIResponses(w http.ResponseWriter, channel model.ModelChannel, body []byte, contentType string, onFailure func()) {
	request, err := newAIResponsesRequest(channel, "/responses", body, contentType)
	if err != nil {
		failAIResponses(w, body, "AI 接口请求失败", onFailure)
		return
	}
	response, err := aiHTTPClient.Do(request)
	if err != nil {
		log.Printf("AI responses request failed: url=%s err=%v", request.URL.String(), err)
		failAIResponses(w, body, "AI 接口请求失败", onFailure)
		return
	}
	if response.StatusCode != http.StatusNotFound {
		copyNativeAIResponses(w, request.URL.String(), response, onFailure)
		return
	}
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	response.Body.Close()
	log.Printf("AI responses endpoint not found, falling back to chat completions: url=%s body=%s", request.URL.String(), safeUpstreamText(string(responseBody)))

	chatBody, stream, err := buildChatCompletionsBody(body)
	if err != nil {
		failAIResponses(w, body, err.Error(), onFailure)
		return
	}
	chatRequest, err := newAIResponsesRequest(channel, "/chat/completions", chatBody, "application/json")
	if err != nil {
		failAIResponses(w, body, "AI 接口请求失败", onFailure)
		return
	}
	chatResponse, err := aiHTTPClient.Do(chatRequest)
	if err != nil {
		log.Printf("AI responses fallback request failed: url=%s err=%v", chatRequest.URL.String(), err)
		failAIResponses(w, body, "AI 接口请求失败", onFailure)
		return
	}
	defer chatResponse.Body.Close()
	if chatResponse.StatusCode >= http.StatusBadRequest {
		responseBody, _ := io.ReadAll(io.LimitReader(chatResponse.Body, 4096))
		log.Printf("AI responses fallback upstream error: url=%s status=%d body=%s", chatRequest.URL.String(), chatResponse.StatusCode, safeUpstreamText(string(responseBody)))
		failAIResponses(w, body, aiUpstreamStatusMessage(chatResponse.StatusCode, responseBody), onFailure)
		return
	}
	if stream {
		copyChatCompletionsStreamAsResponses(w, chatResponse, channel, onFailure)
		return
	}
	if err := copyChatCompletionAsResponse(w, chatResponse.Body, channel); err != nil {
		log.Printf("AI responses fallback parse failed: url=%s err=%v", chatRequest.URL.String(), err)
		failAIResponses(w, body, "AI 接口没有返回有效内容", onFailure)
	}
}

func newAIResponsesRequest(channel model.ModelChannel, path string, body []byte, contentType string) (*http.Request, error) {
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, path), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if contentType == "" {
		contentType = "application/json"
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Accept", "text/event-stream, application/json")
	return request, nil
}

func copyNativeAIResponses(w http.ResponseWriter, upstreamURL string, response *http.Response, onFailure func()) {
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		log.Printf("AI responses upstream error: url=%s status=%d body=%s", upstreamURL, response.StatusCode, safeUpstreamText(string(body)))
		if onFailure != nil {
			onFailure()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(response.StatusCode)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": aiUpstreamStatusMessage(response.StatusCode, body)}})
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
	isEventStream := strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream")
	if isEventStream {
		w.Header().Set("X-Accel-Buffering", "no")
	}
	w.WriteHeader(response.StatusCode)
	if isEventStream {
		if err := copyAndFlushAIResponses(w, response.Body); err != nil {
			log.Printf("AI responses stream read failed: url=%s err=%v", upstreamURL, err)
			if onFailure != nil {
				onFailure()
			}
		}
		return
	}
	if _, err := io.Copy(w, response.Body); err != nil {
		log.Printf("AI responses body read failed: url=%s err=%v", upstreamURL, err)
		if onFailure != nil {
			onFailure()
		}
	}
}

func copyAndFlushAIResponses(w http.ResponseWriter, body io.Reader) error {
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	for {
		read, readErr := body.Read(buffer)
		if read > 0 {
			if _, err := w.Write(buffer[:read]); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

func failAIResponses(w http.ResponseWriter, requestBody []byte, message string, onFailure func()) {
	if onFailure != nil {
		onFailure()
	}
	var payload struct {
		Stream bool `json:"stream"`
	}
	_ = json.Unmarshal(requestBody, &payload)
	if payload.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		writeResponsesEvent(w, map[string]any{"type": "error", "error": map[string]string{"message": message}})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadGateway)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": message}})
}

func buildChatCompletionsBody(body []byte) ([]byte, bool, error) {
	var payload responsesRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, false, errors.New("Responses 请求格式无效")
	}
	if strings.TrimSpace(payload.Model) == "" {
		return nil, payload.Stream, errors.New("缺少模型名称")
	}
	if len(bytes.TrimSpace(payload.Tools)) > 0 && string(bytes.TrimSpace(payload.Tools)) != "[]" && string(bytes.TrimSpace(payload.Tools)) != "null" {
		return nil, payload.Stream, errors.New("当前渠道不支持 /responses，兼容模式暂不支持工具调用")
	}
	messages, err := responseInputToChatMessages(payload.Input)
	if err != nil {
		return nil, payload.Stream, err
	}
	if strings.TrimSpace(payload.Instructions) != "" {
		messages = append([]map[string]any{{"role": "system", "content": payload.Instructions}}, messages...)
	}
	chatPayload := map[string]any{
		"model":    payload.Model,
		"messages": messages,
		"stream":   payload.Stream,
	}
	copyRawJSONField(chatPayload, "max_tokens", payload.MaxOutputTokens)
	copyRawJSONField(chatPayload, "temperature", payload.Temperature)
	copyRawJSONField(chatPayload, "top_p", payload.TopP)
	converted, err := json.Marshal(chatPayload)
	return converted, payload.Stream, err
}

func responseInputToChatMessages(input json.RawMessage) ([]map[string]any, error) {
	input = bytes.TrimSpace(input)
	if len(input) == 0 || string(input) == "null" {
		return nil, errors.New("Responses 请求缺少 input")
	}
	var text string
	if json.Unmarshal(input, &text) == nil {
		return []map[string]any{{"role": "user", "content": text}}, nil
	}
	var items []struct {
		Type    string          `json:"type"`
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(input, &items); err != nil {
		return nil, errors.New("Responses input 格式无效")
	}
	messages := make([]map[string]any, 0, len(items))
	for _, item := range items {
		role := strings.ToLower(strings.TrimSpace(item.Role))
		if role == "" && item.Type == "message" {
			role = "user"
		}
		if role != "system" && role != "developer" && role != "user" && role != "assistant" {
			return nil, errors.New("当前渠道不支持 /responses，兼容模式仅支持文本与图片消息")
		}
		content, err := responseContentToChat(item.Content)
		if err != nil {
			return nil, err
		}
		messages = append(messages, map[string]any{"role": role, "content": content})
	}
	if len(messages) == 0 {
		return nil, errors.New("Responses 请求缺少 input")
	}
	return messages, nil
}

func responseContentToChat(content json.RawMessage) (any, error) {
	var text string
	if json.Unmarshal(content, &text) == nil {
		return text, nil
	}
	var parts []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL any    `json:"image_url"`
	}
	if err := json.Unmarshal(content, &parts); err != nil {
		return nil, errors.New("Responses 消息内容格式无效")
	}
	chatParts := make([]map[string]any, 0, len(parts))
	for _, part := range parts {
		switch part.Type {
		case "input_text", "output_text", "text":
			chatParts = append(chatParts, map[string]any{"type": "text", "text": part.Text})
		case "input_image", "image_url":
			imageURL := jsonURLValue(part.ImageURL)
			if imageURL == "" {
				return nil, errors.New("Responses 图片输入缺少 image_url")
			}
			chatParts = append(chatParts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": imageURL}})
		default:
			return nil, errors.New("当前渠道不支持 /responses，兼容模式仅支持文本与图片消息")
		}
	}
	return chatParts, nil
}

func copyRawJSONField(target map[string]any, key string, raw json.RawMessage) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return
	}
	var value any
	if json.Unmarshal(raw, &value) == nil {
		target[key] = value
	}
}

func copyChatCompletionAsResponse(w http.ResponseWriter, body io.Reader, channel model.ModelChannel) error {
	var completion struct {
		ID      string `json:"id"`
		Created int64  `json:"created"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage map[string]any `json:"usage"`
	}
	if err := json.NewDecoder(body).Decode(&completion); err != nil {
		return err
	}
	if len(completion.Choices) == 0 {
		return errors.New("missing choices")
	}
	text := chatContentText(completion.Choices[0].Message.Content)
	response := completedResponsesPayload(completion.ID, completion.Created, completion.Model, text, completion.Usage, channel)
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(response)
}

func copyChatCompletionsStreamAsResponses(w http.ResponseWriter, response *http.Response, channel model.ModelChannel, onFailure func()) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var dataLines []string
	var responseID string
	var messageID string
	var responseModel string
	var created int64
	var output strings.Builder
	var usage map[string]any
	createdEventSent := false
	process := func() bool {
		if len(dataLines) == 0 {
			return true
		}
		data := strings.TrimSpace(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		if data == "" || data == "[DONE]" {
			return true
		}
		var chunk chatStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return true
		}
		if chunk.Error != nil && strings.TrimSpace(chunk.Error.Message) != "" {
			if onFailure != nil {
				onFailure()
			}
			writeResponsesEvent(w, map[string]any{"type": "error", "error": map[string]string{"message": chunk.Error.Message}})
			return false
		}
		if responseID == "" {
			responseID = normalizeResponseID(chunk.ID)
			messageID = normalizeMessageID(chunk.ID)
		}
		if chunk.Created > 0 {
			created = chunk.Created
		}
		if strings.TrimSpace(chunk.Model) != "" {
			responseModel = chunk.Model
		}
		if !createdEventSent {
			writeResponsesEvent(w, map[string]any{"type": "response.created", "response": inProgressResponsesPayload(responseID, created, responseModel, channel)})
			createdEventSent = true
		}
		for _, choice := range chunk.Choices {
			delta := chatContentText(choice.Delta.Content)
			if delta == "" {
				continue
			}
			output.WriteString(delta)
			writeResponsesEvent(w, map[string]any{"type": "response.output_text.delta", "item_id": messageID, "delta": delta})
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if !process() {
				return
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if !process() {
		return
	}
	if err := scanner.Err(); err != nil {
		log.Printf("AI responses fallback stream read failed: %v", err)
		if onFailure != nil {
			onFailure()
		}
		writeResponsesEvent(w, map[string]any{"type": "error", "error": map[string]string{"message": "AI 接口流式响应中断"}})
		return
	}
	if responseID == "" {
		responseID = normalizeResponseID("")
		messageID = normalizeMessageID(responseID)
	}
	if !createdEventSent {
		writeResponsesEvent(w, map[string]any{"type": "response.created", "response": inProgressResponsesPayload(responseID, created, responseModel, channel)})
	}
	text := output.String()
	writeResponsesEvent(w, map[string]any{"type": "response.output_text.done", "item_id": messageID, "text": text})
	writeResponsesEvent(w, map[string]any{"type": "response.completed", "response": completedResponsesPayload(responseID, created, responseModel, text, usage, channel)})
	if flusher != nil {
		flusher.Flush()
	}
}

func chatContentText(raw json.RawMessage) string {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var result strings.Builder
	for _, part := range parts {
		result.WriteString(part.Text)
	}
	return result.String()
}

func inProgressResponsesPayload(id string, created int64, responseModel string, channel model.ModelChannel) map[string]any {
	if created <= 0 {
		created = time.Now().Unix()
	}
	if responseModel == "" {
		responseModel = firstChannelModel(channel)
	}
	return map[string]any{"id": id, "object": "response", "created_at": created, "status": "in_progress", "model": responseModel, "output": []any{}}
}

func completedResponsesPayload(id string, created int64, responseModel string, text string, usage map[string]any, channel model.ModelChannel) map[string]any {
	id = normalizeResponseID(id)
	if created <= 0 {
		created = time.Now().Unix()
	}
	if responseModel == "" {
		responseModel = firstChannelModel(channel)
	}
	result := map[string]any{
		"id": id, "object": "response", "created_at": created, "status": "completed", "model": responseModel,
		"output": []map[string]any{{
			"id": normalizeMessageID(id), "type": "message", "status": "completed", "role": "assistant",
			"content": []map[string]any{{"type": "output_text", "annotations": []any{}, "text": text}},
		}},
	}
	if converted := responsesUsage(usage); converted != nil {
		result["usage"] = converted
	}
	return result
}

func responsesUsage(usage map[string]any) map[string]any {
	if usage == nil {
		return nil
	}
	result := map[string]any{}
	if value, ok := usage["prompt_tokens"]; ok {
		result["input_tokens"] = value
	}
	if value, ok := usage["completion_tokens"]; ok {
		result["output_tokens"] = value
	}
	if value, ok := usage["total_tokens"]; ok {
		result["total_tokens"] = value
	}
	return result
}

func normalizeResponseID(id string) string {
	id = strings.TrimSpace(id)
	if strings.HasPrefix(id, "resp_") {
		return id
	}
	id = strings.TrimPrefix(id, "chatcmpl-")
	if id == "" {
		id = fmt.Sprint(time.Now().UnixNano())
	}
	return "resp_" + id
}

func normalizeMessageID(id string) string {
	id = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(id), "chatcmpl-"), "resp_")
	if id == "" {
		id = fmt.Sprint(time.Now().UnixNano())
	}
	return "msg_" + id
}

func firstChannelModel(channel model.ModelChannel) string {
	if len(channel.Models) > 0 {
		return channel.Models[0]
	}
	return ""
}

func writeResponsesEvent(w http.ResponseWriter, event any) {
	body, _ := json.Marshal(event)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", body)
}
