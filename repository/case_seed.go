package repository

import (
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func officialToolCase(now, id, title, description, cover, category string, tags []string, schema, workflow, runtime string) model.CaseApp {
	return model.CaseApp{
		ID: id, OwnerID: "platform", Title: title, Description: description, CoverURL: cover,
		Category: category, Tags: tags, Status: model.CaseStatusPublished, IsOfficial: true,
		PublicSchema: schema, WorkflowSnapshot: workflow, RuntimeConfig: runtime,
		PriceCredits: 0, MemberPriceCredits: 0, RevenueSharePercent: 0,
		PublishedVersion: 1, CreatedAt: now, UpdatedAt: now,
	}
}

// seedOfficialCases provides useful platform supply on a fresh deployment so
// the market is not empty before creators have published their first cases.
func seedOfficialCases(db *gorm.DB) error {
	now := time.Now().UTC().Format(time.RFC3339)
	items := []model.CaseApp{
		{
			ID: "official-product-grid", OwnerID: "platform", Title: "商品电商主图套图", Description: "上传 1 到 6 张商品图，生成适配电商平台的 8 张商品套图。", CoverURL: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1200&q=80", Category: "电商", Tags: []string{"商品套图", "主图", "官方"}, Status: model.CaseStatusPublished, IsOfficial: true, PublicSchema: `{"kind":"product-set","imageLimit":6,"defaultTargetImageCount":8}`, WorkflowSnapshot: `{"schemaVersion":2,"type":"official-template","template":"product-listing-set"}`, RuntimeConfig: `{"kind":"product_set","model":"default","templateKey":"product-listing-set"}`, PriceCredits: 0, MemberPriceCredits: 0, CostCredits: 1, RevenueSharePercent: 0, PublishedVersion: 2, CreatedAt: now, UpdatedAt: now,
		},
		{
			ID: "official-fashion-scenes", OwnerID: "platform", Title: "服装多场景换装", Description: "将服装卖点转化为适合电商投放的多场景视觉方案。", CoverURL: "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=1200&q=80", Category: "服装鞋包", Tags: []string{"换装", "服装", "官方"}, Status: model.CaseStatusPublished, IsOfficial: true, PublicSchema: `{"fields":[{"key":"prompt","label":"服装和场景要求","type":"textarea","required":true,"placeholder":"例如：春季女装，通勤街拍，明亮自然光"},{"key":"imageUrl","label":"参考服装或模特图 URL","type":"text","required":false,"placeholder":"可选，填写可访问的参考图 URL"}]}`, WorkflowSnapshot: `{"schemaVersion":1,"type":"official-template","template":"fashion-scenes"}`, RuntimeConfig: `{"kind":"image","model":"default","promptTemplate":"请制作一张高质量服装电商展示图，保留服装版型、颜色和细节，人物姿态自然，画面适合广告投放。用户要求：{{prompt}}","size":"1024x1536","quality":"high"}`, PriceCredits: 3, MemberPriceCredits: 2, CostCredits: 2, RevenueSharePercent: 0, PublishedVersion: 1, CreatedAt: now, UpdatedAt: now,
		},
		{
			ID: "official-furniture-room", OwnerID: "platform", Title: "家具家居场景展示", Description: "为沙发、桌椅、灯具等家居商品生成真实空间展示图。", CoverURL: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=1200&q=80", Category: "家具家装", Tags: []string{"家具", "室内", "官方"}, Status: model.CaseStatusPublished, IsOfficial: true, PublicSchema: `{"fields":[{"key":"prompt","label":"空间风格和商品要求","type":"textarea","required":true,"placeholder":"例如：原木中古风客厅，突出沙发的材质和坐感"},{"key":"imageUrl","label":"商品图 URL","type":"text","required":false,"placeholder":"可选，填写可访问的商品图 URL"}]}`, WorkflowSnapshot: `{"schemaVersion":1,"type":"official-template","template":"furniture-room"}`, RuntimeConfig: `{"kind":"image","model":"default","promptTemplate":"请生成一张真实可信的家居商品场景图，准确保留商品结构和材质，空间布置有生活感，适合电商详情页。用户要求：{{prompt}}","size":"1536x1024","quality":"high"}`, PriceCredits: 3, MemberPriceCredits: 2, CostCredits: 2, RevenueSharePercent: 0, PublishedVersion: 1, CreatedAt: now, UpdatedAt: now,
		},
		{
			ID: "official-product-video", OwnerID: "platform", Title: "商品广告短视频", Description: "根据商品卖点生成 8 秒竖版广告短视频脚本和画面。", CoverURL: "https://images.unsplash.com/photo-1493723843671-1d655e66ac1c?auto=format&fit=crop&w=1200&q=80", Category: "视频创作", Tags: []string{"短视频", "广告", "官方"}, Status: model.CaseStatusPublished, IsOfficial: true, PublicSchema: `{"fields":[{"key":"prompt","label":"商品卖点和视频风格","type":"textarea","required":true,"placeholder":"例如：突出降噪耳机，科技感，镜头快速切换"},{"key":"imageUrl","label":"商品图 URL","type":"text","required":false,"placeholder":"可选，填写可访问的商品图 URL"}]}`, WorkflowSnapshot: `{"schemaVersion":1,"type":"official-template","template":"product-video"}`, RuntimeConfig: `{"kind":"video","model":"default","promptTemplate":"请生成一条适合电商投放的商品广告短视频，镜头简洁有节奏，突出商品卖点，画面保持商品外观一致。用户要求：{{prompt}}","seconds":"8","ratio":"9:16","resolution":"720p","watermark":false}`, PriceCredits: 6, MemberPriceCredits: 4, CostCredits: 4, RevenueSharePercent: 0, PublishedVersion: 1, CreatedAt: now, UpdatedAt: now,
		},
		{
			ID: "official-jewelry-showcase", OwnerID: "platform", Title: "珠宝首饰质感展示", Description: "生成适合首饰详情页和广告投放的高级质感展示图。", CoverURL: "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=1200&q=80", Category: "珠宝首饰", Tags: []string{"珠宝", "首饰", "官方"}, Status: model.CaseStatusPublished, IsOfficial: true, PublicSchema: `{"fields":[{"key":"prompt","label":"首饰卖点和背景要求","type":"textarea","required":true,"placeholder":"例如：999 足金项链，黑色丝绒背景，突出光泽和工艺"},{"key":"imageUrl","label":"首饰图 URL","type":"text","required":false,"placeholder":"可选，填写可访问的商品图 URL"}]}`, WorkflowSnapshot: `{"schemaVersion":1,"type":"official-template","template":"jewelry-showcase"}`, RuntimeConfig: `{"kind":"image","model":"default","promptTemplate":"请生成一张高端珠宝电商展示图，准确保持首饰结构和比例，突出金属光泽、宝石质感和工艺细节。用户要求：{{prompt}}","size":"1024x1024","quality":"high"}`, PriceCredits: 4, MemberPriceCredits: 3, CostCredits: 2, RevenueSharePercent: 0, PublishedVersion: 1, CreatedAt: now, UpdatedAt: now,
		},
		{
			ID: "official-amazon-unboxing", OwnerID: "platform", Title: "亚马逊买家秀开箱", Description: "将商品卖点组织成真实自然的买家秀和开箱内容。", CoverURL: "https://images.unsplash.com/photo-1607082349566-187342175e2f?auto=format&fit=crop&w=1200&q=80", Category: "海外电商", Tags: []string{"亚马逊", "买家秀", "官方"}, Status: model.CaseStatusPublished, IsOfficial: true, PublicSchema: `{"fields":[{"key":"prompt","label":"产品和开箱要求","type":"textarea","required":true,"placeholder":"例如：便携榨汁杯，真实买家口吻，突出易清洗和续航"}]}`, WorkflowSnapshot: `{"schemaVersion":1,"type":"official-template","template":"amazon-unboxing"}`, RuntimeConfig: `{"kind":"text","model":"default","promptTemplate":"请输出一份适合亚马逊买家秀和开箱视频的内容方案，包含自然口吻、镜头顺序、卖点和结尾行动引导。用户要求：{{prompt}}"}`, PriceCredits: 1, MemberPriceCredits: 1, CostCredits: 1, RevenueSharePercent: 0, PublishedVersion: 1, CreatedAt: now, UpdatedAt: now,
		},
		officialToolCase(now, "official-ai-image", "AI 生图", "输入创意或参考图，生成适合商品展示和营销投放的视觉素材。", "https://images.unsplash.com/photo-1545239351-1141bd82e8a6?auto=format&fit=crop&w=1200&q=80", "生成创作", []string{"生图", "官方"}, `{"fields":[{"key":"prompt","label":"创作要求","type":"textarea","required":true,"placeholder":"例如：白底高级感护肤品主图，柔和顶光，留出卖点区域"},{"key":"imageUrl","label":"参考图","type":"image","required":false}]}`, `{"schemaVersion":1,"type":"official-template","template":"ai-image"}`, `{"kind":"image","model":"default","promptTemplate":"请生成一张商业级商品视觉图，构图干净，主体清晰，准确执行用户要求：{{prompt}}","size":"1024x1024","quality":"high"}`),
		officialToolCase(now, "official-detail-page", "详情页", "按平台制作详情长图、切片、A+ 模块及实拍图库，支持独立排字与上传包导出。", "", "电商", []string{"详情页", "长图", "官方"}, `{"kind":"detail-page","imageLimit":6}`, `{"schemaVersion":1,"type":"official-template","template":"detail-page"}`, `{"kind":"product_set","model":"default","templateKey":"detail-page"}`),
		officialToolCase(now, "official-image-variations", "图裂变", "基于一张商品图生成多种构图、场景和风格变体。", "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1200&q=80", "生成创作", []string{"图裂变", "多图", "官方"}, `{"kind":"image-variations","fields":[{"key":"imageUrl","label":"参考图","type":"image","required":true},{"key":"splitMode","label":"裂变设置","type":"select","required":true},{"key":"prompt","label":"补充描述","type":"textarea","required":false},{"key":"similarity","label":"相似度","type":"number","required":true},{"key":"count","label":"生成数量","type":"number","required":true}]}`, `{"schemaVersion":2,"type":"official-template","template":"image-variations"}`, `{"kind":"image","model":"default","promptTemplate":"","size":"1024x1024","quality":"high","count":1}`),
		officialToolCase(now, "official-cutout", "AI 抠图", "自动识别主体去背景，支持边缘羽化与透明、白底、纯色 PNG。", "/examples/cutout/result.png", "图像处理", []string{"抠图", "透明底", "官方"}, `{"fields":[{"key":"imageUrl","label":"上传图片","type":"image","required":true},{"key":"feather","label":"边缘羽化","type":"select","options":["关","弱","强"],"defaultValue":"关"},{"key":"background","label":"输出背景","type":"select","required":true,"options":["透明","白底","纯色"],"defaultValue":"透明"},{"key":"backgroundColor","label":"背景颜色","type":"text","defaultValue":"#3b82f6"}]}`, `{"schemaVersion":1,"type":"official-template","template":"cutout"}`, `{"kind":"local","operation":"cutout-replicate"}`),
		officialToolCase(now, "official-upscale", "AI 变清晰", "使用超分模型按 2x 或 4x 修复并放大图片。", "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1200&q=80", "图像处理", []string{"高清", "修复", "官方"}, `{"fields":[{"key":"imageUrl","label":"待增强图片","type":"image","required":true},{"key":"scale","label":"放大倍数","type":"select","required":true,"options":["2x","4x"],"defaultValue":"2x"},{"key":"direction","label":"增强方向","type":"select","required":true,"options":["通用","人像","商品"],"defaultValue":"通用"}]}`, `{"schemaVersion":1,"type":"official-template","template":"upscale"}`, `{"kind":"local","operation":"upscale-replicate"}`),
		officialToolCase(now, "official-inpaint", "局部改图", "上传原图后涂抹修改区域，生成自然融合的局部结果。", "https://images.unsplash.com/photo-1549490349-8643362247b5?auto=format&fit=crop&w=1200&q=80", "图像处理", []string{"局部重绘", "改图", "官方"}, `{"fields":[{"key":"imageUrl","label":"原始图片","type":"image","required":true},{"key":"maskUrl","label":"涂抹修改区域","type":"mask","required":true},{"key":"prompt","label":"修改要求","type":"textarea","required":true,"placeholder":"例如：把选中区域改成浅灰色，商品和光影保持不变"}]}`, `{"schemaVersion":1,"type":"official-template","template":"inpaint"}`, `{"kind":"image","model":"default","operation":"inpaint","promptTemplate":"只修改蒙版区域，其余主体、构图、色彩和光影保持一致。修改要求：{{prompt}}","size":"1024x1024","quality":"high"}`),
		officialToolCase(now, "official-fusion", "AI 融图", "将商品、场景和风格参考图自然融合成一张完整画面。", "https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85?auto=format&fit=crop&w=1200&q=80", "图像处理", []string{"融图", "合成", "官方"}, `{"fields":[{"key":"imageUrl","label":"主体图片","type":"image","required":true},{"key":"referenceImageUrls","label":"场景或风格参考图","type":"images","required":true},{"key":"prompt","label":"融合要求（选填）","type":"textarea","required":false,"placeholder":"例如：将商品放入明亮的原木客厅，保持商品造型和比例"},{"key":"aspectRatio","label":"比例","type":"select","required":true,"options":["1:1","3:4","4:3","16:9","9:16"],"defaultValue":"1:1"},{"key":"outputMode","label":"出图模式","type":"select","required":true,"options":["基础","标准","高阶"],"defaultValue":"标准","help":"基础：适合快速尝试构图，画面细节相对简化。\n标准：兼顾细节与等待时间，适合大多数场景，也是默认选项。\n高阶：加强纹理、光影与细节表现，适合最终成图，通常需要更长等待时间。\n三档当前按同一模型的单张价格计费。"},{"key":"count","label":"数量","type":"select","required":true,"options":["1","2","4"],"defaultValue":"1"}]}`, `{"schemaVersion":2,"type":"official-template","template":"fusion"}`, `{"kind":"image","model":"default","operation":"image-edit","promptTemplate":"将主体图与参考图自然融合成一张完整的商业图片。优先保持主体的造型、比例、颜色、文字和品牌细节，再吸收参考图的场景、构图、材质、色彩与光线。不要拼图，不要并排展示输入图。补充要求：{{prompt}}","size":"1024x1024","quality":"medium"}`),
		officialToolCase(now, "official-dewatermark", "去水印", "移除图片中的水印、Logo 和文字覆盖并自然补全背景。", "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=1200&q=80", "图像处理", []string{"去水印", "修复", "官方"}, `{"fields":[{"key":"imageUrl","label":"待处理图片","type":"image","required":true},{"key":"watermarkType","label":"水印类型","type":"select","required":true,"options":["通用","文字","Logo"],"defaultValue":"通用"}]}`, `{"schemaVersion":2,"type":"official-template","template":"dewatermark"}`, `{"kind":"image","model":"default","operation":"image-edit","promptTemplate":"移除参考图中的{{watermarkType}}水印、Logo、文字和半透明覆盖，精确补全被遮挡区域，其余内容保持不变。","size":"1024x1024","quality":"high"}`),
		officialToolCase(now, "official-tryon", "服装上身", "上传上装或下装，从素材库选择模特和场景，生成自然真实的电商试穿图。", "https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=1200&q=80", "服装电商", []string{"试穿", "服装", "官方"}, `{"fields":[{"key":"topImageUrl","label":"上装","type":"image","required":false},{"key":"bottomImageUrl","label":"下装","type":"image","required":false},{"key":"modelImageUrl","label":"模特","type":"text","required":false},{"key":"sceneImageUrl","label":"场景","type":"text","required":false},{"key":"prompt","label":"上身要求","type":"textarea","required":false,"placeholder":"例如：自然站姿，完整展示服装细节"}]}`, `{"schemaVersion":2,"type":"official-template","template":"tryon"}`, `{"kind":"image","model":"default","operation":"image-edit","promptTemplate":"将提供的服装自然穿到模特身上，保持每件服装的版型、颜色、面料和细节。提供模特图时保留该人物身份、体型和肤色；提供场景图时参考其环境、构图和光线。只生成一张完整的真实电商全身图，不要拼图，不要并排展示输入图。上身要求：{{prompt}}。","size":"1024x1536","quality":"high"}`),
		officialToolCase(now, "official-garment-extract", "服装提取", "从模特图中提取平铺服装图，保留款式和面料细节。", "https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=1200&q=80", "服装电商", []string{"服装提取", "平铺图", "官方"}, `{"fields":[{"key":"imageUrl","label":"模特服装图","type":"image","required":true},{"key":"detail","label":"保留细节","type":"select","display":"buttons","required":true,"options":["标准","精细"],"defaultValue":"标准","help":"标准：保留整体款式、颜色和主要面料结构。精细：加强缝线、纽扣、刺绣、纹理和边缘轮廓的还原。"},{"key":"shape","label":"输出形态","type":"select","required":true,"options":["平铺","挂拍"]},{"key":"prompt","label":"提取要求","type":"textarea","required":false,"placeholder":"例如：正面平铺，白底，保留刺绣和纽扣细节"}]}`, `{"schemaVersion":2,"type":"official-template","template":"garment-extract"}`, `{"kind":"image","model":"default","operation":"image-edit","promptTemplate":"从参考模特图中提取完整服装，生成独立的{{shape}}商品图。细节级别：{{detail}}。准确还原衣服结构、颜色、纹理和装饰，不保留人物、身体或原背景。提取要求：{{prompt}}。","size":"1024x1536","quality":"high"}`),
		officialToolCase(now, "official-garment-3d", "3D 服装图", "生成服装的立体展示效果，适合商品详情页和视觉展示。", "https://images.unsplash.com/photo-1485968579580-b6d095142e6e?auto=format&fit=crop&w=1200&q=80", "服装电商", []string{"3D", "服装", "官方"}, `{"fields":[{"key":"imageUrl","label":"服装图","type":"image","required":true},{"key":"view","label":"视角","type":"select","required":true,"options":["正面","45 度","侧面"]},{"key":"material","label":"材质","type":"select","options":["真实","光泽","哑光"]},{"key":"imageResolution","label":"分辨率","type":"select","display":"buttons","required":true,"options":["1K","2K","4K"],"defaultValue":"1K"},{"key":"prompt","label":"展示要求","type":"textarea","required":false,"placeholder":"例如：45 度视角，哑光材质，浅灰背景"}]}`, `{"schemaVersion":2,"type":"official-template","template":"garment-3d"}`, `{"kind":"image","model":"default","operation":"image-edit","promptTemplate":"将参考服装制作成具有立体结构和真实材质的 3D 商品展示图，保持款式细节。展示要求：{{prompt}} 视角：{{view}}；材质：{{material}}。","size":"1024x1536","quality":"high"}`),
		officialToolCase(now, "official-dewrinkle", "服装去皱", "去除衣物褶皱和拍摄瑕疵，保持面料纹理自然。", "https://images.unsplash.com/photo-1551488831-00ddcb6c6bd3?auto=format&fit=crop&w=1200&q=80", "服装电商", []string{"去皱", "服装", "官方"}, `{"fields":[{"key":"imageUrl","label":"服装图片","type":"image","required":true},{"key":"strength","label":"去皱强度","type":"select","required":true,"options":["轻","中","强"],"defaultValue":"轻","display":"buttons"},{"key":"preserveTexture","label":"保留纹理","type":"select","required":true,"options":["是","否"],"defaultValue":"是","display":"buttons"},{"key":"prompt","label":"处理要求","type":"textarea","required":false,"placeholder":"例如：轻度去皱，保留真实面料纹理"}]}`, `{"schemaVersion":1,"type":"official-template","template":"dewrinkle"}`, `{"kind":"image","model":"default","operation":"image-edit","promptTemplate":"自然去除参考服装上的褶皱和拍摄瑕疵，保持服装颜色和版型。纹理处理：{{preserveTexture}}（选择“是”时保留真实面料纹理，选择“否”时允许更强平滑）；处理要求：{{prompt}}；去皱强度：{{strength}}。","size":"1024x1536","quality":"high"}`),
		officialToolCase(now, "official-title-gen", "标题生成", "根据商品图和卖点生成适合电商平台的商品标题与卖点文案。", "https://images.unsplash.com/photo-1556740749-887f6717d7e4?auto=format&fit=crop&w=1200&q=80", "营销工具", []string{"标题", "文案", "官方"}, `{"fields":[{"key":"imageUrl","label":"商品图","type":"image","required":true},{"key":"prompt","label":"商品卖点和平台要求","type":"textarea","required":true,"placeholder":"例如：突出轻便、耐用、通勤场景"},{"key":"platform","label":"平台","type":"select","display":"buttons","required":true,"options":["通用","淘宝/天猫","京东","拼多多","抖音","亚马逊","TEMU","TikTok","eBay"],"defaultValue":"通用"},{"key":"language","label":"输出语言","type":"select","display":"buttons","required":true,"options":["中文","English","中英双语"],"defaultValue":"中文"},{"key":"style","label":"风格","type":"select","display":"buttons","required":true,"options":["爆款吸睛","简洁专业","高端轻奢","活泼种草"],"defaultValue":"爆款吸睛"}]}`, `{"schemaVersion":3,"type":"official-template","template":"title-gen"}`, `{"kind":"text","model":"default","promptTemplate":"请只返回 JSON，不要 Markdown：{\"titles\":[\"标题1\",\"标题2\",\"标题3\",\"标题4\",\"标题5\"],\"sellingPoints\":[\"卖点1\",\"卖点2\",\"卖点3\"]}。请根据商品图识别真实卖点，生成适合电商发布的标题与卖点，避免夸大和违规。用户要求：{{prompt}} 平台：{{platform}}；输出语言：{{language}}；风格：{{style}}。"}`),
		officialToolCase(now, "official-print-extract", "印花提取", "从服装或商品图中提取独立印花和图案素材。", "https://images.unsplash.com/photo-1529139574466-a303027c6bd3?auto=format&fit=crop&w=1200&q=80", "营销工具", []string{"印花", "素材", "官方"}, `{"fields":[{"key":"imageUrl","label":"服装或商品图","type":"image","required":true},{"key":"mode","label":"模式","type":"select","required":true,"options":["基础","高阶"],"defaultValue":"基础"},{"key":"category","label":"品类","type":"select","required":true,"options":["通用","服装","家纺","箱包","包装"],"defaultValue":"通用"},{"key":"aspectRatio","label":"比例","type":"select","required":true,"options":["自动","1:1","3:4","4:3","16:9","9:16"],"defaultValue":"自动"},{"key":"edgeCompletion","label":"边缘补全","type":"select","required":true,"options":["不补全","智能补全"],"defaultValue":"不补全"},{"key":"quality","label":"清晰度","type":"select","required":true,"options":["标准","高清"],"defaultValue":"标准"},{"key":"background","label":"输出背景","type":"select","required":true,"options":["透明","白底"],"defaultValue":"透明"},{"key":"prompt","label":"补充要求","type":"textarea","required":false,"placeholder":"例如：只保留胸前主图案，去除文字标签"}]}`, `{"schemaVersion":2,"type":"official-template","template":"print-extract"}`, `{"kind":"image","model":"default","operation":"image-edit","promptTemplate":"从参考图中准确提取{{category}}商品表面的独立印花或图案。使用{{mode}}：去除商品材质、透视、褶皱、阴影、背景和无关元素，将图案还原为正视、平整、边缘干净的设计素材。边缘处理：{{edgeCompletion}}；补充要求：{{prompt}}；输出背景：{{background}}。不要保留商品轮廓，不要添加新的文字、图形或装饰。","size":"1024x1024","quality":"medium","backgroundInput":"background"}`),
		officialToolCase(now, "official-ip-check", "侵权检测", "识别疑似品牌、角色和 Logo 等商用风险，供人工复核。", "https://images.unsplash.com/photo-1450101499163-c8848c66ca85?auto=format&fit=crop&w=1200&q=80", "营销工具", []string{"版权", "检测", "官方"}, `{"fields":[{"key":"prompt","label":"检测重点","type":"textarea","required":false,"placeholder":"例如：重点检查 Logo、动漫角色和品牌标识"},{"key":"imageUrl","label":"待检测图片","type":"image","required":true}]}`, `{"schemaVersion":1,"type":"official-template","template":"ip-check"}`, `{"kind":"text","model":"default","promptTemplate":"请只返回 JSON，不要 Markdown：{\"risk\":\"low|medium|high\",\"riskLabel\":\"低风险|需复核|高风险\",\"summary\":\"一句话总结\",\"items\":[{\"name\":\"疑似对象\",\"reason\":\"原因\"}],\"advice\":\"人工复核建议\"}。对参考商品图进行商业使用风险筛查，列出疑似品牌、Logo、角色、外观专利和素材版权风险。检测重点：{{prompt}}。仅提供视觉风险线索，不将结果表述为确定的侵权或法律结论。"}`),
		officialToolCase(now, "official-print-file", "印刷图", "按成品尺寸和 DPI 输出可下载的印刷级 PNG 文件。", "https://images.unsplash.com/photo-1543002588-bfa74002ed7e?auto=format&fit=crop&w=1200&q=80", "营销工具", []string{"印刷", "高清", "官方"}, `{"fields":[{"key":"imageUrl","label":"原始图片","type":"image","required":true},{"key":"widthMm","label":"成品宽度（毫米）","type":"text","required":true,"placeholder":"例如：210","defaultValue":"210"},{"key":"heightMm","label":"成品高度（毫米）","type":"text","required":true,"placeholder":"例如：297","defaultValue":"297"},{"key":"dpi","label":"DPI","type":"select","required":true,"options":["150","300","600"],"defaultValue":"300"},{"key":"fit","label":"图片适配","type":"select","required":true,"options":["完整留白","填满裁切"],"defaultValue":"完整留白"}]}`, `{"schemaVersion":1,"type":"official-template","template":"print-file"}`, `{"kind":"local","operation":"print-file"}`),
	}
	for _, item := range items {
		if item.ID == "official-cutout" {
			item.PriceCredits = 4
			item.MemberPriceCredits = 4
		}
		if item.ID == "official-upscale" {
			item.PriceCredits = 6
			item.MemberPriceCredits = 6
		}
		if item.ID == "official-ai-image" {
			item.Status = model.CaseStatusOffline
		}
		if item.ID == "official-image-variations" {
			item.PublishedVersion = 2
		}
		if item.ID == "official-fusion" {
			item.PublishedVersion = 2
		}
		if item.ID == "official-print-extract" {
			item.PublishedVersion = 2
		}
		if item.ID == "official-garment-3d" {
			item.PublishedVersion = 2
		}
		var count int64
		if err := db.Model(&model.CaseApp{}).Where("id = ?", item.ID).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			if err := db.Create(&item).Error; err != nil {
				return err
			}
		} else if item.ID == "official-product-grid" || item.ID == "official-detail-page" || item.ID == "official-image-variations" || item.ID == "official-inpaint" || item.ID == "official-print-file" || item.ID == "official-upscale" || item.ID == "official-cutout" || item.ID == "official-fusion" || item.ID == "official-dewatermark" || item.ID == "official-tryon" || item.ID == "official-garment-extract" || item.ID == "official-garment-3d" || item.ID == "official-dewrinkle" || item.ID == "official-print-extract" || item.ID == "official-title-gen" || item.ID == "official-ip-check" {
			updates := map[string]any{
				"description":          item.Description,
				"public_schema":        item.PublicSchema,
				"workflow_snapshot":    item.WorkflowSnapshot,
				"runtime_config":       item.RuntimeConfig,
				"price_credits":        item.PriceCredits,
				"member_price_credits": item.MemberPriceCredits,
				"published_version":    item.PublishedVersion,
				"updated_at":           item.UpdatedAt,
			}
			if item.ID == "official-detail-page" {
				updates["cover_url"] = item.CoverURL
			}
			if err := db.Model(&model.CaseApp{}).Where("id = ? AND owner_id = ?", item.ID, "platform").Updates(updates).Error; err != nil {
				return err
			}
		} else if item.ID == "official-ai-image" {
			if err := db.Model(&model.CaseApp{}).Where("id = ? AND owner_id = ?", item.ID, "platform").Updates(map[string]any{
				"status":     model.CaseStatusOffline,
				"updated_at": item.UpdatedAt,
			}).Error; err != nil {
				return err
			}
		}
	}
	return nil
}
