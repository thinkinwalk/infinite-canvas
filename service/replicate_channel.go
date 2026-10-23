package service

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const ReplicateBaseURL = "https://api.replicate.com/v1"
const WaveSpeedBaseURL = "https://api.wavespeed.ai/api/v3"

func SupportedReplicateModels() []model.PublicChannelModel {
	items := []model.PublicChannelModel{}
	for _, spec := range ReplicateModels() {
		index := -1
		for i := range items {
			if items[i].Model == spec.Model {
				index = i
				break
			}
		}
		if index >= 0 {
			items[index].Operations = append(items[index].Operations, spec.Operation)
			continue
		}
		capability := "video-processing"
		switch spec.Operation {
		case "image-to-video", "text-to-video", "hailuo-video", "head-swap":
			capability = "video"
		case "speech":
			capability = "audio"
		case "transcribe":
			capability = "transcription"
		}
		items = append(items, model.PublicChannelModel{Version: spec.Version, Model: spec.Model, Label: spec.Label, Protocol: spec.ProviderName(), Capabilities: []string{capability}, Operations: []string{spec.Operation}})
	}
	return append(items,
		model.PublicChannelModel{Model: "men1scus/birefnet", Label: "图像抠图", Protocol: "replicate", Capabilities: []string{"image-processing"}, Operations: []string{"cutout-replicate"}},
		model.PublicChannelModel{Model: "nightmareai/real-esrgan", Label: "图像超分", Protocol: "replicate", Capabilities: []string{"image-processing"}, Operations: []string{"upscale-replicate"}},
	)
}

// Move the existing shared credential once; its ID also identifies pre-channel tasks.
func initializeReplicateChannels(setting *model.PrivateSetting) {
	if setting.Replicate.ChannelsInitialized {
		setting.Replicate.APIKey = ""
		setting.Replicate.ClearAPIKey = false
		return
	}
	key := strings.TrimSpace(setting.Replicate.APIKey)
	environment := key == "" && strings.TrimSpace(os.Getenv("REPLICATE_API_TOKEN")) != ""
	if key != "" || environment {
		id := max(1, setting.NextChannelID)
		for _, channel := range setting.Channels {
			id = max(id, channel.ID+1)
		}
		models := []string{}
		for _, spec := range SupportedReplicateModels() {
			if spec.Protocol == "replicate" {
				models = append(models, spec.Model)
			}
		}
		setting.Channels = append(setting.Channels, model.ModelChannel{ID: id, Protocol: "replicate", Name: "Replicate 官方", BaseURL: ReplicateBaseURL, APIKey: key, UseEnvironmentKey: environment, Models: models, Weight: 1, Enabled: true})
		setting.NextChannelID = id + 1
		setting.Replicate.LegacyChannelID = id
	}
	setting.Replicate.ChannelsInitialized = true
	setting.Replicate.APIKey = ""
	setting.Replicate.ClearAPIKey = false
}

func validateReplicateChannels(channels []model.ModelChannel, saved model.PrivateSetting) error {
	for _, channel := range channels {
		if channel.Protocol != "replicate" && channel.Protocol != "wavespeed" {
			continue
		}
		for _, name := range channel.Models {
			supported := false
			for _, spec := range SupportedReplicateModels() {
				if spec.Model == name {
					supported = true
					break
				}
			}
			if !supported {
				return safeMessageError{message: fmt.Sprintf("云模型 %s 尚未适配，请从已支持模型中选择", name)}
			}
			// 模型与渠道协议必须匹配，否则会拿错密钥请求错的上游。
			if provider := ProviderForModel(name); provider != channel.Protocol {
				return safeMessageError{message: fmt.Sprintf("模型 %s 需要通过 %s 渠道调用", name, providerLabel(provider))}
			}
		}
	}
	for _, old := range saved.Channels {
		if old.Protocol != "replicate" && old.Protocol != "wavespeed" {
			continue
		}
		retained := false
		for _, channel := range channels {
			if channel.ID == old.ID && channel.Protocol == old.Protocol {
				retained = true
				break
			}
		}
		if retained {
			continue
		}
		active, err := repository.ReplicateChannelInUse(old.ID, old.ID == saved.Replicate.LegacyChannelID)
		if err != nil {
			return err
		}
		if active {
			return safeMessageError{message: fmt.Sprintf("渠道 #%d 还有未完成的云模型任务，请先停用渠道并处理原任务，再删除或变更协议", old.ID)}
		}
	}
	return nil
}

func replicateChannelKey(channel model.ModelChannel) string {
	if key := strings.TrimSpace(channel.APIKey); key != "" {
		return key
	}
	if !channel.UseEnvironmentKey {
		return ""
	}
	if channel.Protocol == "wavespeed" {
		return strings.TrimSpace(os.Getenv("WAVESPEED_API_KEY"))
	}
	return strings.TrimSpace(os.Getenv("REPLICATE_API_TOKEN"))
}

// ProviderForModel returns the channel protocol a catalog entry requires.
func ProviderForModel(modelName string) string {
	for _, spec := range ReplicateModels() {
		if spec.Model == modelName {
			return spec.ProviderName()
		}
	}
	return "replicate"
}

func providerLabel(provider string) string {
	if provider == "wavespeed" {
		return "WaveSpeed"
	}
	return "Replicate"
}

