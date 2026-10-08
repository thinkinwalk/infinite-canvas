package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// ModelQuote estimates one call without creating a prediction or deducting credits.
func ModelQuote(w http.ResponseWriter, r *http.Request) {
	user, _ := service.UserFromContext(r.Context())
	var input struct {
		Model       string `json:"model"`
		Resolution  string `json:"resolution"`
		Seconds     string `json:"seconds"`
		Interpolate bool   `json:"interpolate"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.Model == "" {
		Fail(w, "请选择模型")
		return
	}
	if input.Model == "wan-video/wan-2.2-i2v-fast" {
		spec, err := service.FindReplicateModel("image-to-video")
		if err != nil {
			FailError(w, err)
			return
		}
		frames := 81
		if input.Seconds == "7.5" {
			frames = 121
		}
		quote, err := service.QuoteReplicate(user, spec, map[string]any{"resolution": input.Resolution + "p", "num_frames": frames, "interpolate_output": input.Interpolate})
		if err != nil {
			FailError(w, err)
			return
		}
		if !quote.Available {
			Fail(w, quote.Reason)
			return
		}
		OK(w, map[string]any{"credits": quote.Credits, "calculation": quote.Calculation})
		return
	}
	if input.Model == "minimax/hailuo-2.3" {
		spec, err := service.FindReplicateModel("hailuo-video")
		if err != nil {
			FailError(w, err)
			return
		}
		seconds, err := strconv.Atoi(input.Seconds)
		if err != nil {
			Fail(w, "请选择 Hailuo 视频时长")
			return
		}
		fields := map[string]any{"prompt": "报价", "resolution": input.Resolution + "p", "duration": float64(seconds)}
		if err := service.ValidateReplicateQuoteInput(user.ID, spec, fields); err != nil {
			Fail(w, err.Error())
			return
		}
		quote, err := service.QuoteReplicate(user, spec, fields)
		if err != nil {
			FailError(w, err)
			return
		}
		if !quote.Available {
			Fail(w, quote.Reason)
			return
		}
		OK(w, map[string]any{"credits": quote.Credits, "calculation": quote.Calculation})
		return
	}
	if _, err := service.SelectModelChannelForGroup(input.Model, user.Group); err != nil {
		FailError(w, err)
		return
	}
	base, err := service.ModelCost(input.Model)
	if err != nil {
		FailError(w, err)
		return
	}
	ratio, err := service.UserGroupRatio(user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	credits := int(math.Ceil(float64(base) * ratio))
	OK(w, map[string]any{"credits": credits, "calculation": fmt.Sprintf("后台配置每次 %d 算力点，已计入用户分组倍率", credits)})
}

func videoChannelPath(channel model.ModelChannel, name, path string) string {
	if service.VideoProfile(channel, name).Interface == "ark" {
		return resolveAIProxyPath("/api/plan/v3", path)
	}
	return path
}

func validateVideoProfileRequest(profile model.VideoModelProfile, body []byte, contentType string) error {
	counts := map[string]int{"image": 0, "video": 0, "audio": 0}
	resolution, seconds := "", ""
	mode, first, last := "reference", false, false
	if profile.Interface == "unavailable" {
		return fmt.Errorf("%s", profile.Description)
	}
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return err
		}
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		for {
			part, err := reader.NextPart()
			if err != nil {
				break
			}
			if part.FormName() == "mode" {
				value, _ := io.ReadAll(part)
				mode = string(value)
			}
			if part.FormName() == profile.FirstFrameField && profile.FirstFrameField != "" {
				first = true
				counts["image"]++
			}
			if part.FormName() == profile.LastFrameField && profile.LastFrameField != "" {
				last = true
				counts["image"]++
			}
			if part.FormName() == "input_reference[]" || part.FormName() == "image_reference" {
				counts["image"]++
			}
			part.Close()
		}
		if profile.Interface == "ark" || profile.Interface == "relay" {
			return fmt.Errorf("该视频渠道需要 JSON 格式，请刷新页面后重试")
		}
	} else {
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			return fmt.Errorf("视频参数格式不正确")
		}
		if value := jsonStringValue(payload["input_mode"]); value != "" {
			mode = value
		}
		first = profile.FirstFrameField != "" && jsonURLValue(payload[profile.FirstFrameField]) != ""
		last = profile.LastFrameField != "" && jsonURLValue(payload[profile.LastFrameField]) != ""
		counts["image"] = len(jsonURLValues(payload["reference_image_urls"]))
		for _, key := range []string{profile.FirstFrameField, profile.LastFrameField} {
			if key != "" && key != "image_url" && jsonURLValue(payload[key]) != "" {
				counts["image"]++
			}
		}
		for _, key := range []string{"first_frame", "last_frame", "last_image", "first_frame_image", "last_frame_url"} {
			if payload[key] != nil && key != profile.FirstFrameField && key != profile.LastFrameField {
				return fmt.Errorf("当前渠道未配置首尾帧字段 %s", key)
			}
		}
		if jsonURLValue(payload["image_url"]) != "" {
			counts["image"]++
		}
		counts["video"] = len(jsonURLValues(payload["reference_videos"]))
		if jsonURLValue(payload["reference_video"]) != "" {
			counts["video"]++
		}
		counts["audio"] = len(jsonURLValues(payload["audio_urls"]))
		if jsonURLValue(payload["audio_url"]) != "" {
			counts["audio"]++
		}
		// Reject aliases we do not translate instead of forwarding unchecked inputs.
		for _, key := range []string{"video_url", "video_urls", "videos", "input_video", "audios", "input_audio", "images", "image_urls", "reference_images", "input_reference"} {
			if payload[key] != nil {
				return fmt.Errorf("请使用标准参考素材字段 image_url / reference_image_urls / reference_videos / audio_urls")
			}
		}
		if content, ok := payload["content"].([]any); ok {
			for _, value := range content {
				item, _ := value.(map[string]any)
				switch jsonStringValue(item["type"]) {
				case "image_url":
					counts["image"]++
					role := jsonStringValue(item["role"])
					if role == "first_frame" || role == "last_frame" {
						if mode == "reference" {
							return fmt.Errorf("首尾帧角色需要选择首尾帧模式")
						}
						if role == "first_frame" {
							if first {
								return fmt.Errorf("首帧重复")
							}
							first = jsonURLValue(item["image_url"]) != ""
						}
						if role == "last_frame" {
							if last {
								return fmt.Errorf("尾帧重复")
							}
							last = jsonURLValue(item["image_url"]) != ""
						}
					} else if mode != "reference" {
						return fmt.Errorf("首尾帧模式不能混入普通参考图片")
					}
				case "video_url":
					counts["video"]++
				case "audio_url":
					counts["audio"]++
				case "text":
				default:
					return fmt.Errorf("视频接口不支持该素材类型")
				}
			}
		}
		resolution = strings.TrimSuffix(jsonStringValue(payload["resolution"]), "p")
		seconds = fmt.Sprint(payload["seconds"])
		if payload["duration"] != nil {
			seconds = fmt.Sprint(payload["duration"])
		}
	}
	allowed := false
	modes := profile.InputModes
	if modes == nil {
		modes = []string{"reference"}
	}
	for _, candidate := range modes {
		if candidate == mode {
			allowed = true
		}
	}
	if !allowed {
		return fmt.Errorf("当前模型渠道不支持所选输入模式")
	}
	if mode != "reference" {
		if counts["video"]+counts["audio"] > 0 || counts["image"] > 2 || counts["image"] != boolCount(first)+boolCount(last) {
			return fmt.Errorf("首尾帧模式不能混入普通参考素材")
		}
		if last && !first || profile.FirstFrameRequired && !first {
			return fmt.Errorf("首帧图片必填，尾帧不能单独使用")
		}
		if mode == "first_frame_only" && last {
			return fmt.Errorf("单首帧模式不支持尾帧")
		}
		if mode == "first_last" && (!profile.LastFrameOptional && !last || profile.LastFrameField == "") {
			return fmt.Errorf("请配置并上传尾帧图片")
		}
	} else if last || first && profile.FirstFrameField != "image_url" {
		return fmt.Errorf("参考模式不能传入首尾帧字段")
	}
	imageLimit := profile.MaxImages
	if mode == "first_last" {
		imageLimit = 2
	} else if mode == "first_frame_only" {
		imageLimit = 1
	}
	for kind, limit := range map[string]int{"image": imageLimit, "video": profile.MaxVideos, "audio": profile.MaxAudios} {
		if counts[kind] > limit {
			return fmt.Errorf("当前模型渠道不支持这些参考素材或已超过素材数量，请刷新模型配置后重试")
		}
	}
	if counts["video"]+counts["audio"] > 0 && profile.Interface != "ark" && profile.Interface != "relay" {
		return fmt.Errorf("当前视频接口未接通视频或音频参考")
	}
	for _, item := range []struct {
		value   string
		options []string
	}{{resolution, profile.Resolutions}, {seconds, profile.Seconds}} {
		value, options := item.value, item.options
		if value == "" || value == "<nil>" || len(options) == 0 {
			continue
		}
		found := false
		for _, option := range options {
			if value == option {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("视频规格不受当前模型支持，请刷新配置后重新选择")
		}
	}
	return nil
}

func checkExpectedVideoCredits(r *http.Request, credits int) error {
	value := r.Header.Get("X-Expected-Credits")
	if value == "" {
		return nil
	}
	expected, err := strconv.Atoi(value)
	if err != nil || expected != credits {
		return fmt.Errorf("模型价格已变化，请刷新报价并重新确认；本次未扣费")
	}
	return nil
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}

// input_mode belongs to our gateway and must never reach an upstream endpoint.
func stripVideoInputMode(body []byte, contentType string) []byte {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return body
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return body
	}
	delete(payload, "input_mode")
	result, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return result
}
