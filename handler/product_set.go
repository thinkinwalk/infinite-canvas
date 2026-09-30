package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

type productSetInput struct {
	Images               []string         `json:"images"`
	Platform             string           `json:"platform"`
	Market               string           `json:"market"`
	Language             string           `json:"language"`
	ProductBrief         string           `json:"productBrief"`
	StyleMode            string           `json:"styleMode"`
	StyleText            string           `json:"styleText"`
	StyleReferenceImages []string         `json:"styleReferenceImages"`
	LayoutMode           string           `json:"layoutMode"`
	CustomLayout         string           `json:"customLayout"`
	TargetImageCount     int              `json:"targetImageCount"`
	CardIDs              []string         `json:"cardIds"`
	PlanCards            []productSetCard `json:"planCards"`
}

type productSetPlanRequest struct {
	Inputs productSetInput `json:"inputs"`
}

type productSetAnalyzeRequest struct {
	Inputs productSetInput `json:"inputs"`
}

type productSetRunRequest struct {
	Inputs productSetInput `json:"inputs"`
}

type productSetCard struct {
	ID          string `json:"id"`
	Category    string `json:"category,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description"`
	AspectRatio string `json:"aspectRatio"`
}

type productSetResult struct {
	CardID      string `json:"cardId"`
	Category    string `json:"category,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Data        any    `json:"data,omitempty"`
	Error       string `json:"error,omitempty"`
}

var productSetCards = []productSetCard{
	{ID: "white-background", Title: "白底主图", Description: "突出商品本体，背景干净，适合平台主图规范。", AspectRatio: "1:1"},
	{ID: "brand-hero", Title: "品牌主视觉海报", Description: "建立品牌氛围和第一视觉记忆点。", AspectRatio: "1:1"},
	{ID: "selling-point", Title: "核心卖点海报", Description: "用一张图清楚表达商品最重要的购买理由。", AspectRatio: "1:1"},
	{ID: "material-structure", Title: "材质与结构说明图", Description: "展示材质、结构和使用方式，减少购买疑虑。", AspectRatio: "4:3"},
	{ID: "craft-detail", Title: "工艺细节图", Description: "聚焦工艺、纹理和细节质感。", AspectRatio: "1:1"},
	{ID: "spec-quality", Title: "规格与品质信任图", Description: "表达规格、品质和可信赖的产品信息。", AspectRatio: "4:3"},
	{ID: "lifestyle", Title: "真实使用场景图", Description: "把商品放入真实生活场景，帮助用户理解使用价值。", AspectRatio: "4:3"},
	{ID: "closing-value", Title: "收官价值视觉图", Description: "总结核心价值并形成购买行动引导。", AspectRatio: "1:1"},
	{ID: "comparison-proof", Title: "对比与效果说明图", Description: "用清晰对比和结果信息强化购买信心。", AspectRatio: "4:3"},
	{ID: "size-guide", Title: "尺寸与适配指南图", Description: "补充尺寸、适配范围和选购建议。", AspectRatio: "4:3"},
	{ID: "how-to-use", Title: "使用步骤图", Description: "按步骤展示商品的安装、操作或保养方法。", AspectRatio: "4:3"},
	{ID: "package-list", Title: "包装清单图", Description: "展示包装内容和配件，降低收货后的不确定感。", AspectRatio: "1:1"},
	{ID: "trust-service", Title: "服务保障图", Description: "表达售后、质保和配送承诺，完成转化闭环。", AspectRatio: "1:1"},
	{ID: "brand-story", Title: "品牌故事图", Description: "补充品牌理念和产品价值，增强记忆与信任。", AspectRatio: "1:1"},
	{ID: "campaign-banner", Title: "活动转化海报", Description: "突出优惠或活动信息，引导用户完成购买。", AspectRatio: "1:1"},
	{ID: "final-call-to-action", Title: "最终购买引导图", Description: "收束卖点并给出简洁明确的行动提示。", AspectRatio: "1:1"},
}

type productSetStyle struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

var productSetStyles = []productSetStyle{
	{ID: "clean-commerce", Title: "干净高级电商", Description: "明亮留白、柔和光线、突出商品材质和轮廓。"},
	{ID: "warm-lifestyle", Title: "温暖生活方式", Description: "自然光和真实使用场景，适合生活方式类商品。"},
	{ID: "premium-editorial", Title: "高端品牌画册", Description: "克制构图、质感光影和品牌化视觉语言。"},
}

type productSetOption struct {
	Label        string   `json:"label"`
	Value        string   `json:"value"`
	IsDefault    bool     `json:"isDefault,omitempty"`
	MarketValues []string `json:"marketValues,omitempty"`
}

type productSetExample struct {
	Title string `json:"title"`
	Src   string `json:"src"`
}

// ProductSetConfig exposes only public workspace options. Prompt templates and
// model routing remain private in the server runtime configuration.
func ProductSetConfig(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/api/cases/"))
	id = strings.TrimSuffix(id, "/product-set/config")
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || item.ID != "official-product-grid" {
		Fail(w, "商品套图案例不存在")
		return
	}
	platforms := []productSetOption{
		{Label: "淘宝", Value: "淘宝", IsDefault: true, MarketValues: []string{"中国"}},
		{Label: "抖音", Value: "抖音", MarketValues: []string{"中国"}},
		{Label: "小红书", Value: "小红书", MarketValues: []string{"中国"}},
		{Label: "TikTok Shop", Value: "TikTok Shop", MarketValues: []string{"us", "eu", "sea", "日本", "韩国", "南非", "新加坡"}},
		{Label: "Amazon", Value: "Amazon", MarketValues: []string{"us", "eu", "sea", "日本", "韩国", "南非", "新加坡"}},
		{Label: "Temu", Value: "Temu", MarketValues: []string{"us", "eu", "sea", "日本", "韩国", "南非", "新加坡"}},
		{Label: "拼多多", Value: "拼多多", MarketValues: []string{"中国"}},
		{Label: "京东", Value: "京东", MarketValues: []string{"中国"}},
		{Label: "阿里国际站", Value: "阿里国际站", MarketValues: []string{"新加坡", "南非", "韩国", "日本", "sea", "eu", "us"}},
		{Label: "OZON", Value: "OZON", MarketValues: []string{"俄罗斯"}},
		{Label: "阿里巴巴", Value: "阿里巴巴"},
	}
	markets := []productSetOption{
		{Label: "中国", Value: "中国", IsDefault: true},
		{Label: "美国", Value: "us"}, {Label: "欧洲", Value: "eu"}, {Label: "东南亚", Value: "sea"},
		{Label: "日本", Value: "日本"}, {Label: "韩国", Value: "韩国"}, {Label: "南非", Value: "南非"},
		{Label: "新加坡", Value: "新加坡"}, {Label: "俄罗斯", Value: "俄罗斯"},
	}
	languages := []productSetOption{
		{Label: "English", Value: "en"}, {Label: "简体中文", Value: "zh-CN", IsDefault: true}, {Label: "日本語", Value: "ja"},
		{Label: "俄语", Value: "俄语"}, {Label: "韩语", Value: "韩语"}, {Label: "法语", Value: "法语"}, {Label: "德语", Value: "德语"},
		{Label: "泰语", Value: "泰语"}, {Label: "巴西语", Value: "巴西语"}, {Label: "西班牙语", Value: "西班牙语"},
		{Label: "越南语", Value: "越南语"}, {Label: "马来西亚语", Value: "马来西亚语"}, {Label: "繁体中文（必须使用2K及以上）", Value: "繁体中文"}, {Label: "无文字", Value: "无文字"},
	}
	examples := []productSetExample{
		{Title: "01 白底主图", Src: "/examples/product-set/01-main.png"},
		{Title: "02 品牌主视觉海报", Src: "/examples/product-set/02-hero.png"},
		{Title: "03 核心卖点海报", Src: "/examples/product-set/03-selling-points.png"},
		{Title: "04 材质与结构说明图", Src: "/examples/product-set/04-structure.png"},
		{Title: "05 工艺细节图", Src: "/examples/product-set/05-details.png"},
		{Title: "06 品质展示图", Src: "/examples/product-set/06-quality.png"},
		{Title: "07 真实使用场景图", Src: "/examples/product-set/07-lifestyle.png"},
		{Title: "08 收官价值视觉图", Src: "/examples/product-set/08-gift.png"},
	}
	OK(w, map[string]any{
		"entry":             map[string]any{"title": item.Title, "description": item.Description, "cover": item.CoverURL},
		"platforms":         platforms,
		"markets":           markets,
		"languages":         languages,
		"examples":          examples,
		"styles":            productSetStyles,
		"targetImageCounts": []int{7, 8},
	})
}

func ProductSetAnalyze(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || item.ID != "official-product-grid" {
		Fail(w, "商品套图案例不存在")
		return
	}
	var request productSetAnalyzeRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "商品套图参数格式无效")
		return
	}
	if len(request.Inputs.Images) < 1 || len(request.Inputs.Images) > 6 {
		Fail(w, "请上传 1 到 6 张商品图片")
		return
	}
	if strings.TrimSpace(request.Inputs.Platform) == "" || strings.TrimSpace(request.Inputs.Market) == "" || strings.TrimSpace(request.Inputs.Language) == "" {
		Fail(w, "请选择目标平台、市场和语言")
		return
	}
	text, err := productSetTextCompletion(r, item, user, fmt.Sprintf("请分析这些商品参考图，为%s平台、%s市场、%s文案语言生成一段适合电商套图的产品卖点说明。只输出可直接编辑的中文商品信息，包含产品名称、核心卖点、适用人群、使用场景和材质/规格；不要虚构图片中无法确认的参数。", request.Inputs.Platform, request.Inputs.Market, request.Inputs.Language), request.Inputs.Images)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, map[string]string{"productBrief": text})
}

func ProductSetParse(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || item.ID != "official-product-grid" {
		Fail(w, "商品套图案例不存在")
		return
	}
	var request productSetAnalyzeRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "商品套图参数格式无效")
		return
	}
	if len(request.Inputs.Images) < 1 || len(request.Inputs.Images) > 6 {
		Fail(w, "请上传 1 到 6 张商品图片")
		return
	}
	if strings.TrimSpace(request.Inputs.Platform) == "" || strings.TrimSpace(request.Inputs.Market) == "" || strings.TrimSpace(request.Inputs.Language) == "" {
		Fail(w, "请选择目标平台、市场和语言")
		return
	}
	prompt := fmt.Sprintf("你是电商商品分析与视觉设计师。分析参考商品图片，为%s市场的%s平台、%s文案语言生成可编辑的产品信息和3种不同的商品套图设计风格。只返回JSON对象，格式为{\"productBrief\":\"产品名称、核心卖点、适用人群、使用场景和材质规格的说明\",\"styles\":[{\"title\":\"风格名称\",\"description\":\"可直接用于图片生成的详细视觉风格描述\"}]}。不要添加Markdown代码块，不要虚构图片中无法确认的功能和参数。", request.Inputs.Market, request.Inputs.Platform, request.Inputs.Language)
	text, err := productSetTextCompletion(r, item, user, prompt, request.Inputs.Images)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	brief, styles, err := parseProductSetOneClickResult(text)
	if err != nil {
		Fail(w, "一键解析返回格式无效，请重试")
		return
	}
	OK(w, map[string]any{"productBrief": brief, "styles": styles})
}

func ProductSetRecommendStyle(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || item.ID != "official-product-grid" {
		Fail(w, "商品套图案例不存在")
		return
	}
	var request productSetAnalyzeRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "商品套图参数格式无效")
		return
	}
	if strings.TrimSpace(request.Inputs.ProductBrief) == "" {
		Fail(w, "请先输入产品卖点")
		return
	}
	if len(request.Inputs.Images) > 6 {
		Fail(w, "最多上传 6 张商品图片")
		return
	}
	text, err := productSetTextCompletion(r, item, user, fmt.Sprintf("你是电商视觉设计师。根据产品信息为%s市场的%s平台推荐3种不同的商品套图设计风格，文案语言为%s。产品信息：%s。只返回JSON对象，格式为{\"styles\":[{\"title\":\"风格名称\",\"description\":\"可直接用于图片生成的详细视觉风格描述\"}]}。不要解释，不要添加Markdown代码块，不要编造商品参数。", request.Inputs.Market, request.Inputs.Platform, request.Inputs.Language, strings.TrimSpace(request.Inputs.ProductBrief)), request.Inputs.Images)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	styles, err := parseProductSetStyleSuggestions(text)
	if err != nil {
		Fail(w, "AI 风格分析返回格式无效，请重试")
		return
	}
	OK(w, map[string]any{"styles": styles})
}

func productSetTextCompletion(r *http.Request, item model.CaseApp, user model.AuthUser, prompt string, images []string) (string, error) {
	var runtime caseRuntimeConfig
	if err := json.Unmarshal([]byte(item.RuntimeConfig), &runtime); err != nil {
		return "", errors.New("商品套图运行配置无效")
	}
	modelName, err := resolveCaseModel("text", runtime.Model, user.Group)
	if err != nil {
		return "", err
	}
	content := []any{map[string]any{"type": "text", "text": prompt}}
	for _, image := range images {
		content = append(content, map[string]any{"type": "image_url", "image_url": map[string]string{"url": image}})
	}
	body, err := json.Marshal(map[string]any{"model": modelName, "messages": []any{map[string]any{"role": "user", "content": content}}})
	if err != nil {
		return "", errors.New("商品分析请求构造失败")
	}
	internalRequest := httptest.NewRequest(http.MethodPost, "/chat/completions", bytes.NewReader(body))
	internalRequest.Header.Set("Content-Type", "application/json")
	internalRequest = internalRequest.WithContext(service.WithUser(r.Context(), user))
	recorder := httptest.NewRecorder()
	proxyAIRequest(recorder, internalRequest, "/chat/completions")
	text, message, ok := parseProductSetTextResponse(recorder.Code, recorder.Body.Bytes())
	if !ok {
		return "", errors.New(message)
	}
	return text, nil
}

func parseProductSetOneClickResult(text string) (string, []productSetStyle, error) {
	styles, err := parseProductSetStyleSuggestions(text)
	if err != nil {
		return "", nil, err
	}
	var result struct {
		ProductBrief string `json:"productBrief"`
	}
	if err := json.Unmarshal([]byte(productSetJSONText(text)), &result); err != nil {
		return "", nil, err
	}
	brief := strings.TrimSpace(result.ProductBrief)
	if brief == "" {
		return "", nil, errors.New("empty product brief")
	}
	return brief, styles, nil
}

func parseProductSetStyleSuggestions(text string) ([]productSetStyle, error) {
	text = productSetJSONText(text)
	var result struct {
		Styles []productSetStyle `json:"styles"`
	}
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return nil, err
	}
	styles := make([]productSetStyle, 0, len(result.Styles))
	for _, style := range result.Styles {
		style.Title = strings.TrimSpace(style.Title)
		style.Description = strings.TrimSpace(style.Description)
		if style.Title == "" || style.Description == "" {
			continue
		}
		style.ID = fmt.Sprintf("ai-style-%d", len(styles)+1)
		styles = append(styles, style)
	}
	if len(styles) == 0 {
		return nil, errors.New("empty style suggestions")
	}
	return styles, nil
}

func productSetJSONText(text string) string {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```") {
		if index := strings.IndexByte(text, '\n'); index >= 0 {
			text = strings.TrimSpace(strings.TrimSuffix(text[index+1:], "```"))
		}
	}
	return text
}

