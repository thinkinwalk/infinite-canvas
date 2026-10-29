import type { VideoDraft, ViralEffect, ViralIntent } from "@/types/video-workbench";

export const viralPreserveOptions = ["内容结构", "镜头节奏", "关键画面", "视觉风格", "结尾表达"];
export const viralBriefFields = { subject: "主体名称", person: "人物资料", scene: "场景资料", marks: "准确名称与标识" } as const;
export const viralReferenceImages = (d: VideoDraft) => d.media.filter((m) => m.kind === "image" && ["visual-reference", "product", "background"].includes(m.role));
export function viralIntent(d: VideoDraft): ViralIntent {
    return d.viralIntent || {
        preserve: viralPreserveOptions,
        replacements: (["background", "model", "product"] as const).filter((role) => d.media.some((m) => m.kind === "image" && m.role === role)),
        textMode: "pending", text: "", textSurface: "",
    };
}
export function viralTargetFacts(d: VideoDraft) {
    return [d.viralFacts, ...Object.entries(d.viralBrief || {}).filter(([, value]) => value.trim()).map(([key, value]) => `${viralBriefFields[key as keyof typeof viralBriefFields]}：${value}`)].filter(Boolean).join("\n") || "未提供，不虚构价格、优惠、功效或承诺";
}
export function viralPlanPrompt(d: VideoDraft) {
    const intent = viralIntent(d), roles = { background: "场景", model: "人物", product: "商品" };
    const text = intent.textMode === "none" ? "用户确认本次没有需要处理的画面文字"
        : intent.textMode === "pending" ? "按原片实际内容和用户要求处理。字幕与口播按目标资料改编，不照搬原品牌、价格或承诺；物体文字优先采用用户明确指定或目标素材清晰可辨的对应字样，目标素材未覆盖且未要求改动的原片清晰文字沿用，不擅自用主体名称推测替字；没有文字时不新增，无法辨认时不编造"
        : intent.textMode === "remove" ? "去除用户要求移除的原片画面文字，不新增替代字幕"
        : intent.textMode === "replace" ? `替换为准确字样「${intent.text}」，承载物、位置及出现时机：${intent.textSurface || "沿用原片分析中的对应承载物、位置和出现时机"}`
        : "保留原片识别清楚的准确字样；识别不清列待确认";
    return `复刻安排（用户补充要求优先）：保留${intent.preserve.join("、") || "内容按已采用分析与补充要求"}；使用目标图片替换${intent.replacements.map((role) => roles[role]).join("、") || "无，按原片与补充要求"}。画面内文字：${text}。
参考图片用途：未指定用途的图片按可见内容与用户要求提供目标主体、环境或视觉风格，不默认每张都是商品、背景或需要复制的完整画面；明确标为人物、商品或场景的图片只约束对应内容。
复刻要点：${viralPlanEffects(d).map((effect, i) => `要点${i + 1}：原片${effect.time || "时间不确定"} ${effect.description}；${effect.action === "remove" ? "用户明确删除" : effect.action === "replace" ? `改为${effect.target || "待确认"}` : "保留其表现方式，涉及目标内容时按用户资料改编"}`).join("\n") || "按完整已采用分析承接实际存在的内容结构、镜头节奏和创意特点，不要求用户另填清单"}。只采用原片实际存在或用户明确要求的内容，不为套用模板添加人物、商品、特效、文字或高潮。撰写时自行安排到目标时长，不机械照搬原片秒数；清单不是画面字幕，不声称已通过语义或成片质量验证。`;
}
export function viralIntentError(d: VideoDraft) {
    const intent = viralIntent(d);
    if (intent.textMode === "replace" && !intent.text.trim()) return "请填写要替换的准确字样";
    if (intent.replacements.some((role) => !d.media.some((m) => m.kind === "image" && m.role === role))) return "选中的人物、场景或商品替换缺少对应图片";
    if (viralPlanEffects(d).some((effect) => !effect.description.trim() || (effect.action === "replace" && !effect.target.trim()))) return "请补全自定义效果描述及改编内容，或移除空白项";
    return "";
}
export const viralEffectsSource = (d: VideoDraft) => JSON.stringify([d.media.filter((m) => m.kind === "video" && m.role === "reference").map((m) => [m.id, m.storageKey || m.url]), d.analysis, d.viralAdoptedAnalysis]);
export function viralPlanEffects(d: VideoDraft): ViralEffect[] {
    return d.viralEffectsSource === viralEffectsSource(d) && d.viralEffects ? d.viralEffects : viralEffectCandidates(d.analysis);
}
export function viralPlanState(d: Partial<VideoDraft>) {
    return {
        viralBrief: d.viralBrief, viralIntent: d.viralIntent, viralEffects: d.viralEffects,
        viralEffectsSource: d.viralEffectsSource, viralNoEffects: d.viralNoEffects, viralReviewKey: d.viralReviewKey,
        viralClimax: d.viralClimax, viralClimaxId: d.viralClimaxId, viralClimaxPrompt: d.viralClimaxPrompt,
        viralClimaxReferenceId: d.viralClimaxReferenceId, viralClimaxUse: d.viralClimaxUse, viralImageTarget: d.viralImageTarget,
    };
}
// Only parse the explicit JSON appendix; the full analysis is always included in requests.
export function viralEffectCandidates(text: string): ViralEffect[] {
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
        try {
            const data: unknown = JSON.parse(match[1]);
            if (!data || typeof data !== "object" || !("recreationEffects" in data) || !Array.isArray(data.recreationEffects)) continue;
            return data.recreationEffects.filter((item): item is { time: string; description: string } => Boolean(item && typeof item.time === "string" && typeof item.description === "string" && item.description.trim())).map((item, index) => ({ id: `analysis-effect-${index + 1}`, time: item.time, description: item.description, action: "keep", target: "", scriptRange: "" }));
        } catch { /* An invalid appendix never replaces the adopted analysis. */ }
    }
    return [];
}
