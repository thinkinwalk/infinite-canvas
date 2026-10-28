package handler

import (
	"bytes"
	"embed"
	"net/http"
	"time"
)

//go:embed tryon_assets/*.jpg
var tryonAssets embed.FS

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

func TryonPoseAsset(w http.ResponseWriter, r *http.Request) {
	data, ok := tryonPoseImage(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "pose.jpg", time.Time{}, bytes.NewReader(data))
}
