package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

// Convert our canonical references to H3 v2; the OpenAI compatibility API ignores video fields.
func sparkCineH3Body(body []byte, userID string) ([]byte, error) {
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return nil, fmt.Errorf("H3 视频参数格式不正确")
	}
	resolution := strings.ToUpper(strings.TrimSuffix(jsonStringValue(payload["resolution"]), "p"))
	ratio := jsonStringValue(payload["aspect_ratio"])
	if ratio == "" {
		ratio = jsonStringValue(payload["ratio"])
	}
	duration := payload["seconds"]
	if payload["duration"] != nil {
		duration = payload["duration"]
	}
	seconds, err := strconv.ParseFloat(fmt.Sprint(duration), 64)
	if err != nil {
		return nil, fmt.Errorf("请选择 H3 输出秒数")
	}
	if err := service.SparkCineH3SpecError(resolution, ratio, seconds); err != nil {
		return nil, err
	}
	content := []any{}
	hasVideo := false
	if prompt := strings.TrimSpace(jsonStringValue(payload["prompt"])); prompt != "" {
		content = append(content, map[string]any{"type": "text", "text": prompt})
	}
	add := func(kind, address string) error {
		if err := validateSparkCineReference(kind, address, userID); err != nil {
			return err
		}
		item := map[string]any{"type": kind + "_url"}
		if kind == "video" {
			item["url"], item["role"] = address, "reference_video"
			hasVideo = true
		} else {
			item[kind+"_url"] = map[string]string{"url": address}
			if kind == "image" {
				item["role"] = "reference_image"
			}
		}
		content = append(content, item)
		return nil
	}
	for _, ref := range []struct{ kind, single, multiple string }{
		{"image", "image_url", "reference_image_urls"},
		{"video", "reference_video", "reference_videos"},
		{"audio", "audio_url", "audio_urls"},
	} {
		addresses := jsonURLValues(payload[ref.multiple])
		if address := jsonURLValue(payload[ref.single]); address != "" {
			addresses = append([]string{address}, addresses...)
		}
		for _, address := range addresses {
			if err := add(ref.kind, address); err != nil {
				return nil, err
			}
		}
	}
	if items, ok := payload["content"].([]any); ok {
		for _, value := range items {
			item, _ := value.(map[string]any)
			kind := strings.TrimSuffix(jsonStringValue(item["type"]), "_url")
			if kind == "text" {
				content = append(content, map[string]any{"type": "text", "text": jsonStringValue(item["text"])})
				continue
			}
			address := jsonURLValue(item[kind+"_url"])
			if kind == "video" && address == "" {
				address = jsonURLValue(item["url"])
			}
			if err := add(kind, address); err != nil {
				return nil, err
			}
		}
	}
	if len(content) == 0 {
		return nil, fmt.Errorf("请填写提示词或添加参考素材")
	}
	mentions := []string{}
	// H3 uses <Picture N>, not <Image N>, for image references.
	for kind, count := range map[string]int{"Picture": 9, "Video": 1, "Audio": 3} {
		label := map[string]string{"Picture": "图片", "Video": "视频", "Audio": "音频"}[kind]
		for i := 1; i <= count; i++ {
			index := i
			if kind == "Audio" && hasVideo {
				index++ // The reference video's soundtrack occupies Audio 1.
			}
			token := fmt.Sprintf("<%s %d>", kind, index)
			mentions = append(mentions, fmt.Sprintf("@%s%d", label, i), token, fmt.Sprintf("%s%d", label, i), token)
		}
	}
	replacer := strings.NewReplacer(mentions...)
	for _, value := range content {
		item := value.(map[string]any)
		if text, ok := item["text"].(string); ok {
			item["text"] = replacer.Replace(text)
		}
	}
	return json.Marshal(map[string]any{
		"model": "h3-video", "content": content, "resolution": resolution + "P",
		"duration": int(seconds), "ratio": ratio,
		"extra": map[string]string{"prompt_expansion_mode": "disabled"},
	})
}

