import { isWan30, videoInputMode, videoProfile } from "@/lib/video-capabilities";
import { isMiniMaxH3Name } from "@/lib/minimax-h3";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { VideoDraft, WorkbenchMedia } from "@/types/video-workbench";
import { storeCast } from "./store-materials";

export const storePersonVoices = (d: Pick<VideoDraft, "media">) => d.media.filter((m) => m.role === "voice" && m.kind === "audio");
export const storeVoiceMinimumSeconds = (config: AiConfig) => (isWan30(config.videoModel) || modelOptionName(config.videoModel).trim().toLowerCase() === "wan30-1080p-fast" ? 1 : 2);

export function storeVoiceFileError(file: Pick<File, "name" | "size">) {
    if (!/\.(wav|mp3)$/i.test(file.name)) return "人物音色请使用 WAV 或 MP3 录音";
    if (!file.size) return "人物音色文件为空，请重新选择";
    return file.size > 15 * 1024 * 1024 ? "人物音色文件不能超过 15 MB" : "";
}

export async function storeVoiceFileFormatError(file: Pick<File, "name" | "slice">) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const wav = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
    const mp3 = bytes.length >= 2 && (String.fromCharCode(...bytes.subarray(0, 3)) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    if (!wav && !mp3) return "无法识别音频内容，请上传真实 WAV 或 MP3 文件";
    if ((wav && !/\.wav$/i.test(file.name)) || (mp3 && !/\.mp3$/i.test(file.name))) return "音频文件扩展名与实际格式不一致，请更正文件名后重试";
    return "";
}

export function storeVoiceSampleError(sample: WorkbenchMedia, config: AiConfig) {
    const fileError = storeVoiceFileError({ name: sample.name, size: sample.bytes });
    if (fileError) return fileError;
    if (!["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3"].includes(sample.mimeType)) return "人物音色请使用 WAV 或 MP3 录音";
    if (!sample.durationMs || !Number.isFinite(sample.durationMs)) return "无法读取人物音色录音，请选择可正常播放的 WAV 或 MP3";
    const minimum = storeVoiceMinimumSeconds(config);
    return sample.durationMs < minimum * 1000 || sample.durationMs > 15000 ? `当前模型的人物音色录音需为 ${minimum}–15 秒，请裁剪或更换录音` : "";
}

export function storePersonVoiceError(d: VideoDraft, config: AiConfig) {
    const voices = storePersonVoices(d);
    if (!voices.length) return "";
    if (videoInputMode(config, config.videoModel) !== "reference" || videoProfile(config, config.videoModel).maxAudios < voices.length) return "当前模型或输入模式不支持人物音色参考，请切换支持音频参考的模型和参考模式，或移除人物音色";
    if (d.storeAudioMode && d.storeAudioMode !== "source") return "人物音色用于模型原声，请在声音与字幕中选择原片声音，或移除人物音色";
    if (videoProfile(config, config.videoModel).generateAudio && config.videoGenerateAudio !== "true") return "使用人物音色需在视频设置中开启生成声音";
    if (d.storeShots?.length && !d.storeShots.some((shot) => shot.dialogue.trim())) return "请先为镜头填写需要用人物音色朗读的台词";
    const cast = storeCast(d);
    for (const sample of voices) {
        if (!cast.some((person) => person.name === sample.storePerson)) return "请选择人物音色对应的出镜人物；人物已改名或移除时需重新选择";
        const error = storeVoiceSampleError(sample, config);
        if (error) return error;
    }
    if (voices.reduce((total, sample) => total + (sample.durationMs || 0), 0) > 15000) return "人物音色参考录音总时长不能超过 15 秒";
    return "";
}

export function storePersonVoicePrompt(d: VideoDraft, config: AiConfig, images: WorkbenchMedia[]) {
    const voices = storePersonVoices(d);
    if (!voices.length) return "";
    const h3 = isMiniMaxH3Name(modelOptionName(config.videoModel)) || videoProfile(config, config.videoModel).interface === "sparkcine_h3";
    return voices.map((sample, index) => {
        const personImage = images.findIndex((image) => image.role === "model" && (image.storePerson?.trim() || "探店人") === sample.storePerson);
        const person = storeCast(d).findIndex((candidate) => candidate.name === sample.storePerson);
        const imageReference = personImage >= 0 ? h3 ? `<Picture ${personImage + 1}>` : `图${personImage + 1}` : `出镜人物${person + 1}`;
        const audioReference = h3 ? `<Audio ${index + 1}>` : `音频${index + 1}`;
        return h3
            ? `${audioReference} is the voice-timbre reference for ${imageReference} (Subject ${person + 1}); generate only the new dialogue written in each shot, do not reuse the sample's words, music, or ambient noise, and synchronize visible speech with the spoken dialogue.`
            : `${imageReference}的人物口型同步朗读对应镜头台词；音色参考音频${index + 1}，只使用参考录音的音色，不复用原话、背景音乐或环境噪声。`;
    }).join(" ");
}
