import type { VideoModelProfile } from "@/services/api/admin";
import { isMiniMaxH3Name, miniMaxH3Profile } from "@/lib/minimax-h3";
import { managedModelBinding, modelAdapter, modelOptionLabel, modelOptionName, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";

export const VIDEO_INPUT_MODES = [
    { value: "reference", label: "参考" },
    { value: "first_last", label: "首尾帧" },
    { value: "first_frame_only", label: "文生 / 单首帧" },
];

export function sparkCineH3Preset(): VideoModelProfile {
    return {
        displayName: "MiniMax H3 Video", description: "支持图片、音频及一段 2–15 秒视频参考；内容替换效果待实测确认。",
        interface: "sparkcine_h3", maxImages: 9, maxVideos: 1, maxAudios: 3,
        resolutions: ["480", "720", "768", "960", "1080"], seconds: Array.from({ length: 27 }, (_, i) => String(i + 4)),
        inputModes: ["reference"], generateAudio: false, contentReplacement: true,
        referenceVideoMinSeconds: 2, referenceVideoMaxSeconds: 15,
    };
}

export function videoProfile(config: AiConfig, model: string): VideoModelProfile {
    if (config.managed?.enabled && config.channelMode === "remote") {
        const binding = managedModelBinding(config,model,"video");
        if (binding?.video) return binding.video;
        const operation = binding?.operations[0];
        if (operation === "text-to-video" || operation === "image-to-video") return { displayName:modelOptionLabel(config,model), description:"", interface:"relay", maxImages:operation === "image-to-video" ? 2 : 0, maxVideos:0,maxAudios:0,resolutions:["480","720"],seconds:["5","7.5"],generateAudio:false,inputModes:operation === "image-to-video" ? ["first_last"] : ["reference"],firstFrameField:"image",lastFrameField:"last_image",firstFrameRequired:operation === "image-to-video",lastFrameOptional:true };
        if (operation === "hailuo-video") return { displayName:modelOptionLabel(config,model),description:"",interface:"relay",maxImages:1,maxVideos:0,maxAudios:0,resolutions:["768","1080"],seconds:config.vquality.replace(/p$/i,"") === "1080" ? ["6"] : ["6","10"],generateAudio:false,inputModes:["first_frame_only"],firstFrameField:"first_frame_image" };
        return { displayName:modelOptionLabel(config,model),description:"",interface:"relay",maxImages:1,maxVideos:1,maxAudios:0,resolutions:["480","720"],seconds:["10","15"],generateAudio:false,inputModes:["reference"] };
    }
    const name = modelOptionName(model);
    if (isMiniMaxH3Name(name)) return { ...miniMaxH3Profile(name), ...(config.channelMode === "remote" ? config.videoModels?.[name] : undefined) };
    if (isH3Video2K(model)) return { displayName: name, description: "支持 768p / 2K，支持 5 / 10 / 15 秒，按次计费；2K 为模型输出档位，实际像素以成片为准。", interface: "relay", maxImages: 9, maxVideos: 3, maxAudios: 3, resolutions: ["2K", "768"], seconds: ["15", "5", "10"], generateAudio: false, inputModes: ["reference"], contentReplacement: config.channelMode === "remote" && config.videoModels?.[name]?.contentReplacement === true };
    if (model.startsWith("replicate::") && name === "wan-video/wan-2.2-t2v-fast") return { displayName: modelOptionLabel(config, model), description: "只写文字即可生成视频，支持横屏 / 竖屏、约 5 秒或 7.5 秒。", interface: "relay", maxImages: 0, maxVideos: 0, maxAudios: 0, resolutions: ["480", "720"], seconds: ["5", "7.5"], generateAudio: false, inputModes: ["reference"] };
    if (model.startsWith("replicate::") && name === "wan-video/wan-2.2-i2v-fast") return { displayName: modelOptionLabel(config, model), description: "首帧必填、尾帧可选；可选横屏 / 竖屏，确认裁剪构图后生成，支持约 5 秒或 7.5 秒。", interface: "relay", maxImages: 2, maxVideos: 0, maxAudios: 0, resolutions: ["480", "720"], seconds: ["5", "7.5"], generateAudio: false, inputModes: ["first_last"], firstFrameRequired: true, lastFrameOptional: true, firstFrameField: "image", lastFrameField: "last_image" };
    if (model.startsWith("replicate::") && name === "minimax/hailuo-2.3") return { displayName: modelOptionLabel(config, model), description: "可直接输入文字，也可上传1张首帧图片。768p支持6/10秒，1080p仅支持6秒。", interface: "relay", maxImages: 1, maxVideos: 0, maxAudios: 0, resolutions: ["768", "1080"], seconds: config.vquality.replace(/p$/i, "") === "1080" ? ["6"] : ["6", "10"], generateAudio: false, inputModes: ["first_frame_only"], firstFrameRequired: false, firstFrameField: "first_frame_image" };
    const saved = config.channelMode === "remote" ? config.videoModels?.[name] : undefined;
    const request = resolveModelRequestConfig(config, model);
    const ark = request.baseUrl.includes("/api/plan/v3");
    const seedance = /seedance|seedace/i.test(name);
    const resolutions = isH3Video768(model) ? ["768"] : saved?.resolutions ?? (seedance && !ark ? ["480", "720"] : ["480", "720", "1080"]);
    return { description: "根据文字和参考图片制作视频；视频、音频及首尾帧需由管理员确认渠道支持后开放。", interface: ark ? "ark" : seedance ? "relay" : "openai", maxImages: 7, maxVideos: ark ? 3 : 0, maxAudios: ark ? 3 : 0, seconds: seedance ? Array.from({ length: 12 }, (_, i) => String(i + 4)) : [], generateAudio: ark, inputModes: ["reference"], ...saved, resolutions, displayName: /seedance.*mini/i.test(name) ? modelOptionLabel(config, model) : saved?.displayName || name };
}

export function isH3Video768(model: string) {
    return modelOptionName(model).trim().toLowerCase() === "h3video-768";
}

export function isH3Video2K(model: string) {
    if (modelAdapter(model) === "video.h3-2k") return true;
    return modelOptionName(model).trim().toLowerCase() === "h3video-2k";
}

export function isWan30(model: string) {
    if (modelAdapter(model) === "video.wan30") return true;
    return modelOptionName(model).trim().toLowerCase() === "wan30-720p";
}

export function videoReferenceDurationError(model: string, videos: { durationMs?: number }[], config?: AiConfig) {
    const profile = config ? videoProfile(config, model) : undefined;
    const minimum = profile?.referenceVideoMinSeconds || (isWan30(model) ? 1 : 0);
    const maximum = profile?.referenceVideoMaxSeconds || (isWan30(model) ? 30 : 0);
    if (!minimum && !maximum) return "";
    for (const [index, video] of videos.entries()) {
        const duration = video.durationMs;
        if (!duration || !Number.isFinite(duration)) return `第 ${index + 1} 个参考视频时长无法读取，请重新上传`;
        if (duration < minimum * 1000 || maximum > 0 && duration > maximum * 1000) return `第 ${index + 1} 个参考视频需为 ${minimum}–${maximum || "不限"} 秒，请裁剪后再提交`;
    }
    return "";
}

export function contentReplacementModels(config: AiConfig) {
    if (config.managed?.enabled && config.channelMode === "remote") return selectableModelsByCapability(config,"video");
    return selectableModelsByCapability(config, "video").filter((model) => {
        const profile = config.videoModels?.[modelOptionName(model)] ?? videoProfile(config, model);
        return model.startsWith("remote::") && profile.contentReplacement === true &&
            ["relay", "ark", "sparkcine_h3"].includes(profile.interface) && profile.maxImages > 0 && profile.maxVideos > 0 &&
            supportedVideoInputModes(profile).includes("reference");
    }).sort((a, b) => Number(isWan30(b)) - Number(isWan30(a)));
}

export function sparkCineVideoSeconds(profile: VideoModelProfile, resolution: string, ratio: string) {
    if (profile.interface !== "sparkcine_h3") return profile.seconds;
    const limit = ["960", "1080"].includes(resolution.replace(/p$/i, "")) ? 15 : resolution.replace(/p$/i, "") === "768" && ratio === "21:9" ? 20 : 30;
    return profile.seconds.filter((value) => Number.isInteger(Number(value)) && Number(value) >= 4 && Number(value) <= limit);
}

export function sparkCineVideoSpecError(profile: VideoModelProfile, resolution: string, ratio: string, seconds: string) {
    if (profile.interface !== "sparkcine_h3") return "";
    if (!["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"].includes(ratio)) return "H3 不支持当前画幅，请重新选择";
    if (resolution.replace(/p$/i, "") === "720" && !["16:9", "9:16"].includes(ratio)) return "H3 的 720P 仅支持 16:9 / 9:16";
    return sparkCineVideoSeconds(profile, resolution, ratio).includes(seconds) ? "" : "H3 当前画幅和清晰度不支持所选时长，请重新选择";
}

export function resolveAutomaticVideoModel(config: AiConfig, images: number, videos: number, audios: number, requestedMode?: string) {
    const models = selectableModelsByCapability(config, "video");
    const preferred = `replicate::wan-video/wan-2.2-${images ? "i2v" : "t2v"}-fast`;
    const supportsMode = (model: string) => !requestedMode || supportedVideoInputModes(videoProfile(config, model)).includes(requestedMode);
    const ordered = [preferred, config.videoModel, ...models].filter((model, index, values) => values.indexOf(model) === index);
    return ordered.find((model) => models.includes(model) && videoProfile(config, model).interface !== "unavailable" && supportsMode(model) && !videoReferenceError(config, model, images, videos, audios))
        || "";
}

export function videoModelsForInputMode(config: AiConfig, mode: string) {
    return selectableModelsByCapability(config, "video").filter((model) => {
        const profile = videoProfile(config, model);
        const modes = supportedVideoInputModes(profile);
        const compatible = mode === "reference" ? modes.includes("reference") || modes.includes("first_frame_only") : modes.includes(mode);
        return profile.interface !== "unavailable" && compatible;
    });
}

export function supportedVideoInputModes(profile: VideoModelProfile) {
    return (profile.inputModes ?? ["reference"]).filter((mode) => mode === "reference" || ((mode === "first_last" || mode === "first_frame_only") && !!profile.firstFrameField && (mode !== "first_last" || !!profile.lastFrameField)));
}

export function videoInputMode(config: AiConfig, model: string) {
    const modes = supportedVideoInputModes(videoProfile(config, model));
    return modes.includes(config.videoInputMode) ? config.videoInputMode : modes[0] || "reference";
}

export function videoInputDescription(profile: VideoModelProfile, mode: string) {
    if (mode === "first_last") return `首帧图片${profile.firstFrameRequired ? "必填" : "可选"}，尾帧图片${profile.lastFrameOptional ? "可选" : "必填"}；两张图分别控制开始和结束画面，不作为普通多图参考。`;
    if (mode === "first_frame_only") return profile.firstFrameRequired ? "上传1张首帧图片生成视频，不支持尾帧。" : "只写文字即可生成视频；也可添加1张首帧图片，不支持尾帧。";
    return "图片用于参考外观与场景；支持的视频、音频按渠道能力参考动作、镜头或声音。第二张参考图不代表尾帧。";
}

export function videoReferenceError(config: AiConfig, model: string, images: number, videos: number, audios: number) {
    const profile = videoProfile(config, model);
    const mode = videoInputMode(config, model);
    if (!supportedVideoInputModes(profile).length) return "当前渠道未配置可用输入模式，请联系管理员。";
    if (mode !== "reference") {
        if (videos || audios) return "首帧 / 首尾帧模式不支持视频或音频参考，请移除这些素材或切换模式。";
        if (images > (mode === "first_last" ? 2 : 1)) return "当前模式只支持1张首帧图片，以及首尾帧模式下的1张尾帧图片，请移除多余图片。";
        if (profile.firstFrameRequired && !images) return "请上传首帧图片；尾帧不能单独使用。";
        if (mode === "first_last" && !profile.lastFrameOptional && images < 2) return "当前模型要求同时上传首帧和尾帧。";
    } else if (images > profile.maxImages || videos > profile.maxVideos || audios > profile.maxAudios) return "参考素材不受当前模型支持或数量超限，请调整素材或切换模型。";
    return "";
}

export type MaterialIdentity = { id: string; label: string };
export function remapMaterialMentions(prompt: string, previous: MaterialIdentity[], next: MaterialIdentity[]) {
    const names = new Map(previous.map((item) => [item.label, next.find((candidate) => candidate.id === item.id)?.label]));
    return prompt.replace(/@(图片|视频|音频)\d+/g, (mention) => {
        const label = mention.slice(1);
        if (!names.has(label)) return mention;
        return names.get(label) ? `@${names.get(label)}` : `@已移除素材（${label}）`;
    });
}

export function materialMentionError(prompt: string, materials: MaterialIdentity[]) {
    if (prompt.includes("@已移除素材")) return "脚本引用的素材已移除，请删除标记或重新选择参考素材。";
    const labels = new Set(materials.map((item) => item.label));
    const missing = (prompt.match(/@(图片|视频|音频)\d+/g) || []).find((item) => !labels.has(item.slice(1)));
    return missing ? `${missing} 不存在，请重新选择参考素材。` : "";
}
