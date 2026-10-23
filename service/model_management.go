package service

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type ManagedSelection struct {
	Group    string
	Revision int
	Feature  model.ModelFeature
	Model    model.ManagedModel
	Route    model.ManagedRoute
	Channel  model.ModelChannel
	Profile  *model.VideoModelProfile
}

type managedSelectionKey struct{}

func WithManagedSelection(ctx context.Context, selected *ManagedSelection) context.Context {
	return context.WithValue(ctx, managedSelectionKey{}, selected)
}

func ManagedSelectionFromContext(ctx context.Context) *ManagedSelection {
	selected, _ := ctx.Value(managedSelectionKey{}).(*ManagedSelection)
	return selected
}

func ManagementEnabled() (bool, error) {
	settings, err := repository.GetSettings()
	return settings.Private.ModelManagement != nil && settings.Private.ModelManagement.Enabled, err
}

func ResolveManagedModel(featureID, modelID, group string, channelID int) (*ManagedSelection, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return nil, err
	}
	management := settings.Private.ModelManagement
	if management == nil || !management.Enabled {
		return nil, nil
	}
	feature, err := FindModelFeature(featureID)
	if err != nil {
		return nil, err
	}
	bindings := append([]model.FeatureBinding{}, management.Bindings...)
	sort.SliceStable(bindings, func(i, j int) bool {
		if bindings[i].Default != bindings[j].Default {
			return bindings[i].Default
		}
		return bindings[i].Order < bindings[j].Order
	})
	for _, binding := range bindings {
		if binding.FeatureID != featureID || !binding.Enabled || (modelID != "" && binding.ModelID != modelID) {
			continue
		}
		var entry *model.ManagedModel
		for i := range management.Models {
			if management.Models[i].ID == binding.ModelID {
				entry = &management.Models[i]
				break
			}
		}
		if entry == nil || !entry.Enabled || !entry.Pricing.Configured {
			continue
		}
		candidates := []ManagedSelection{}
		for _, route := range management.Routes {
			if !route.Enabled || !containsString(entry.RouteIDs, route.ID) || !containsString(binding.RouteIDs, route.ID) {
				continue
			}
			if route.Capability != feature.Capability || len(sharedStrings(route.Operations, feature.Operations)) == 0 {
				continue
			}
			for _, channel := range normalizePrivateSetting(settings.Private).Channels {
				if channel.ID != route.ChannelID || !channel.Enabled || !containsString(channel.Models, route.Model) {
					continue
				}
				allowed := modelChannelsForGroup([]model.ModelChannel{channel}, route.Model, group)
				if channel.Protocol == "replicate" || channel.Protocol == "wavespeed" {
					allowed = replicateChannelsForGroup([]model.ModelChannel{channel}, route.Model, group)
				}
				if len(allowed) == 0 {
					continue
				}
				groupRatio, err := UserGroupRatio(group)
				if err != nil || groupRatio < 0 {
					continue
				}
				profile := route.Video
				if profile != nil {
					copy := *profile
					if len(binding.Resolutions) > 0 {
						copy.Resolutions = sharedStrings(copy.Resolutions, binding.Resolutions)
					}
					if len(binding.Seconds) > 0 {
						copy.Seconds = sharedStrings(copy.Seconds, binding.Seconds)
					}
					if len(copy.Resolutions) == 0 || len(copy.Seconds) == 0 {
						continue
					}
					profile = &copy
				}
				if entry.Pricing.Video != nil && profile != nil {
					copy := *profile
					copy.BillingMode, copy.UnitCredits, copy.MinimumCredits, copy.BillingTiers = entry.Pricing.Video.BillingMode, entry.Pricing.Video.UnitCredits, entry.Pricing.Video.MinimumCredits, entry.Pricing.Video.BillingTiers
					profile = &copy
				}
				if profile != nil {
					channel.VideoModels = map[string]model.VideoModelProfile{route.Model: *profile}
				}
				channel.ManagedProfile = profile != nil
				candidates = append(candidates, ManagedSelection{Group: group, Revision: management.Revision, Feature: feature, Model: *entry, Route: route, Channel: allowed[0], Profile: profile})
				// Keep credentials from the resolved channel, and capabilities from the route.
				candidates[len(candidates)-1].Channel.VideoModels = channel.VideoModels
				candidates[len(candidates)-1].Channel.ManagedProfile = channel.ManagedProfile
				candidates[len(candidates)-1].Channel.ManagedAdapter = route.Adapter
				candidates[len(candidates)-1].Channel.PlatformModelID = entry.ID
				candidates[len(candidates)-1].Channel.ModelLabel = ManagedLabel(*entry, []model.ManagedRoute{route})
			}
		}
		if len(candidates) > 0 {
			common := candidates[0].Profile
			if common != nil {
				copy := *common
				for _, candidate := range candidates[1:] {
					other := candidate.Profile
					if other == nil || other.Interface != copy.Interface || other.FirstFrameField != copy.FirstFrameField || other.LastFrameField != copy.LastFrameField {
						return nil, fmt.Errorf("模型多渠道输入方式不一致，请拆分配置")
					}
					copy.MaxImages, copy.MaxVideos, copy.MaxAudios = min(copy.MaxImages, other.MaxImages), min(copy.MaxVideos, other.MaxVideos), min(copy.MaxAudios, other.MaxAudios)
					copy.Resolutions, copy.Seconds, copy.InputModes = sharedStrings(copy.Resolutions, other.Resolutions), sharedStrings(copy.Seconds, other.Seconds), sharedStrings(copy.InputModes, other.InputModes)
					copy.GenerateAudio = copy.GenerateAudio && other.GenerateAudio
					copy.FirstFrameRequired = copy.FirstFrameRequired || other.FirstFrameRequired
					copy.LastFrameOptional = copy.LastFrameOptional && other.LastFrameOptional
					copy.ReferenceVideoMinSeconds = max(copy.ReferenceVideoMinSeconds, other.ReferenceVideoMinSeconds)
					if copy.ReferenceVideoMaxSeconds == 0 || other.ReferenceVideoMaxSeconds > 0 && other.ReferenceVideoMaxSeconds < copy.ReferenceVideoMaxSeconds {
						copy.ReferenceVideoMaxSeconds = other.ReferenceVideoMaxSeconds
					}
				}
				if len(copy.Resolutions) == 0 || len(copy.Seconds) == 0 || len(copy.InputModes) == 0 {
					return nil, fmt.Errorf("模型渠道没有共同规格，请拆分配置")
				}
				for i := range candidates {
					profile := copy
					candidates[i].Profile = &profile
					candidates[i].Channel.VideoModels[candidates[i].Route.Model] = profile
				}
			}
			channels := []model.ModelChannel{}
			for _, candidate := range candidates {
				if channelID == 0 || candidate.Channel.ID == channelID {
					channels = append(channels, candidate.Channel)
				}
			}
			if len(channels) == 0 {
				return nil, fmt.Errorf("报价渠道已不可用，请重新确认费用")
			}
			first := orderModelChannels(channels)[0]
			for i := range candidates {
				if candidates[i].Channel.ID == first.ID {
					return &candidates[i], nil
				}
			}
		}
	}
	return nil, fmt.Errorf("该功能没有可用的已配置模型，请刷新模型目录或联系管理员；本次未扣费")
}

