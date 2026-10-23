package handler

import (
	"encoding/json"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func AdminModelManagement(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	settings, err := service.AdminSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	features, err := service.ModelFeatures()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"management": settings.Private.ModelManagement, "features": features, "channels": settings.Private.Channels})
}

func AdminPreviewModelManagement(w http.ResponseWriter, r *http.Request) {
	preview, err := service.PreviewModelManagement()
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, preview)
}

func AdminSaveModelManagement(w http.ResponseWriter, r *http.Request) {
	var management model.ModelManagement
	if json.NewDecoder(r.Body).Decode(&management) != nil {
		Fail(w, "模型配置格式不正确")
		return
	}
	settings, err := repository.GetSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	settings.Private.ModelManagement = &management
	saved, err := service.SaveSettings(settings)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved.Private.ModelManagement)
}
