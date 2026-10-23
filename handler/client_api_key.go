package handler

import (
	"net/http"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func ClientAPIKeys(w http.ResponseWriter, r *http.Request) {
	user, _ := service.UserFromContext(r.Context())
	clientAPIKeys(w, r, user.ID)
}

func clientAPIKeys(w http.ResponseWriter, r *http.Request, userID string) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method == http.MethodGet {
		items, err := repository.ListClientAPIKeys(userID)
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
	key, secret, err := service.CreateClientAPIKey(userID, input.Name)
	if err != nil {
		VoiceAPIFail(w, 400, "INVALID_REQUEST", "客户端 Key 创建失败，请检查名称")
		return
	}
	OK(w, map[string]any{"key": key, "api_key": secret})
}

func RevokeClientAPIKey(w http.ResponseWriter, r *http.Request, id string) {
	user, _ := service.UserFromContext(r.Context())
	revokeClientAPIKey(w, user.ID, id)
}

// AdminAuth protects these routes; the selected account owns the key and its charges.
func AdminClientAPIKeys(w http.ResponseWriter, r *http.Request, userID, keyID string) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, found, err := repository.GetUserByID(userID)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if !found {
		VoiceAPIFail(w, 404, "USER_NOT_FOUND", "用户不存在")
		return
	}
	if r.Method == http.MethodPost {
		if user.Role != model.UserRoleUser {
			VoiceAPIFail(w, 400, "INVALID_KEY_OWNER", "客户端 Key 必须绑定普通用户账号")
			return
		}
		if user.Status != model.UserStatusActive {
			VoiceAPIFail(w, 409, "ACCOUNT_DISABLED", "该账号已禁用，不能创建客户端 Key")
			return
		}
	}
	if r.Method == http.MethodDelete {
		revokeClientAPIKey(w, userID, keyID)
		return
	}
	clientAPIKeys(w, r, userID)
}

func revokeClientAPIKey(w http.ResponseWriter, userID, id string) {
	w.Header().Set("Cache-Control", "private, no-store")
	found, err := repository.RevokeClientAPIKey(userID, id, time.Now().UTC().Format(time.RFC3339Nano))
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
