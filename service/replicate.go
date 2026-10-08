package service

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"math"
	"net/url"
	"strconv"
	"strings"
)

//go:embed replicate-models.json
var replicateModelsJSON []byte

type ReplicateModel struct {
	Operation   string `json:"operation"`
	Label       string `json:"label"`
	Model       string `json:"model"`
	Version     string `json:"version"`
	InputSchema struct {
		Required   []string                  `json:"required"`
		Properties map[string]map[string]any `json:"properties"`
	} `json:"inputSchema"`
	Enums map[string][]any `json:"enums"`
}

type ReplicateQuote struct {
	Operation           string  `json:"operation"`
	Label               string  `json:"label"`
	Model               string  `json:"model"`
	Credits             int     `json:"credits"`
	Description         string  `json:"description"`
	BillingMode         string  `json:"billingMode"`
	BillingDescription  string  `json:"billingDescription"`
	PricingSnapshot     string  `json:"pricingSnapshot"`
	Configured          bool    `json:"configured"`
	Available           bool    `json:"available"`
	Reason              string  `json:"reason,omitempty"`
	UnitCredits         int     `json:"unitCredits"`
	MinimumCredits      int     `json:"minimumCredits"`
	BillableUnits       int     `json:"billableUnits"`
	DurationSeconds     float64 `json:"durationSeconds,omitempty"`
	UsedDefaultDuration bool    `json:"usedDefaultDuration"`
	Calculation         string  `json:"calculation,omitempty"`
	SubmissionBlocked   string  `json:"submissionBlocked,omitempty"`
}

