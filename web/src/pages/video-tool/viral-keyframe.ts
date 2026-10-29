import type { VideoDraft, WorkbenchMedia } from "@/types/video-workbench";
import { viralFrameMaterials, viralSource } from "./viral-analysis";
import { viralIntent, viralPlanPrompt, viralTargetFacts } from "./viral-plan";

const visualRoles: Record<string, string> = { background: "场景", model: "人物", product: "商品", "first-frame": "首帧" };
export const viralVisualRole = (role: string) => visualRoles[role] || "参考";

export function viralKeyframeMaterials(d: VideoDraft, target: "opening" | "climax" = "opening"): WorkbenchMedia[] {
    const pose = viralFrameMaterials(d).find((m) => m.id === (target === "climax" ? d.viralClimaxReferenceId : d.viralKeyframeReferenceId));
    return [...d.media.filter((m) => m.kind === "image" && viralIntent(d).replacements.some((role) => role === m.role)), ...(pose ? [pose] : [])];
}

export function viralKeyframeInputKey(d: VideoDraft, target: "opening" | "climax" = "opening") {
    return JSON.stringify([
        viralSource(d), viralKeyframeMaterials(d, target).map((m) => [m.id, m.storageKey, m.role]),
        target === "climax" ? d.viralClimaxReferenceId : d.viralKeyframeReferenceId, d.script, d.instructions, d.viralFacts, target === "climax" ? d.viralClimaxPrompt : d.viralKeyframePrompt, d.viralSettings?.size,
        d.viralBrief, d.viralIntent, d.viralEffects?.map(({ description, action, target }) => [description, action, target]), d.analysis,
    ]);
}

export function viralKeyframeError(d: VideoDraft, target: "opening" | "climax" = "opening") {
    const id = target === "climax" ? d.viralClimaxId : d.viralFirstFrameId, confirmation = target === "climax" ? d.viralClimax : d.viralKeyframe, name = target === "climax" ? "高潮画面" : "首帧";
    if (!id) return "";
    const selected = [...d.media, ...viralFrameMaterials(d)].find((m) => m.id === id);
    if (!selected) return `所选${name}已失效，请重新选择`;
    if (confirmation?.id !== selected.id || !confirmation.confirmed || confirmation.inputKey !== viralKeyframeInputKey(d, target))
        return `请在第 2 步核对并确认${name}；素材或脚本变化后需重新确认`;
    return "";
}

export function viralKeyframePrompt(d: VideoDraft, target: "opening" | "climax" = "opening") {
    const climax = target === "climax";
    return `制作一张${climax ? "展示脚本高潮效果的目标关键画面，明确呈现展开或变形后的完整形态、大小、文字和人物姿态" : "用于视频生成的开场首帧"}。按各参考图的角色合成同一真实场景，保持人物身份、服饰可见细节、场景建筑结构和可辨认标识。不得将场景图当商品或人物，不复制动作参考中的人物身份、服装、建筑和文字。动作参考画面仅提供${climax ? "高潮效果形态、姿势" : "开场姿势"}、机位和主体占比，具体文字以用户确认要求为准。
参考图顺序：${viralKeyframeMaterials(d, target).map((m, i) => `图${i + 1}=${m.id.startsWith("frame:") ? "动作与效果参考" : viralVisualRole(m.role)}（${m.name}）`).join("；")}。
真实资料：${viralTargetFacts(d)}。
${viralPlanPrompt(d)}
视频脚本：${d.script}。
改编要求：${d.instructions}。
画面补充：${(climax ? d.viralClimaxPrompt : d.viralKeyframePrompt) || "主体完整入镜，为动作留出空间；只生成单幅画面，不制作拼图。"}。
画幅参考：${d.viralSettings?.size || "跟随当前图片设置"}。照片没有展示的全身、裙摆与背面属于生成补全，不声称与实物完全一致；不要虚构价格、优惠、功效或承诺。`;
}
