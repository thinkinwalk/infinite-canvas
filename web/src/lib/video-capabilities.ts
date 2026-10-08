import type { VideoModelProfile } from "@/services/api/admin";
import { modelOptionLabel, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

export const VIDEO_INPUT_MODES = [
    { value: "reference", label: "参考" },
    { value: "first_last", label: "首尾帧" },
    { value: "first_frame_only", label: "文生 / 单首帧" },
];

export function videoProfile(config: AiConfig, model: string): VideoModelProfile {
    const name = modelOptionName(model);
    if (model.startsWith("replicate::") && name === "wan-video/wan-2.2-i2v-fast") return { displayName: modelOptionLabel(config, model), description: "首帧必填、尾帧可选；比例跟随首帧，支持约 5 秒或 7.5 秒。", interface: "relay", maxImages: 2, maxVideos: 0, maxAudios: 0, resolutions: ["480", "720"], seconds: ["5", "7.5"], generateAudio: false, inputModes: ["first_last"], firstFrameRequired: true, lastFrameOptional: true, firstFrameField: "image", lastFrameField: "last_image" };
    if (model.startsWith("replicate::") && name === "minimax/hailuo-2.3") return { displayName: modelOptionLabel(config, model), description: "可直接输入文字，也可上传1张首帧图片。768p支持6/10秒，1080p仅支持6秒。", interface: "relay", maxImages: 1, maxVideos: 0, maxAudios: 0, resolutions: ["768", "1080"], seconds: config.vquality.replace(/p$/i, "") === "1080" ? ["6"] : ["6", "10"], generateAudio: false, inputModes: ["first_frame_only"], firstFrameRequired: false, firstFrameField: "first_frame_image" };
    const saved = config.channelMode === "remote" ? config.videoModels?.[name] : undefined;
    const request = resolveModelRequestConfig(config, model);
    const ark = request.baseUrl.includes("/api/plan/v3");
    const seedance = /seedance|seedace/i.test(name);
    return { description: "根据文字和参考图片制作视频；视频、音频及首尾帧需由管理员确认渠道支持后开放。", interface: ark ? "ark" : seedance ? "relay" : "openai", maxImages: 7, maxVideos: ark ? 3 : 0, maxAudios: ark ? 3 : 0, resolutions: seedance && !ark ? ["480", "720"] : ["480", "720", "1080"], seconds: seedance ? Array.from({ length: 12 }, (_, i) => String(i + 4)) : [], generateAudio: ark, inputModes: ["reference"], ...saved, displayName: /seedance.*mini/i.test(name) ? modelOptionLabel(config, model) : saved?.displayName || name };
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