func ReplicateModels() []ReplicateModel {
	var items []ReplicateModel
	_ = json.Unmarshal(replicateModelsJSON, &items)
	// 字幕去除复用已配置的 Wan VideoEdit 模型和价格，不另存一份 Replicate 凭据。
	for _, item := range items {
		if item.Operation == "video-edit" {
			alias := item
			alias.Operation = "subtitle-remove"
			alias.Label = "硬字幕去除"
			items = append(items, alias)
			break
		}
	}
	return items
}
func FindReplicateModel(operation string) (ReplicateModel, error) {
	for _, item := range ReplicateModels() {
		if item.Operation == operation {
			return item, nil
		}
	}
	return ReplicateModel{}, fmt.Errorf("未支持的云模型功能")
}
func QuoteReplicate(user model.AuthUser, spec ReplicateModel, input map[string]any) (ReplicateQuote, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return ReplicateQuote{}, err
	}
	settings.Private = normalizePrivateSetting(settings.Private)
	pricing, configured := settings.Private.Replicate.Pricing[spec.Model]
	if pricing.Version != "" && pricing.Version != spec.Version {
		configured = false
	}
	quote := ReplicateQuote{Operation: spec.Operation, Label: spec.Label, Model: spec.Model, Description: replicateDescription(spec.Operation), BillingMode: pricing.BillingMode, BillingDescription: replicateBillingDescription(spec.Operation)}
	if configured && pricing.Enabled {
		billingInput, duration := replicatePricingInput(user.ID, spec, input)
		credits, priceErr := calculateReplicateCredits(pricing, billingInput)
		if priceErr != nil {
			return quote, priceErr
		}
		quote.Credits = credits
		quote.UnitCredits = pricing.UnitCredits
		quote.MinimumCredits = pricing.MinimumCredits
		quote.DurationSeconds = duration
		quote.BillableUnits = 1
		switch pricing.BillingMode {
		case "input_characters":
			characters := len([]rune(strings.TrimSpace(replicateString(billingInput["text"]))))
			quote.BillableUnits = int(math.Max(1, math.Ceil(float64(characters)/1000)))
			quote.Calculation = fmt.Sprintf("%d 个字符，按 %d 个千字档 × %d 点计算", characters, quote.BillableUnits, pricing.UnitCredits)
		case "output_count":
			quote.UnitCredits = replicateTierPrice(pricing, billingInput)
			if frames, ok := replicateNumber(billingInput["num_frames"]); ok {
				quote.DurationSeconds = frames / 16
			}
			quote.Calculation = fmt.Sprintf("1 条视频 × %d 点", quote.UnitCredits)
			if spec.Operation == "hailuo-video" {
				quote.DurationSeconds, _ = replicateNumber(billingInput["duration"])
				quote.Calculation = fmt.Sprintf("%s · %g 秒：1 条视频 × %d 点", replicateString(billingInput["resolution"]), quote.DurationSeconds, quote.UnitCredits)
			}
		case "input_seconds", "output_seconds", "duration_resolution", "runtime_seconds":
			seconds := replicateDurationUnits(pricing, billingInput)
			quote.BillableUnits = seconds
			quote.UsedDefaultDuration = duration <= 0 && billingInput["duration"] == nil
			if pricing.BillingMode == "duration_resolution" {
				quote.UnitCredits = replicateTierPrice(pricing, billingInput)
				if pricing.BlockSeconds > 1 {
					quote.BillableUnits = int(math.Ceil(float64(seconds) / float64(pricing.BlockSeconds)))
				}
			}
			if pricing.BillingMode == "duration_resolution" && pricing.BlockSeconds > 1 {
				quote.Calculation = fmt.Sprintf("素材不足整秒先向上取整为 %d 秒，再按每 %d 秒一档：%d 档 × %d 点", seconds, pricing.BlockSeconds, quote.BillableUnits, quote.UnitCredits)
			} else {
				quote.Calculation = fmt.Sprintf("不足 1 秒按 1 秒计算：%d 秒 × %d 点/秒", seconds, quote.UnitCredits)
			}
			if quote.UsedDefaultDuration {
				quote.Calculation = fmt.Sprintf("无法读取素材时长，采用后台备用时长 %d 秒；", seconds) + quote.Calculation
			}
		}
		if quote.BillableUnits*quote.UnitCredits < pricing.MinimumCredits {
			quote.Calculation += fmt.Sprintf("；按单次最低 %d 点收取", pricing.MinimumCredits)
		}
		snapshot, _ := json.Marshal(pricing)
		quote.PricingSnapshot = string(snapshot)
	} else {
		configured = false
	}
	quote.Configured = configured
	token, err := ReplicateAPIKey()
	if err != nil {
		return quote, err
	}
	if token == "" {
		quote.Reason = "管理员尚未配置 Replicate"
		return quote, nil
	}
	if spec.Operation == "transcribe" && !configured {
		quote.Reason = "云端语音识别尚未启用或计费配置需更新，请管理员在后台设置识别价格并启用；已有服务密钥可以复用。"
		return quote, nil
	}
	if !configured && user.Role != "admin" {
		quote.Reason = "管理员尚未配置该模型的算力点价格，普通用户暂不可用"
		return quote, nil
	}
	if !configured {
		quote.Reason = "管理员测试：该模型价格未配置或版本已变化"
		return quote, nil
	}
	ratio, err := UserGroupRatio(user.Group)
	if err != nil {
		return quote, err
	}
	quote.Credits = int(math.Ceil(float64(quote.Credits) * ratio))
	if ratio != 1 {
		quote.Calculation += fmt.Sprintf("；用户分组倍率 %g", ratio)
	}
	quote.Available = true
	base, _ := url.Parse(config.Cfg.PublicBaseURL)
	for key, value := range input {
		field := spec.InputSchema.Properties[key]
		if value != nil && (field["format"] == "uri" || field["type"] == "array") && (base == nil || base.Scheme != "https") {
			quote.SubmissionBlocked = "当前素材使用本地 HTTP 地址，可查看报价；服务器配置公开可访问的 HTTPS 素材地址后才能提交云模型。"
			break
		}
	}
	return quote, nil
}

func replicateDescription(operation string) string {
	switch operation {
	case "transcribe":
		return "将视频中的人声转为可编辑原文，识别在云端运行，无需本机加载语音模型"
	case "speech":
		return "文字转语音，支持预设音色、声音克隆和声音设计"
	case "digital-human":
		return "上传人物照片和语音，生成会说话的数字人视频"
	case "lipsync":
		return "让已有视频中的人物口型与新音频同步"
	case "replace-person":
		return "将视频中的人物替换为指定角色并保留动作"
	case "upscale":
		return "提升视频清晰度，可输出 720p、1080p 或 4K"
	case "image-to-video":
		return "让静态图片按照文字描述生成动态短视频"
	case "hailuo-video":
		return "Hailuo 2.3 支持纯文字生成视频，也可上传一张首帧图；768p 支持 6/10 秒，1080p 仅支持 6 秒"
	case "video-edit":
		return "用文字修改视频中的时间、天气、背景和视觉风格"
	case "subtitle-remove":
		return "根据手动框选区域去除硬字幕，并请求保留原音轨"
	case "masked-edit":
		return "通过掩膜指定区域，局部修改人物、物体或背景"
	default:
		return "使用云端模型处理媒体素材"
	}
}

