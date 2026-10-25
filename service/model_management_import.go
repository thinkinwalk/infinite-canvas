package service

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

type ManagementPreview struct {
	Management model.ModelManagement `json:"management"`
	Warnings   []string              `json:"warnings"`
}

// Explicit preview only; reading settings never imports or activates a catalog.
func PreviewModelManagement() (ManagementPreview, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return ManagementPreview{}, err
	}
	settings = normalizeSettings(settings)
	features, err := ModelFeatures()
	if err != nil {
		return ManagementPreview{}, err
	}
	catalog := model.ModelManagement{Routes: []model.ManagedRoute{}, Models: []model.ManagedModel{}, Bindings: []model.FeatureBinding{}}
	if settings.Private.ModelManagement != nil {
		catalog = cloneManagement(*settings.Private.ModelManagement)
	}
	warnings := []string{}
	defaults := map[string]bool{}
	for _, binding := range catalog.Bindings {
		if binding.Default {
			defaults[binding.FeatureID] = true
		}
	}
	for _, channel := range settings.Private.Channels {
		for _, name := range channel.Models {
			exists := false
			for _, route := range catalog.Routes {
				exists = exists || route.ChannelID == channel.ID && route.Model == name
			}
			if exists {
				continue
			}
			route := model.ManagedRoute{ID: "route_" + strings.ReplaceAll(uuid.NewString(), "-", ""), ChannelID: channel.ID, Model: name, Enabled: channel.Enabled}
			entry := model.ManagedModel{ID: "model_" + strings.ReplaceAll(uuid.NewString(), "-", ""), InternalName: channel.Name + " / " + name, DisplayName: name, DisplayMode: "real", Enabled: channel.Enabled, RouteIDs: []string{route.ID}}
			if channel.Protocol == "replicate" || channel.Protocol == "wavespeed" {
				for _, spec := range SupportedReplicateModels() {
					if spec.Model != name {
						continue
					}
					route.Adapter, route.Operations = "cloud:"+spec.Operations[0], spec.Operations
					entry.DisplayName = spec.Label
					_, route.Capability, _ = ManagedAdapterOperations(route.Adapter, name)
					if price, ok := settings.Private.Replicate.Pricing[name]; ok {
						entry.Pricing = model.ManagedPricing{Configured: true, Replicate: &price}
						entry.Enabled = entry.Enabled && price.Enabled
					}
					if strings.HasSuffix(route.Adapter, "-replicate") {
						entry.Pricing = model.ManagedPricing{Configured: true, Free: true}
						warnings = append(warnings, channel.Name+" / "+name+"：图像处理继续收取案例服务费，模型部分显式标为免费；启用前请核对总价。")
					}
					route.Version = spec.Version
					break
				}
			} else {
				route.Capability, route.Adapter, route.Operations = "text", "text.openai", []string{"text"}
				if isImageModelName(name) {
					route.Capability, route.Adapter, route.Operations = "image", "image.openai", []string{"image"}
				}
				if isVideoModelName(name) || channel.VideoModels[name].Interface != "" {
					profile := VideoProfile(channel, name)
					route.Capability, route.Adapter, route.Operations, route.Video = "video", "video."+profile.Interface, []string{"video"}, &profile
					switch {
					case IsH3Video2K(name):
						route.Adapter = "video.h3-2k"
					case IsMiniMaxH3(name):
						route.Adapter = "video.minimax-h3"
						if strings.EqualFold(name, "minimax-h3-fl2v") {
							route.Adapter = "video.minimax-h3-frames"
						}
					case strings.EqualFold(name, "wan30-720p"):
						route.Adapter = "video.wan30"
					}
					if profile.DisplayName != "" {
						entry.DisplayName = profile.DisplayName
					}
					entry.Description = profile.Description
					if len(profile.Seconds) == 0 {
						for value := 4; value <= 30; value++ {
							profile.Seconds = append(profile.Seconds, fmt.Sprint(value))
						}
						warnings = append(warnings, channel.Name+" / "+name+"：输出秒数采用既有界面档位，启用前请核对上游规格。")
					}
					if profile.BillingMode != "" && len(profile.BillingTiers) > 0 {
						entry.Pricing.Configured, entry.Pricing.Video = true, &profile
					}
				}
				lower := strings.ToLower(name)
				if strings.Contains(lower, "tts") || strings.Contains(lower, "speech") {
					route.Capability, route.Adapter, route.Operations = "audio", "audio.openai", []string{"audio"}
				}
				for _, price := range settings.Public.ModelChannel.ModelCosts {
					if price.Model == name {
						entry.Pricing.Configured, entry.Pricing.Credits = true, price.Credits
					}
				}
			}
			if route.Adapter == "" {
				warnings = append(warnings, "未导入尚未适配的模型："+channel.Name+" / "+name)
				continue
			}
			if !entry.Pricing.Configured {
				entry.Enabled = false
				warnings = append(warnings, channel.Name+" / "+name+"：价格未配置，导入后保持停用。")
			}
			if entry.Pricing.Configured && entry.Pricing.Credits == 0 && entry.Pricing.Replicate == nil && entry.Pricing.Video == nil {
				entry.Pricing.Free = true
			}
			catalog.Routes, catalog.Models = append(catalog.Routes, route), append(catalog.Models, entry)
			for _, feature := range features {
				if feature.Capability != route.Capability || len(sharedStrings(feature.Operations, route.Operations)) == 0 {
					continue
				}
				if feature.ID == "replace.person" && !strings.HasPrefix(route.Adapter, "cloud:") {
					if route.Video == nil || route.Video.ContentReplacement == nil || !*route.Video.ContentReplacement || name == "h3-video" {
						continue
					}
				}
				if (feature.ID == "replace.product" || feature.ID == "replace.background") && !strings.HasPrefix(route.Adapter, "cloud:") && (route.Video == nil || route.Video.MaxVideos == 0 || route.Video.MaxImages == 0) {
					continue
				}
				preferred := settings.Public.ModelChannel.DefaultTextModel
				switch route.Capability {
				case "image":
					preferred = settings.Public.ModelChannel.DefaultImageModel
				case "video":
					preferred = settings.Public.ModelChannel.DefaultVideoModel
				}
				isDefault := name == preferred && entry.Enabled && !defaults[feature.ID]
				if isDefault {
					defaults[feature.ID] = true
				}
				catalog.Bindings = append(catalog.Bindings, model.FeatureBinding{FeatureID: feature.ID, ModelID: entry.ID, RouteIDs: []string{route.ID}, Enabled: entry.Enabled, Default: isDefault, Order: len(catalog.Bindings)})
			}
		}
	}
	warnings = append(warnings, "仅预览，尚未写入或启用；h3-video 不导入人物替换绑定。请核对各功能的初始模型、价格与默认项。")
	return ManagementPreview{Management: catalog, Warnings: warnings}, nil
}