func ProductSetPlan(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || item.ID != "official-product-grid" {
		Fail(w, "商品套图案例不存在")
		return
	}
	var request productSetPlanRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "商品套图参数格式无效")
		return
	}
	if err := validateProductSetInput(request.Inputs, false); err != nil {
		Fail(w, err.Error())
		return
	}
	baseCards := plannedProductSetCards(request.Inputs)
	structure := make([]map[string]string, 0, len(baseCards))
	for _, card := range baseCards {
		structure = append(structure, map[string]string{"id": card.ID, "category": card.Title, "requirements": productSetCategoryRequirements(card.ID)})
	}
	prompt := fmt.Sprintf("你是电商商品套图策划师。基于商品图片和已确认商品信息，为%s市场的%s平台设计%d张同一商品的完整套图，文案语言为%s。产品信息：%s。整套共享设计风格：%s。按以下图类顺序逐张规划，不可把结构说明、规格、细节等图类改成重复的氛围照片：%s。每张描述应明确商品视角与位置、背景、信息排版、要展示的真实卖点和画面内标题；白底主图不得加文字。所有图片必须保持同一商品和一致的色彩、字体、光线，只改变图类要求的构图。如果上传素材只有动物、人物或景物，且用户未确认售卖的商品，不得擅自当作宠物用品，也不能编造其材质、结构、尺寸或品牌。只返回JSON对象，格式为{\"cards\":[{\"title\":\"该图类的简短商品图名\",\"description\":\"具体构图、信息排版和画面内文案\"}]}，cards数量必须是%d。不输出图片、内部提示词模板或Markdown。", request.Inputs.Market, request.Inputs.Platform, len(baseCards), request.Inputs.Language, strings.TrimSpace(request.Inputs.ProductBrief), strings.TrimSpace(request.Inputs.StyleText), mustJSON(structure), len(baseCards))
	references := append(append([]string{}, request.Inputs.Images...), request.Inputs.StyleReferenceImages...)
	prompt += fmt.Sprintf("参考图前%d张为商品实拍，用来锁定商品；其后的%d张仅参考配色与排版，禁止把后面图片的商品当作本次主体。", len(request.Inputs.Images), len(request.Inputs.StyleReferenceImages))
	text, err := productSetTextCompletion(r, item, user, prompt, references)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	cards, err := parseProductSetPlan(text, baseCards)
	if err != nil {
		Fail(w, "套图方案返回格式无效，请重试")
		return
	}
	OK(w, map[string]any{"cards": cards, "targetImageCount": len(cards)})
}

