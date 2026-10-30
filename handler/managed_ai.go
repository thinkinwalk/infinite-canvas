package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/service"
)

func managedOperation(path string, body []byte) string {
	switch path {
	case "/video-understanding":
		var input struct {
			Recreation bool   `json:"recreation"`
			Mode       string `json:"mode"`
		}
		if json.Unmarshal(body, &input) == nil && input.Recreation && input.Mode == "frames" {
			return "text"
		}
		return "video-understand"
	case "/videos":
		return "video"
	case "/audio/speech":
		return "audio"
	case "/images/generations", "/images/edits":
		return "image"
	case "/responses":
		if isImageResponsesRequest(path, body) {
			return "image"
		}
	}
	return "text"
}

func managedVideoParameters(resolution, seconds, aspect string, interpolate bool) map[string]any {
	return map[string]any{"resolution": strings.TrimSuffix(resolution, "p"), "seconds": seconds, "aspect_ratio": aspect, "interpolate": interpolate}
}

func managedBodyParameters(body []byte, contentType string) map[string]any {
	resolution, seconds := videoRequestPricingFields(body, contentType)
	var fields map[string]any
	_ = json.Unmarshal(body, &fields)
	aspect := jsonStringValue(fields["aspect_ratio"])
	if aspect == "" {
		aspect = jsonStringValue(fields["ratio"])
	}
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, _ := mime.ParseMediaType(contentType)
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		for {
			part, err := reader.NextPart()
			if err != nil {
				break
			}
			if part.FormName() == "aspect_ratio" || part.FormName() == "ratio" {
				value, _ := io.ReadAll(part)
				aspect = string(value)
			}
			part.Close()
		}
	}
	if aspect == "" {
		aspect = "16:9"
	}
	interpolate, _ := fields["interpolate_output"].(bool)
	return managedVideoParameters(resolution, seconds, aspect, interpolate)
}

func rewriteManagedModel(body []byte, contentType, real string) ([]byte, string, error) {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return nil, "", err
		}
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		var output bytes.Buffer
		writer := multipart.NewWriter(&output)
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, "", err
			}
			target, err := writer.CreatePart(part.Header)
			if err != nil {
				return nil, "", err
			}
			if part.FormName() == "model" {
				_, err = io.WriteString(target, real)
			} else {
				_, err = io.Copy(target, part)
			}
			part.Close()
			if err != nil {
				return nil, "", err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, "", err
		}
		return output.Bytes(), writer.FormDataContentType(), nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, "", err
	}
	fields["model"], _ = json.Marshal(real)
	result, err := json.Marshal(fields)
	return result, contentType, err
}

func prepareManagedAI(r *http.Request, path string, body []byte, contentType, modelID string) (*http.Request, []byte, string, string, error) {
	enabled, err := service.ManagementEnabled()
	if err != nil || !enabled {
		return r, body, contentType, modelID, err
	}
	user, _ := service.UserFromContext(r.Context())
	selected := service.ManagedSelectionFromContext(r.Context())
	if selected != nil {
		ctx, checkErr := service.RevalidateManagedSelection(r.Context())
		if checkErr != nil {
			return r, nil, "", "", checkErr
		}
		r = r.WithContext(ctx)
		selected = service.ManagedSelectionFromContext(ctx)
	}
	operation := managedOperation(path, body)
	if operation == "video" && readAIRequestCount(body, contentType) != 1 {
		return r, nil, "", "", fmt.Errorf("视频请按单个任务确认报价并提交")
	}
	if selected == nil {
		channelID := 0
		proofRevision := 0
		if token := r.Header.Get("X-Model-Quote"); token != "" {
			parameters := map[string]any{"count": readAIRequestCount(body, contentType)}
			if operation == "video" {
				parameters = managedBodyParameters(body, contentType)
			}
			proof, err := service.VerifyManagedQuote(token, user.ID, parameters)
			if err != nil {
				return r, nil, "", "", err
			}
			if proof.Group != user.Group {
				return r, nil, "", "", fmt.Errorf("用户分组已变化，请重新确认报价")
			}
			if proof.ModelID != modelID || proof.FeatureID != r.Header.Get("X-Model-Feature") {
				return r, nil, "", "", fmt.Errorf("模型报价与本次功能不一致")
			}
			channelID = proof.ChannelID
			proofRevision = proof.Revision
		}
		selected, err = service.ResolveManagedModel(r.Header.Get("X-Model-Feature"), modelID, user.Group, channelID)
		if err != nil {
			return r, nil, "", "", err
		}
		revision, _ := strconv.Atoi(r.Header.Get("X-Model-Revision"))
		if revision != selected.Revision {
			return r, nil, "", "", fmt.Errorf("模型配置已变化，请刷新模型并重新确认费用；本次未扣费")
		}
		if proofRevision != 0 && proofRevision != selected.Revision {
			return r, nil, "", "", fmt.Errorf("报价配置版本已变化，请重新确认费用")
		}
		if r.Header.Get("X-Model-Quote") == "" {
			return r, nil, "", "", fmt.Errorf("请重新读取并确认模型报价")
		}
		r = r.WithContext(service.WithManagedSelection(r.Context(), selected))
	}
	if !managedHas(selected.Feature.Operations, operation) || !managedHas(selected.Route.Operations, operation) {
		return r, nil, "", "", fmt.Errorf("所选模型不支持当前功能操作")
	}
	rewritten, nextType, err := rewriteManagedModel(body, contentType, selected.Route.Model)
	return r, rewritten, nextType, selected.Route.Model, err
}

