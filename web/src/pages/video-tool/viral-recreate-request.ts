import { materialMentionError, videoInputMode, videoProfile, videoReferenceError } from "@/lib/video-capabilities";
import { inferVideoRatio } from "@/lib/media-size";
import { isReplicateVideoModel, REPLICATE_VIDEO_MODEL } from "@/services/api/replicate";
import { resolveModelRequestConfig, selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { VideoDraft, WorkbenchMedia, ViralRecreateInput } from "@/types/video-workbench";
import { storeVideoConfig, storeVideoSettings } from "./store-explore-request";
import { viralAdoptedAnalysisError, viralAdoptedAnalysisText, viralAnalysisMode, viralFrameMaterials, viralReference } from "./viral-analysis";
import { viralKeyframeError, viralVisualRole } from "./viral-keyframe";

export { viralAnalysisMode, viralFrameMaterials, viralReference, viralSource } from "./viral-analysis";
export const viralImageCandidates = (d: VideoDraft) => [...d.media.filter((m) => m.kind === "image"), ...viralFrameMaterials(d)];
export function viralMaterialLabels(d: VideoDraft) {
    const images = d.media.filter((m) => m.kind === "image");
    return [
        ...(viralReference(d) ? [{ id: viralReference(d)!.id, label: "视频1", name: viralReference(d)!.name }] : []),
        ...images.map((m, i) => ({ id: m.id, label: `图片${i + 1}`, name: m.name })),
        ...viralFrameMaterials(d).map((m, i) => ({ id: m.id, label: `图片${images.length + i + 1}`, name: m.name })),
    ];
}
export function viralVideoConfig(d: VideoDraft, config: AiConfig): AiConfig {
    return storeVideoConfig({...d,storeSettings:d.viralSettings},config);
}
const viralContinuityRules = `复刻内容约束：以用户明确的修改或删除要求为准；仅替换人物、商品或场景，不等于删除原视频的核心动作与视觉效果。逐项承接已采用分析中的动作顺序、物体展开或变形、高潮展示、结束状态及画面内文字，不得将具体过程简化为“转身、展示、结束”等泛泛描述。必须写清谁在何时做什么、物体从何种状态变成何种形态、大小与位置、最终如何展示和保持。
画面内文字属于可见物体内容，须写清准确字样、承载物、位置和出现时机；不能用口播或屏幕字幕替代。用户明确指定替换字样时使用指定文字；未指定替换且分析识别清楚时沿用原字并注明，文字不清或替换意图冲突时列为待确认，不擅自改成品牌名、不直接省略。原人物、服装和场景以用户目标素材为准，不因保留动作效果而恢复原主体。`;
export function viralScriptPrompt(d: VideoDraft, cfg: AiConfig) {
    const labels = viralMaterialLabels(d), ratio = inferVideoRatio(cfg.size);
    return `为参考视频改编中文视频脚本，只返回可编辑脚本。目标规格：${cfg.videoSeconds}秒单片段，画幅${ratio === "auto" ? "16:9" : ratio}；按此规格重排节奏，保留高潮展示时间，不机械照搬原片秒数。逐段写时间范围、机位与构图、人物动作、物体变化和可见文字，结尾写明最终画面。
${viralContinuityRules}
主体与场景真实资料：${d.viralFacts || "未提供，不虚构价格、优惠、功效或承诺"}。
已采用的参考结构：${viralAdoptedAnalysisText(d)}。
新商品分析：${d.viralProductStale ? "旧分析素材已变，以资料和图片为准" : d.viralProductAnalysis || "未提供"}。
用户改编要求：${d.instructions}。
待修改原稿：${d.script || "无"}。原稿可能遗漏关键内容，须按已采用分析补齐；旧稿没有写到不代表用户要求删除。
编号与角色：${labels.map((l) => `${l.label}=${l.name}（${viralVisualRole(d.media.find((m) => m.id === l.id)?.role || "")}）`).join("；")}。保留用户@编号，不编造编号。人物半身照片未展示的全身、裙摆和背面须通过首帧补全并确认。
当前视频实际输入为${viralVideoMaterials(d, cfg).map((m) => m.name).join("、") || "尚未选择"}；未发送的新人物/商品须准备相应首帧，不承诺凭文字即可精准替换。不能承诺多镜头后期、配音字幕已完成。
输出前逐项对照已采用分析，补回遗漏的核心动作、变形结果和画面文字。脚本末尾附“复刻要点核对”：列出原片关键效果对应的新脚本时间段、用户明确要求的替换或删除，以及仍待确认的文字/视觉素材；没有待确认项则写无。不得将待确认项写成已完成效果。`;
}
export function viralVideoMaterials(d: VideoDraft, cfg: AiConfig) {
    const mode = videoInputMode(cfg, cfg.videoModel);
    const candidates = viralImageCandidates(d);
    const images =
        mode === "reference"
            ? candidates.filter((m) => m.kind === "image" && (["product", "model", "background"].includes(m.role) || m.id === d.viralFirstFrameId))
            : [candidates.find((m) => m.id === d.viralFirstFrameId), ...(mode === "first_last" && cfg.videoModel !== REPLICATE_VIDEO_MODEL ? [candidates.find((m) => m.id === d.viralLastFrameId)] : [])].filter((m): m is WorkbenchMedia => Boolean(m));
    return [...images, ...(d.viralUseVideo && viralReference(d) ? [viralReference(d)!] : [])];
}
export function viralVideoError(d: VideoDraft, cfg: AiConfig) {
    const model = cfg.videoModel,
        profile = videoProfile(cfg, model);
    if (!model || !selectableModelsByCapability(cfg, "video").includes(model)) return "请选择当前已启用的视频模型";
    if ((cfg.channelMode === "remote" || isReplicateVideoModel(model)) && !useUserStore.getState().token) return "登录后使用平台视频模型";
    if (!isReplicateVideoModel(model) && !useConfigStore.getState().isAiConfigReady(cfg, model)) return "请配置当前视频模型的渠道";
    if (!d.script.trim()) return "请填写或生成视频脚本";
    const keyframeError = viralKeyframeError(d);
    if (keyframeError) return keyframeError;
    const analysisError = viralAdoptedAnalysisError(d);
    if (analysisError) return analysisError;
    if (profile.interface === "unavailable") return profile.description;
    if (profile.seconds.length && !profile.seconds.includes(cfg.videoSeconds)) return "当前模型不支持所选时长，请调整视频设置";
    if (profile.resolutions.length && !profile.resolutions.includes(cfg.vquality)) return "当前模型不支持所选清晰度，请调整视频设置";
    const mentionError = materialMentionError(`${d.instructions}\n${d.script}`, viralMaterialLabels(d));
    if (mentionError) return mentionError;
    const mode = videoInputMode(cfg, model),
        candidates = viralImageCandidates(d);
    if (mode !== "reference" && d.viralFirstFrameId && !candidates.some((m) => m.id === d.viralFirstFrameId)) return "所选首帧已失效，请重新选择";
    if (mode === "first_last" && model !== REPLICATE_VIDEO_MODEL && d.viralLastFrameId && !candidates.some((m) => m.id === d.viralLastFrameId)) return "所选尾帧已失效，请重新选择";
    if (d.viralUseVideo && !viralReference(d)) return "请上传参考视频，或关闭直接视频参考";
    const materials = viralVideoMaterials(d, cfg);
    return videoReferenceError(cfg, model, materials.filter((m) => m.kind === "image").length, materials.filter((m) => m.kind === "video").length, 0);
}
export function viralVideoPrompt(d: VideoDraft, cfg: AiConfig) {
    const labels = viralMaterialLabels(d),
        materials = viralVideoMaterials(d, cfg);
    return `${d.script}\n${viralContinuityRules}\n脚本未展开的核心动作与视觉效果按已采用分析补齐，用户明确修改或删除的内容除外；脚本中的核对清单和待确认说明不是需要出现在画面上的字幕。\n主体与场景真实资料：${d.viralFacts || "未提供，不虚构价格、优惠、功效或承诺"}\n改编要求：${d.instructions}\n参考结构：${viralAdoptedAnalysisText(d)}\n商品分析：${d.viralProductStale ? "素材已变化，以用户资料及实际输入为准" : d.viralProductAnalysis || "未分析"}\n本次实际视觉输入：${materials.map((m, i) => `${labels.find((l) => l.id === m.id)?.label || m.name}=${m.kind === "video" ? "参考视频" : videoInputMode(cfg, cfg.videoModel) === "reference" ? `参考图${i + 1}` : i === 0 ? "首帧" : "尾帧"}（${viralVisualRole(m.role)}${m.id === d.viralFirstFrameId ? "，已确认的开场画面" : ""}）`).join("；") || "纯文字"}。场景图提供环境与建筑，人物图提供身份与服饰，商品图提供商品外观；不要把未发送的素材当作视觉输入。${d.viralUseVideo ? "参考视频用于动作与节奏参考，实际一致性以成片为准。" : "没有向视频模型发送原视频，动作仅依照文字脚本重建，不声称逐帧复制原动作。"}生成${cfg.videoSeconds}秒单条片段；口播、字幕及配乐建议不代表已完成独立后期。`;
}
export function viralInput(d: VideoDraft, cfg: AiConfig): ViralRecreateInput {
    const {
        media,
        frames,
        frameCount,
        transcript,
        analysis,
        instructions,
        script,
        viralFacts,
        viralProductAnalysis,
        viralFirstFrameId,
        viralLastFrameId,
        viralUseVideo,
        viralAnalysisMode: analysisMode,
        viralFrameSource,
        viralFrameTimes,
        viralTranscriptSource,
        viralAnalysisStale,
        viralProductStale,
        viralScriptStale,
    } = d;
    return {
        media,
        frames,
        frameCount,
        transcript,
        analysis,
        instructions,
        script,
        viralFacts,
        viralProductAnalysis,
        viralFirstFrameId,
        viralLastFrameId,
        viralUseVideo,
        viralAnalysisMode: analysisMode || viralAnalysisMode(d, cfg),
        viralAnalyses: d.viralAnalyses,
        viralAdoptedAnalysis: d.viralAdoptedAnalysis,
        viralUseTranscript: d.viralUseTranscript,
        viralFrameSource,
        viralFrameTimes,
        viralTranscriptSource,
        viralAnalysisStale,
        viralProductStale,
        viralScriptStale,
        viralKeyframe: d.viralKeyframe,
        viralKeyframePrompt: d.viralKeyframePrompt,
        viralKeyframeReferenceId: d.viralKeyframeReferenceId,
        viralSettings: storeVideoSettings(cfg),
        channelMode: cfg.channelMode,
        baseUrl: resolveModelRequestConfig(cfg, cfg.videoModel).baseUrl,
    };
}