func ManagedLabel(entry model.ManagedModel, routes []model.ManagedRoute) string {
	real := ""
	for _, route := range routes {
		if containsString(entry.RouteIDs, route.ID) {
			real = route.Model
			break
		}
	}
	switch entry.DisplayMode {
	case "real":
		return real
	case "both":
		return entry.DisplayName + " · " + real
	default:
		return entry.DisplayName
	}
}

func ManagedModelCost(ctx context.Context, name string) (int, error) {
	if selected := ManagedSelectionFromContext(ctx); selected != nil {
		if !selected.Model.Pricing.Configured {
			return 0, fmt.Errorf("模型价格尚未配置")
		}
		if selected.Model.Pricing.Free {
			return 0, nil
		}
		return selected.Model.Pricing.Credits, nil
	}
	return ModelCost(name)
}

func ManagedCredits(selected *ManagedSelection, resolution, seconds string) (int, string, error) {
	if selected.Model.Pricing.Free {
		return 0, "管理员配置免费", nil
	}
	if selected.Profile != nil {
		if credits, calculation, ok := VideoQuote(selected.Channel, selected.Route.Model, resolution, seconds); ok {
			return credits, calculation, nil
		}
	}
	return selected.Model.Pricing.Credits, fmt.Sprintf("每次 %d 算力点", selected.Model.Pricing.Credits), nil
}

