package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

var adminModelHTTPClient = &http.Client{Timeout: 30 * time.Second}

func PublicSettings() (model.PublicSetting, error) {
	return PublicSettingsForGroup("default")
}

func PublicSettingsForGroup(userGroup string) (model.PublicSetting, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.PublicSetting{}, err
	}
	normalized := normalizeSettings(settings)
	if normalized.Private.ModelManagement != nil && normalized.Private.ModelManagement.Enabled {
		catalog, err := ManagedPublicCatalog(normalized, userGroup)
		if err != nil {
			return model.PublicSetting{}, err
		}
		normalized.Public.ModelChannel = model.PublicModelChannelSetting{
			Managed: catalog, AllowCustomChannel: normalized.Public.ModelChannel.AllowCustomChannel,
			SystemPrompt: normalized.Public.ModelChannel.SystemPrompt,
			Models:       []model.PublicChannelModel{}, AvailableModels: []string{}, ModelCosts: []model.ModelCost{}, VideoModels: map[string]model.VideoModelProfile{},
		}
		return normalized.Public, nil
	}
	channels := modelChannelsForGroup(normalized.Private.Channels, "", userGroup)
	normalized.Public.ModelChannel.AvailableModels = enabledChannelModels(channels)
	normalized.Public.ModelChannel.VideoModels = publicVideoProfiles(channels)
	video := func(name string) bool { _, ok := normalized.Public.ModelChannel.VideoModels[name]; return ok }
	text := func(name string) bool { return !video(name) && isTextModelName(name) }
	normalized.Public.ModelChannel.DefaultTextModel = repairDefaultModel(normalized.Public.ModelChannel.DefaultTextModel, normalized.Public.ModelChannel.AvailableModels, text)
	normalized.Public.ModelChannel.DefaultImageModel = repairDefaultModel(normalized.Public.ModelChannel.DefaultImageModel, normalized.Public.ModelChannel.AvailableModels, isImageModelName)
	normalized.Public.ModelChannel.DefaultVideoModel = repairDefaultModel(normalized.Public.ModelChannel.DefaultVideoModel, normalized.Public.ModelChannel.AvailableModels, video)
	normalized.Public.ModelChannel.DefaultModel = repairDefaultModel(normalized.Public.ModelChannel.DefaultModel, normalized.Public.ModelChannel.AvailableModels, text)
	normalized.Public.ModelChannel.Models = publicChannelModels(normalized, userGroup)
	return normalized.Public, nil
}

func AdminSettings() (model.Settings, error) {
	settings, err := repository.GetSettings()
	return hidePrivateAPIKeys(normalizeSettings(settings)), err
}

func SaveSettings(settings model.Settings) (model.Settings, error) {
	if settings.Private.ModelManagement != nil {
		detached := cloneManagement(*settings.Private.ModelManagement)
		settings.Private.ModelManagement = &detached
	}
	saved, err := repository.GetSettings()
	if err != nil {
		return model.Settings{}, err
	}
	saved = normalizeSettings(saved)
	settings.Private.NextChannelID = max(settings.Private.NextChannelID, saved.Private.NextChannelID)
	settings.Private.Replicate.ChannelsInitialized = saved.Private.Replicate.ChannelsInitialized
	settings.Private.Replicate.LegacyChannelID = saved.Private.Replicate.LegacyChannelID
	settings = normalizeSettings(settings)
	keepPrivateAPIKeys(&settings, saved)
	keepPrivateAuthSecrets(&settings, saved)
	if err := validateReplicateChannels(settings.Private.Channels, saved.Private); err != nil {
		return model.Settings{}, safeMessageError{message: err.Error()}
	}
	if err := validateManagedReferences(saved, settings); err != nil {
		return model.Settings{}, safeMessageError{message: err.Error()}
	}
	if err := ValidateModelManagement(settings); err != nil {
		return model.Settings{}, safeMessageError{message: err.Error()}
	}
	result, err := repository.SaveSettingsChecked(settings, saved.Private.ModelManagement, now())
	var conflict repository.SettingsConflictError
	if errors.As(err, &conflict) {
		return model.Settings{}, safeMessageError{message: err.Error()}
	}
	if err == nil {
		RefreshPromptSyncScheduler()
	}
	return hidePrivateAPIKeys(result), err
}

