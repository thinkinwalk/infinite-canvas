import type { VideoDraft, WorkbenchMedia } from "@/types/video-workbench";
import { viralAdoptedAnalysisText, viralFrameMaterials, viralSource } from "./viral-analysis";
import { viralIntent, viralPlanEffects, viralPlanPrompt, viralTargetFacts } from "./viral-plan";

const visualRoles: Record<string, string> = { "visual-reference": "参考图片", background: "场景", model: "人物", product: "商品", "first-frame": "视频画面" };
export const viralVisualRole = (role: string) => visualRoles[role] || "参考";

export function viralKeyframeMaterials(d: VideoDraft, target: "opening" | "climax" = "opening"): WorkbenchMedia[] {
    const pose = viralFrameMaterials(d).find((m) => m.id === (target === "climax" ? d.viralClimaxReferenceId : d.viralKeyframeReferenceId));
    return [...d.media.filter((m) => m.kind === "image" && (m.role === "visual-reference" || viralIntent(d).replacements.some((role) => role === m.role))), ...(pose ? [pose] : [])];
}

export function viralKeyframeInputKey(d: VideoDraft, target: "opening" | "climax" = "opening") {
    return JSON.stringify([
        viralSource(d), viralKeyframeMaterials(d, target).map((m) => [m.id, m.storageKey, m.role]),
        target === "climax" ? d.viralClimaxReferenceId : d.viralKeyframeReferenceId, d.script, d.instructions, d.viralFacts, target === "climax" ? d.viralClimaxPrompt : d.viralKeyframePrompt, d.viralSettings?.size,
        d.viralBrief, viralIntent(d), viralPlanEffects(d).map(({ description, action, target }) => [description, action, target]), d.analysis,
    ]);
}

export function viralKeyframeError(d: VideoDraft, target: "opening" | "climax" = "opening") {
    const id = target === "climax" ? d.viralClimaxId : d.viralFirstFrameId, confirmation = target === "climax" ? d.viralClimax : d.viralKeyframe, name = target === "climax" ? "补充画面" : "首帧";
    if (!id) return "";
    const selected = [...d.media, ...viralFrameMaterials(d)].find((m) => m.id === id);
    if (!selected) return `所选${name}已失效，请重新选择`;
    if (confirmation?.id !== selected.id || !confirmation.confirmed || confirmation.inputKey !== viralKeyframeInputKey(d, target))
        return `请在第 2 步核对并确认${name}；素材或脚本变化后需重新确认`;
    return "";
}

export function viralKeyframePrompt(d: VideoDraft, target: "opening" | "climax" = "opening") {
    const climax = target === "climax";
    return `制作一张${climax ? "用户指定时刻或状态的补充画面；优先按画面补充要求，其次按选定构图参考，没有指定时取脚本结尾状态，不自动选择高潮或添加特殊效果" : "用于视频生成的开场首帧，表现脚本开场实际需要的内容"}。按参考图用途和用户要求组织画面，参考图片可提供主体、环境或风格；已明确人物、商品或场景用途的图片只约束对应部分。有对应主体时保持其可见特征，不要求每次都出现人物、商品或建筑，不将多张图片机械拼贴。原片构图参考只提供该时刻的构图、状态和机位，不覆盖目标素材与用户指定内容。
参考图顺序：${viralKeyframeMaterials(d, target).map((m, i) => `图${i + 1}=${m.id.startsWith("frame:") ? "动作与效果参考" : viralVisualRole(m.role)}（${m.name}）`).join("；")}。
用户复刻要求与资料：${viralTargetFacts(d)}。
${viralPlanPrompt(d)}
当前采用的观察依据：${d.viralAdoptedAnalysis ? viralAdoptedAnalysisText(d) : "按用户脚本与实际图片，不推测原片事实"}。
保持对应物体的身份、材质与连接关系，外形相似不代表新增独立道具；文字附着在指定承载物上，不改成悬浮字幕。用户明确要求的改编优先。
视频脚本：${d.script}。
画面补充：${(climax ? d.viralClimaxPrompt : d.viralKeyframePrompt) || "构图与景别跟随该时刻脚本内容，只生成单幅画面，不制作拼图。"}。
画幅参考：${d.viralSettings?.size || "跟随当前图片设置"}。图片未展示的外观与空间属于生成补全，不声称与实物完全一致；静态图仅呈现指定时刻，不能把整段过程同时画入。不要虚构价格、优惠、功效或承诺。`;
}
