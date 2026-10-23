package handler

import (
	"net/http"
	"time"

	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func ClientAPIKeys(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, _ := service.UserFromContext(r.Context())
	if r.Method == http.MethodGet {
		items, err := repository.ListClientAPIKeys(user.ID)
		if err != nil {
			voiceFailError(w, err)
			return
		}
		OK(w, map[string]any{"items": items})
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := strictVoiceJSON(r, &input); err != nil {
		voiceFailError(w, err)
		return
	}
	if input.Name == "" {
		VoiceAPIFail(w, 400, "INVALID_REQUEST", "请输入客户端名称")
		return
	}
	key, secret, err := service.CreateClientAPIKey(user.ID, input.Name)
	if err != nil {
		VoiceAPIFail(w, 400, "INVALID_REQUEST", "客户端 Key 创建失败，请检查名称")
		return
	}
	OK(w, map[string]any{"key": key, "api_key": secret})
}

func RevokeClientAPIKey(w http.ResponseWriter, r *http.Request, id string) {
	user, _ := service.UserFromContext(r.Context())
	found, err := repository.RevokeClientAPIKey(user.ID, id, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if !found {
		VoiceAPIFail(w, 404, "KEY_NOT_FOUND", "客户端 Key 不存在")
		return
	}
	OK(w, true)
}