func ProductSetPlanPrice(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || item.ID != "official-product-grid" {
		Fail(w, "商品套图案例不存在")
		return
	}
	var runtime caseRuntimeConfig
	if err := json.Unmarshal([]byte(item.RuntimeConfig), &runtime); err != nil {
		Fail(w, "商品套图运行配置无效")
		return
	}
	modelName, err := resolveCaseModel("text", runtime.Model, user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	baseCredits, err := service.ModelCost(modelName)
	if err != nil {
		FailError(w, err)
		return
	}
	ratio, err := service.UserGroupRatio(user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"points": int(math.Ceil(float64(baseCredits) * ratio))})
}

func ProductSetImagePrice(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || item.ID != "official-product-grid" {
		Fail(w, "商品套图案例不存在")
		return
	}
	var runtime caseRuntimeConfig
	if err := json.Unmarshal([]byte(item.RuntimeConfig), &runtime); err != nil {
		Fail(w, "商品套图运行配置无效")
		return
	}
	modelName, err := resolveCaseModel("image", runtime.Model, user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	baseCredits, err := service.ModelCost(modelName)
	if err != nil {
		FailError(w, err)
		return
	}
	ratio, err := service.UserGroupRatio(user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"model": modelName, "pointsPerImage": int(math.Ceil(float64(baseCredits) * ratio))})
}

