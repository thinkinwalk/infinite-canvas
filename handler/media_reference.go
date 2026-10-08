package handler

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

const (
	referenceMediaMaxBytes    = 80 << 20
	referenceImageMaxBytes    = 30 << 20
	referenceVideoMaxBytes    = 50 << 20
	referenceAudioMaxBytes    = 15 << 20
	referenceImageAllowedText = "jpeg/png/webp/bmp/gif/heic/heif 图片"
	referenceVideoAllowedText = "mp4/mov 视频"
	referenceAudioAllowedText = "mp3/wav 音频"
	referenceMediaAllowedText = referenceImageAllowedText + "、" + referenceVideoAllowedText + "或" + referenceAudioAllowedText
)

type referenceMediaUploadResult struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	MimeType string `json:"mimeType"`
	Bytes    int64  `json:"bytes"`
}

func UploadReferenceMedia(w http.ResponseWriter, r *http.Request) {
	publicBaseURL := strings.TrimRight(strings.TrimSpace(config.Cfg.PublicBaseURL), "/")
	if publicBaseURL == "" {
		Fail(w, "未配置 PUBLIC_BASE_URL，无法向云模型提供参考素材")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, referenceMediaMaxBytes+1)
	if err := r.ParseMultipartForm(referenceMediaMaxBytes); err != nil {
		Fail(w, "参考素材过大或上传格式不正确")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请上传参考图片或视频")
		return
	}
	defer file.Close()

	mimeType, ext, ok := normalizeReferenceMediaType(header.Header.Get("Content-Type"), filepath.Ext(header.Filename))
	if !ok {
		Fail(w, "参考素材格式不支持，请使用 "+referenceMediaAllowedText)
		return
	}
	if err := os.MkdirAll(referenceMediaDir(), 0o755); err != nil {
		Fail(w, "参考素材保存失败")
		return
	}
	id := uuid.NewString() + ext
	targetPath := filepath.Join(referenceMediaDir(), id)
	target, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		Fail(w, "参考素材保存失败")
		return
	}
	bytes, copyErr := io.Copy(target, file)
	closeErr := target.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(targetPath)
		Fail(w, "参考素材保存失败")
		return
	}
	if bytes <= 0 {
		_ = os.Remove(targetPath)
		Fail(w, "参考素材为空")
		return
	}
	if limit := referenceMediaTypeMaxBytes(mimeType); limit > 0 && bytes > limit {
		_ = os.Remove(targetPath)
		Fail(w, referenceMediaSizeMessage(mimeType))
		return
	}
	user, authenticated := service.UserFromContext(r.Context())
	if !authenticated {
		_ = os.Remove(targetPath)
		Fail(w, "请登录后上传素材")
		return
	}
	duration := 0.0
	if r.FormValue("purpose") == "transcribe" {
		if !strings.HasPrefix(mimeType, "video/") && !strings.HasPrefix(mimeType, "audio/") {
			_ = os.Remove(targetPath)
			Fail(w, "语音识别需要上传视频或音频")
			return
		}
		audioID := uuid.NewString() + ".mp3"
		audioPath := filepath.Join(referenceMediaDir(), audioID)
		err := service.PrepareTranscriptionAudio(r.Context(), targetPath, audioPath)
		_ = os.Remove(targetPath)
		if err != nil {
			_ = os.Remove(audioPath)
			Fail(w, err.Error())
			return
		}
		info, err := os.Stat(audioPath)
		if err != nil || info.Size() <= 0 || info.Size() > referenceAudioMaxBytes {
			_ = os.Remove(audioPath)
			Fail(w, "识别音频为空或超过现有音频上传大小，请缩短素材后重试")
			return
		}
		id, targetPath, mimeType, bytes = audioID, audioPath, "audio/mpeg", info.Size()
	}
	if strings.HasPrefix(mimeType, "video/") || strings.HasPrefix(mimeType, "audio/") {
		duration = service.ProbeMediaDuration(r.Context(), targetPath)
	}
	if r.FormValue("purpose") == "transcribe" && duration <= 0 {
		_ = os.Remove(targetPath)
		Fail(w, "无法读取识别音频时长，请管理员检查 FFprobe 配置")
		return
	}
	if err := repository.SaveReferenceMediaOwner(model.ReferenceMediaOwner{ID: id, UserID: user.ID, MimeType: mimeType, Bytes: bytes, DurationSeconds: duration}); err != nil {
		_ = os.Remove(targetPath)
		Fail(w, "素材归属保存失败")
		return
	}
	OK(w, referenceMediaUploadResult{
		ID:       id,
		URL:      fmt.Sprintf("%s/api/media/references/%s", publicBaseURL, id),
		MimeType: mimeType,
		Bytes:    bytes,
	})
}

