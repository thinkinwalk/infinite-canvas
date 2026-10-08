export type DetailProfile = {
    id: string; label: string; width: number; height: number;
    output: "slices" | "gallery" | "aplus" | "sections";
    photoOnly?: boolean; note: string; modules: string[];
};
const standard = ["首屏主视觉", "核心卖点", "使用场景", "功能细节", "材质工艺", "使用步骤", "规格与包装", "价值收尾"];
export const detailProfiles: DetailProfile[] = [
    { id: "taobao", label: "淘宝 / 天猫", width: 750, height: 900, output: "slices", note: "连续叙事，按章节或指定高度切片；准确保留商品外观。", modules: standard },
    { id: "jd", label: "京东", width: 750, height: 850, output: "slices", note: "突出规格、功能和细节，导出按序上传的长图切片。", modules: standard },
    { id: "pdd", label: "拼多多", width: 750, height: 900, output: "slices", note: "首屏明确商品与真实卖点，减少重复场景图。", modules: standard },
    { id: "douyin", label: "抖音电商", width: 750, height: 1000, output: "slices", note: "用于详情区域；主图请另用商品实拍，详情图保持商品一致。", modules: standard },
    { id: "xhs", label: "小红书", width: 1242, height: 1242, output: "gallery", note: "生活方式叙事，导出独立图卡及长图预览。", modules: ["封面", "生活场景", "使用体验", "细节", "使用步骤", "规格", "收尾"] },
    { id: "amazon", label: "Amazon A+", width: 970, height: 300, output: "aplus", note: "按所选 A+ 模板输出固定尺寸模块；上传位置需匹配卖家后台模板。", modules: ["品牌主视觉", "核心特点", "细节展示", "应用场景", "规格说明"] },
    { id: "aliexpress", label: "AliExpress", width: 960, height: 900, output: "slices", note: "突出尺寸、适配和包装内容，按目标市场语言排字。", modules: standard },
    { id: "temu", label: "Temu", width: 1200, height: 1500, output: "gallery", note: "独立商品图卡；具体比例与素材要求以上架类目及卖家后台为准。", modules: ["商品主视觉", "核心特点", "细节", "使用场景", "尺寸", "包装"] },
    { id: "tiktok", label: "TikTok Shop", width: 1200, height: 1200, output: "gallery", photoOnly: true, note: "实拍图库模式：保持原始比例，仅缩放，不叠加文字、不生成合成商品图。", modules: ["正面实拍", "侧面实拍", "细节实拍", "真实使用", "尺度参照", "包装实拍"] },
    { id: "ebay", label: "eBay", width: 1600, height: 1600, output: "gallery", photoOnly: true, note: "优先实拍：展示实际品相、瑕疵、配件与包装；保持原始比例。", modules: ["商品正面", "其他角度", "品相与细节", "尺度参照", "配件", "包装"] },
    { id: "etsy", label: "Etsy", width: 2000, height: 2000, output: "gallery", photoOnly: true, note: "采用实物商品的保守实拍策略：环境主图、尺度、工艺、制作过程、包装；不合成、不叠字。定制及数字商品的例外需另核对平台规则。", modules: ["环境主图", "尺度参照", "材质与手工细节", "真实使用", "制作过程", "包装与送礼"] },
    { id: "shopify", label: "Shopify", width: 1536, height: 900, output: "sections", note: "品牌页面分区，图像与文案同时导出，可按店铺主题逐区使用。", modules: [...standard.slice(0, 7), "常见问题", "品牌收尾"] },
];
export const outputLabels = { slices: "长图 + 切片", gallery: "独立图库", aplus: "A+ 模块", sections: "品牌页面分区" };
export const detailMarkets = [
    { value: "中国大陆", label: "中国大陆" },
    { value: "美国", label: "美国" },
    { value: "欧洲", label: "欧洲" },
    { value: "英国", label: "英国" },
    { value: "加拿大", label: "加拿大" },
    { value: "澳大利亚", label: "澳大利亚" },
    { value: "东南亚", label: "东南亚" },
    { value: "日本", label: "日本" },
    { value: "韩国", label: "韩国" },
    { value: "俄罗斯", label: "俄罗斯" },
    { value: "南非", label: "南非" },
    { value: "新加坡", label: "新加坡" },
];
export type DetailModule = {
    id: string; role: string; title: string; body: string; visual: string;
    layout: "top" | "left" | "none"; source: "photo" | "ai";
    photoId: string; image?: string; error?: string; enabled: boolean;
};
export type DetailPhoto = { id: string; name: string; url: string };
export type DetailDraft = {
    platform: string; market: string; language: string; brief: string; style: string;
    confirmed: boolean; background: string; foreground: string;
    amazonTemplate: "basic" | "premium"; sliceMode: "module" | "fixed"; sliceHeight: number;
    photos: DetailPhoto[]; modules: DetailModule[];
};
export function profileFor(draft: Pick<DetailDraft, "platform" | "amazonTemplate">): DetailProfile {
    const profile = detailProfiles.find(p => p.id === draft.platform) || detailProfiles[0];
    return profile.id === "amazon" && draft.amazonTemplate === "premium" ? { ...profile, width: 1464, height: 600 } : profile;
}
export function createModules(profile: DetailProfile): DetailModule[] {
    return profile.modules.map((role, i) => ({ id: `detail-${i + 1}`, role, title: "", body: "", visual: role + "，只呈现已确认或照片可见的商品特征。", layout: profile.photoOnly ? "none" : profile.output === "aplus" ? "left" : "top", source: profile.photoOnly ? "photo" : "ai", photoId: "", enabled: true }));
}
export function newDraft(): DetailDraft {
    return { platform: "taobao", market: "中国大陆", language: "简体中文", brief: "", style: "自然光、清晰商品细节、统一柔和背景", confirmed: false, background: "#f7f3ed", foreground: "#29251f", amazonTemplate: "basic", sliceMode: "module", sliceHeight: 900, photos: [], modules: createModules(detailProfiles[0]) };
}
export function moduleImage(module: DetailModule, draft: DetailDraft): string | undefined {
    if (profileFor(draft).photoOnly || module.source === "photo") return draft.photos.find(p => p.id === module.photoId)?.url;
    return module.image;
}
export function sliceRanges(heights: number[], mode: DetailDraft["sliceMode"], sliceHeight: number) {
    if (heights.some(h => !Number.isSafeInteger(h) || h <= 0)) throw new Error("模块高度无效");
    if (mode === "fixed" && (!Number.isSafeInteger(sliceHeight) || sliceHeight <= 0)) throw new Error("切片高度必须为正整数");
    const total = heights.reduce((a, b) => a + b, 0);
    const ranges: { y: number; height: number }[] = [];
    if (mode === "module") {
        let y = 0;
        heights.forEach(height => { ranges.push({ y, height }); y += height; });
    } else for (let y = 0; y < total; y += sliceHeight) ranges.push({ y, height: Math.min(sliceHeight, total - y) });
    return ranges;
}
