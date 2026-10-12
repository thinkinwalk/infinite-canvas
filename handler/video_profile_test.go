package handler

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func TestVideoReferencesSurviveProtocolConversion(t *testing.T) {
	payload := map[string]any{"model": "seedance-test", "prompt": "参考视频1的运镜", "seconds": "5", "image_url": "https://example.com/image.png", "reference_videos": []any{"https://example.com/video.mp4"}, "audio_urls": []any{"https://example.com/audio.mp3"}}
	ark, ok := buildArkAgentPlanVideoBody(payload)
	if !ok {
		t.Fatal("conversion failed")
	}
	var content map[string]any
	if err := json.Unmarshal(ark, &content); err != nil {
		t.Fatal(err)
	}
	relay, ok := buildOpenAICompatibleVideoBody(content)
	if !ok {
		t.Fatal("reverse conversion failed")
	}
	var result map[string]any
	json.Unmarshal(relay, &result)
	if len(jsonURLValues(result["reference_videos"])) != 1 || len(jsonURLValues(result["audio_urls"])) != 1 {
		t.Fatalf("lost references: %s", relay)
	}
}

func TestH3VideoRequestValidatesExactParametersBeforeBilling(t *testing.T) {
	profile := service.VideoProfile(model.ModelChannel{}, "H3video-2k")
	for _, resolution := range []string{"2K", "768p"} {
		body := []byte(`{"model":"H3video-2k","resolution":"` + resolution + `","seconds":"15","aspect_ratio":"16:9"}`)
		if err := validateH3VideoRequest(body, "application/json"); err != nil {
			t.Fatal(err)
		}
		if err := validateVideoProfileRequest(profile, body, "application/json"); err != nil {
			t.Fatal(err)
		}
		forwarded, _ := normalizeAIProxyVideoBody("", "/videos", stripVideoInputMode(body, "application/json"), "application/json")
		if err := validateH3VideoRequest(forwarded, "application/json"); err != nil {
			t.Fatalf("protocol conversion changed valid H3 fields: %s", forwarded)
		}
	}
	for _, body := range []string{
		`{"resolution":"1080p","seconds":"15","aspect_ratio":"16:9"}`,
		`{"resolution":"720p","seconds":"15","aspect_ratio":"16:9"}`,
		`{"resolution":"2Kp","seconds":"15","aspect_ratio":"16:9"}`,
		`{"resolution":"768","seconds":"15","aspect_ratio":"16:9"}`,
		`{"resolution":"2K","seconds":"5","aspect_ratio":"16:9"}`,
		`{"resolution":"2K","seconds":"15","ratio":"16:9"}`,
		`{"resolution":"2K","seconds":"15","size":"1920x1080"}`,
		`{"resolution":"2K","seconds":"15","aspect_ratio":"2:3"}`,
		`{"resolution":"2K","seconds":"15","aspect_ratio":"16:9","duration":5}`,
	} {
		if validateH3VideoRequest([]byte(body), "application/json") == nil {
			t.Fatalf("invalid H3 parameters accepted: %s", body)
		}
	}
	if validateH3VideoRequest([]byte(`{}`), "multipart/form-data") == nil {
		t.Fatal("H3 multipart accepted")
	}
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
		if validateVideoProfileRequest(profile, []byte(body), "application/json") == nil {
			t.Fatalf("unchecked input: %s", body)
		}
	}
	profile.MaxVideos, profile.MaxAudios = 3, 3
	if err := validateVideoProfileRequest(profile, []byte(`{"resolution":"720p","seconds":"5","reference_videos":["https://example.com/video.mp4"],"audio_urls":["https://example.com/audio.mp3"]}`), "application/json"); err != nil {
		t.Fatal(err)
	}
}

func TestVideoPriceChangeRequiresNewConfirmation(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/v1/videos", nil)
	r.Header.Set("X-Expected-Credits", "180")
	if checkExpectedVideoCredits(r, 180) != nil {
		t.Fatal("matching quote rejected")
	}
	if checkExpectedVideoCredits(r, 390) == nil {
		t.Fatal("changed price accepted")
	}
}

func TestVideoRequestPricingFieldsReadsJSON(t *testing.T) {
	resolution, seconds := videoRequestPricingFields([]byte(`{"resolution":"720p","seconds":"5"}`), "application/json")
	if resolution != "720p" || seconds != "5" {
		t.Fatalf("pricing fields = %q, %q", resolution, seconds)
	}
}
