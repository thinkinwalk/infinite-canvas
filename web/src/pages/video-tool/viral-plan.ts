import type { AiConfig } from "@/stores/use-config-store";
import type { VideoDraft, ViralEffect, ViralIntent } from "@/types/video-workbench";

export const viralPreserveOptions = ["动作顺序", "镜头节奏", "物体展开或变形", "高潮展示", "结束姿态"];
export const viralBriefFields = { subject: "主体名称", person: "人物与服装", scene: "目标场景", marks: "必须保留的标识" } as const;
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
        : intent.textMode === "pending" ? "文字处理尚待用户确认，不擅自更改或省略原字"
        : intent.textMode === "remove" ? "去除原片物体上的文字，不新增替代字幕"
        : intent.textMode === "replace" ? `替换为准确字样「${intent.text}」，承载物、位置及出现时机：${intent.textSurface || "待确认"}`
        : "保留原片识别清楚的准确字样；识别不清列待确认";
    return `用户结构化选择（与补充要求有冲突时列为待确认）：保留${intent.preserve.join("、") || "内容按逐项要点与补充要求"}；使用目标图片替换${intent.replacements.map((role) => roles[role]).join("、") || "无，按原片与补充要求"}。画面内文字：${text}。
关键效果清单：${(d.viralEffects || []).map((effect, i) => `要点${i + 1}：原片${effect.time || "时间待确认"} ${effect.description}；${effect.action === "remove" ? "用户明确删除" : effect.action === "replace" ? `改为${effect.target || "待确认"}` : "保留"}${effect.scriptRange ? `；脚本位置${effect.scriptRange}` : ""}`).join("\n") || (d.viralNoEffects ? "用户确认没有需要单独列出的效果，仍遵循已采用分析及明确要求" : "尚未逐项确认，不声称已完成缺项检查")}。清单及检查状态不是画面字幕。`;
}
export function viralIntentError(d: VideoDraft) {
    const intent = viralIntent(d);
    if (intent.textMode === "replace" && (!intent.text.trim() || !intent.textSurface.trim())) return "请填写准确替换字样及承载物、位置与出现时机";
    if (intent.replacements.some((role) => !d.media.some((m) => m.kind === "image" && m.role === role))) return "选中的人物、场景或商品替换缺少对应图片";
    if (d.viralEffects?.some((effect) => !effect.description.trim() || (effect.action === "replace" && !effect.target.trim()))) return "请补全关键效果描述及替换内容";
    return "";
}
export const viralEffectsSource = (d: VideoDraft) => JSON.stringify([d.media.filter((m) => m.kind === "video" && m.role === "reference").map((m) => [m.id, m.storageKey || m.url]), d.analysis, d.viralAdoptedAnalysis]);
export function viralPlanState(d: Partial<VideoDraft>) {
    return {
        viralBrief: d.viralBrief, viralIntent: d.viralIntent, viralEffects: d.viralEffects,
        viralEffectsSource: d.viralEffectsSource, viralNoEffects: d.viralNoEffects, viralReviewKey: d.viralReviewKey,
        viralClimax: d.viralClimax, viralClimaxId: d.viralClimaxId, viralClimaxPrompt: d.viralClimaxPrompt,
        viralClimaxReferenceId: d.viralClimaxReferenceId, viralClimaxUse: d.viralClimaxUse, viralImageTarget: d.viralImageTarget,
    };
}
export function viralReviewKey(d: VideoDraft, cfg: AiConfig) {
    return JSON.stringify([viralEffectsSource(d), d.script, d.instructions, d.viralFacts, d.viralBrief, d.viralProductAnalysis, d.viralProductStale, viralIntent(d), d.viralEffects, d.viralNoEffects, d.media.filter((m) => ["background", "model", "product"].includes(m.role)).map((m) => [m.id, m.storageKey]), cfg.videoModel, cfg.videoSeconds, cfg.size, cfg.vquality]);
}
export function viralReviewError(d: VideoDraft, cfg: AiConfig) {
    const error = viralIntentError(d);
    if (error) return error;
    if (viralIntent(d).textMode === "pending") return "请确认原片画面文字的处理方式；无文字时选择无相关文字";
    if (!d.viralEffects?.length && !d.viralNoEffects) return "请列出关键效果，或确认没有需要单列的效果";
    if (d.viralEffects?.length && d.viralEffectsSource !== viralEffectsSource(d)) return "参考视频或已采用分析已变化，请重新核对要点来源";
    if (d.viralEffects?.some((effect) => effect.action !== "remove" && !effect.scriptRange.trim())) return "请逐项填写关键效果在脚本中的对应时间段或段落";
    if (!d.script.trim()) return "请先填写改编脚本";
    if (d.viralReviewKey !== viralReviewKey(d, cfg)) return "请在第 2 步确认脚本已覆盖关键效果及目标规格";
    return "";
}
// Only import the explicit JSON appendix; prose remains available for manual selection.
export function viralEffectCandidates(text: string): ViralEffect[] {
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
        try {
            const data: unknown = JSON.parse(match[1]);
            if (!data || typeof data !== "object" || !("recreationEffects" in data) || !Array.isArray(data.recreationEffects)) continue;
            return data.recreationEffects.filter((item): item is { time: string; description: string } => Boolean(item && typeof item.time === "string" && typeof item.description === "string" && item.description.trim())).map((item) => ({ id: crypto.randomUUID(), time: item.time, description: item.description, action: "keep", target: "", scriptRange: "" }));
        } catch { /* An invalid appendix never replaces the adopted analysis. */ }
    }
    return [];
}