// Revalidate immediately before each new paid step, keeping the quoted route.
func RevalidateManagedSelection(ctx context.Context) (context.Context, error) {
	old := ManagedSelectionFromContext(ctx)
	if old == nil {
		return ctx, nil
	}
	user, ok := UserFromContext(ctx)
	if !ok {
		return ctx, fmt.Errorf("请先登录")
	}
	if old.Group != user.Group {
		return ctx, fmt.Errorf("用户分组已变化，请重新确认费用")
	}
	selected, err := ResolveManagedModel(old.Feature.ID, old.Model.ID, user.Group, old.Channel.ID)
	if err != nil {
		return ctx, err
	}
	if selected == nil || selected.Revision != old.Revision {
		return ctx, fmt.Errorf("模型配置已变化，请重新确认费用；尚未提交的步骤已暂停")
	}
	return WithManagedSelection(ctx, selected), nil
}

func ValidateModelManagement(settings model.Settings) error {
	management := settings.Private.ModelManagement
	if management == nil {
		return nil
	}
	features, err := ModelFeatures()
	if err != nil {
		return err
	}
	featureMap := map[string]model.ModelFeature{}
	for _, feature := range features {
		featureMap[feature.ID] = feature
	}
	validID := regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)
	routes := map[string]model.ManagedRoute{}
	for _, route := range management.Routes {
		if !validID.MatchString(route.ID) || routes[route.ID].ID != "" {
			return fmt.Errorf("渠道模型编号无效或重复：%s", route.ID)
		}
		operations, capability, err := ManagedAdapterOperations(route.Adapter, route.Model)
		if err != nil || capability != route.Capability || len(route.Operations) == 0 || len(sharedStrings(operations, route.Operations)) != len(route.Operations) {
			return fmt.Errorf("渠道模型 %s 的适配器、类型或操作不匹配", route.ID)
		}
		channelFound := false
		for _, channel := range settings.Private.Channels {
			if channel.ID == route.ChannelID && containsString(channel.Models, route.Model) {
				channelFound = true
				cloud := channel.Protocol == "replicate" || channel.Protocol == "wavespeed"
				if cloud != strings.HasPrefix(route.Adapter, "cloud:") {
					return fmt.Errorf("渠道模型 %s 的协议与适配器不符", route.ID)
				}
			}
		}
		if !channelFound {
			return fmt.Errorf("渠道模型 %s 引用了不存在的渠道或真实模型", route.ID)
		}
		if route.Enabled && strings.HasPrefix(route.Adapter, "cloud:") && !strings.HasSuffix(route.Adapter, "-replicate") {
			for _, operation := range route.Operations {
				spec, err := FindReplicateModel(operation)
				if err != nil || spec.Model != route.Model || route.Version != "" && route.Version != spec.Version {
					return fmt.Errorf("渠道模型 %s 的真实模型或固定版本与适配器不一致", route.ID)
				}
			}
		}
		if route.Enabled && capability == "video" && !strings.HasPrefix(route.Adapter, "cloud:") {
			if route.Video == nil || len(route.Video.Resolutions) == 0 || len(route.Video.Seconds) == 0 {
				return fmt.Errorf("视频模型 %s 必须明确配置输出规格", route.ID)
			}
			if route.Video.MaxImages < 0 || route.Video.MaxVideos < 0 || route.Video.MaxAudios < 0 {
				return fmt.Errorf("素材数量不能为负数")
			}
			expectedInterface := strings.TrimPrefix(route.Adapter, "video.")
			if expectedInterface == "wan30" || expectedInterface == "h3-2k" || strings.HasPrefix(expectedInterface, "minimax-h3") {
				expectedInterface = "relay"
			}
			if route.Video.Interface != expectedInterface {
				return fmt.Errorf("视频接口与已选适配器不一致：%s", route.ID)
			}
			normalized := normalizeVideoInputProfile(*route.Video)
			if normalized.Interface == "unavailable" || len(normalized.InputModes) != len(route.Video.InputModes) {
				return fmt.Errorf("请明确配置有效输入方式及首尾帧字段：%s", route.ID)
			}
			for _, seconds := range route.Video.Seconds {
				value, err := strconv.ParseFloat(seconds, 64)
				if err != nil || value <= 0 || math.IsInf(value, 0) || math.IsNaN(value) {
					return fmt.Errorf("视频输出秒数无效：%s", route.ID)
				}
			}
		}
		routes[route.ID] = route
	}
	entries := map[string]model.ManagedModel{}
	for _, entry := range management.Models {
		if !validID.MatchString(entry.ID) || entries[entry.ID].ID != "" || strings.TrimSpace(entry.DisplayName) == "" {
			return fmt.Errorf("平台模型编号重复、无效或名称为空")
		}
		if entry.DisplayMode != "alias" && entry.DisplayMode != "real" && entry.DisplayMode != "both" {
			return fmt.Errorf("平台模型 %s 展示方式不正确", entry.ID)
		}
		if entry.Enabled && (!entry.Pricing.Configured || len(entry.RouteIDs) == 0) {
			return fmt.Errorf("启用模型 %s 前请配置价格与渠道", entry.DisplayName)
		}
		if entry.Pricing.Credits < 0 {
			return fmt.Errorf("模型价格不能为负数")
		}
		first := model.ManagedRoute{}
		for _, id := range entry.RouteIDs {
			route, exists := routes[id]
			if !exists {
				return fmt.Errorf("平台模型 %s 引用了不存在的渠道模型", entry.DisplayName)
			}
			if first.ID == "" {
				first = route
			} else if first.Adapter != route.Adapter || first.Model != route.Model || first.Version != route.Version {
				return fmt.Errorf("一个平台模型的多渠道必须使用相同真实模型、版本和适配器；请拆分模型")
			}
		}
		if price := entry.Pricing.Replicate; price != nil && entry.Enabled {
			if price.UnitCredits < 0 || price.MinimumCredits < 0 || price.DefaultUnits < 0 || price.BlockSeconds < 0 {
				return fmt.Errorf("云模型报价不能为负数")
			}
			for _, value := range price.Tiers {
				if value < 0 {
					return fmt.Errorf("规格价格不能为负数")
				}
			}
			if !containsString([]string{"fixed", "input_characters", "input_seconds", "output_seconds", "duration_resolution", "runtime_seconds", "output_count"}, price.BillingMode) {
				return fmt.Errorf("云模型计费方式无效")
			}
		}
		if entry.Enabled && !entry.Pricing.Free && entry.Pricing.Credits == 0 && entry.Pricing.Video == nil && entry.Pricing.Replicate == nil {
			return fmt.Errorf("零点价格请明确勾选免费")
		}
		if price := entry.Pricing.Video; price != nil && entry.Enabled {
			if price.BillingMode != "duration_resolution" || len(price.BillingTiers) == 0 || price.UnitCredits < 0 || price.MinimumCredits < 0 {
				return fmt.Errorf("请完整配置视频规格报价")
			}
			for _, value := range price.BillingTiers {
				if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
					return fmt.Errorf("视频规格价格不正确")
				}
			}
		}
		if strings.HasPrefix(first.Adapter, "cloud:") && !strings.HasSuffix(first.Adapter, "-replicate") && entry.Enabled && entry.Pricing.Replicate == nil && !entry.Pricing.Free {
			return fmt.Errorf("云模型必须配置专用报价")
		}
		if entry.Enabled && !entry.Pricing.Free {
			if p := entry.Pricing.Video; p != nil {
				for _, id := range entry.RouteIDs {
					if profile := routes[id].Video; profile != nil {
						for _, resolution := range profile.Resolutions {
							if p.BillingTiers[resolution] <= 0 {
								return fmt.Errorf("视频规格 %s 必须配置正数价格；免费模型请明确勾选免费", resolution)
							}
						}
					}
				}
			}
			if p := entry.Pricing.Replicate; p != nil && p.UnitCredits <= 0 {
				if len(p.Tiers) == 0 {
					return fmt.Errorf("云模型零点价格请明确勾选免费")
				}
				for _, price := range p.Tiers {
					if price <= 0 {
						return fmt.Errorf("云模型规格必须配置正数价格；免费模型请明确勾选免费")
					}
				}
			}
			if strings.HasSuffix(first.Adapter, "-replicate") && entry.Pricing.Replicate != nil {
				return fmt.Errorf("案例专用图像处理使用固定点数，请选择固定计费")
			}
		}
		entries[entry.ID] = entry
	}
	defaults, pairs := map[string]bool{}, map[string]bool{}
	for _, binding := range management.Bindings {
		feature, exists := featureMap[binding.FeatureID]
		if !exists {
			return fmt.Errorf("绑定引用了未登记的功能：%s", binding.FeatureID)
		}
		entry, exists := entries[binding.ModelID]
		if !exists {
			return fmt.Errorf("功能绑定引用了不存在的平台模型")
		}
		pair := binding.FeatureID + "\x00" + binding.ModelID
		if pairs[pair] {
			return fmt.Errorf("同一功能不能重复绑定同一模型")
		}
		pairs[pair] = true
		if binding.Enabled && len(binding.RouteIDs) == 0 {
			return fmt.Errorf("启用绑定前请指定允许的渠道模型")
		}
		for _, id := range binding.RouteIDs {
			route := routes[id]
			if !containsString(entry.RouteIDs, id) || route.Capability != feature.Capability || len(sharedStrings(route.Operations, feature.Operations)) == 0 {
				return fmt.Errorf("功能 %s 与模型的渠道或操作不匹配", feature.Label)
			}
			if binding.FeatureID == "replace.person" && !strings.HasPrefix(route.Adapter, "cloud:") && (route.Video == nil || route.Video.MaxImages == 0 || route.Video.MaxVideos == 0) {
				return fmt.Errorf("人物替换需要图片与视频参考能力")
			}
			if route.Video != nil {
				if len(sharedStrings(binding.Resolutions, route.Video.Resolutions)) != len(binding.Resolutions) || len(sharedStrings(binding.Seconds, route.Video.Seconds)) != len(binding.Seconds) {
					return fmt.Errorf("功能规格不得超出渠道模型能力")
				}
			}
		}
		if binding.Default {
			if !binding.Enabled || !entry.Enabled || defaults[binding.FeatureID] {
				return fmt.Errorf("每个功能只能设置一个已启用的默认模型")
			}
			defaults[binding.FeatureID] = true
		}
	}
	return nil
}

