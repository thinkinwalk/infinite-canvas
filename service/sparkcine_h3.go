package service

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
)

const SparkCineH3Interface = "sparkcine_h3"

// Match the verified provider and full model ID; unrelated H3 aliases keep their adapters.
func IsSparkCineH3(channel model.ModelChannel, name string) bool {
	if channel.ManagedAdapter != "" {
		return channel.ManagedAdapter == "video.sparkcine_h3"
	}
	if name != "h3-video" {
		return false
	}
	base, err := url.Parse(channel.BaseURL)
	return channel.VideoModels[name].Interface == SparkCineH3Interface ||
		err == nil && strings.EqualFold(base.Hostname(), "hi.hi.run")
}

func sparkCineH3Profile(profile model.VideoModelProfile) model.VideoModelProfile {
	if profile.Interface != SparkCineH3Interface {
		profile.MaxImages, profile.MaxAudios, profile.MaxVideos = 9, 3, 1
		profile.InputModes = []string{"reference"}
		profile.FirstFrameField, profile.LastFrameField = "", ""
		profile.FirstFrameRequired = false
		profile.Resolutions = nil
		profile.Seconds = nil
	}
	profile.Interface = SparkCineH3Interface
	profile.GenerateAudio = false
	if profile.DisplayName == "" {
		profile.DisplayName = "MiniMax H3 Video"
	}
	if profile.Description == "" {
		profile.Description = "支持图片、音频及一段 2–15 秒视频参考；内容替换效果待实测确认。"
	}
	profile.MaxImages = max(0, min(9, profile.MaxImages))
	profile.MaxVideos = max(0, min(1, profile.MaxVideos))
	profile.MaxAudios = max(0, min(3, profile.MaxAudios))
	profile.ReferenceVideoMinSeconds, profile.ReferenceVideoMaxSeconds = 2, 15
	if profile.Resolutions == nil {
		profile.Resolutions = []string{"480", "720", "768", "960", "1080"}
	}
	if profile.Seconds == nil {
		profile.Seconds = []string{}
		for seconds := 4; seconds <= 30; seconds++ {
			profile.Seconds = append(profile.Seconds, fmt.Sprint(seconds))
		}
	}
	if profile.ContentReplacement == nil {
		enabled := true
		profile.ContentReplacement = &enabled
	}
	return normalizeVideoInputProfile(profile)
}

func SparkCineH3URL(channel model.ModelChannel, path string) string {
	base, err := url.Parse(channel.BaseURL)
	if err != nil {
		return ""
	}
	prefix := strings.TrimRight(base.Path, "/")
	for _, suffix := range []string{"/api/openai/v1", "/api/h3", "/v1"} {
		if strings.HasSuffix(prefix, suffix) {
			prefix = strings.TrimSuffix(prefix, suffix)
			break
		}
	}
	base.Path, base.RawPath = prefix+"/api/h3"+path, ""
	base.RawQuery, base.Fragment = "", ""
	return base.String()
}

func SparkCineH3SpecError(resolution, ratio string, seconds float64) error {
	resolution = strings.TrimRight(strings.ToUpper(resolution), "P")
	switch resolution {
	case "480", "720", "768", "960", "1080":
	default:
		return fmt.Errorf("H3 支持 480 / 720 / 768 / 960 / 1080P")
	}
	switch ratio {
	case "16:9", "9:16", "21:9", "4:3", "1:1", "3:4":
	default:
		return fmt.Errorf("H3 不支持当前画幅，请使用 16:9 / 9:16 / 21:9 / 4:3 / 1:1 / 3:4")
	}
	limit := 30.0
	if resolution == "960" || resolution == "1080" {
		limit = 15
	} else if resolution == "768" && ratio == "21:9" {
		limit = 20
	}
	if seconds < 4 || seconds > limit || seconds != float64(int(seconds)) {
		return fmt.Errorf("H3 当前画幅和清晰度支持 4–%g 秒整数时长", limit)
	}
	if resolution == "720" && ratio != "16:9" && ratio != "9:16" {
		return fmt.Errorf("H3 的 720P 仅支持 16:9 / 9:16")
	}
	return nil
}

func SparkCineH3AspectRatios(resolution string) []string {
	if strings.TrimRight(strings.ToUpper(resolution), "P") == "720" {
		return []string{"16:9", "9:16"}
	}
	return []string{"16:9", "9:16", "21:9", "4:3", "1:1", "3:4"}
}
