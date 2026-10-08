import { inferVideoRatio, computeVideoSize } from "@/lib/media-size";
import { materialMentionError, videoInputMode, videoProfile, videoReferenceError } from "@/lib/video-capabilities";
import { isReplicateVideoModel, REPLICATE_VIDEO_MODEL } from "@/services/api/replicate";
import { selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { VideoDraft, StoreVideoSettings } from "@/types/video-workbench";

export function storeVideoSettings(config: AiConfig): StoreVideoSettings {
    const { videoModel, size, vquality, videoSeconds, videoGenerateAudio, videoWatermark, videoInputMode, videoInterpolate } = config;
    return { videoModel, size, vquality, videoSeconds, videoGenerateAudio, videoWatermark, videoInputMode, videoInterpolate };
}

export function storeVideoConfig(d: VideoDraft, config: AiConfig): AiConfig {
    const settings = d.storeSettings || storeVideoSettings(config);
    return { ...config, ...settings, model: settings.videoModel, vquality: settings.vquality.replace(/p$/i, "") };
}

export function normalizeStoreSettings(settings: StoreVideoSettings, config: AiConfig): StoreVideoSettings {
    const next = { ...settings, vquality: settings.vquality.replace(/p$/i, "") };
    const profile = videoProfile({ ...config, ...next }, next.videoModel);
    if (profile.resolutions.length && !profile.resolutions.includes(next.vquality)) next.vquality = profile.resolutions[0];
    const updated = videoProfile({ ...config, ...next }, next.videoModel);
    if (updated.seconds.length && !updated.seconds.includes(next.videoSeconds)) next.videoSeconds = updated.seconds[0];
    next.videoInputMode = videoInputMode({ ...config, ...next }, next.videoModel);
    if (!isReplicateVideoModel(next.videoModel)) next.size = computeVideoSize(next.vquality, inferVideoRatio(next.size) === "auto" ? "16:9" : inferVideoRatio(next.size));
    return next;
}

export function storeMaterialLabels(d: VideoDraft) {
    return d.media.filter((m) => m.kind === "image" && ["reference", "model", "first-frame"].includes(m.role)).map((m, index) => ({ id: m.id, label: `图片${index + 1}`, name: m.name }));
}

export function storeVideoMaterials(d: VideoDraft, config: AiConfig) {
    if (videoInputMode(config, config.videoModel) === "reference") return d.media.filter((m) => m.kind === "image" && ["reference", "model"].includes(m.role));
    const first = d.media.find((m) => m.kind === "image" && m.id === d.storeFirstFrameId) || d.media.find((m) => m.role === "first-frame" && m.kind === "image");
    const last = d.media.find((m) => m.kind === "image" && m.id === d.storeLastFrameId);
    return [...(first ? [first] : []), ...(videoInputMode(config, config.videoModel) === "first_last" && config.videoModel !== REPLICATE_VIDEO_MODEL && last ? [last] : [])];
}

export function storeVideoError(d: VideoDraft, config: AiConfig) {
    const model = config.videoModel;
    if (!model || !selectableModelsByCapability(config, "video").includes(model)) return "请选择当前已启用的视频模型";
    if ((config.channelMode === "remote" || isReplicateVideoModel(model)) && !useUserStore.getState().token) return "登录后使用平台视频模型";
    if (!isReplicateVideoModel(model) && !useConfigStore.getState().isAiConfigReady(config, model)) return "请配置当前视频模型的渠道";
    if (!d.script.trim()) return "请填写或生成视频脚本";
    const profile = videoProfile(config, model);
    if (profile.interface === "unavailable") return profile.description;
    if (profile.seconds.length && !profile.seconds.includes(config.videoSeconds)) return "当前模型不支持所选时长，请调整视频设置";
    if (profile.resolutions.length && !profile.resolutions.includes(config.vquality.replace(/p$/i, ""))) return "当前模型不支持所选清晰度，请调整视频设置";
    const mentionError = materialMentionError(`${d.instructions}\n${d.script}`, storeMaterialLabels(d));
    if (mentionError) return mentionError;
    const mode = videoInputMode(config, model);
    if (mode !== "reference" && d.storeFirstFrameId && !d.media.some((m) => m.id === d.storeFirstFrameId)) return "选定的首帧已移除，请重新选择";
    if (mode === "first_last" && model !== REPLICATE_VIDEO_MODEL && d.storeLastFrameId && !d.media.some((m) => m.id === d.storeLastFrameId)) return "选定的尾帧已移除，请重新选择";
    return videoReferenceError(config, model, storeVideoMaterials(d, config).length, 0, 0);
}

export function storeVideoPrompt(d: VideoDraft, config: AiConfig) {
    const materials = storeVideoMaterials(d, config);
    const labels = storeMaterialLabels(d);
    const mapping = materials
        .map(
            (m, index) =>
                `${labels.find((label) => label.id === m.id)?.label || m.name}=${videoInputMode(config, config.videoModel) === "reference" ? `视频参考图${index + 1}` : index === 0 ? "生成首帧" : "生成尾帧"}（${m.role === "model" ? "人物" : "门店/商品"}）`,
        )
        .join("；");
    return `${d.script}\n门店真实资料（价格、地址和活动仅以此为准）：${d.storeFacts || "未提供，不虚构"}\n创作要求：${d.instructions}\n视觉分析（不作为价格、地址或促销依据）：${d.analysis}\n本次实际图片对应关系：${mapping || "纯文字生成"}。制作${config.videoSeconds}秒的单条视频片段；不要把未发送的图片当作视觉输入。`;
}