func replicateChannelsForGroup(channels []model.ModelChannel, modelName, group string) []model.ModelChannel {
	items := []model.ModelChannel{}
	provider := ProviderForModel(modelName)
	for _, channel := range channels {
		if channel.Protocol != provider || !channel.Enabled || replicateChannelKey(channel) == "" {
			continue
		}
		if group != "" && len(channel.AllowedGroups) > 0 && !containsString(channel.AllowedGroups, group) {
			continue
		}
		if !containsString(channel.Models, modelName) {
			continue
		}
		channel.APIKey = replicateChannelKey(channel)
		items = append(items, channel)
	}
	return items
}

func SelectReplicateChannel(modelName, group string) (model.ModelChannel, error) {
	return SelectReplicateChannelForID(modelName, group, 0)
}

// A durable workflow pins a channel while still checking current access and availability.
func SelectReplicateChannelForID(modelName, group string, id int) (model.ModelChannel, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.ModelChannel{}, err
	}
	if group == "" {
		group = "default"
	}
	private := normalizePrivateSetting(settings.Private)
	channels := replicateChannelsForGroup(private.Channels, modelName, group)
	if len(channels) == 0 {
		if len(replicateChannelsForGroup(private.Channels, modelName, "")) > 0 {
			return model.ModelChannel{}, modelGroupAccessError(modelName, group, private.Groups, settings.Public.AdminContact)
		}
		return model.ModelChannel{}, safeMessageError{message: fmt.Sprintf("没有可用的 %s 渠道，请管理员配置并启用该模型", providerLabel(ProviderForModel(modelName)))}
	}
	if id != 0 {
		for _, channel := range channels {
			if channel.ID == id {
				return channel, nil
			}
		}
		return model.ModelChannel{}, safeMessageError{message: "整片任务原渠道已不可用，已暂停；不会切换渠道"}
	}
	return orderModelChannels(channels)[0], nil
}

// A disabled channel can still finish its existing tasks; never switch accounts.
func ResolveReplicateTaskChannel(task model.ReplicateTask) (model.ModelChannel, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.ModelChannel{}, err
	}
	private := normalizePrivateSetting(settings.Private)
	id := task.ChannelID
	if id == 0 {
		id = private.Replicate.LegacyChannelID
	}
	for _, channel := range private.Channels {
		if channel.ID == id && (channel.Protocol == "replicate" || channel.Protocol == "wavespeed") && replicateChannelKey(channel) != "" {
			channel.APIKey = replicateChannelKey(channel)
			return channel, nil
		}
	}
	return model.ModelChannel{}, safeMessageError{message: "任务原云模型渠道不存在或密钥未配置，请管理员恢复原渠道；不会创建新任务"}
}

func testReplicateChannelModel(channel model.ModelChannel, name string) (string, error) {
	supported := false
	for _, spec := range SupportedReplicateModels() {
		if spec.Model == name {
			supported = true
			break
		}
	}
	if !supported {
		return "", safeMessageError{message: "该云模型尚未适配"}
	}
	if channel.Protocol == "wavespeed" {
		request, err := http.NewRequest(http.MethodGet, WaveSpeedBaseURL+"/balance", nil)
		if err != nil {
			return "", err
		}
		request.Header.Set("Authorization", "Bearer "+replicateChannelKey(channel))
		response, err := adminModelHTTPClient.Do(request)
		if err != nil {
			return "", safeMessageError{message: "WaveSpeed 连接失败"}
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		if response.StatusCode != http.StatusOK {
			return "", safeMessageError{message: fmt.Sprintf("WaveSpeed 令牌校验失败（%d），请检查密钥", response.StatusCode)}
		}
		return "令牌有效；未执行付费生成", nil
	}
	request, err := http.NewRequest(http.MethodGet, ReplicateBaseURL+"/models/"+name, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+replicateChannelKey(channel))
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", safeMessageError{message: "Replicate 模型连接失败"}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusOK {
		return "", safeMessageError{message: fmt.Sprintf("Replicate 模型访问失败（%d），请检查令牌和模型权限", response.StatusCode)}
	}
	return "令牌有效，当前模型可访问；未执行付费生成", nil
}

func publicChannelModels(settings model.Settings, group string) []model.PublicChannelModel {
	items := []model.PublicChannelModel{}
	channels := modelChannelsForGroup(settings.Private.Channels, "", group)
	videos := publicVideoProfiles(channels)
	for _, name := range enabledChannelModels(channels) {
		capability := "text"
		if _, configured := videos[name]; configured {
			capability = "video"
		} else if isImageModelName(name) {
			capability = "image"
		}
		items = append(items, model.PublicChannelModel{Model: name, Label: name, Protocol: "openai", Capabilities: []string{capability}})
	}
	for _, spec := range SupportedReplicateModels() {
		if len(replicateChannelsForGroup(settings.Private.Channels, spec.Model, group)) == 0 {
			continue
		}
		if len(spec.Capabilities) == 0 || spec.Capabilities[0] != "image-processing" {
			price, ok := settings.Private.Replicate.Pricing[spec.Model]
			pinned, err := FindReplicateModel(spec.Operations[0])
			if !ok || !price.Enabled || err != nil || price.Version != pinned.Version {
				continue
			}
		}
		items = append(items, spec)
	}
	return items
}
