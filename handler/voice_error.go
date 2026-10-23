package handler

import (
	"encoding/json"
	"io"
	"net/http"
)

type voiceAPIError struct {
	Status  int
	Code    string
	Message string
}

func (e *voiceAPIError) Error() string                  { return e.Message }
func (e *voiceAPIError) SafeMessage() string            { return e.Message }
func voiceError(status int, code, message string) error { return &voiceAPIError{status, code, message} }

func VoiceAPIFail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 1, "data": nil, "msg": message, "error": map[string]string{"code": code, "message": message}})
}

func voiceFailError(w http.ResponseWriter, err error) {
	if typed, ok := err.(*voiceAPIError); ok {
		VoiceAPIFail(w, typed.Status, typed.Code, typed.Message)
		return
	}
	VoiceAPIFail(w, 500, "INTERNAL_ERROR", "操作失败，请稍后重试")
}

func strictVoiceJSON(r *http.Request, value any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return voiceError(400, "INVALID_REQUEST", "请求格式不正确或包含不支持的参数")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return voiceError(400, "INVALID_REQUEST", "请求只能包含一个 JSON 对象")
	}
	return nil
}
