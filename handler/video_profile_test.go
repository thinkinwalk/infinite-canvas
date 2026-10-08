package handler

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestVideoReferencesSurviveProtocolConversion(t *testing.T) {
	payload := map[string]any{"model": "seedance-test", "prompt": "参考视频1的运镜", "seconds": "5", "image_url": "https://example.com/image.png", "reference_videos": []any{"https://example.com/video.mp4"}, "audio_urls": []any{"https://example.com/audio.mp3"}}
	ark, ok := buildArkAgentPlanVideoBody(payload)
	if !ok { t.Fatal("conversion failed") }
	var content map[string]any
	if err := json.Unmarshal(ark, &content); err != nil { t.Fatal(err) }
	relay, ok := buildOpenAICompatibleVideoBody(content)
	if !ok { t.Fatal("reverse conversion failed") }
	var result map[string]any
	json.Unmarshal(relay, &result)
	if len(jsonURLValues(result["reference_videos"])) != 1 || len(jsonURLValues(result["audio_urls"])) != 1 { t.Fatalf("lost references: %s", relay) }
}

func TestVideoProfileRejectsUnsupportedInputsBeforeBilling(t *testing.T) {
	profile := model.VideoModelProfile{Interface: "relay", MaxImages: 7, Resolutions: []string{"720"}, Seconds: []string{"5"}}
	for _, body := range []string{
		`{"model":"seedance-test","reference_videos":["https://example.com/video.mp4"]}`,
		`{"model":"seedance-test","content":[{"type":"audio_url","audio_url":{"url":"https://example.com/audio.mp3"}}]}`,
		`{"model":"seedance-test","video_urls":["https://example.com/video.mp4"]}`,
		`{"model":"seedance-test","resolution":"1080p","seconds":"5"}`,
		`{"model":"seedance-test","resolution":"720p","seconds":"15"}`,
	} {
		if validateVideoProfileRequest(profile, []byte(body), "application/json") == nil { t.Fatalf("unchecked input: %s", body) }
	}
	profile.MaxVideos, profile.MaxAudios = 3, 3
	if err := validateVideoProfileRequest(profile, []byte(`{"resolution":"720p","seconds":"5","reference_videos":["https://example.com/video.mp4"],"audio_urls":["https://example.com/audio.mp3"]}`), "application/json"); err != nil { t.Fatal(err) }
}

func TestVideoPriceChangeRequiresNewConfirmation(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/v1/videos", nil)
	r.Header.Set("X-Expected-Credits", "180")
	if checkExpectedVideoCredits(r, 180) != nil { t.Fatal("matching quote rejected") }
	if checkExpectedVideoCredits(r, 390) == nil { t.Fatal("changed price accepted") }
}
