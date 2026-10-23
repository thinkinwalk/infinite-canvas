package router

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

type speechTransport func(*http.Request) (*http.Response, error)

func (f speechTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Synthetic PCM is only a container/decode fixture, never a voice-cloning quality sample.
func speechTestWAV() []byte {
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+16000*2))
	b.WriteString("WAVEfmt ")
	for _, value := range []any{uint32(16), uint16(1), uint16(1), uint32(16000), uint32(32000), uint16(2), uint16(16)} {
		_ = binary.Write(&b, binary.LittleEndian, value)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(16000*2))
	b.Write(make([]byte, 16000*2))
	return b.Bytes()
}

func TestSpeechAPIHTTPWorkflow(t *testing.T) {
	binaryPath := os.Getenv("FFPROBE_PATH")
	if binaryPath == "" {
		binaryPath = "ffprobe"
	}
	if _, err := exec.LookPath(binaryPath); err != nil {
		t.Skip("real FFprobe required; set FFPROBE_PATH")
	}
	oldConfig, oldTransport := config.Cfg, http.DefaultTransport
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: "file:speech-http-test?mode=memory&cache=shared", JWTSecret: "speech-test-jwt", JWTExpireHours: 1}
	t.Cleanup(func() { config.Cfg, http.DefaultTransport = oldConfig, oldTransport })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "app.db")
	oldSettings, _ := repository.GetSettings()
	t.Cleanup(func() { _, _ = repository.SaveSettings(oldSettings, "test") })
	spec, _ := service.FindReplicateModel("speech")
	settings := model.Settings{Private: model.PrivateSetting{
		Replicate: model.ReplicateSetting{ChannelsInitialized: true, Pricing: map[string]model.ReplicatePricing{spec.Model: {Model: spec.Model, Version: spec.Version, BillingMode: "input_characters", UnitCredits: 70, MinimumCredits: 100, Enabled: true}}},
		Channels:  []model.ModelChannel{{ID: 811, Name: "mock-replicate", Protocol: "replicate", APIKey: "mock-upstream-secret", Models: []string{spec.Model}, Enabled: true, Weight: 1}},
	}}
	if _, err := repository.SaveSettings(settings, "test"); err != nil {
		t.Fatal(err)
	}
	user, err := service.SaveUser(model.User{ID: "speech-http-a", Username: "speech-http-a", AffCode: "speech-http-a", Role: model.UserRoleUser, Status: model.UserStatusActive}, "test-password")
	if err != nil {
		t.Fatal(err)
	}
	other, err := service.SaveUser(model.User{ID: "speech-http-b", Username: "speech-http-b", AffCode: "speech-http-b", Role: model.UserRoleUser, Status: model.UserStatusActive}, "test-password")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ids := []string{user.ID, other.ID}
		for _, target := range []any{&model.ClientAPIKey{}, &model.Voice{}, &model.ReplicateTask{}, &model.CreditLog{}} {
			db.Where("user_id IN ?", ids).Delete(target)
		}
		db.Where("id IN ?", ids).Delete(&model.User{})
	})
	db.Model(&model.User{}).Where("id = ?", user.ID).Update("credits", 2000)
	session, _ := service.Login(user.Username, "test-password")
	otherSession, _ := service.Login(other.Username, "test-password")
	wav := speechTestWAV()
	var mu sync.Mutex
	creates, polls := 0, 0
	failCreate, uncertainCreate, badOutput := false, false, false
	http.DefaultTransport = speechTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "replicate.delivery" {
			body := wav
			if badOutput {
				body = []byte("invalid audio")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"audio/wav"}}, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
		}
		if r.URL.Host != "api.replicate.com" {
			if r.URL.Hostname() != "127.0.0.1" {
				return nil, fmt.Errorf("unexpected external request blocked")
			}
			return oldTransport.RoundTrip(r)
		}
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer mock-upstream-secret" {
			t.Error("wrong upstream credential")
		}
		status, body := 200, ""
		if r.Method == "POST" {
			creates++
			var payload struct {
				Version string         `json:"version"`
				Input   map[string]any `json:"input"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if payload.Version != spec.Version || payload.Input["mode"] != "voice_clone" || payload.Input["reference_text"] != "测试录音原文" {
				t.Error("wrong pinned clone input")
			}
			audio, _ := payload.Input["reference_audio"].(string)
			decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(audio, "data:audio/wav;base64,"))
			if err != nil || !bytes.Equal(decoded, wav) {
				t.Error("reference did not come from private saved audio")
			}
			if uncertainCreate {
				return nil, fmt.Errorf("simulated ambiguous disconnect")
			}
			if failCreate {
				status, body = 422, `{"detail":"mock rejection"}`
			} else {
				body = fmt.Sprintf(`{"id":"mock-speech-%d","status":"processing"}`, creates)
			}
		} else {
			polls++
			body = fmt.Sprintf(`{"id":%q,"status":"succeeded","output":"https://replicate.delivery/mock.wav"}`, filepath.Base(r.URL.Path))
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	server := httptest.NewServer(New())
	defer server.Close()
	client := &http.Client{Transport: oldTransport}
	type reply struct {
		Code  int             `json:"code"`
		Data  json.RawMessage `json:"data"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	call := func(method, path, token string, body any, key string) (int, reply) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			encoded, _ := json.Marshal(body)
			reader = bytes.NewReader(encoded)
		}
		req, _ := http.NewRequest(method, server.URL+path, reader)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var result reply
		if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
			t.Fatalf("%s %s: invalid JSON (%d)", method, path, res.StatusCode)
		}
		return res.StatusCode, result
	}
	data := func(result reply) map[string]any {
		t.Helper()
		var v map[string]any
		if err := json.Unmarshal(result.Data, &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	expect := func(status int, result reply, expectedStatus int, code string) {
		t.Helper()
		if status != expectedStatus || result.Error.Code != code {
			t.Fatalf("status=%d error=%s, want %d %s", status, result.Error.Code, expectedStatus, code)
		}
	}
	_, createdKey := call("POST", "/api/client-api-keys", session.Token, map[string]string{"name": "HTTP test client"}, "")
	secret := data(createdKey)["api_key"].(string)
	keyID := data(createdKey)["key"].(map[string]any)["id"].(string)
	_, otherKey := call("POST", "/api/client-api-keys", otherSession.Token, map[string]string{"name": "other test client"}, "")
	otherSecret := data(otherKey)["api_key"].(string)
	_, listedKeys := call("GET", "/api/client-api-keys", session.Token, nil, "")
	if bytes.Contains(listedKeys.Data, []byte(secret)) || bytes.Contains(listedKeys.Data, []byte("digest")) {
		t.Fatal("key plaintext or digest exposed")
	}
	var stored model.ClientAPIKey
	db.First(&stored, "id = ?", keyID)
	if stored.Digest == secret || stored.Digest != service.ClientKeyDigest(secret) {
		t.Fatal("key not securely hashed")
	}
	status, result := call("POST", "/api/client-api-keys", secret, map[string]string{"name": "forbidden"}, "")
	expect(status, result, 401, "SESSION_REQUIRED")
	status, result = call("GET", "/api/v1/voices", "", nil, "")
	expect(status, result, 401, "UNAUTHORIZED")

	upload := func(audio []byte) (int, reply) {
		t.Helper()
		var b bytes.Buffer
		form := multipart.NewWriter(&b)
		_ = form.WriteField("name", "测试个人音色")
		_ = form.WriteField("reference_text", "测试录音原文")
		_ = form.WriteField("language", "Chinese")
		file, _ := form.CreateFormFile("file", "fake-name.mp3")
		_, _ = file.Write(audio)
		_ = form.Close()
		req, _ := http.NewRequest("POST", server.URL+"/api/v1/voices", &b)
		req.Header.Set("Content-Type", form.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+secret)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var reply reply
		_ = json.NewDecoder(res.Body).Decode(&reply)
		return res.StatusCode, reply
	}
	status, result = upload([]byte("not an audio file"))
	expect(status, result, 400, "INVALID_AUDIO")
	status, result = upload(wav[:44])
	expect(status, result, 400, "INVALID_AUDIO")
	status, result = upload(make([]byte, (15<<20)+1))
	expect(status, result, 413, "UPLOAD_TOO_LARGE")
	status, result = upload(wav)
	expect(status, result, 200, "")
	voiceID := data(result)["voice_id"].(string)
	voiceVersion := data(result)["version"].(string)
	if data(result)["mime_type"] != "audio/wav" || data(result)["duration_seconds"].(float64) != 1 {
		t.Fatal("actual file format and duration not detected")
	}
	voice, found, _ := repository.GetVoice(user.ID, voiceID)
	if !found {
		t.Fatal("voice not persisted")
	}
	privatePath := filepath.Join(filepath.Dir(config.Cfg.DatabaseDSN), "voices", voice.ReferenceFile)
	if _, err := os.Stat(privatePath); err != nil {
		t.Fatal(err)
	}
	resp, _ := client.Get(server.URL + "/api/media/references/" + voice.ReferenceFile)
	if resp.StatusCode != 404 {
		t.Fatal("private voice leaked through public references")
	}
	resp.Body.Close()
	_, result = call("GET", "/api/v1/voices", otherSecret, nil, "")
	if data(result)["total"] != float64(0) {
		t.Fatal("voice list crossed account")
	}
	status, result = call("PATCH", "/api/v1/voices/"+voiceID, otherSecret, map[string]string{"name": "x"}, "")
	expect(status, result, 404, "VOICE_NOT_FOUND")
	status, result = call("PATCH", "/api/v1/voices/"+voiceID, secret, map[string]string{"name": "重命名"}, "")
	expect(status, result, 200, "")
	if data(result)["version"] != voiceVersion {
		t.Fatal("rename invalidated audio content version")
	}
	payload := map[string]any{"voice_id": voiceID, "text": "用于接口验证的合成文字", "language": "Chinese"}
	status, result = call("POST", "/api/v1/speech/quote", otherSecret, payload, "")
	expect(status, result, 404, "VOICE_NOT_FOUND")
	status, result = call("POST", "/api/v1/speech/quote", secret, payload, "")
	expect(status, result, 200, "")
	if data(result)["credits"] != float64(100) || data(result)["sufficient_balance"] != true || creates != 0 {
		t.Fatal("quote charged/called upstream or priced incorrectly")
	}
	db.Model(&model.User{}).Where("id = ?", user.ID).Update("credits", 1)
	_, result = call("POST", "/api/v1/speech/quote", secret, payload, "")
	if data(result)["sufficient_balance"] != false {
		t.Fatal("quote did not check account balance")
	}
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "insufficient")
	expect(status, result, 402, "INSUFFICIENT_CREDITS")
	db.Model(&model.User{}).Where("id = ?", user.ID).Update("credits", 2000)
	pricing := settings.Private.Replicate.Pricing[spec.Model]
	pricing.Enabled = false
	settings.Private.Replicate.Pricing[spec.Model] = pricing
	_, _ = repository.SaveSettings(settings, "test")
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "disabled-model")
	expect(status, result, 503, "MODEL_DISABLED")
	pricing.Enabled = true
	settings.Private.Replicate.Pricing[spec.Model] = pricing
	settings.Private.Channels[0].Enabled = false
	_, _ = repository.SaveSettings(settings, "test")
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "missing-channel")
	expect(status, result, 503, "CHANNEL_NOT_CONFIGURED")
	settings.Private.Channels[0].Enabled = true
	_, _ = repository.SaveSettings(settings, "test")
	payload["speed"] = 1
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "unknown")
	expect(status, result, 400, "INVALID_REQUEST")
	delete(payload, "speed")
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "")
	expect(status, result, 400, "IDEMPOTENCY_KEY_REQUIRED")
	payload["expected_credits"] = 99
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "price-conflict")
	expect(status, result, 409, "QUOTE_CHANGED")
	delete(payload, "expected_credits")
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "http-first")
	expect(status, result, 202, "")
	taskID := data(result)["task_id"].(string)
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "http-first")
	expect(status, result, 200, "")
	if data(result)["task_id"] != taskID || creates != 1 {
		t.Fatal("retry duplicated model prediction")
	}
	// Concurrent client retries all recover the same persisted debit and provider ID.
	var retries sync.WaitGroup
	for i := 0; i < 4; i++ {
		retries.Add(1)
		go func() {
			defer retries.Done()
			encoded, _ := json.Marshal(payload)
			req, _ := http.NewRequest("POST", server.URL+"/api/v1/speech/tasks", bytes.NewReader(encoded))
			req.Header.Set("Authorization", "Bearer "+secret)
			req.Header.Set("Idempotency-Key", "http-first")
			res, err := client.Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			defer res.Body.Close()
			var response reply
			_ = json.NewDecoder(res.Body).Decode(&response)
			if res.StatusCode != 200 || response.Code != 0 {
				t.Error("concurrent retry rejected")
			}
		}()
	}
	retries.Wait()
	if creates != 1 {
		t.Fatal("concurrent retries duplicated prediction")
	}
	payload["text"] = "不同内容"
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "http-first")
	expect(status, result, 409, "IDEMPOTENCY_CONFLICT")
	payload["text"] = "用于接口验证的合成文字"
	status, result = call("GET", "/api/v1/speech/tasks/"+taskID, otherSecret, nil, "")
	expect(status, result, 404, "TASK_NOT_FOUND")
	status, result = call("GET", "/api/v1/speech/tasks/"+taskID+"/audio", otherSecret, nil, "")
	expect(status, result, 404, "TASK_NOT_FOUND")
	// A fresh router has no browser state; the DB and private files remain authoritative.
	server.Close()
	server = httptest.NewServer(New())
	defer server.Close()
	badOutput = true
	status, result = call("GET", "/api/v1/speech/tasks/"+taskID, secret, nil, "")
	expect(status, result, 200, "")
	if data(result)["status"] != "generated" {
		t.Fatal("invalid provider audio marked completed")
	}
	badOutput = false
	status, result = call("GET", "/api/v1/speech/tasks/"+taskID, secret, nil, "")
	expect(status, result, 200, "")
	if data(result)["status"] != "completed" || data(result)["audio"].(map[string]any)["duration_seconds"] != float64(1) {
		t.Fatal("audio not archived with verified duration")
	}
	if polls != 1 {
		t.Fatal("archive retry unnecessarily polled/created upstream")
	}
	download := func(token string, etag string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("GET", server.URL+"/api/v1/speech/tasks/"+taskID+"/audio", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("If-None-Match", etag)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	audio := download(secret, "")
	audioBytes, _ := io.ReadAll(audio.Body)
	audio.Body.Close()
	if audio.StatusCode != 200 || audio.Header.Get("Content-Type") != "audio/wav" || !bytes.Equal(audioBytes, wav) {
		t.Fatal("authenticated download wrong")
	}
	cached := download(secret, audio.Header.Get("ETag"))
	cached.Body.Close()
	if cached.StatusCode != 304 {
		t.Fatal("ETag cache validation failed")
	}
	failCreate = true
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "http-failure")
	expect(status, result, 202, "")
	if data(result)["refunded"] != true || data(result)["charged_credits"] != float64(0) {
		t.Fatal("failure not refunded")
	}
	_, _ = call("POST", "/api/v1/speech/tasks", secret, payload, "http-failure")
	failCreate = false
	uncertainCreate = true
	_, result = call("POST", "/api/v1/speech/tasks", secret, payload, "http-uncertain")
	uncertainID := data(result)["task_id"].(string)
	if data(result)["status"] != "uncertain" || data(result)["refunded"] != false {
		t.Fatal("ambiguous submission wrongly retried/refunded")
	}
	_, _ = call("POST", "/api/v1/speech/tasks", secret, payload, "http-uncertain")
	_, _ = call("GET", "/api/v1/speech/tasks/"+uncertainID, secret, nil, "")
	uncertainCreate = false
	if creates != 3 {
		t.Fatal("failure/uncertain retry created extra predictions")
	}
	expectedBalance, expectedDebits := 1800, int64(3)
	if shell, err := exec.LookPath("pwsh"); err == nil {
		t.Setenv("VOICE_API_BASE_URL", server.URL)
		t.Setenv("VOICE_LOGIN_TOKEN", session.Token)
		t.Setenv("VOICE_API_KEY", "")
		t.Setenv("VOICE_REFERENCE_TEXT", "测试录音原文")
		t.Setenv("VOICE_SYNTHESIS_TEXT", "用于接口验证的合成文字")
		t.Setenv("VOICE_IDEMPOTENCY_KEY", "powershell-mock-flow")
		t.Setenv("VOICE_ID", "")
		fixture := filepath.Join(t.TempDir(), "fixture.wav")
		if err := os.WriteFile(fixture, wav, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("VOICE_REFERENCE_FILE", fixture)
		script, _ := filepath.Abs("../scripts/wechat-voice-api.ps1")
		output := filepath.Join(t.TempDir(), "script-output.wav")
		command := exec.Command(shell, "-NoProfile", "-File", script, "-CreateKey", "-OutputPath", output)
		log, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("PowerShell workflow failed: %v: %s", err, log)
		}
		if bytes.Contains(log, []byte("icv_")) || bytes.Contains(log, []byte(session.Token)) {
			t.Fatal("PowerShell exposed credential")
		}
		downloaded, err := os.ReadFile(output)
		if err != nil || !bytes.Equal(downloaded, wav) {
			t.Fatal("PowerShell workflow download mismatch")
		}
		t.Log("PowerShell 7 script executed: create client Key, upload, list, quote, task, poll, download and SHA-256 validation")
		expectedBalance, expectedDebits = 1700, 4
	} else {
		t.Log("PowerShell 7 unavailable; script execution not verified on this host")
	}
	// The same business key in another account creates an independent task.
	firstSecret := secret
	secret = otherSecret
	_, otherVoiceReply := upload(wav)
	secret = firstSecret
	otherVoiceID := data(otherVoiceReply)["voice_id"].(string)
	db.Model(&model.User{}).Where("id = ?", other.ID).Update("credits", 200)
	otherPayload := map[string]any{"voice_id": otherVoiceID, "text": payload["text"], "language": "Chinese"}
	status, result = call("POST", "/api/v1/speech/tasks", otherSecret, otherPayload, "http-first")
	expect(status, result, 202, "")
	if data(result)["task_id"] == taskID {
		t.Fatal("idempotency keys not scoped by account")
	}
	db.Model(&model.User{}).Where("id = ?", other.ID).Update("status", model.UserStatusBan)
	status, result = call("GET", "/api/v1/voices", otherSecret, nil, "")
	expect(status, result, 401, "UNAUTHORIZED")
	db.Model(&model.User{}).Where("id = ?", other.ID).Update("status", model.UserStatusActive)
	_, _ = call("DELETE", "/api/v1/voices/"+voiceID, secret, nil, "")
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "after-disable")
	expect(status, result, 409, "VOICE_DISABLED")
	status, result = call("POST", "/api/v1/speech/tasks", secret, payload, "http-first")
	expect(status, result, 200, "")
	audio = download(secret, "")
	audio.Body.Close()
	if audio.StatusCode != 200 {
		t.Fatal("voice deletion blocked historical audio")
	}
	var current model.User
	db.First(&current, "id = ?", user.ID)
	var debitCount, refundCount int64
	db.Model(&model.CreditLog{}).Where("user_id = ? AND type = ?", user.ID, model.CreditLogTypeAIConsume).Count(&debitCount)
	db.Model(&model.CreditLog{}).Where("user_id = ? AND type = ?", user.ID, model.CreditLogTypeAIRefund).Count(&refundCount)
	if current.Credits != expectedBalance || debitCount != expectedDebits || refundCount != 1 {
		t.Fatalf("ledger mismatch: balance=%d debits=%d refunds=%d", current.Credits, debitCount, refundCount)
	}
	status, result = call("DELETE", "/api/client-api-keys/"+keyID, otherSession.Token, nil, "")
	expect(status, result, 404, "KEY_NOT_FOUND")
	status, result = call("DELETE", "/api/client-api-keys/"+keyID, session.Token, nil, "")
	expect(status, result, 200, "")
	status, result = call("GET", "/api/v1/voices", secret, nil, "")
	expect(status, result, 401, "UNAUTHORIZED")
	audio = download(secret, "")
	audio.Body.Close()
	if audio.StatusCode != 401 {
		t.Fatal("revoked key downloaded audio")
	}
	t.Log("real localhost HTTP: API keys, private uploads/FFprobe, ownership, quote, clone input, idempotency, archive retry, download/cache, debit/refund, ambiguity and revocation passed; upstream fully mocked")
}