func validateManagedReferences(saved, next model.Settings) error {
	if saved.Private.ModelManagement == nil {
		return nil
	}
	// History references are checked again inside the settings transaction.
	for _, old := range saved.Private.ModelManagement.Routes {
		if next.Private.ModelManagement != nil {
			for _, route := range next.Private.ModelManagement.Routes {
				if route.ID == old.ID {
					if old.Model != route.Model || old.ChannelID != route.ChannelID || old.Adapter != route.Adapter || old.Version != route.Version {
						return fmt.Errorf("渠道模型的真实身份不可原地更换，请新增接入并停用原记录")
					}
				}
			}
		}
	}
	// Credentials remain on channels; replacing a URL/key can invalidate existing jobs.
	for _, old := range saved.Private.Channels {
		if next.Private.ModelManagement == nil {
			continue
		}
		for _, route := range next.Private.ModelManagement.Routes {
			if route.ChannelID != old.ID {
				continue
			}
			found := false
			for _, channel := range next.Private.Channels {
				if channel.ID != old.ID {
					continue
				}
				found = true
				if old.BaseURL != channel.BaseURL || old.Protocol != channel.Protocol || old.APIKey != "" && channel.APIKey == "" {
					return fmt.Errorf("已有模型渠道的地址、协议或凭据移除会破坏任务恢复；请新增渠道并停用原接入，密钥轮换可直接填写新密钥")
				}
			}
			if !found {
				return fmt.Errorf("渠道 %s 仍被接入 %s 引用，请先删除不再使用的渠道模型并保存", old.Name, route.Model)
			}
		}
	}
	return nil
}

func ManagedBackupJSON(settings model.Settings) ([]byte, error) {
	return json.MarshalIndent(settings, "", "  ")
}
