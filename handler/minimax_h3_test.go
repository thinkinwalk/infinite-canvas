package handler

import (
	"encoding/json"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func TestMiniMaxH3ValidatedReferencesReachUpstream(t *testing.T) {
	for _, name := range []string{"minimax-h3", "minimax-h3-fl2v"} {
		for resolution, size := range map[string]string{"480p": "480x864", "768p": "768x1376", "1080p": "1088x1920", "2K": "2K", "4K": "4K"} {
			frames := name == "minimax-h3-fl2v"
			payload := map[string]any{"model": name, "prompt": "test", "seconds": "5", "resolution": resolution, "aspect_ratio": "9:16", "input_mode": "reference", "image_url": "https://example.com/first.png"}
			if frames {
				payload["input_mode"], payload["last_frame"] = "first_last", "https://example.com/last.png"
			} else {
				payload["reference_image_urls"] = []string{"https://example.com/last.png"}
				payload["reference_videos"] = []string{"https://example.com/video.mp4"}
				payload["audio_urls"] = []string{"https://example.com/audio.mp3"}
			}
			body, _ := json.Marshal(payload)
			profile := service.VideoProfile(model.ModelChannel{}, name)
			if err := validateVideoProfileRequest(profile, body, "application/json"); err != nil {
				t.Fatal(err)
			}
			forwarded, contentType := normalizeAIProxyVideoBody("", "/videos", stripVideoInputMode(body, "application/json"), "application/json")
			var result map[string]any
			if err := json.Unmarshal(forwarded, &result); err != nil {
				t.Fatal(err)
			}
			images := jsonURLValues(result["images"])
			if contentType != "application/json" || result["size"] != size || result["seconds"] != float64(5) || len(images) != 2 || images[0] != payload["image_url"] || images[1] != "https://example.com/last.png" {
				t.Fatalf("MiniMax fields lost or reordered: %s", forwarded)
			}
			for _, key := range []string{"input_mode", "resolution", "image_url", "reference_image_urls", "last_frame", "audio_urls"} {
				if result[key] != nil {
					t.Fatalf("gateway field leaked: %s: %s", key, forwarded)
				}
			}
			if !frames && (len(jsonURLValues(result["reference_videos"])) != 1 || len(jsonURLValues(result["reference_audios"])) != 1) {
				t.Fatalf("reference media dropped: %s", forwarded)
			}
		}
	}
}

func TestMiniMaxH3RejectsInvalidInputsBeforeBilling(t *testing.T) {
	for _, body := range []string{
		`{"model":"minimax-h3-fl2v","prompt":"test","seconds":"5","resolution":"768p","aspect_ratio":"16:9","input_mode":"reference"}`,
		`{"model":"minimax-h3-fl2v","prompt":"test","seconds":"5","resolution":"768p","aspect_ratio":"16:9","input_mode":"first_last","last_frame":"https://example.com/last.png"}`,
		`{"model":"minimax-h3-fl2v","prompt":"test","seconds":"5","resolution":"768p","aspect_ratio":"16:9","input_mode":"first_last","reference_videos":["https://example.com/video.mp4"]}`,
		`{"model":"minimax-h3","prompt":"test","seconds":"16","resolution":"768p","aspect_ratio":"16:9"}`,
		`{"model":"minimax-h3","prompt":"test","seconds":"5","resolution":"720p","aspect_ratio":"16:9"}`,
		`{"model":"minimax-h3","prompt":"test","seconds":"5","resolution":"768p","aspect_ratio":"9:21"}`,
		`{"model":"minimax-h3","prompt":"test","seconds":"5","resolution":"768p","aspect_ratio":"16:9","images":["https://example.com/unvalidated.png"]}`,
	} {
		var payload map[string]any
		json.Unmarshal([]byte(body), &payload)
		if err := validateVideoProfileRequest(service.VideoProfile(model.ModelChannel{}, jsonStringValue(payload["model"])), []byte(body), "application/json"); err == nil {
			t.Fatalf("invalid MiniMax input accepted: %s", body)
		}
	}
	for _, name := range []string{"minimax-h3", "minimax-h3-fl2v"} {
		profile := service.VideoProfile(model.ModelChannel{}, name)
		body := []byte(`{"model":"` + name + `","prompt":"test","seconds":5,"resolution":"768p","aspect_ratio":"16:9","input_mode":"` + profile.InputModes[0] + `"}`)
		if err := validateVideoProfileRequest(profile, body, "application/json"); err != nil {
			t.Fatal(err)
		}
	}
}