func replicateBillingDescription(operation string) string {
	switch operation {
	case "transcribe":
		return "本站按输入音频秒数报价；供应商按模型运行时间计费，两者分别核算"
	case "speech":
		return "按输入字符数计费，最低 100 算力点"
	case "digital-human":
		return "按输出视频秒数计费"
	case "lipsync":
		return "按输出视频秒数计费"
	case "replace-person":
		return "按输出秒数和分辨率计费"
	case "upscale":
		return "按视频时长、输出分辨率和帧率计费"
	case "image-to-video":
		return "按视频版本、分辨率和输出条数计费"
	case "hailuo-video":
		return "按分辨率、时长档位收取每条视频费用"
	case "video-edit":
		return "按输出视频秒数计费"
	case "subtitle-remove":
		return "按输出视频秒数计费，当前模型限制视频为 2–10 秒"
	case "masked-edit":
		return "按模型运行时间计费"
	default:
		return "按模型价格规则计费"
	}
}

func defaultReplicatePricing(spec ReplicateModel) model.ReplicatePricing {
	pricing := model.ReplicatePricing{Model: spec.Model, Version: spec.Version, MinimumCredits: 100, DefaultUnits: 1, Enabled: true, Tiers: map[string]int{}}
	switch spec.Operation {
	case "transcribe":
		pricing.BillingMode = "input_seconds"
		pricing.UnitCredits, pricing.MinimumCredits = 0, 0
		pricing.Enabled = false
	case "speech":
		pricing.BillingMode = "input_characters"
		pricing.UnitCredits = 70
	case "digital-human":
		pricing.BillingMode = "output_seconds"
		pricing.UnitCredits = 70
		pricing.DefaultUnits = 8
	case "lipsync":
		pricing.BillingMode = "output_seconds"
		pricing.UnitCredits = 180
		pricing.DefaultUnits = 60
	case "replace-person":
		pricing.BillingMode = "duration_resolution"
		pricing.UnitCredits = 180
		pricing.DefaultUnits = 10
		pricing.BlockSeconds = 1
		pricing.Tiers["480"] = 70
		pricing.Tiers["720"] = 180
	case "upscale":
		pricing.BillingMode = "duration_resolution"
		pricing.DefaultUnits = 60
		pricing.BlockSeconds = 5
		pricing.Tiers = map[string]int{"720p:30": 100, "720p:60": 190, "1080p:30": 330, "1080p:60": 660, "4k:30": 1310, "4k:60": 2620}
	case "image-to-video":
		pricing.BillingMode = "output_count"
		pricing.UnitCredits = 180
		pricing.Tiers = map[string]int{"base:480p": 180, "interpolate:480p": 230, "base:720p": 390, "interpolate:720p": 510}
	case "hailuo-video":
		pricing.BillingMode = "output_count"
		pricing.UnitCredits = 800
		pricing.Tiers = map[string]int{"768p:6": 800, "768p:10": 1600, "1080p:6": 1400}
	case "video-edit":
		pricing.BillingMode = "output_seconds"
		pricing.UnitCredits = 350
		pricing.DefaultUnits = 10
	case "subtitle-remove":
		pricing.BillingMode = "output_seconds"
		pricing.UnitCredits = 350
		pricing.DefaultUnits = 10
	case "masked-edit":
		pricing.BillingMode = "runtime_seconds"
		pricing.UnitCredits = 6
		pricing.DefaultUnits = 60
		pricing.Enabled = false
	default:
		pricing.BillingMode = "fixed"
		pricing.UnitCredits = 100
	}
	return pricing
}