func AdminChannelModels(index *int, channel model.ModelChannel) ([]string, error) {
	if channel.Protocol == "replicate" || channel.Protocol == "wavespeed" {
		return fetchAdminChannelModels(normalizeModelChannel(channel))
	}
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return nil, err
	}
	return fetchAdminChannelModels(resolved)
}

func AdminTestChannelModel(index *int, channel model.ModelChannel, modelName string) (string, error) {
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return "", err
	}
	if resolved.Protocol == "replicate" || resolved.Protocol == "wavespeed" {
		return testReplicateChannelModel(resolved, modelName)
	}
	if isArkAgentPlanChannel(resolved) {
		return testArkSeedanceChannelModel(resolved, modelName)
	}
	if isVideoModelName(modelName) || resolved.VideoModels[modelName].Interface != "" {
		return testVideoChannelModel(resolved, modelName)
	}
	return testAdminChannelModel(resolved, modelName)
}

func normalizeSettings(settings model.Settings) model.Settings {
	settings.Private = normalizePrivateSetting(settings.Private)
	settings.Public = normalizePublicSettingWithChannels(settings.Public, settings.Private.Channels)
	return settings
}

func normalizePublicSetting(setting model.PublicSetting) model.PublicSetting {
	return normalizePublicSettingWithChannels(setting, nil)
}

func normalizePublicSettingWithChannels(setting model.PublicSetting, channels []model.ModelChannel) model.PublicSetting {
	if setting.ModelChannel.AvailableModels == nil {
		setting.ModelChannel.AvailableModels = []string{}
	}
	if setting.ModelChannel.ModelCosts == nil {
		setting.ModelChannel.ModelCosts = []model.ModelCost{}
	}
	for i := range setting.ModelChannel.ModelCosts {
		setting.ModelChannel.ModelCosts[i].Model = strings.TrimSpace(setting.ModelChannel.ModelCosts[i].Model)
		if setting.ModelChannel.ModelCosts[i].Credits < 0 {
			setting.ModelChannel.ModelCosts[i].Credits = 0
		}
	}
	if setting.ModelChannel.AllowCustomChannel == nil {
		enabled := true
		setting.ModelChannel.AllowCustomChannel = &enabled
	}
	if setting.Auth.AllowRegister == nil {
		enabled := true
		setting.Auth.AllowRegister = &enabled
	}
	enabledModels := enabledChannelModels(channels)
	if len(enabledModels) > 0 {
		setting.ModelChannel.AvailableModels = enabledModels
	} else {
		setting.ModelChannel.AvailableModels = uniqueModelNames(setting.ModelChannel.AvailableModels)
	}
	setting.ModelChannel.DefaultTextModel = repairDefaultModel(setting.ModelChannel.DefaultTextModel, setting.ModelChannel.AvailableModels, isTextModelName)
	setting.ModelChannel.DefaultImageModel = repairDefaultModel(setting.ModelChannel.DefaultImageModel, setting.ModelChannel.AvailableModels, isImageModelName)
	setting.ModelChannel.DefaultVideoModel = repairDefaultModel(setting.ModelChannel.DefaultVideoModel, setting.ModelChannel.AvailableModels, isVideoModelName)
	setting.ModelChannel.DefaultModel = repairDefaultModel(setting.ModelChannel.DefaultModel, setting.ModelChannel.AvailableModels, isTextModelName)
	return setting
}

func ModelCost(modelName string) (int, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return 0, err
	}
	modelName = strings.TrimSpace(modelName)
	for _, item := range normalizePublicSetting(settings.Public).ModelChannel.ModelCosts {
		if item.Model == modelName {
			if IsH3Video2K(modelName) && item.Credits <= 0 {
				return 0, fmt.Errorf("H3video-2k 尚未配置按次价格，请联系管理员设置算力点单价；本次未扣费")
			}
			return item.Credits, nil
		}
	}
	if IsH3Video2K(modelName) {
		return 0, fmt.Errorf("H3video-2k 尚未配置按次价格，请联系管理员设置算力点单价；本次未扣费")
	}
	return 0, nil
}

