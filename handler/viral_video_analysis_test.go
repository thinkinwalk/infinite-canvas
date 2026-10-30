package handler

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func TestReadViralObservationsOptionalWindowsAndUnavailableAudio(t *testing.T) {
	input := `{"analysis":"人物转身，听到口播","analysisFacts":[{"id":"v","kind":"event","subject":"人物","description":"人物转身","time":"00:01","evidence":["画面[1]"],"status":"observed","source":"visual"},{"id":"a","kind":"audio","subject":"口播","description":"听到一句口播","time":"00:01","evidence":["原片声音"],"status":"observed","source":"audio"}]}`
	document, err := readViralObservations(input, []service.AnalysisFrame{{Time: 1}}, "frames", false, false)
	if err != nil || len(document.Windows) != 0 || document.Facts[1].Status != "uncertain" {
		t.Fatalf("document=%+v err=%v", document, err)
	}
	result, err := viralAnalysisResult(document)
	if err != nil || strings.Contains(strings.Split(result, "```")[0], "口播") {
		t.Fatalf("unavailable audio leaked into visible prose: %s %v", result, err)
	}
}

func TestParseViralReviewWindowsSkipsMalformedEntries(t *testing.T) {
	windows := parseViralReviewWindows(json.RawMessage(`[{"start":1,"end":2},{"start":"bad","end":3},{"start":4}]`))
	if len(windows) != 1 || windows[0].Start != 1 || windows[0].End != 2 {
		t.Fatalf("windows=%+v", windows)
	}
}

func TestViralResultRetainsLongSequenceAndCarrierWithoutDraft(t *testing.T) {
	document := viralObservationDocument{Analysis: "初稿错误：长裙变成独立折扇"}
	for i := 0; i < 30; i++ {
		document.Facts = append(document.Facts, viralObservation{
			ID: fmt.Sprint(i), Kind: "event", Subject: "裙摆", Time: fmt.Sprint(i),
			Description: fmt.Sprintf("镜头%d布面连续展开", i), Status: "observed", Source: "visual",
		})
	}
	document.Facts = append(document.Facts, viralObservation{
		ID: "text", Kind: "text", Subject: "字样", Time: "结尾", Description: "西安随布面起伏",
		Surface: "裙摆上方布面", Status: "observed", Source: "visual",
	})
	text, err := viralAnalysisResult(document)
	prose := strings.Split(text, "```")[0]
	if err != nil || !strings.Contains(prose, "镜头29") || !strings.Contains(prose, "裙摆上方布面") ||
		strings.Contains(text, "独立折扇") || strings.Contains(text, "reviewWindows") {
		t.Fatalf("invalid final result: %s %v", text, err)
	}
}

func TestViralAutomaticReviewChargesOnceAndRefundsReviewFailure(t *testing.T) {
	ffmpeg := os.Getenv("FFMPEG_PATH")
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	ffprobe := os.Getenv("FFPROBE_PATH")
	if ffprobe == "" {
		ffprobe = "ffprobe"
	}
	for _, binary := range []string{ffmpeg, ffprobe} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skip("FFmpeg and FFprobe required for full automatic analysis integration")
		}
	}
	path := filepath.Join(t.TempDir(), "input.mp4")
	if out, err := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i",
		"testsrc2=size=128x192:rate=10:duration=3", "-c:v", "mpeg4", path).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	data, _ := os.ReadFile(path)
	db := setupVideoLogTest(t)
	user := model.User{ID: "viral-review-owner", Username: "viral-review-owner", AffCode: "viral-review-owner", Credits: 500, Group: "default", Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Delete(&user)
	})
	for _, mode := range []string{"video", "frames"} {
		for _, failReview := range []bool{false, true} {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var payload map[string]any
				_ = json.NewDecoder(r.Body).Decode(&payload)
				if calls == 2 && failReview {
					w.WriteHeader(502)
					return
				}
				document := viralObservationDocument{Analysis: "裙摆变成独立折扇",
					Facts: []viralObservation{{ID: "cloth", Kind: "event", Subject: "裙摆", Time: "00:01",
						Description: "裙摆展开", Evidence: []string{"画面[1]布料连续"}, Status: "observed", Source: "visual"}},
					WindowPayload: json.RawMessage(`[{"start":1,"end":2}]`)}
				if calls == 2 {
					document.Analysis = "裙摆展开，字在裙摆上"
					document.Facts[0].Description = "裙摆连续展开呈扇形，仍为同一块布面"
					if mode == "frames" {
						parts := payload["input"].([]any)[0].(map[string]any)["content"].([]any)
						for _, part := range parts[:len(parts)-1] {
							text, _ := part.(map[string]any)["text"].(string)
							if strings.HasPrefix(text, "画面[3]") || strings.HasPrefix(text, "画面[4]") {
								if !strings.Contains(text, "1.250") && !strings.Contains(text, "1.750") {
									t.Errorf("review escaped selected window: %s", text)
								}
							}
						}
					}
				}
				answer, _ := json.Marshal(document)
				if mode == "video" {
					_ = json.NewEncoder(w).Encode(map[string]any{"candidates": []any{map[string]any{"finishReason": "STOP", "content": map[string]any{"parts": []any{map[string]string{"text": string(answer)}}}}}})
				} else {
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{map[string]any{"type": "message", "content": []any{map[string]string{"type": "output_text", "text": string(answer)}}}}})
				}
			}))
			channel := model.ModelChannel{ID: 987, BaseURL: upstream.URL, APIKey: "test"}
			feature, adapter := "viral-recreate.video-analyze", "text.gemini-video"
			if mode == "frames" {
				feature, adapter = "viral-recreate.analyze", "text.openai"
			}
			input := viralAnalysisInput{Prompt: "分析", Recreation: true, Mode: mode, FrameCount: 2}
			input.Video.Data, input.Video.MimeType = base64.StdEncoding.EncodeToString(data), "video/mp4"
			body, _ := json.Marshal(input)
			r := httptest.NewRequest("POST", "/", nil)
			r = r.WithContext(service.WithManagedSelection(r.Context(), &service.ManagedSelection{
				Feature: model.ModelFeature{ID: feature}, Route: model.ManagedRoute{Adapter: adapter},
			}))
			before, _, _ := repository.GetUserByID(user.ID)
			w := httptest.NewRecorder()
			proxyViralVideoAnalysis(w, r, channel, body, user.ID, "review-test", 7)
			upstream.Close()
			after, _, _ := repository.GetUserByID(user.ID)
			expected := before.Credits - 7
			if failReview {
				expected = before.Credits
				if !strings.Contains(w.Body.String(), "7 算力点已退回") {
					t.Errorf("refund unconfirmed: %s", w.Body.String())
				}
			} else if !strings.Contains(w.Body.String(), "仍为同一块布面") || strings.Contains(w.Body.String(), "独立折扇") {
				t.Errorf("draft leaked: %s", w.Body.String())
			}
			if calls != 2 || after.Credits != expected {
				t.Fatalf("mode=%s fail=%v calls=%d balance=%d want=%d response=%s", mode, failReview, calls, after.Credits, expected, w.Body.String())
			}
		}
	}
}
