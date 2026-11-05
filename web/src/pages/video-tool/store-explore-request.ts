import { inferVideoRatio, computeVideoSize } from "@/lib/media-size";
import { materialMentionError, videoInputMode, videoProfile, videoReferenceError } from "@/lib/video-capabilities";
import { isReplicateVideoModel, REPLICATE_VIDEO_MODEL } from "@/services/api/replicate";
import { selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { VideoDraft, StoreVideoSettings } from "@/types/video-workbench";
import { storeFreeScriptError, storePlanError } from "./store-explore-plan";
import { storeCandidateMaterials, storeCast, storeCastReferenceError, storeSelectedIds, storeSelectedMaterialError } from "./store-materials";
import { storePersonVoiceError, storePersonVoices, storePersonVoicePrompt } from "./store-person-voice";

export function storeVideoSettings(config: AiConfig): StoreVideoSettings {
    const { videoModel, size, vquality, videoSeconds, videoGenerateAudio, videoWatermark, videoInputMode, videoInterpolate } = config;
    return { videoModel, size, vquality, videoSeconds, videoGenerateAudio, videoWatermark, videoInputMode, videoInterpolate };
}

export function storeVideoConfig(d: VideoDraft, config: AiConfig): AiConfig {
    let settings = d.storeSettings || storeVideoSettings(config);
    if (config.managed?.enabled && config.channelMode === "remote") {
        const videoModel = selectableModelsByCapability(config,"video").includes(settings.videoModel) ? settings.videoModel : config.videoModel;
        settings = videoModel ? normalizeStoreSettings({...settings,videoModel},config) : {...settings,videoModel:""};
    }
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
    if (videoInputMode(config, config.videoModel) === "reference") {
        const selected = new Set(storeSelectedIds(d));
        return storeCandidateMaterials(d).filter((m) => selected.has(m.id));
    }
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
    const planError = storePlanError(d.storeShots || [], d.media.filter((m) => m.kind === "image").map((m) => m.id), Number(config.videoSeconds));
    if (planError) return planError;
    if (!d.storeShots?.length) {
        const scriptError = storeFreeScriptError(d.script, Number(config.videoSeconds), inferVideoRatio(config.size));
        if (scriptError) return scriptError;
    }
    const profile = videoProfile(config, model);
    if (profile.interface === "unavailable") return profile.description;
    if (profile.seconds.length && !profile.seconds.includes(config.videoSeconds)) return "当前模型不支持所选时长，请调整视频设置";
    if (profile.resolutions.length && !profile.resolutions.includes(config.vquality.replace(/p$/i, ""))) return "当前模型不支持所选清晰度，请调整视频设置";
    const voiceError = storePersonVoiceError(d, config);
    if (voiceError) return voiceError;
    const mentionError = materialMentionError(`${d.instructions}\n${d.script}`, storeMaterialLabels(d));
    if (mentionError) return mentionError;
    const mode = videoInputMode(config, model);
    const materials = storeVideoMaterials(d, config);
    if (mode === "reference") {
        const materialError = storeSelectedMaterialError(d);
        if (materialError) return materialError;
        const castError = storeCastReferenceError(d, storeSelectedIds(d));
        if (castError) return castError;
        const mentioned = (d.storeShots?.length ? d.storeShots.map((s) => `${s.visual}\n${s.dialogue}`).join("\n") : d.script).match(/@?图片\d+/g) || [];
        if (mentioned.some((mention) => !materials.some((m) => storeMaterialLabels(d).find((l) => l.id === m.id)?.label === mention.replace(/^@/, "")))) return "方案引用了未采用的图片，请在对应镜头或本次参考图中选用";
        if (materials.length > profile.maxImages) return `本次已选 ${materials.length} 张，当前模型最多支持 ${profile.maxImages} 张，请精选或调整参考图`;
    }
    if (mode !== "reference" && d.storeFirstFrameId && !d.media.some((m) => m.id === d.storeFirstFrameId)) return "选定的首帧已移除，请重新选择";
    if (mode === "first_last" && model !== REPLICATE_VIDEO_MODEL && d.storeLastFrameId && !d.media.some((m) => m.id === d.storeLastFrameId)) return "选定的尾帧已移除，请重新选择";
    return videoReferenceError(config, model, materials.length, 0, storePersonVoices(d).length);
}

export function storeVideoPrompt(d: VideoDraft, config: AiConfig) {
    const materials = storeVideoMaterials(d, config);
    const labels = storeMaterialLabels(d);
    const renumber = (text: string) => text.replace(/(@?)图片(\d+)/g, (original, at, index) => {
        const label = labels[Number(index) - 1], actual = materials.findIndex((m) => m.id === label?.id);
        return actual < 0 ? "未发送的候选图片" : `${at}图片${actual + 1}`;
    });
    const mapping = materials
        .map(
            (m, index) =>
                `图片${index + 1}=${videoInputMode(config, config.videoModel) === "reference" ? `视频参考图${index + 1}` : index === 0 ? "生成首帧" : "生成尾帧"}（${m.role === "model" ? `人物 ${m.storePerson?.trim() || "探店人"}` : m.storePurpose || "门店/商品"}）`,
        )
        .join("；");
    const plan = d.storeShots?.length ? d.storeShots.map((s) => `${s.start}-${s.end}秒：${renumber(s.visual)}${s.dialogue && d.storeAudioMode !== "mute" ? `；台词：${renumber(s.dialogue)}` : ""}。本镜实际参考：${s.materialIds.filter((id) => materials.some((m) => m.id === id)).map((id) => `图片${materials.findIndex((m) => m.id === id) + 1}`).join("、") || "无直接图片输入，以文字描述为准"}`).join("\n") : renumber(d.script);
    const audio = d.storeAudioMode === "narration" ? "画面不生成口播，旁白在后期添加；不要求人物对口型。" : d.storeAudioMode === "mute" ? "不生成口播或人声。" : storePersonVoicePrompt(d, config, materials)
        || "声音以当前模型实际能力为准，不承诺精确口型。";
    const canvas = isReplicateVideoModel(config.videoModel) ? "画幅跟随所传首帧，纯文字时使用模型默认比例" : `画幅${config.size}`;
    const cast = storeCast(d);
    const people = cast.length ? `出镜人物：${cast.map((person) => person.name).join("、")}；按方案实际出镜并完成相应动作，保持同一人物的脸部、发型和服装，不替换成随机主持人。同名或未命名人物的多视角、单张三视图只代表同一个人，不生成重复人物或三视图拼贴。人物身份仅依据本次实际输入的人物参考或已合成首帧。` : "";
    return `${plan}\n门店真实资料（价格、地址和活动仅以此为准）：${d.storeFacts || "未提供，不虚构"}\n本次实际图片对应关系：${mapping || "纯文字生成"}。同名人物多图属于同一身份。${people}制作${config.videoSeconds}秒、${canvas}、${config.vquality}p的单条视频片段。镜头时间为创作计划；不要把未发送的图片当作视觉输入。${audio}\n不要将分析说明或制作参数显示为画面文字。`;
}