func normalizePrivateSetting(setting model.PrivateSetting) model.PrivateSetting {
	if setting.Channels == nil {
		setting.Channels = []model.ModelChannel{}
	}
	if setting.Groups == nil {
		setting.Groups = map[string]model.UserGroup{}
	}
	if _, ok := setting.Groups["default"]; !ok {
		setting.Groups["default"] = model.UserGroup{Name: "普通用户", CreditRatio: 1, Enabled: true}
	}
	for key, group := range setting.Groups {
		if strings.TrimSpace(group.Name) == "" {
			group.Name = key
		}
		if group.CreditRatio < 0 {
			group.CreditRatio = 0
		}
		setting.Groups[key] = group
	}
	setting.PromptSync = normalizePromptSyncSetting(setting.PromptSync)
	setting.Replicate = normalizeReplicatePricing(setting.Replicate)
	initializeReplicateChannels(&setting)
	setting.NextChannelID = max(1, setting.NextChannelID)
	for _, channel := range setting.Channels {
		setting.NextChannelID = max(setting.NextChannelID, channel.ID+1)
	}
	channelIDs := map[int]bool{}
	for i := range setting.Channels {
		id := setting.Channels[i].ID
		if id <= 0 || channelIDs[id] {
			id = setting.NextChannelID
			setting.NextChannelID++
			setting.Channels[i].ID = id
		}
		channelIDs[id] = true
		if setting.Channels[i].Protocol == "" {
			setting.Channels[i].Protocol = "openai"
		}
		if setting.Channels[i].Models == nil {
			setting.Channels[i].Models = []string{}
		}
		setting.Channels[i].AllowedGroups = uniqueModelNames(setting.Channels[i].AllowedGroups)
		if setting.Channels[i].Weight <= 0 {
			setting.Channels[i].Weight = 1
		}
		setting.Channels[i] = normalizeModelChannel(setting.Channels[i])
	}
	return setting
}

func hidePrivateAPIKeys(settings model.Settings) model.Settings {
	settings.Public.ModelChannel.Models = SupportedReplicateModels()
	settings.Private.Channels = append([]model.ModelChannel(nil), settings.Private.Channels...)
	for i := range settings.Private.Channels {
		settings.Private.Channels[i].APIKeyConfigured = strings.TrimSpace(settings.Private.Channels[i].APIKey) != "" || ((settings.Private.Channels[i].Protocol == "replicate" || settings.Private.Channels[i].Protocol == "wavespeed") && replicateChannelKey(settings.Private.Channels[i]) != "")
		settings.Private.Channels[i].APIKey = ""
		settings.Private.Channels[i].ClearAPIKey = false
	}
	settings.Private.Auth.LinuxDo.ClientSecret = ""
	settings.Private.Replicate.APIKey = ""
	return settings
}

func keepPrivateAPIKeys(settings *model.Settings, saved model.Settings) {
	for i := range settings.Private.Channels {
		settings.Private.Channels[i].APIKeyConfigured = false
		if settings.Private.Channels[i].ClearAPIKey {
			settings.Private.Channels[i].APIKey = ""
			settings.Private.Channels[i].ClearAPIKey = false
			continue
		}
		if strings.TrimSpace(settings.Private.Channels[i].APIKey) != "" {
			continue
		}
		if channel, ok := findSavedChannel(settings.Private.Channels[i], saved.Private.Channels, i); ok {
			if channel.Protocol == settings.Private.Channels[i].Protocol {
				settings.Private.Channels[i].APIKey = channel.APIKey
			}
		}
	}
}

func keepPrivateAuthSecrets(settings *model.Settings, saved model.Settings) {
	if strings.TrimSpace(settings.Private.Auth.LinuxDo.ClientSecret) == "" {
		settings.Private.Auth.LinuxDo.ClientSecret = saved.Private.Auth.LinuxDo.ClientSecret
	}
}

func findSavedChannel(channel model.ModelChannel, saved []model.ModelChannel, index int) (model.ModelChannel, bool) {
	if channel.ID > 0 {
		for _, item := range saved {
			if item.ID == channel.ID {
				return item, true
			}
		}
		return model.ModelChannel{}, false
	}
	for _, item := range saved {
		if item.Name == channel.Name && item.BaseURL == channel.BaseURL {
			return item, true
		}
	}
	if index >= 0 && index < len(saved) {
		return saved[index], true
	}
	return model.ModelChannel{}, false
}

