package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

func voiceDirectory() string { return filepath.Join(referenceDataDir(), "voices") }

func voiceLanguage(language string) (string, error) {
	if language == "" {
		language = "auto"
	}
	spec, err := service.FindReplicateModel("speech")
	if err != nil {
		return "", err
	}
	for _, allowed := range spec.Enums["language"] {
		if language == allowed {
			return language, nil
		}
	}
	return "", voiceError(400, "INVALID_LANGUAGE", "语言不在当前 Qwen 渠道支持的选项中")
}

func Voices(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, _ := service.UserFromContext(r.Context())
	if r.Method == http.MethodGet {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		size, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
		if page < 1 {
			page = 1
		}
		if size <= 0 {
			size = 20
		}
		if size > model.MaxPageSize {
			size = model.MaxPageSize
		}
		items, total, err := repository.ListVoices(user.ID, page, size)
		if err != nil {
			voiceFailError(w, err)
			return
		}
		OK(w, map[string]any{"items": items, "total": total, "page": page, "page_size": size})
		return
	}
	// Reuse the existing audio upload size policy and multipart storage handling.
	r.Body = http.MaxBytesReader(w, r.Body, referenceMediaMaxBytes)
	if err := r.ParseMultipartForm(referenceAudioMaxBytes); err != nil {
		VoiceAPIFail(w, 413, "UPLOAD_TOO_LARGE", "上传过大或 multipart 格式不正确")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	for field := range r.MultipartForm.Value {
		if field != "name" && field != "reference_text" && field != "language" {
			VoiceAPIFail(w, 400, "INVALID_REQUEST", "包含不支持的音色字段")
			return
		}
		if len(r.MultipartForm.Value[field]) != 1 {
			VoiceAPIFail(w, 400, "INVALID_REQUEST", "音色字段不能重复")
			return
		}
	}
	if len(r.MultipartForm.File) != 1 || len(r.MultipartForm.File["file"]) != 1 {
		VoiceAPIFail(w, 400, "INVALID_REQUEST", "请上传一份 file 录音文件")
		return
	}
	name, text := strings.TrimSpace(r.FormValue("name")), strings.TrimSpace(r.FormValue("reference_text"))
	language, err := voiceLanguage(r.FormValue("language"))
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if name == "" || text == "" {
		VoiceAPIFail(w, 400, "INVALID_REQUEST", "名称和录音原文不能为空")
		return
	}
	source, _, err := r.FormFile("file")
	if err != nil {
		VoiceAPIFail(w, 400, "INVALID_AUDIO", "请上传录音文件")
		return
	}
	defer source.Close()
	if err := os.MkdirAll(voiceDirectory(), 0o700); err != nil {
		voiceFailError(w, err)
		return
	}
	target, err := os.CreateTemp(voiceDirectory(), "upload-*")
	if err != nil {
		voiceFailError(w, err)
		return
	}
	path := target.Name()
	defer os.Remove(path)
	hash := sha256.New()
	count, copyErr := io.Copy(io.MultiWriter(target, hash), io.LimitReader(source, referenceAudioMaxBytes+1))
	closeErr := target.Close()
	if count > referenceAudioMaxBytes {
		VoiceAPIFail(w, 413, "UPLOAD_TOO_LARGE", "录音超过 15 MiB，请缩短后重试")
		return
	}
	if copyErr != nil || closeErr != nil || count == 0 {
		VoiceAPIFail(w, 400, "INVALID_AUDIO", "录音为空或保存失败")
		return
	}
	info, err := service.InspectVoiceAudio(r.Context(), path, true)
	if err != nil {
		VoiceAPIFail(w, 400, "INVALID_AUDIO", err.Error())
		return
	}
	_, _ = fmt.Fprintf(hash, "\x00%s\x00%s", text, language)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	voice := model.Voice{ID: "voice-" + uuid.NewString(), UserID: user.ID, Name: name, ReferenceText: text, Language: language, Version: hex.EncodeToString(hash.Sum(nil)), ReferenceFile: uuid.NewString() + info.Extension, MimeType: info.MimeType, Bytes: count, DurationSeconds: info.Duration, CreatedAt: now, UpdatedAt: now}
	savedPath := filepath.Join(voiceDirectory(), voice.ReferenceFile)
	if err := os.Rename(path, savedPath); err != nil {
		voiceFailError(w, err)
		return
	}
	if err := repository.SaveVoice(voice); err != nil {
		_ = os.Remove(savedPath)
		voiceFailError(w, err)
		return
	}
	OK(w, voice)
}

func VoiceAction(w http.ResponseWriter, r *http.Request, id string) {
	user, _ := service.UserFromContext(r.Context())
	voice, found, err := repository.GetVoice(user.ID, id)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if !found {
		VoiceAPIFail(w, 404, "VOICE_NOT_FOUND", "音色不存在或无权访问")
		return
	}
	if r.Method == http.MethodDelete && voice.DisabledAt != "" {
		OK(w, true)
		return
	}
	if voice.DisabledAt != "" {
		VoiceAPIFail(w, 409, "VOICE_DISABLED", "音色已停用")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	changes := map[string]any{"updated_at": now}
	if r.Method == http.MethodDelete {
		changes["disabled_at"] = now
	} else {
		var input struct {
			Name string `json:"name"`
		}
		if err := strictVoiceJSON(r, &input); err != nil {
			voiceFailError(w, err)
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		if input.Name == "" {
			VoiceAPIFail(w, 400, "INVALID_REQUEST", "名称不能为空")
			return
		}
		changes["name"] = input.Name
	}
	updated, err := repository.UpdateVoice(user.ID, id, changes)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	if !updated {
		VoiceAPIFail(w, 409, "VOICE_DISABLED", "音色已停用")
		return
	}
	if r.Method == http.MethodDelete {
		OK(w, true)
		return
	}
	voice, _, err = repository.GetVoice(user.ID, id)
	if err != nil {
		voiceFailError(w, err)
		return
	}
	OK(w, voice)
}