func parseProductSetPlan(text string, baseCards []productSetCard) ([]productSetCard, error) {
	var result struct {
		Cards []productSetCard `json:"cards"`
	}
	if err := json.Unmarshal([]byte(productSetJSONText(text)), &result); err != nil {
		return nil, err
	}
	if len(result.Cards) != len(baseCards) {
		return nil, errors.New("unexpected card count")
	}
	cards := make([]productSetCard, len(baseCards))
	for index, base := range baseCards {
		base.Category = base.Title
		base.Title = strings.TrimSpace(result.Cards[index].Title)
		base.Description = strings.TrimSpace(result.Cards[index].Description)
		if base.Title == "" || base.Description == "" {
			return nil, errors.New("empty card content")
		}
		cards[index] = base
	}
	return cards, nil
}

func ProductSetRun(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, ok, err := service.GetCase(id, true)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || item.ID != "official-product-grid" {
		Fail(w, "商品套图案例不存在")
		return
	}
	var request productSetRunRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "商品套图参数格式无效")
		return
	}
	if err := validateProductSetInput(request.Inputs, true); err != nil {
		Fail(w, err.Error())
		return
	}
	var runtime caseRuntimeConfig
	if err := json.Unmarshal([]byte(item.RuntimeConfig), &runtime); err != nil {
		Fail(w, "商品套图运行配置无效")
		return
	}
	modelName, err := resolveCaseModel("image", runtime.Model, user.Group)
	if err != nil {
		FailError(w, err)
		return
	}
	selected := selectedProductSetCards(request.Inputs)
	if len(selected) == 0 {
		Fail(w, "请选择有效的套图方案后再生成")
		return
	}
	run := model.CaseRun{ID: fmt.Sprintf("case-product-set-%d", nowUnixNano()), CaseID: item.ID, UserID: user.ID, Version: item.PublishedVersion, Status: "pending"}
	run.CreatedAt = serviceNow()
	run.UpdatedAt = run.CreatedAt
	_ = repository.SaveCaseRun(run)
	stream := r.URL.Query().Get("stream") == "1"
	if stream {
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		writeProductSetEvent(w, map[string]any{"type": "start", "total": len(selected)})
	}
	results := make([]productSetResult, 0, len(selected))
	appendResult := func(result productSetResult) {
		for _, card := range selected {
			if card.ID == result.CardID {
				result.Category = card.Category
				break
			}
		}
		results = append(results, result)
		run.ResponseBody = mustJSON(results)
		run.UpdatedAt = serviceNow()
		_ = repository.SaveCaseRun(run)
		if stream {
			writeProductSetEvent(w, map[string]any{"type": "item", "item": result, "completed": len(results), "total": len(selected)})
		}
	}
	for _, card := range selected {
		prompt := productSetPrompt(card, request.Inputs)
		references := append([]string{}, request.Inputs.Images...)
		references = append(references, request.Inputs.StyleReferenceImages...)
		body, err := json.Marshal(map[string]any{
			"model":                modelName,
			"prompt":               prompt,
			"size":                 "1024x1024",
			"quality":              "high",
			"image_url":            request.Inputs.Images[0],
			"reference_image_urls": references,
		})
		if err != nil {
			appendResult(productSetResult{CardID: card.ID, Title: card.Title, Description: card.Description, Error: err.Error()})
			continue
		}
		internalRequest := httptest.NewRequest(http.MethodPost, "/images/generations", bytes.NewReader(body))
		internalRequest.Header.Set("Content-Type", "application/json")
		internalRequest = internalRequest.WithContext(service.WithUser(r.Context(), user))
		recorder := httptest.NewRecorder()
		proxyAIRequest(recorder, internalRequest, "/images/generations")
		responseBody := recorder.Body.Bytes()
		data, message, ok := parseProductSetImageResponse(recorder.Code, responseBody)
		if !ok {
			appendResult(productSetResult{CardID: card.ID, Title: card.Title, Description: card.Description, Error: message})
			continue
		}
		appendResult(productSetResult{CardID: card.ID, Title: card.Title, Description: card.Description, Data: data})
	}
	failed := 0
	for _, result := range results {
		if result.Error != "" {
			failed++
		}
	}
	if failed == len(results) {
		run.Status = "failed"
		run.ErrorMessage = "套图生成失败，请检查图片模型配置后重试"
		run.ResponseBody = mustJSON(results)
		run.UpdatedAt = serviceNow()
		_ = repository.SaveCaseRun(run)
		productSetRunDone(w, stream, results, failed)
		return
	}
	run.Status = "succeeded"
	if failed > 0 {
		run.Status = "partial"
	}
	run.ResponseBody = mustJSON(results)
	run.UpdatedAt = serviceNow()
	_ = repository.SaveCaseRun(run)
	_ = repository.IncrementCaseRun(item.ID)
	productSetRunDone(w, stream, results, failed)
}