func SelectModelChannel(modelName string) (model.ModelChannel, error) {
	return SelectModelChannelForGroup(modelName, "")
}

func SelectModelChannelForGroup(modelName string, userGroup string) (model.ModelChannel, error) {
	channels, err := SelectModelChannelsForGroup(modelName, userGroup)
	if err != nil {
		return model.ModelChannel{}, err
	}
	return channels[0], nil
}

// SelectModelChannelsForGroup orders eligible channels by weight without replacement.
func SelectModelChannelsForGroup(modelName string, userGroup string) ([]model.ModelChannel, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return nil, err
	}
	private := normalizePrivateSetting(settings.Private)
	channels := modelChannelsForGroup(private.Channels, modelName, userGroup)
	if len(channels) == 0 {
		if len(modelChannelsForGroup(private.Channels, modelName, "")) > 0 {
			return nil, modelGroupAccessError(modelName, userGroup, private.Groups, settings.Public.AdminContact)
		}
		return nil, errors.New("没有可用模型渠道")
	}
	return orderModelChannels(channels), nil
}

func orderModelChannels(channels []model.ModelChannel) []model.ModelChannel {
	ordered := make([]model.ModelChannel, 0, len(channels))
	for len(channels) > 0 {
		total := 0
		for _, channel := range channels {
			total += channel.Weight
		}
		hit := rand.Intn(total)
		for i, channel := range channels {
			hit -= channel.Weight
			if hit < 0 {
				ordered = append(ordered, channel)
				channels = append(channels[:i], channels[i+1:]...)
				break
			}
		}
	}
	return ordered
}

// ResolveModelChannelForTask returns the same configured channel that created an asynchronous task.
func ResolveModelChannelForTask(channelName string, channelBaseURL string, channelIDs ...int) (model.ModelChannel, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.ModelChannel{}, err
	}
	baseURL := normalizeModelChannelBaseURL(channelBaseURL)
	if len(channelIDs) > 0 && channelIDs[0] > 0 {
		for _, channel := range normalizePrivateSetting(settings.Private).Channels {
			if channel.ID == channelIDs[0] && normalizeModelChannelBaseURL(channel.BaseURL) == baseURL {
				return channel, nil
			}
		}
		return model.ModelChannel{}, errors.New("视频任务原渠道不存在或配置已变更")
	}
	for _, channel := range normalizePrivateSetting(settings.Private).Channels {
		if normalizeModelChannelBaseURL(channel.BaseURL) == baseURL && (channelName == "" || channel.Name == channelName) {
			return channel, nil
		}
	}
	return model.ModelChannel{}, errors.New("视频任务原渠道不存在或配置已变更")
}

func BuildModelChannelURL(channel model.ModelChannel, path string) string {
	baseURL := normalizeModelChannelBaseURL(channel.BaseURL)
	lowerBaseURL := strings.ToLower(baseURL)
	if !strings.HasSuffix(lowerBaseURL, "/v1") && !strings.HasSuffix(lowerBaseURL, "/api/v3") && !strings.HasSuffix(lowerBaseURL, "/api/plan/v3") {
		baseURL += "/v1"
	}
	return baseURL + path
}

func normalizeModelChannelBaseURL(baseURL string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err == nil && parsed.Scheme != "" && parsed.Host != "" {
		path := strings.TrimRight(parsed.Path, "/")
		lowerPath := strings.ToLower(path)
		if index := strings.Index(lowerPath, "/api/plan/v3"); index >= 0 {
			end := index + len("/api/plan/v3")
			if len(lowerPath) == end || lowerPath[end] == '/' {
				parsed.Path = path[:end]
				parsed.RawPath = ""
				parsed.RawQuery = ""
				parsed.Fragment = ""
				return strings.TrimRight(parsed.String(), "/")
			}
		}
	}
	return baseURL
}

func isArkAgentPlanChannel(channel model.ModelChannel) bool {
	baseURL := strings.ToLower(normalizeModelChannelBaseURL(channel.BaseURL))
	return strings.HasSuffix(baseURL, "/api/plan/v3")
}

func enabledChannelModels(channels []model.ModelChannel) []string {
	models := []string{}
	for _, channel := range channels {
		if !channel.Enabled || channel.Protocol == "replicate" || channel.Protocol == "wavespeed" {
			continue
		}
		models = append(models, channel.Models...)
	}
	return uniqueModelNames(models)
}

