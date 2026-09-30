package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

type adminChannelActionRequest struct {
	Index   *int               `json:"index"`
	Channel model.ModelChannel `json:"channel"`
	Model   string             `json:"model"`
}

func Settings(w http.ResponseWriter, r *http.Request) {
	group := "default"
	if user, ok := service.UserFromContext(r.Context()); ok {
		group = user.Group
	}
	settings, err := service.PublicSettingsForGroup(group)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.AdminSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSaveSettings(w http.ResponseWriter, r *http.Request) {
	var settings model.Settings
	_ = json.NewDecoder(r.Body).Decode(&settings)
	result, err := service.SaveSettings(settings)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminChannelModels(w http.ResponseWriter, r *http.Request) {
	var request adminChannelActionRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	models, err := service.AdminChannelModels(request.Index, request.Channel)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, models)
}

func AdminTestChannelModel(w http.ResponseWriter, r *http.Request) {
	var request adminChannelActionRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	result, err := service.AdminTestChannelModel(request.Index, request.Channel, request.Model)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminTestReplicate(w http.ResponseWriter, r *http.Request) {
	key, err := service.ReplicateAPIKey()
	if err != nil {
		FailError(w, err)
		return
	}
	if key == "" {
		Fail(w, "请先保存 Replicate API Token")
		return
	}
	for _, name := range []string{"men1scus/birefnet", "nightmareai/real-esrgan"} {
		request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://api.replicate.com/v1/models/"+name, nil)
		if err != nil {
			FailError(w, err)
			return
		}
		request.Header.Set("Authorization", "Bearer "+key)
		response, err := aiHTTPClient.Do(request)
		if err != nil {
			Fail(w, "Replicate 连接失败")
			return
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
				Fail(w, "Replicate 令牌无效或无权限")
			} else {
				Fail(w, "Replicate 模型访问失败："+strings.TrimSpace(response.Status))
			}
			return
		}
	}
	OK(w, "令牌有效，抠图和超分模型可访问；尚未执行付费生成")
}
