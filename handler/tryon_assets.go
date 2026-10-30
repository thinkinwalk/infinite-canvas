package handler

import (
	"bytes"
	"embed"
	"net/http"
	"time"
)

//go:embed tryon_assets/*.jpg
var tryonAssets embed.FS

var tryonChildModels = []tryonModel{
	{ID: "child-boy-1", Name: "男童 01", Group: "intl", Gender: "m", URL: "/api/tryon/assets/child-boy-1.jpg", Thumb: "/api/tryon/assets/child-boy-1-thumb.jpg", Child: true},
	{ID: "child-boy-2", Name: "男童 02", Group: "intl", Gender: "m", URL: "/api/tryon/assets/child-boy-2.jpg", Thumb: "/api/tryon/assets/child-boy-2-thumb.jpg", Child: true},
	{ID: "child-boy-3", Name: "男童 03", Group: "intl", Gender: "m", URL: "/api/tryon/assets/child-boy-3.jpg", Thumb: "/api/tryon/assets/child-boy-3-thumb.jpg", Child: true},
	{ID: "child-boy-4", Name: "男童 04", Group: "intl", Gender: "m", URL: "/api/tryon/assets/child-boy-4.jpg", Thumb: "/api/tryon/assets/child-boy-4-thumb.jpg", Child: true},
	{ID: "child-boy-5", Name: "男童 05", Group: "intl", Gender: "m", URL: "/api/tryon/assets/child-boy-5.jpg", Thumb: "/api/tryon/assets/child-boy-5-thumb.jpg", Child: true},
	{ID: "child-boy-6", Name: "男童 06", Group: "intl", Gender: "m", URL: "/api/tryon/assets/child-boy-6.jpg", Thumb: "/api/tryon/assets/child-boy-6-thumb.jpg", Child: true},
	{ID: "child-girl-1", Name: "女童 01", Group: "intl", Gender: "f", URL: "/api/tryon/assets/child-girl-1.jpg", Thumb: "/api/tryon/assets/child-girl-1-thumb.jpg", Child: true},
	{ID: "child-girl-2", Name: "女童 02", Group: "intl", Gender: "f", URL: "/api/tryon/assets/child-girl-2.jpg", Thumb: "/api/tryon/assets/child-girl-2-thumb.jpg", Child: true},
	{ID: "child-girl-3", Name: "女童 03", Group: "intl", Gender: "f", URL: "/api/tryon/assets/child-girl-3.jpg", Thumb: "/api/tryon/assets/child-girl-3-thumb.jpg", Child: true},
	{ID: "child-girl-4", Name: "女童 04", Group: "intl", Gender: "f", URL: "/api/tryon/assets/child-girl-4.jpg", Thumb: "/api/tryon/assets/child-girl-4-thumb.jpg", Child: true},
	{ID: "child-girl-5", Name: "女童 05", Group: "intl", Gender: "f", URL: "/api/tryon/assets/child-girl-5.jpg", Thumb: "/api/tryon/assets/child-girl-5-thumb.jpg", Child: true},
	{ID: "child-girl-6", Name: "女童 06", Group: "intl", Gender: "f", URL: "/api/tryon/assets/child-girl-6.jpg", Thumb: "/api/tryon/assets/child-girl-6-thumb.jpg", Child: true},
}

type tryonPresetPose struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	URL    string `json:"url"`
	Source string `json:"source"`
}

var tryonPresetPoses = []tryonPresetPose{
	{"crossed-stand", "交叉站姿", "/api/tryon/assets/crossed-stand.jpg", "https://www.pexels.com/photo/12857529/"},
	{"look-back", "侧身回头", "/api/tryon/assets/look-back.jpg", "https://www.pexels.com/photo/4590986/"},
	{"relaxed-stand", "轻侧身站立", "/api/tryon/assets/relaxed-stand.jpg", "https://www.pexels.com/photo/5665378/"},
	{"one-pocket", "单手插兜（半身）", "/api/tryon/assets/one-pocket.jpg", "https://www.pexels.com/photo/6311050/"},
	{"both-pockets", "双手插兜（半身）", "/api/tryon/assets/both-pockets.jpg", "https://www.pexels.com/photo/6140705/"},
	{"one-hip", "单手叉腰（半身）", "/api/tryon/assets/one-hip.jpg", "https://www.pexels.com/photo/15323444/"},
	{"both-hips", "双手叉腰（半身）", "/api/tryon/assets/both-hips.jpg", "https://www.pexels.com/photo/5151058/"},
	{"walking", "自然迈步", "/api/tryon/assets/walking.jpg", "https://www.pexels.com/photo/7752448/"},
}

func findTryonPose(id string) (tryonPresetPose, bool) {
	for _, pose := range tryonPresetPoses {
		if pose.ID == id {
			return pose, true
		}
	}
	return tryonPresetPose{}, false
}

func tryonPoseImage(url string) ([]byte, bool) {
	for _, pose := range tryonPresetPoses {
		if pose.URL == url {
			data, err := tryonAssets.ReadFile("tryon_assets/" + pose.ID + ".jpg")
			return data, err == nil
		}
	}
	return nil, false
}

func tryonModelImage(url string) ([]byte, bool) {
	for _, model := range tryonChildModels {
		if url == model.URL || url == model.Thumb {
			name := model.ID + ".jpg"
			if url == model.Thumb {
				name = model.ID + "-thumb.jpg"
			}
			data, err := tryonAssets.ReadFile("tryon_assets/" + name)
			return data, err == nil
		}
	}
	return nil, false
}

func TryonAsset(w http.ResponseWriter, r *http.Request) {
	data, ok := tryonPoseImage(r.URL.Path)
	if !ok {
		data, ok = tryonModelImage(r.URL.Path)
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "pose.jpg", time.Time{}, bytes.NewReader(data))
}
