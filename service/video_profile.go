package service

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
)

func VideoProfile(channel model.ModelChannel, name string) model.VideoModelProfile {
	if profile, ok := channel.VideoModels[name]; ok && profile.Interface != "" {
		return normalizeVideoInputProfile(profile)
	}
	profile := model.VideoModelProfile{DisplayName: name, Interface: "openai", MaxImages: 7, Resolutions: []string{"480", "720", "1080"}}
	if isArkAgentPlanChannel(channel) {
		profile.Interface, profile.MaxVideos, profile.MaxAudios = "ark", 3, 3
		profile.GenerateAudio = true
	}
	if strings.Contains(strings.ToLower(name), "seedance") || strings.Contains(strings.ToLower(name), "seedace") {
		if profile.Interface != "ark" {
			profile.Interface = "relay"
			profile.Resolutions = []string{"480", "720"}
		}
		for seconds := 4; seconds <= 15; seconds++ {
			profile.Seconds = append(profile.Seconds, fmt.Sprint(seconds))
		}
	}
	profile.Description = "根据文字和参考图片制作视频，适合商品展示、场景和镜头创作。当前渠道支持图片参考。"
	if profile.Interface == "ark" {
		profile.Description = "支持图片、视频、音频组合参考，用于指定外观、动作、镜头与声音。"
	}
	return normalizeVideoInputProfile(profile)
}

// Only declared input modes are exposed; unconfigured channels retain reference input.
func normalizeVideoInputProfile(profile model.VideoModelProfile) model.VideoModelProfile {
	if profile.InputModes == nil {
		profile.InputModes = []string{"reference"}
	}
	field := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	reserved := map[string]bool{"model": true, "prompt": true, "seconds": true, "duration": true, "resolution": true, "content": true, "input_mode": true, "mode": true, "reference_image_urls": true, "reference_videos": true, "audio_urls": true}
	valid := func(value string) bool { return field.MatchString(value) && !reserved[value] }
	modes := []string{}
	for _, mode := range profile.InputModes {
		if mode == "reference" || mode == "first_frame_only" && valid(profile.FirstFrameField) || mode == "first_last" && valid(profile.FirstFrameField) && valid(profile.LastFrameField) && profile.FirstFrameField != profile.LastFrameField {
			found := false
			for _, existing := range modes {
				if existing == mode {
					found = true
				}
			}
			if !found {
				modes = append(modes, mode)
			}
		}
	}
	profile.InputModes = modes
	if len(modes) == 0 {
		profile.Interface = "unavailable"
		profile.Description = "当前渠道未配置有效的输入模式或首尾帧字段，请管理员检查配置。"
	}
	return profile
}

// A weighted route may only advertise capabilities shared by every candidate.
func publicVideoProfiles(channels []model.ModelChannel) map[string]model.VideoModelProfile {
	profiles := map[string]model.VideoModelProfile{}
	for _, name := range enabledChannelModels(channels) {
		if !isVideoModelName(name) {
			continue
		}
		candidates := modelChannelsForModel(channels, name)
		if len(candidates) == 0 {
			continue
		}
		profile := VideoProfile(candidates[0], name)
		for _, channel := range candidates[1:] {
			other := VideoProfile(channel, name)
			if profile.Interface != other.Interface {
				profile.Interface = "unavailable"
				profile.Description = "该模型的多个渠道视频接口不同，请管理员统一接口配置后使用。"
			}
			profile.MaxImages = min(profile.MaxImages, other.MaxImages)
			profile.MaxVideos = min(profile.MaxVideos, other.MaxVideos)
			profile.MaxAudios = min(profile.MaxAudios, other.MaxAudios)
			profile.GenerateAudio = profile.GenerateAudio && other.GenerateAudio
			profile.InputModes = sharedVideoOptions(profile.InputModes, other.InputModes)
			if profile.FirstFrameField != other.FirstFrameField || profile.LastFrameField != other.LastFrameField {
				modes := []string{}
				for _, mode := range profile.InputModes {
					if mode == "reference" {
						modes = append(modes, mode)
					}
				}
				profile.InputModes = modes
				profile.FirstFrameField, profile.LastFrameField = "", ""
			}
			profile.FirstFrameRequired = profile.FirstFrameRequired || other.FirstFrameRequired
			profile.LastFrameOptional = profile.LastFrameOptional && other.LastFrameOptional
			profile.Resolutions = sharedVideoOptions(profile.Resolutions, other.Resolutions)
			profile.Seconds = sharedVideoOptions(profile.Seconds, other.Seconds)
		}
		if len(profile.Resolutions) > 0 && profile.Resolutions[0] == "unavailable" || len(profile.Seconds) > 0 && profile.Seconds[0] == "unavailable" {
			profile.Interface = "unavailable"
			profile.Description = "该模型的多个渠道没有共同的视频规格，请管理员统一配置后使用。"
		}
		profiles[name] = normalizeVideoInputProfile(profile)
	}
	return profiles
}

func sharedVideoOptions(left, right []string) []string {
	if len(left) == 0 {
		return right
	}
	if len(right) == 0 {
		return left
	}
	result := []string{}
	for _, value := range left {
		for _, candidate := range right {
			if value == candidate {
				result = append(result, value)
				break
			}
		}
	}
	// No intersection must not become an unrestricted list on the frontend.
	if len(result) == 0 {
		return []string{"unavailable"}
	}
	return result
}