func writeProductSetEvent(w http.ResponseWriter, event any) {
	_ = json.NewEncoder(w).Encode(event)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func productSetRunDone(w http.ResponseWriter, stream bool, results []productSetResult, failed int) {
	response := map[string]any{"items": results, "failed": failed, "total": len(results)}
	if stream {
		writeProductSetEvent(w, map[string]any{"type": "done", "failed": failed, "total": len(results)})
		return
	}
	OK(w, response)
}

func validateProductSetInput(input productSetInput, requireCards bool) error {
	if len(input.Images) < 1 || len(input.Images) > 6 {
		return errors.New("请上传 1 到 6 张商品图片")
	}
	if strings.TrimSpace(input.Platform) == "" || strings.TrimSpace(input.Market) == "" || strings.TrimSpace(input.Language) == "" {
		return errors.New("请选择目标平台、市场和语言")
	}
	if strings.TrimSpace(input.ProductBrief) == "" {
		return errors.New("请填写商品卖点")
	}
	if requireCards && len(input.CardIDs) == 0 {
		return errors.New("请至少选择一张套图")
	}
	return nil
}

func normalizedProductSetCount(value int) int {
	if value <= 0 {
		return len(productSetCards)
	}
	if value < 7 {
		return 7
	}
	if value > len(productSetCards) {
		return len(productSetCards)
	}
	return value
}

func plannedProductSetCards(input productSetInput) []productSetCard {
	count := normalizedProductSetCount(input.TargetImageCount)
	if input.LayoutMode != "custom" {
		return append([]productSetCard(nil), productSetCards[:count]...)
	}
	var layout struct {
		WhiteBackground int `json:"whiteBackground"`
		Scene           int `json:"scene"`
		SellingPoint    int `json:"sellingPoint"`
		Other           int `json:"other"`
	}
	if err := json.Unmarshal([]byte(input.CustomLayout), &layout); err != nil || layout.WhiteBackground < 0 || layout.Scene < 0 || layout.SellingPoint < 0 || layout.Other < 0 || layout.WhiteBackground+layout.Scene+layout.SellingPoint+layout.Other != count {
		return append([]productSetCard(nil), productSetCards[:count]...)
	}
	result := make([]productSetCard, 0, count)
	for _, group := range []struct {
		prefix string
		title  string
		count  int
	}{
		{"white-background", "白底主图", layout.WhiteBackground},
		{"scene", "场景图", layout.Scene},
		{"selling-point", "卖点图", layout.SellingPoint},
		{"other", "其他图", layout.Other},
	} {
		for index := 1; index <= group.count; index++ {
			result = append(result, productSetCard{ID: fmt.Sprintf("%s-%d", group.prefix, index), Title: fmt.Sprintf("%s %02d", group.title, index), Description: fmt.Sprintf("根据商品特征制作第 %d 张%s，构图和信息重点与同类图片区分。", index, group.title), AspectRatio: "1:1"})
		}
	}
	return result
}

func selectedProductSetCards(input productSetInput) []productSetCard {
	wanted := map[string]bool{}
	for _, id := range input.CardIDs {
		wanted[strings.TrimSpace(id)] = true
	}
	result := make([]productSetCard, 0, len(productSetCards))
	planByID := make(map[string]productSetCard, len(input.PlanCards))
	for _, card := range input.PlanCards {
		planByID[card.ID] = card
	}
	for _, card := range plannedProductSetCards(input) {
		if len(wanted) == 0 || wanted[card.ID] {
			card.Category = card.Title
			if planned, ok := planByID[card.ID]; ok && strings.TrimSpace(planned.Title) != "" && strings.TrimSpace(planned.Description) != "" {
				card.Title = strings.TrimSpace(planned.Title)
				card.Description = strings.TrimSpace(planned.Description)
			}
			result = append(result, card)
		}
	}
	return result
}

func productSetPrompt(card productSetCard, input productSetInput) string {
	style := strings.TrimSpace(input.StyleText)
	if style == "" {
		style = "干净、高级、真实可信的电商视觉，保持商品本体准确"
	}
	category := card.Category
	if category == "" {
		category = card.Title
	}
	return fmt.Sprintf("制作一张可直接用于电商运营的完整成品图。图类：%s；方案名：%s。必须执行的已确认方案：%s。图类设计要求：%s。商品真实信息：%s。目标平台：%s；目标市场：%s；画面文案语言：%s。整套共享视觉规范：%s。同套图保持一致的品牌色、字体、光线和商品身份，按本图类改变视角和版式，不得把每张都做成相同背景中的商品照片。参考图前%d张是商品身份参考，必须保持外形、颜色、材质、Logo、结构及配件数量；之后%d张仅为风格和排版参考，禁止混入其商品。图类要求优先于氛围风格：白底图必须纯白背景且无文字；语言为无文字时所有图类禁止文字，改用图形说明。其他情况按方案加入简洁可读标题和信息层级；只有用户已提供或图片确实可见的信息可以作卖点。不得虚构品牌、尺寸、认证、优惠、服务承诺或产品功能。缺少参数时使用真实外观说明，不要填入猜测数值。输出单张完整图片，不输出提示词、步骤或套图拼贴。", category, card.Title, card.Description, productSetCategoryRequirements(card.ID), strings.TrimSpace(input.ProductBrief), strings.TrimSpace(input.Platform), strings.TrimSpace(input.Market), strings.TrimSpace(input.Language), style, len(input.Images), len(input.StyleReferenceImages))
}

func productSetCategoryRequirements(id string) string {
	for _, category := range []struct{ id, requirements string }{
		{"white-background", "纯白背景，完整展示商品主体，居中构图，保留自然接触阴影，不加文字、道具或信息框"},
		{"brand-hero", "品牌主视觉海报：商品为视觉中心，具有场景氛围和清晰的主标题，品牌未提供时不造Logo"},
		{"selling-point", "卖点海报：围绕一个已确认核心卖点，搭配短标题、细节特写或信息标注，不能仅展示场景照片"},
		{"material-structure", "材质与结构说明：完整商品加局部放大区域及清楚的连线标注，说明可见材质和结构，不虚构内部剖面"},
		{"craft-detail", "工艺细节：真实表面、接缝或纹理的近距离特写，搭配简短细节说明，与整体主图明显区分"},
		{"spec-quality", "规格与品质：整洁的信息板式、多角度商品视图和已提供的规格；无具体参数时只展示可见外观细节"},
		{"lifestyle", "真实使用场景：商品处于合理使用状态，清晰展示实际用途和真实尺度，不可只有与商品无关的人物或环境"},
		{"closing-value", "收官价值海报：总结已确认购买理由，清晰标题及简洁视觉收束，不编造价格、促销或服务承诺"},
		{"comparison-proof", "对比说明：商品可确认的角度或使用方式对照，带清晰标注，禁止虚构竞品和性能结果"},
		{"size-guide", "尺寸适配：仅使用已确认的尺寸与适配信息，缺少数值时展示不同视角的外观关系，不造尺码"},
		{"how-to-use", "使用步骤：分步骤信息版式，仅展示已确认操作，不发明功能"},
		{"package-list", "包装清单：只展示参考图或用户确认的商品和配件，整齐排布并标注"},
		{"trust-service", "保障信息：只展示用户已提供的承诺，未提供时用真实商品细节建立信任，不虚构认证"},
		{"brand-story", "品牌故事：使用已提供品牌理念和产品资料形成主题海报，不造品牌历史"},
		{"campaign-banner", "活动海报：主题标题和商品视觉明确，优惠或价格仅使用用户已确认内容"},
		{"final-call-to-action", "购买引导：用已确认商品价值和清晰标题形成收尾，不造销量、优惠和评价"},
		{"scene", "场景图：商品在真实使用环境中，清晰展示用途，与其他场景图采用不同视角"},
		{"other", "补充信息图：使用真实商品信息制作对比、尺寸或步骤版式，不重复主视觉和场景照片"},
	} {
		if id == category.id || strings.HasPrefix(id, category.id+"-") {
			return category.requirements
		}
	}
	return "严格按确认方案制作，商品身份一致，信息真实可读"
}

func mustJSON(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func parseProductSetImageResponse(status int, body []byte) (any, string, bool) {
	if status >= http.StatusBadRequest {
		return nil, "图片生成失败", false
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, "图片生成返回格式无效", false
	}
	if envelope, ok := payload.(map[string]any); ok {
		if code, exists := envelope["code"]; exists {
			switch value := code.(type) {
			case float64:
				if value != 0 {
					if message, ok := envelope["msg"].(string); ok && message != "" {
						if strings.Contains(message, "504 Gateway Time-out") {
							return nil, "图片服务响应超时，可单张重试", false
						}
						return nil, message, false
					}
					return nil, "图片生成失败", false
				}
				if data, exists := envelope["data"]; exists {
					return data, "", true
				}
			case string:
				if value != "" && value != "0" {
					return nil, "图片生成失败", false
				}
			}
		}
	}
	return payload, "", true
}

func parseProductSetTextResponse(status int, body []byte) (string, string, bool) {
	if status >= http.StatusBadRequest {
		return "", "商品分析失败", false
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", "商品分析返回格式无效", false
	}
	if envelope, ok := payload.(map[string]any); ok {
		if code, exists := envelope["code"]; exists && fmt.Sprint(code) != "0" {
			if message, ok := envelope["msg"].(string); ok && message != "" {
				return "", message, false
			}
			return "", "商品分析失败", false
		}
	}
	text := productSetTextValue(payload)
	if strings.TrimSpace(text) == "" {
		return "", "商品分析没有返回文本", false
	}
	return strings.TrimSpace(text), "", true
}

func productSetTextValue(value any) string {
	switch item := value.(type) {
	case string:
		return item
	case []any:
		for _, child := range item {
			if text := productSetTextValue(child); strings.TrimSpace(text) != "" {
				return text
			}
		}
	case map[string]any:
		for _, key := range []string{"data", "choices", "message", "delta", "content", "output", "text", "output_text"} {
			if child, exists := item[key]; exists {
				if text := productSetTextValue(child); strings.TrimSpace(text) != "" {
					return text
				}
			}
		}
	}
	return ""
}

func nowUnixNano() int64 {
	return time.Now().UnixNano()
}