func normalizeReplicatePricing(setting model.ReplicateSetting) model.ReplicateSetting {
	if setting.Pricing == nil {
		setting.Pricing = map[string]model.ReplicatePricing{}
	}
	for _, spec := range ReplicateModels() {
		pricing, ok := setting.Pricing[spec.Model]
		if !ok {
			if legacy, exists := setting.ModelCredits[spec.Operation]; exists && legacy != nil {
				pricing = defaultReplicatePricing(spec)
				pricing.BillingMode = "fixed"
				pricing.UnitCredits = *legacy
				pricing.MinimumCredits = 0
			} else {
				pricing = defaultReplicatePricing(spec)
			}
		}
		defaults := defaultReplicatePricing(spec)
		if pricing.Model == "" {
			pricing.Model = spec.Model
		}
		if pricing.Version == "" {
			pricing.Version = spec.Version
		}
		if pricing.BillingMode == "" {
			pricing.BillingMode = defaults.BillingMode
		}
		if pricing.Tiers == nil {
			pricing.Tiers = defaults.Tiers
		}
		if pricing.DefaultUnits <= 0 {
			pricing.DefaultUnits = defaults.DefaultUnits
		}
		if pricing.BlockSeconds <= 0 {
			pricing.BlockSeconds = defaults.BlockSeconds
		}
		if pricing.MinimumCredits < 0 {
			pricing.MinimumCredits = 0
		}
		if pricing.UnitCredits < 0 {
			pricing.UnitCredits = 0
		}
		setting.Pricing[spec.Model] = pricing
	}
	return setting
}

func calculateReplicateCredits(pricing model.ReplicatePricing, input map[string]any) (int, error) {
	units := 1
	unitCredits := pricing.UnitCredits
	switch pricing.BillingMode {
	case "input_characters":
		units = int(math.Ceil(float64(len([]rune(strings.TrimSpace(fmt.Sprint(input["text"]))))) / 1000))
		if units < 1 {
			units = 1
		}
	case "input_seconds", "output_seconds":
		units = replicateDurationUnits(pricing, input)
	case "duration_resolution":
		units = replicateDurationUnits(pricing, input)
		if pricing.BlockSeconds > 1 {
			units = int(math.Ceil(float64(units) / float64(pricing.BlockSeconds)))
		}
		unitCredits = replicateTierPrice(pricing, input)
	case "output_count":
		units = 1
		unitCredits = replicateTierPrice(pricing, input)
	case "runtime_seconds":
		units = replicateDurationUnits(pricing, input)
		unitCredits = pricing.UnitCredits
	case "fixed":
		units = 1
	default:
		return 0, fmt.Errorf("不支持的 Replicate 计费方式 %s", pricing.BillingMode)
	}
	if units <= 0 {
		units = pricing.DefaultUnits
	}
	if units <= 0 {
		units = 1
	}
	credits := units * unitCredits
	if credits < pricing.MinimumCredits {
		credits = pricing.MinimumCredits
	}
	return credits, nil
}

func replicateDurationUnits(pricing model.ReplicatePricing, input map[string]any) int {
	for _, key := range []string{"durationSeconds", "duration", "output_seconds"} {
		if value, ok := replicateNumber(input[key]); ok && value > 0 {
			return int(math.Ceil(value))
		}
	}
	for _, key := range []string{"num_frames_per_chunk", "num_frames", "frame_num"} {
		if value, ok := replicateNumber(input[key]); ok && value > 0 {
			return int(math.Ceil(value / 16))
		}
	}
	return pricing.DefaultUnits
}

func replicateTierPrice(pricing model.ReplicatePricing, input map[string]any) int {
	if len(pricing.Tiers) == 0 {
		return pricing.UnitCredits
	}
	keys := []string{}
	if pricing.Model == "minimax/hailuo-2.3" {
		resolution, duration := replicateString(input["resolution"]), replicateString(input["duration"])
		if resolution == "" {
			resolution = "768p"
		}
		if duration == "" {
			duration = "6"
		}
		keys = append(keys, resolution+":"+duration)
	}
	if resolution := replicateString(input["resolution"]); resolution != "" {
		variant := replicateString(input["variant"])
		if variant == "" {
			variant = "base"
			if input["interpolate_output"] == true {
				variant = "interpolate"
			}
		}
		keys = append(keys, variant+":"+resolution)
	}
	resolution := replicateString(input["target_resolution"])
	if resolution == "" {
		resolution = replicateString(input["resolution"])
	}
	fps := replicateString(input["target_fps"])
	if value, ok := replicateNumber(input["target_fps"]); ok {
		if value <= 30 {
			fps = "30"
		} else {
			fps = "60"
		}
	}
	if resolution != "" && fps != "" {
		keys = append(keys, resolution+":"+fps)
	}
	if resolution != "" {
		keys = append(keys, resolution)
	}
	for _, key := range keys {
		if value, ok := pricing.Tiers[key]; ok {
			return value
		}
	}
	max := pricing.UnitCredits
	for _, value := range pricing.Tiers {
		if value > max {
			max = value
		}
	}
	return max
}