func validateSparkCineReference(kind, address, userID string) error {
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return fmt.Errorf("H3 参考素材需要有效的 HTTPS 地址")
	}
	base := strings.TrimRight(config.Cfg.PublicBaseURL, "/") + "/api/media/references/"
	owned := config.Cfg.PublicBaseURL != "" && strings.HasPrefix(address, base)
	if !owned {
		if kind == "video" {
			return fmt.Errorf("H3 参考视频请先上传到平台，以核对 2–15 秒时长")
		}
		return nil
	}
	id := strings.TrimPrefix(address, base)
	owner, found, err := repository.GetReferenceMediaOwner(id)
	if err != nil || !found || owner.UserID != userID || !strings.HasPrefix(owner.MimeType, kind+"/") {
		return fmt.Errorf("H3 参考素材不存在或无权访问，请重新上传")
	}
	if kind == "video" {
		if owner.DurationSeconds < 2 || owner.DurationSeconds > 15 || owner.Bytes > 64<<20 {
			return fmt.Errorf("H3 参考视频需为 2–15 秒且不超过 64MB；本次未扣费")
		}
	} else if owner.Bytes > 24<<20 {
		return fmt.Errorf("H3 图片或音频参考不能超过 24MB；本次未扣费")
	}
	if kind == "image" && owner.MimeType != "image/png" && owner.MimeType != "image/jpeg" && owner.MimeType != "image/webp" {
		return fmt.Errorf("H3 参考图片仅支持 PNG / JPEG / WebP")
	}
	if kind == "image" {
		file, err := os.Open(filepath.Join(referenceMediaDir(), filepath.Base(id)))
		if err != nil {
			return fmt.Errorf("H3 参考图片无法读取，请重新上传")
		}
		size, _, err := image.DecodeConfig(file)
		file.Close()
		if err != nil || size.Width < 64 || size.Height < 64 || int64(size.Width)*int64(size.Height) > 12_000_000 {
			return fmt.Errorf("H3 参考图片宽高至少 64 像素且不超过 1200 万像素")
		}
	}
	return nil
}

func querySparkCineH3(ctx context.Context, channel model.ModelChannel, id string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, service.SparkCineH3URL(channel, "/v2/query/video_generation/"+url.PathEscape(id)), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	response, err := aiHTTPClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("H3 任务查询失败，请稍后恢复查询")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("H3 任务响应读取失败")
	}
	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("%s", aiUpstreamStatusMessage(response.StatusCode, body))
	}
	var result struct {
		Task struct {
			ID      string `json:"id"`
			Status  string `json:"status"`
			Content struct {
				URL string `json:"url"`
			} `json:"content"`
			Error json.RawMessage `json:"error"`
		} `json:"task"`
	}
	if json.Unmarshal(body, &result) != nil || result.Task.ID != id {
		return nil, fmt.Errorf("H3 返回的任务信息不完整，请稍后恢复查询")
	}
	task := result.Task
	switch task.Status {
	case "queued", "running", "succeeded", "failed", "cancelled":
	default:
		return nil, fmt.Errorf("H3 返回未知任务状态，请稍后恢复查询")
	}
	return json.Marshal(map[string]any{"id": id, "status": task.Status, "video_url": task.Content.URL, "error": task.Error})
}

func copySparkCineH3Video(w http.ResponseWriter, r *http.Request, channel model.ModelChannel, task model.VideoTask, content bool) {
	body, err := querySparkCineH3(r.Context(), channel, task.ID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	task.OutputURL = videoResponseOutputURL(body)
	status := videoResponseString(body, "status")
	if err := service.UpdateVideoTaskStatus(task, status); err != nil {
		FailError(w, err)
		return
	}
	if !content {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
		return
	}
	if status != "succeeded" || task.OutputURL == "" {
		Fail(w, "H3 视频尚未完成或下载地址暂不可用，请恢复查询")
		return
	}
	// Always refresh the signed URL, then download through the existing public-only transport.
	request, err := sparkCineDownloadRequest(r.Context(), task.OutputURL)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	response, err := creditLogVideoClient.Do(request)
	if err != nil {
		Fail(w, "H3 视频下载失败，可恢复查询后重试，不会重新生成")
		return
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	head, _ := reader.Peek(512)
	mediaType := http.DetectContentType(head)
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(mediaType, "video/") {
		Fail(w, "H3 暂未返回有效视频，可稍后恢复下载")
		return
	}
	w.Header().Set("Content-Type", mediaType)
	_, _ = io.Copy(w, reader)
}

func sparkCineDownloadRequest(ctx context.Context, address string) (*http.Request, error) {
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return nil, fmt.Errorf("H3 返回的视频地址无效")
	}
	return http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
}
