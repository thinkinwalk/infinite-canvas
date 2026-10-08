import { materialMentionError, videoInputMode, videoProfile, videoReferenceError } from "@/lib/video-capabilities";
import { isReplicateVideoModel, REPLICATE_VIDEO_MODEL } from "@/services/api/replicate";
import { resolveModelRequestConfig, selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { VideoDraft, WorkbenchMedia, ViralRecreateInput } from "@/types/video-workbench";
import { storeVideoSettings } from "./store-explore-request";

export const viralReference = (d: VideoDraft) => d.media.find((m) => m.role === "reference" && m.kind === "video");
export const viralSource = (d: VideoDraft) => {
    const video = viralReference(d);
    return video ? `${video.id}:${video.storageKey || video.url}` : "";
};
export function viralFrameMaterials(d: VideoDraft): WorkbenchMedia[] {
    return d.viralFrameSource === viralSource(d) && d.viralFrameSource ? d.frames.map((f, i) => ({ ...f, id: `frame:${f.storageKey}`, name: `抽样画面${i + 1}`, role: "first-frame", kind: "image" })) : [];
}
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
    const settings = d.viralSettings || storeVideoSettings(config);
    return { ...config, ...settings, model: settings.videoModel, vquality: settings.vquality.replace(/p$/i, "") };
}
export function viralVideoMaterials(d: VideoDraft, cfg: AiConfig) {
    const mode = videoInputMode(cfg, cfg.videoModel);
    const candidates = viralImageCandidates(d);
    const images =
        mode === "reference"
            ? d.media.filter((m) => m.kind === "image" && ["product", "model", "first-frame"].includes(m.role))
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
    return `${d.script}\n新商品真实资料：${d.viralFacts || "未提供，不虚构价格、优惠、功效或承诺"}\n改编要求：${d.instructions}\n参考结构（${d.viralAnalysisStale ? "输入已变化，仅供核对" : "分析依据"}）：${d.analysis}\n商品分析：${d.viralProductStale ? "素材已变化，以用户资料及实际输入为准" : d.viralProductAnalysis || "未分析"}\n本次实际视觉输入：${materials.map((m, i) => `${labels.find((l) => l.id === m.id)?.label || m.name}=${m.kind === "video" ? "参考视频" : videoInputMode(cfg, cfg.videoModel) === "reference" ? `参考图${i + 1}` : i === 0 ? "首帧" : "尾帧"}（${m.role === "product" ? "新商品" : m.role === "model" ? "人物" : "画面"}）`).join("；") || "纯文字"}。不要把未发送的素材当作视觉输入。生成${cfg.videoSeconds}秒单条片段；口播、字幕及配乐建议不代表已完成独立后期。`;
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
        viralFrameSource,
        viralFrameTimes,
        viralTranscriptSource,
        viralAnalysisStale,
        viralProductStale,
        viralScriptStale,
        viralSettings: storeVideoSettings(cfg),
        channelMode: cfg.channelMode,
        baseUrl: resolveModelRequestConfig(cfg, cfg.videoModel).baseUrl,
    };
}