func replicateString(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

// Pricing metadata comes from owned uploads. Never forward it as model input.
func replicatePricingInput(userID string, spec ReplicateModel, input map[string]any) (map[string]any, float64) {
	result := map[string]any{}
	for key, value := range input {
		result[key] = value
	}
	if spec.Operation == "hailuo-video" {
		if result["resolution"] == nil {
			result["resolution"] = "768p"
		}
		if result["duration"] == nil {
			result["duration"] = float64(6)
		}
	}
	keys := []string{"video"}
	if spec.Operation == "digital-human" || spec.Operation == "transcribe" {
		keys = []string{"audio"}
	}
	if spec.Operation == "lipsync" {
		keys = []string{"audio", "video"}
	}
	base, _ := url.Parse(config.Cfg.PublicBaseURL)
	basePath := ""
	if base != nil {
		basePath = base.Path
	}
	duration := 0.0
	for _, key := range keys {
		address, err := url.Parse(replicateString(input[key]))
		if err != nil || address.Path == "" {
			continue
		}
		prefix := strings.TrimRight(basePath, "/") + "/api/media/references/"
		if !strings.HasPrefix(address.Path, prefix) {
			continue
		}
		id := strings.TrimPrefix(address.Path, prefix)
		owner, found, err := repository.GetReferenceMediaOwner(id)
		if err == nil && found && owner.UserID == userID && owner.DurationSeconds > duration {
			duration = owner.DurationSeconds
		}
	}
	if spec.Operation == "video-edit" {
		if value, ok := replicateNumber(input["duration"]); ok && value > 0 {
			duration = value
		}
	}
	if duration > 0 {
		result["durationSeconds"] = duration
	}
	return result, duration
}

func replicateNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, true
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(number), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

// Validate only the published fields used by these pinned model versions.
func ValidateReplicateInput(userID string, spec ReplicateModel, input map[string]any) error {
	return validateReplicateInput(userID, spec, input, true)
}

// Quotes stay local and can inspect owned HTTP uploads; cloud submission still requires HTTPS.
func ValidateReplicateQuoteInput(userID string, spec ReplicateModel, input map[string]any) error {
	return validateReplicateInput(userID, spec, input, false)
}

func validateReplicateInput(userID string, spec ReplicateModel, input map[string]any, submitting bool) error {
	for _, key := range spec.InputSchema.Required {
		value, exists := input[key]
		if !exists || value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
			return fmt.Errorf("缺少模型参数 %s", key)
		}
	}
	if spec.Operation == "speech" && input["mode"] == "voice_clone" {
		if strings.TrimSpace(fmt.Sprint(input["reference_audio"])) == "" || input["reference_audio"] == nil {
			return fmt.Errorf("声音克隆需要上传声音样本")
		}
	}
	if spec.Operation == "masked-edit" && (input["src_video"] == nil || input["src_mask"] == nil) {
		return fmt.Errorf("掩膜编辑需要原视频及掩膜")
	}
	if spec.Operation == "hailuo-video" && input["resolution"] == "1080p" && replicateString(input["duration"]) == "10" {
		return fmt.Errorf("Hailuo 1080p 仅支持 6 秒，请选择 768p 制作 10 秒视频")
	}
	for key, value := range input {
		field, exists := spec.InputSchema.Properties[key]
		if !exists {
			return fmt.Errorf("模型不支持参数 %s", key)
		}
		if value == nil {
			if field["nullable"] == true {
				continue
			}
			return fmt.Errorf("参数 %s 不能为空", key)
		}
		switch field["type"] {
		case "string":
			if _, ok := value.(string); !ok {
				return fmt.Errorf("参数 %s 需要文字或素材地址", key)
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("参数 %s 需要布尔值", key)
			}
		case "integer", "number":
			number, ok := value.(float64)
			if !ok || (field["type"] == "integer" && number != math.Trunc(number)) {
				return fmt.Errorf("参数 %s 的数字格式不正确", key)
			}
			if lower, ok := field["minimum"].(float64); ok && number < lower {
				return fmt.Errorf("模型参数 %s 最小为 %v", key, lower)
			}
			if upper, ok := field["maximum"].(float64); ok && number > upper {
				return fmt.Errorf("模型参数 %s 最大为 %v", key, upper)
			}
		}
		if refs, ok := field["allOf"].([]any); ok {
			for _, entry := range refs {
				reference, _ := entry.(map[string]any)
				pointer, _ := reference["$ref"].(string)
				if values, ok := spec.Enums[strings.TrimPrefix(pointer, "#/components/schemas/")]; ok {
					allowed := false
					for _, choice := range values {
						if fmt.Sprint(choice) == fmt.Sprint(value) {
							allowed = true
							break
						}
					}
					if !allowed {
						return fmt.Errorf("参数 %s 不在该模型支持的选项中", key)
					}
				}
			}
		}
		if values, ok := field["enum"].([]any); ok {
			allowed := false
			for _, choice := range values {
				if fmt.Sprint(choice) == fmt.Sprint(value) {
					allowed = true
					break
				}
			}
			if !allowed {
				return fmt.Errorf("参数 %s 不在该模型支持的选项中", key)
			}
		}
		if field["format"] == "uri" {
			address, _ := value.(string)
			if err := validateReplicateReference(userID, address, key, submitting); err != nil {
				return err
			}
		}
		if field["type"] == "array" {
			values, ok := value.([]any)
			if !ok {
				return fmt.Errorf("参数 %s 需要素材列表", key)
			}
			for _, entry := range values {
				address, ok := entry.(string)
				if !ok {
					return fmt.Errorf("参数 %s 的素材格式不正确", key)
				}
				if err := validateReplicateReference(userID, address, key, submitting); err != nil {
					return err
				}
			}
		}
	}
	if spec.Operation == "transcribe" {
		_, duration := replicatePricingInput(userID, spec, input)
		if duration <= 0 {
			return fmt.Errorf("无法读取识别音频时长，请重新上传素材或检查 FFprobe 配置")
		}
	}
	return nil
}

