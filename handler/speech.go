package handler

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

type speechRequest struct {
	VoiceID         string `json:"voice_id"`
	Text            string `json:"text"`
	Language        string `json:"language"`
	ExpectedCredits *int   `json:"expected_credits,omitempty"`
}

func speechHash(value any) string {
	encoded, _ := json.Marshal(value)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func speechConfigVersion(spec service.ReplicateModel) string {
	return speechHash([]string{spec.Model, spec.Version, "voice_clone"})
}

func readSpeechRequest(r *http.Request) (speechRequest, error) {
	var input speechRequest
	if err := strictVoiceJSON(r, &input); err != nil {
		return input, err
	}
	input.Text = strings.TrimSpace(input.Text)
	if input.VoiceID == "" || input.Text == "" {
		return input, voiceError(400, "INVALID_REQUEST", "音色编号和合成文字不能为空")
	}
	// An omitted language follows the model's auto detection, consistently across retries.
	language, err := voiceLanguage(input.Language)
	input.Language = language
	return input, err
}

func speechVoice(userID, id string) (model.Voice, error) {
	voice, found, err := repository.GetVoice(userID, id)
	if err != nil {
		return voice, err
	}
	if !found {
		return voice, voiceError(404, "VOICE_NOT_FOUND", "音色不存在或无权访问")
	}
	if voice.DisabledAt != "" {
		return voice, voiceError(409, "VOICE_DISABLED", "音色已停用，不能创建新任务")
	}
	if voice.ReferenceFile == "" || filepath.Base(voice.ReferenceFile) != voice.ReferenceFile {
		return voice, voiceError(500, "REFERENCE_UNAVAILABLE", "音色文件不可用，请联系管理员")
	}
	file, err := os.Stat(filepath.Join(voiceDirectory(), voice.ReferenceFile))
	if err != nil || file.Size() != voice.Bytes {
		return voice, voiceError(503, "REFERENCE_UNAVAILABLE", "音色参考录音不可用，请联系管理员恢复存储")
	}
	return voice, nil
}

func speechQuote(user model.AuthUser, input speechRequest) (service.ReplicateQuote, service.ReplicateModel, error) {
	spec, err := service.FindReplicateModel("speech")
	if err != nil {
		return service.ReplicateQuote{}, spec, err
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return service.ReplicateQuote{}, spec, err
	}
	if pricing, exists := settings.Private.Replicate.Pricing[spec.Model]; exists {
		if !pricing.Enabled {
			return service.ReplicateQuote{}, spec, voiceError(503, "MODEL_DISABLED", "声音模型未启用，请联系管理员")
		}
		if pricing.Version != "" && pricing.Version != spec.Version {
			return service.ReplicateQuote{}, spec, voiceError(503, "MODEL_VERSION_MISMATCH", "模型固定版本与计费配置不一致，请联系管理员")
		}
	}
	if _, err := service.SelectReplicateChannel(spec.Model, user.Group); err != nil {
		return service.ReplicateQuote{}, spec, voiceError(503, "CHANNEL_NOT_CONFIGURED", "当前账号没有可用的声音克隆渠道，请管理员检查密钥、启用状态及分组权限")
	}
	quote, err := service.QuoteReplicate(user, spec, map[string]any{"text": input.Text})
	if err != nil {
		return quote, spec, err
	}
	if !quote.Available {
		return quote, spec, voiceError(503, "MODEL_NOT_CONFIGURED", "声音模型计费未配置，请联系管理员")
	}
	return quote, spec, nil
}

func SpeechQuote(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	input, err := readSpeechRequest(r)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if input.ExpectedCredits != nil {
		VoiceAPIFail(w, 400, "INVALID_REQUEST", "报价接口不接受 expected_credits")
		return
	}
	user, _ := service.UserFromContext(r.Context())
	voice, err := speechVoice(user.ID, input.VoiceID)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	quote, spec, err := speechQuote(user, input)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	OK(w, map[string]any{
		"voice_id": voice.ID, "voice_version": voice.Version, "model": spec.Model, "model_version": spec.Version, "config_version": speechConfigVersion(spec),
		"credits": quote.Credits, "balance": user.Credits, "sufficient_balance": user.Credits >= quote.Credits,
		"billing_mode": quote.BillingMode, "billable_units": quote.BillableUnits, "unit_credits": quote.UnitCredits, "minimum_credits": quote.MinimumCredits, "calculation": quote.Calculation,
	})
}

func SpeechCreateTask(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	input, err := readSpeechRequest(r)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if strings.TrimSpace(key) == "" {
		VoiceAPIFail(w, 400, "IDEMPOTENCY_KEY_REQUIRED", "请提供稳定且唯一的 Idempotency-Key")
		return
	}
	user, _ := service.UserFromContext(r.Context())
	id := "speech-" + speechHash([]string{user.ID, key})
	hash := speechHash([]string{input.VoiceID, input.Text, input.Language})
	existing, found, err := repository.GetReplicateTask(id)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if found {
		if existing.UserID != user.ID || existing.SpeechRequestHash != hash {
			VoiceAPIFail(w, 409, "IDEMPOTENCY_CONFLICT", "同一幂等键已用于不同的生成内容")
			return
		}
		OK(w, speechTaskView(existing))
		return
	}
	voice, err := speechVoice(user.ID, input.VoiceID)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	quote, _, err := speechQuote(user, input)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if input.ExpectedCredits != nil && *input.ExpectedCredits != quote.Credits {
		VoiceAPIFail(w, 409, "QUOTE_CHANGED", "报价已变化，请重新确认费用")
		return
	}
	if user.Credits < quote.Credits {
		VoiceAPIFail(w, 402, "INSUFFICIENT_CREDITS", "算力点不足")
		return
	}
	data, err := os.ReadFile(filepath.Join(voiceDirectory(), voice.ReferenceFile))
	if err != nil {
		VoiceAPIFail(w, 503, "REFERENCE_UNAVAILABLE", "参考录音读取失败")
		return
	}
	// Private recordings never receive a publicly readable file URL.
	modelInput := map[string]any{"mode": "voice_clone", "text": input.Text, "language": input.Language, "reference_text": voice.ReferenceText, "reference_audio": "data:" + voice.MimeType + ";base64," + base64.StdEncoding.EncodeToString(data)}
	task, err := submitReplicateTask(r, user, replicateRequest{ID: id, Operation: "speech", Input: modelInput, ExpectedCredits: &quote.Credits, Voice: &voice, SpeechRequestHash: hash, SpeechLanguage: input.Language})
	if err != nil {
		voiceFailError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusAccepted)
	OK(w, speechTaskView(task))
}

func speechTaskView(task model.ReplicateTask) map[string]any {
	actual := task.Credits
	if task.Refunded {
		actual = 0
	}
	result := map[string]any{
		"task_id": task.ID, "status": task.Status, "voice_id": task.SpeechVoiceID, "voice_version": task.SpeechVoiceVersion,
		"model": task.Model, "model_version": task.Version, "config_version": speechHash([]string{task.Model, task.Version, "voice_clone"}), "language": task.SpeechLanguage,
		"quoted_credits": task.Credits, "charged_credits": actual, "refunded": task.Refunded, "created_at": task.CreatedAt, "updated_at": task.UpdatedAt, "audio": nil, "error": nil,
	}
	if task.Status == "failed" || task.Status == "cancelled" {
		result["error"] = map[string]string{"code": "UPSTREAM_FAILED", "message": "模型生成失败或已取消，对应扣费已按账本返还"}
	} else if task.Status == "uncertain" {
		result["error"] = map[string]string{"code": "SUBMISSION_UNCERTAIN", "message": "上游提交结果未确认，请管理员核对；不会自动重新生成或退款"}
	} else if task.Error != "" {
		result["error"] = map[string]string{"code": "AUDIO_ARCHIVE_PENDING", "message": "音频归档暂未完成，后台及后续查询将继续恢复"}
	}
	if task.Status == "completed" && task.ResultFile != "" {
		result["audio"] = map[string]any{"url": "/api/v1/speech/tasks/" + task.ID + "/audio", "mime_type": task.MimeType, "format": strings.TrimPrefix(filepath.Ext(task.ResultFile), "."), "bytes": task.AudioBytes, "duration_seconds": task.AudioDuration, "sha256": task.AudioSHA256, "cache_key": task.AudioSHA256}
	}
	return result
}

func ownedSpeechTask(r *http.Request, id string) (model.ReplicateTask, error) {
	user, _ := service.UserFromContext(r.Context())
	task, found, err := repository.GetReplicateTask(id)
	if err != nil {
		return task, err
	}
	if !found || task.UserID != user.ID || task.SpeechVoiceID == "" {
		return task, voiceError(404, "TASK_NOT_FOUND", "语音任务不存在或无权访问")
	}
	return task, nil
}

func SpeechTask(w http.ResponseWriter, r *http.Request, id string) {
	w.Header().Set("Cache-Control", "private, no-store")
	task, err := ownedSpeechTask(r, id)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	task, err = refreshReplicateTask(r.Context(), task)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	OK(w, speechTaskView(task))
}

func SpeechAudio(w http.ResponseWriter, r *http.Request, id string) {
	task, err := ownedSpeechTask(r, id)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if task.Status != "completed" || task.ResultFile == "" {
		VoiceAPIFail(w, 409, "AUDIO_NOT_READY", "音频尚未完成，请查询任务状态")
		return
	}
	if filepath.Base(task.ResultFile) != task.ResultFile {
		VoiceAPIFail(w, 500, "AUDIO_UNAVAILABLE", "音频存储记录无效")
		return
	}
	file, err := os.Open(filepath.Join(referenceDataDir(), "replicate-results", task.ResultFile))
	if err != nil {
		VoiceAPIFail(w, 404, "AUDIO_UNAVAILABLE", "平台音频文件暂不可用，请联系管理员恢复存储")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		voiceFailError(w, err)
		return
	}
	w.Header().Set("Content-Type", task.MimeType)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", `"`+task.AudioSHA256+`"`)
	w.Header().Set("Content-Disposition", `attachment; filename="`+task.ID+filepath.Ext(task.ResultFile)+`"`)
	http.ServeContent(w, r, task.ResultFile, info.ModTime(), file)
}

func inspectSavedSpeech(ctx context.Context, task *model.ReplicateTask, path string) error {
	info, err := service.InspectVoiceAudio(ctx, path, false)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(hash, file)
	if err != nil {
		return err
	}
	task.MimeType, task.AudioDuration, task.AudioBytes, task.AudioSHA256 = info.MimeType, info.Duration, count, hex.EncodeToString(hash.Sum(nil))
	return nil
}

// Reuse the existing task poll/archive path. Never create or replay a paid prediction.
func recoverSpeechTasks(ctx context.Context) error {
	db, err := repository.DB()
	if err != nil {
		return err
	}
	var tasks []model.ReplicateTask
	err = db.Where("speech_voice_id <> ? AND status IN ?", "", []string{"creating", "running", "generated"}).Find(&tasks).Error
	if err != nil {
		return err
	}
	for _, task := range tasks {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if _, err := refreshReplicateTask(ctx, task); err != nil {
			log.Printf("speech recovery deferred for task %s", task.ID)
		}
	}
	return nil
}

var speechRecoveryOnce sync.Once

func StartSpeechTaskRecovery() {
	speechRecoveryOnce.Do(func() {
		go func() {
			for {
				if err := recoverSpeechTasks(context.Background()); err != nil {
					log.Print("speech recovery temporarily unavailable")
				}
				time.Sleep(time.Minute)
			}
		}()
	})
}