func uniqueModelNames(models []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, item := range models {
		name := strings.TrimSpace(item)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, name)
	}
	return result
}

func repairDefaultModel(current string, models []string, preferred func(string) bool) string {
	current = strings.TrimSpace(current)
	for _, item := range models {
		if item == current && preferred(item) {
			return current
		}
	}
	for _, item := range models {
		if preferred(item) {
			return item
		}
	}
	return ""
}

func isVideoModelName(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	return IsMiniMaxH3(name) || strings.Contains(name, "seedance") ||
		strings.Contains(name, "video") ||
		strings.Contains(name, "sora") ||
		strings.Contains(name, "veo") ||
		strings.Contains(name, "kling") ||
		strings.Contains(name, "hailuo") ||
		name == "wan30-720p" ||
		strings.Contains(name, "tejiasd")
}

func isImageModelName(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(name, "seedream") || strings.Contains(name, "gpt-image") || strings.Contains(name, "image")
}

func isTextModelName(modelName string) bool {
	return !isImageModelName(modelName) && !isVideoModelName(modelName)
}

func normalizeModelChannel(channel model.ModelChannel) model.ModelChannel {
	if channel.Protocol == "" {
		channel.Protocol = "openai"
	}
	if channel.Protocol == "replicate" {
		channel.BaseURL = ReplicateBaseURL
		channel.Models = uniqueModelNames(channel.Models)
		channel.VideoModels = nil
		return channel
	}
	if channel.Protocol == "wavespeed" {
		channel.BaseURL = WaveSpeedBaseURL
		channel.Models = uniqueModelNames(channel.Models)
		channel.VideoModels = nil
		return channel
	}
	if channel.Models == nil {
		channel.Models = []string{}
	}
	if channel.Weight <= 0 {
		channel.Weight = 1
	}
	if channel.VideoModels == nil {
		channel.VideoModels = map[string]model.VideoModelProfile{}
	}
	for _, name := range channel.Models {
		if !isVideoModelName(name) && channel.VideoModels[name].Interface == "" {
			continue
		}
		profile := VideoProfile(channel, name)
		if profile.DisplayName == "" {
			profile.DisplayName = name
		}
		if profile.Description == "" {
			profile.Description = "根据文字及支持的参考素材制作视频。"
		}
		if profile.Resolutions == nil {
			profile.Resolutions = []string{"480", "720", "1080"}
		}
		if profile.Seconds == nil {
			profile.Seconds = []string{}
		}
		imageLimit, mediaLimit := profile.MaxImages, 3
		if IsH3Video2K(name) || IsMiniMaxH3(name) {
			imageLimit = 9
		}
		if strings.EqualFold(strings.TrimSpace(name), "wan30-720p") {
			imageLimit, mediaLimit = 10, 5
		}
		profile.MaxImages = max(0, min(imageLimit, profile.MaxImages))
		profile.MaxVideos = max(0, min(mediaLimit, profile.MaxVideos))
		profile.MaxAudios = max(0, min(mediaLimit, profile.MaxAudios))
		if profile.Interface != "relay" && profile.Interface != "ark" && profile.Interface != SparkCineH3Interface && profile.Interface != "unavailable" {
			profile.Interface, profile.MaxVideos, profile.MaxAudios = "openai", 0, 0
		}
		channel.VideoModels[name] = profile
	}
	return channel
}

func resolveAdminChannel(index *int, channel model.ModelChannel) (model.ModelChannel, error) {
	resolved := normalizeModelChannel(channel)
	if strings.TrimSpace(resolved.APIKey) == "" {
		settings, err := repository.GetSettings()
		if err != nil {
			return model.ModelChannel{}, err
		}
		saved := normalizePrivateSetting(settings.Private).Channels
		if index != nil && *index >= 0 && *index < len(saved) {
			if resolved.APIKey == "" {
				resolved.APIKey = saved[*index].APIKey
			}
			if resolved.BaseURL == "" {
				resolved.BaseURL = saved[*index].BaseURL
			}
			if resolved.Name == "" {
				resolved.Name = saved[*index].Name
			}
		}
		if resolved.APIKey == "" {
			if savedChannel, ok := findSavedChannel(resolved, saved, -1); ok {
				resolved.APIKey = savedChannel.APIKey
			}
		}
	}
	if resolved.Protocol == "replicate" || resolved.Protocol == "wavespeed" {
		resolved.APIKey = replicateChannelKey(resolved)
	}
	if strings.TrimSpace(resolved.BaseURL) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少接口地址"}
	}
	if strings.TrimSpace(resolved.APIKey) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少 API Key"}
	}
	return resolved, nil
}