func validateReplicateReference(userID, address, key string, submitting bool) error {
	base, err := url.Parse(strings.TrimRight(config.Cfg.PublicBaseURL, "/"))
	if err != nil || base.Host == "" {
		return fmt.Errorf("服务器需要配置公开素材地址")
	}
	parsed, err := url.Parse(address)
	prefix := strings.TrimRight(base.Path, "/") + "/api/media/references/"
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Scheme != base.Scheme || parsed.Host != base.Host || parsed.User != nil || parsed.RawQuery != "" || !strings.HasPrefix(parsed.Path, prefix) {
		return fmt.Errorf("参数 %s 需要上传到本站的素材", key)
	}
	if submitting && parsed.Scheme != "https" {
		return fmt.Errorf("云模型需要公开 HTTPS 素材地址，请配置服务器 PUBLIC_BASE_URL；本地可查看报价")
	}
	id := strings.TrimPrefix(parsed.Path, prefix)
	if id == "" || strings.Contains(id, "/") {
		return fmt.Errorf("素材地址无效")
	}
	item, found, err := repository.GetReferenceMediaOwner(id)
	if err != nil {
		return err
	}
	if !found || item.UserID != userID {
		return fmt.Errorf("参数 %s 的素材不存在或不属于当前用户，请重新上传", key)
	}
	expected := "image/"
	switch key {
	case "audio", "reference_audio":
		expected = "audio/"
	case "video", "src_video":
		expected = "video/"
	case "src_mask":
		if strings.HasPrefix(item.MimeType, "video/") {
			expected = "video/"
		}
	}
	if !strings.HasPrefix(item.MimeType, expected) {
		return fmt.Errorf("参数 %s 的素材类型不正确", key)
	}
	return nil
}