func ManagedPublicCatalog(settings model.Settings, group string) (*model.ManagedCatalog, error) {
	management := settings.Private.ModelManagement
	if management == nil || !management.Enabled {
		return nil, nil
	}
	features, err := ModelFeatures()
	if err != nil {
		return nil, err
	}
	catalog := &model.ManagedCatalog{Enabled: true, Revision: management.Revision, Features: features, Models: []model.PublicManagedModel{}, Bindings: []model.PublicFeatureModels{}}
	for _, entry := range management.Models {
		if !entry.Enabled {
			continue
		}
		capability := ""
		for _, route := range management.Routes {
			if containsString(entry.RouteIDs, route.ID) {
				capability = route.Capability
				break
			}
		}
		catalog.Models = append(catalog.Models, model.PublicManagedModel{ID: entry.ID, Label: ManagedLabel(entry, management.Routes), Description: entry.Description, Capability: capability})
	}
	for _, binding := range management.Bindings {
		if !binding.Enabled {
			continue
		}
		item := model.PublicFeatureModels{FeatureID: binding.FeatureID, ModelID: binding.ModelID, Default: binding.Default, Order: binding.Order, Operations: []string{}}
		selected, err := ResolveManagedModel(binding.FeatureID, binding.ModelID, group, 0)
		if err != nil || selected == nil {
			item.Reason = "该模型暂不可用或当前分组无权限"
		} else {
			item.Available, item.Adapter, item.Operations, item.Video, item.Credits = true, selected.Route.Adapter, sharedStrings(selected.Route.Operations, selected.Feature.Operations), selected.Profile, selected.Model.Pricing.Credits
			if item.Video != nil {
				copy := *item.Video
				copy.DisplayName, copy.Description = ManagedLabel(selected.Model, management.Routes), selected.Model.Description
				copy.BillingTiers = nil
				item.Video = &copy
			}
		}
		catalog.Bindings = append(catalog.Bindings, item)
	}
	return catalog, nil
}

// DetachJSON prevents a request from modifying the shared settings map/slices.
func cloneManagement(value model.ModelManagement) model.ModelManagement {
	data, _ := json.Marshal(value)
	var result model.ModelManagement
	_ = json.Unmarshal(data, &result)
	return result
}
