import type { VideoDraft, WorkbenchMedia } from "@/types/video-workbench";
import { viralFrameMaterials, viralSource } from "./viral-analysis";

const visualRoles: Record<string, string> = { background: "场景", model: "人物", product: "商品", "first-frame": "首帧" };
export const viralVisualRole = (role: string) => visualRoles[role] || "参考";

export function viralKeyframeMaterials(d: VideoDraft): WorkbenchMedia[] {
    const pose = viralFrameMaterials(d).find((m) => m.id === d.viralKeyframeReferenceId);
    return [...d.media.filter((m) => m.kind === "image" && ["background", "model", "product"].includes(m.role)), ...(pose ? [pose] : [])];
}

export function viralKeyframeInputKey(d: VideoDraft) {
    return JSON.stringify([
        viralSource(d), viralKeyframeMaterials(d).map((m) => [m.id, m.storageKey, m.role]),
        d.viralKeyframeReferenceId, d.script, d.instructions, d.viralFacts, d.viralKeyframePrompt, d.viralSettings?.size,
    ]);
}

export function viralKeyframeError(d: VideoDraft) {
    if (!d.viralFirstFrameId) return "";
    const selected = [...d.media, ...viralFrameMaterials(d)].find((m) => m.id === d.viralFirstFrameId);
    if (!selected) return "所选首帧已失效，请重新选择";
    if (d.viralKeyframe?.id !== selected.id || !d.viralKeyframe.confirmed || d.viralKeyframe.inputKey !== viralKeyframeInputKey(d))
        return "请在第 2 步核对并确认首帧；素材或脚本变化后需重新确认";
    return "";
}

export function viralKeyframePrompt(d: VideoDraft) {
    return `制作一张用于视频生成的开场首帧。按各参考图的角色合成同一真实场景，保持人物身份、服饰可见细节、场景建筑结构和可辨认标识。不得将场景图当商品或人物，不复制动作参考中的人物身份、服装、建筑和文字。${d.viralKeyframeReferenceId ? "动作参考画面仅提供开场姿势、机位和主体占比。" : "按脚本的开场姿态安排人物和构图。"}
参考图顺序：${viralKeyframeMaterials(d).map((m, i) => `图${i + 1}=${m.id.startsWith("frame:") ? "开场姿势参考" : viralVisualRole(m.role)}（${m.name}）`).join("；")}。
真实资料：${d.viralFacts || "未提供"}。
视频脚本：${d.script}。
改编要求：${d.instructions}。
画面补充：${d.viralKeyframePrompt || "主体完整入镜，为动作留出空间；只生成单幅画面，不制作拼图。"}。
画幅参考：${d.viralSettings?.size || "跟随当前图片设置"}。照片没有展示的全身、裙摆与背面属于生成补全，不声称与实物完全一致；不要虚构价格、优惠、功效或承诺。`;
}