func ReferenceMedia(w http.ResponseWriter, r *http.Request, id string) {
	if id == "" || id != filepath.Base(id) || strings.Contains(id, "..") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(referenceMediaDir(), id)
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if mimeType := mimeTypeByReferenceMediaExt(filepath.Ext(id)); mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, r, id, info.ModTime(), file)
}

func referenceMediaDir() string {
	return filepath.Join(referenceDataDir(), "reference-media")
}

func referenceDataDir() string {
	driver := strings.ToLower(strings.TrimSpace(config.Cfg.StorageDriver))
	dsn := strings.TrimSpace(config.Cfg.DatabaseDSN)
	if (driver == "" || driver == "sqlite") && dsn != "" && dsn != ":memory:" && !strings.HasPrefix(dsn, "file:") {
		pathPart := dsn
		if index := strings.Index(dsn, "?"); index >= 0 {
			pathPart = dsn[:index]
		}
		if filepath.IsAbs(pathPart) {
			return filepath.Dir(pathPart)
		}
	}
	if _, err := os.Stat("/app/data"); err == nil {
		return "/app/data"
	}
	return "data"
}

func normalizeReferenceMediaType(contentType string, ext string) (string, string, bool) {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	ext = strings.ToLower(strings.TrimSpace(ext))
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = mimeTypeByReferenceMediaExt(ext)
	}
	if fixedExt := referenceMediaExtByMimeType(contentType); fixedExt != "" {
		return contentType, fixedExt, true
	}
	if mimeType := mimeTypeByReferenceMediaExt(ext); mimeType != "" {
		return mimeType, ext, true
	}
	return "", "", false
}

func referenceMediaExtByMimeType(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	case "image/gif":
		return ".gif"
	case "image/heic":
		return ".heic"
	case "image/heif":
		return ".heif"
	case "video/mp4":
		return ".mp4"
	case "video/quicktime", "video/mov":
		return ".mov"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/wav", "audio/x-wav", "audio/wave":
		return ".wav"
	default:
		return ""
	}
}

func mimeTypeByReferenceMediaExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".gif":
		return "image/gif"
	case ".heic":
		return "image/heic"
	case ".heif":
		return "image/heif"
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	default:
		return ""
	}
}

func referenceMediaTypeMaxBytes(mimeType string) int64 {
	if strings.HasPrefix(mimeType, "image/") {
		return referenceImageMaxBytes
	}
	if strings.HasPrefix(mimeType, "video/") {
		return referenceVideoMaxBytes
	}
	if strings.HasPrefix(mimeType, "audio/") {
		return referenceAudioMaxBytes
	}
	return referenceMediaMaxBytes
}

func referenceMediaSizeMessage(mimeType string) string {
	if strings.HasPrefix(mimeType, "image/") {
		return "参考图片超过大小限制，请使用 30MB 以内的图片"
	}
	if strings.HasPrefix(mimeType, "video/") {
		return "参考视频超过大小限制，请使用 50MB 以内的 mp4/mov 视频"
	}
	if strings.HasPrefix(mimeType, "audio/") {
		return "参考音频超过大小限制，请使用 15MB 以内的 mp3/wav 音频"
	}
	return "参考素材超过大小限制"
}