func managedHas(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

// Redact provider identity in JSON/SSE metadata without touching media bytes.
// A complete line is buffered so split HTTP writes cannot bypass redaction.
type managedResponseWriter struct {
	http.ResponseWriter
	selected *service.ManagedSelection
	pending  []byte
}

func (w *managedResponseWriter) WriteHeader(code int) {
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(code)
}

func (w *managedResponseWriter) Write(data []byte) (int, error) {
	kind := w.Header().Get("Content-Type")
	if !strings.Contains(kind, "json") && !strings.Contains(kind, "event-stream") {
		return w.ResponseWriter.Write(data)
	}
	w.Header().Del("Content-Length")
	w.pending = append(w.pending, data...)
	if !strings.Contains(kind, "event-stream") {
		return len(data), nil
	}
	for {
		index := bytes.IndexByte(w.pending, '\n')
		if index < 0 {
			break
		}
		line := append([]byte{}, w.pending[:index+1]...)
		w.pending = w.pending[index+1:]
		if _, err := w.ResponseWriter.Write(w.redact(line)); err != nil {
			return 0, err
		}
	}
	return len(data), nil
}

func (w *managedResponseWriter) redact(data []byte) []byte {
	selected := w.selected
	prefix := []byte{}
	payload := bytes.TrimSpace(data)
	if bytes.HasPrefix(payload, []byte("data:")) {
		prefix = []byte("data: ")
		payload = bytes.TrimSpace(payload[5:])
	}
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return data
	}
	var redact func(any, bool)
	redact = func(value any, inError bool) {
		switch item := value.(type) {
		case map[string]any:
			for key, field := range item {
				if key == "model" {
					item[key] = selected.Model.ID
					continue
				}
				if text, ok := field.(string); ok && (inError || key == "msg" || key == "message" && item["code"] != nil) && selected.Model.DisplayMode == "alias" && selected.Route.Model != "" {
					item[key] = strings.ReplaceAll(text, selected.Route.Model, selected.Model.DisplayName)
				} else {
					redact(field, inError || key == "error")
				}
			}
		case []any:
			for _, field := range item {
				redact(field, inError)
			}
		}
	}
	redact(value, false)
	result, err := json.Marshal(value)
	if err != nil {
		return data
	}
	result = append(prefix, result...)
	if bytes.HasSuffix(data, []byte("\n")) {
		result = append(result, '\n')
	}
	return result
}

func (w *managedResponseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
func (w *managedResponseWriter) finish() {
	if len(w.pending) > 0 {
		_, _ = w.ResponseWriter.Write(w.redact(w.pending))
		w.pending = nil
	}
}
func managedWriter(w http.ResponseWriter, r *http.Request) (http.ResponseWriter, func()) {
	if selected := service.ManagedSelectionFromContext(r.Context()); selected != nil {
		wrapped := &managedResponseWriter{ResponseWriter: w, selected: selected}
		return wrapped, wrapped.finish
	}
	return w, func() {}
}