func fetchAdminChannelModels(channel model.ModelChannel) ([]string, error) {
	if channel.Protocol == "replicate" || channel.Protocol == "wavespeed" {
		models := []string{}
		for _, spec := range SupportedReplicateModels() {
			if spec.Protocol == "wavespeed" {
				if channel.Protocol == "wavespeed" {
					models = append(models, spec.Model)
				}
				continue
			}
			if channel.Protocol == "replicate" {
				models = append(models, spec.Model)
			}
		}
		return models, nil
	}
	request, err := http.NewRequest(http.MethodGet, BuildModelChannelURL(channel, "/models"), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return nil, safeMessageError{message: "读取模型失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		if response.StatusCode == http.StatusNotFound && isArkAgentPlanChannel(channel) {
			return nil, safeMessageError{message: "火山方舟 Agent Plan 未提供 OpenAI /models 模型列表接口，请手动填写模型名称，例如 doubao-seedance-2.0。"}
		}
		return nil, readAdminChannelError(body, response.StatusCode, "读取模型失败")
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &payload)
	result := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if strings.TrimSpace(item.ID) != "" {
			result = append(result, item.ID)
		}
	}
	sort.Strings(result)
	return result, nil
}

func testAdminChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	body, _ := json.Marshal(map[string]any{
		"model":  modelName,
		"input":  "hi",
		"stream": false,
	})
	request, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/responses"), strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", adminTextRequestError("/responses", err)
	}
	responseBody, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		_, statusCode, fallbackErr := testAdminChatCompletions(channel, modelName)
		if fallbackErr != nil {
			if statusCode == http.StatusNotFound {
				return "", safeMessageError{message: "测试失败：渠道同时缺少 /responses 和 /chat/completions 接口（404）"}
			}
			return "", fallbackErr
		}
		return "渠道未提供 /responses，已通过 /chat/completions 兼容测试；画布文本生成会自动转换请求。", nil
	}
	if response.StatusCode >= http.StatusBadRequest {
		return "", readAdminChannelError(responseBody, response.StatusCode, "/responses 测试失败")
	}
	var payload struct {
		Output []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	_ = json.Unmarshal(responseBody, &payload)
	for _, item := range payload.Output {
		for _, content := range item.Content {
			if content.Type == "output_text" && strings.TrimSpace(content.Text) != "" {
				return content.Text, nil
			}
		}
	}
	return "Responses API 测试通过", nil
}

func testAdminChatCompletions(channel model.ModelChannel, modelName string) (string, int, error) {
	body, _ := json.Marshal(map[string]any{
		"model": modelName,
		"messages": []map[string]string{{
			"role":    "user",
			"content": "hi",
		}},
	})
	request, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/chat/completions"), strings.NewReader(string(body)))
	if err != nil {
		return "", 0, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", 0, adminTextRequestError("/chat/completions", err)
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return "", response.StatusCode, readAdminChannelError(responseBody, response.StatusCode, "/chat/completions 兼容测试失败")
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(responseBody, &payload)
	if len(payload.Choices) > 0 && strings.TrimSpace(payload.Choices[0].Message.Content) != "" {
		return payload.Choices[0].Message.Content, response.StatusCode, nil
	}
	return "ok", response.StatusCode, nil
}

func adminTextRequestError(endpoint string, err error) error {
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &networkError) && networkError.Timeout() {
		return safeMessageError{message: fmt.Sprintf("测试失败：%s 请求超时", endpoint)}
	}
	return safeMessageError{message: fmt.Sprintf("测试失败：%s 上游接口无响应或网络不可达", endpoint)}
}

func testVideoChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	models, err := fetchAdminChannelModels(channel)
	if err != nil {
		return "", err
	}
	for _, item := range models {
		if strings.TrimSpace(item) == strings.TrimSpace(modelName) {
			return "视频模型配置已通过：/models 鉴权成功并确认模型存在。后台测试不会创建视频任务，因此不会消耗额度；请在视频创作页验证实际生成。", nil
		}
	}
	return "", safeMessageError{message: fmt.Sprintf("测试失败：/models 未返回模型 %s，请检查该渠道的模型权限或模型名", modelName)}
}

func testArkSeedanceChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	if strings.TrimSpace(channel.BaseURL) == "" {
		return "", safeMessageError{message: "缺少接口地址"}
	}
	if strings.TrimSpace(channel.APIKey) == "" {
		return "", safeMessageError{message: "缺少 API Key"}
	}
	if !isArkAgentPlanChannel(channel) {
		return "Seedance 视频模型不会发送 /chat/completions 文本测试。已检查 Base URL、API Key 和模型名非空；未调用视频生成接口，因此未验证套餐额度或模型权限。", nil
	}
	return "Agent Plan / Seedance 视频模型配置格式已通过。后台测试不会调用视频生成接口，因此未验证 API Key、套餐额度或模型权限；请在画布中使用视频生成验证。", nil
}

func readAdminChannelError(body []byte, statusCode int, fallback string) error {
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg string `json:"msg"`
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
			return safeMessageError{message: payload.Error.Message}
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return safeMessageError{message: payload.Msg}
		}
	}
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return safeMessageError{message: fmt.Sprintf("上游接口鉴权失败（%d），请检查 API Key、套餐权限或模型权限", statusCode)}
	}
	if statusCode == http.StatusTooManyRequests {
		return safeMessageError{message: "上游接口限流或额度不足（429），请稍后重试或检查额度"}
	}
	if statusCode > 0 {
		return safeMessageError{message: fmt.Sprintf("%s：%d", fallback, statusCode)}
	}
	return safeMessageError{message: fallback}
}

type safeMessageError struct {
	message string
}

func (err safeMessageError) Error() string {
	return err.message
}

func (err safeMessageError) SafeMessage() string {
	return err.message
}

func modelChannelsForModel(channels []model.ModelChannel, modelName string) []model.ModelChannel {
	return modelChannelsForGroup(channels, modelName, "")
}

func modelChannelsForGroup(channels []model.ModelChannel, modelName string, userGroup string) []model.ModelChannel {
	result := []model.ModelChannel{}
	for _, channel := range channels {
		if channel.Protocol == "replicate" || channel.Protocol == "wavespeed" || !channel.Enabled || channel.BaseURL == "" || channel.APIKey == "" {
			continue
		}
		if userGroup != "" && len(channel.AllowedGroups) > 0 && !containsString(channel.AllowedGroups, userGroup) {
			continue
		}
		for _, item := range channel.Models {
			if modelName == "" || strings.TrimSpace(item) == modelName {
				result = append(result, channel)
				break
			}
		}
	}
	return result
}

func modelGroupAccessError(modelName string, userGroup string, groups map[string]model.UserGroup, contact model.AdminContactSetting) error {
	groupKey := strings.TrimSpace(userGroup)
	if groupKey == "" {
		groupKey = "default"
	}
	groupName := groupKey
	if group, ok := groups[groupKey]; ok && strings.TrimSpace(group.Name) != "" {
		groupName = strings.TrimSpace(group.Name)
	}
	message := fmt.Sprintf("当前模型 %s 未向你所在的「%s（%s）」分组开放，请联系管理员开通该模型的访问权限", modelName, groupName, groupKey)
	if note := strings.TrimSpace(contact.Note); note != "" {
		message += "。" + note
	}
	if qq := strings.TrimSpace(contact.QQ); qq != "" {
		message += "。管理员 QQ：" + qq
	}
	return safeMessageError{message: message}
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if strings.TrimSpace(item) == strings.TrimSpace(target) {
			return true
		}
	}
	return false
}

func UserGroupRatio(userGroup string) (float64, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return 0, err
	}
	group := strings.TrimSpace(userGroup)
	if group == "" {
		group = "default"
	}
	item, ok := normalizePrivateSetting(settings.Private).Groups[group]
	if !ok || !item.Enabled {
		return 0, safeMessageError{message: "用户分组不可用"}
	}
	return item.CreditRatio, nil
}
