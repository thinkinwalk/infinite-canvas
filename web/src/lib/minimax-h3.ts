import type { VideoModelProfile } from "@/services/api/admin";

export function isMiniMaxH3Name(name: string) {
    return ["minimax-h3", "minimax-h3-fl2v"].includes(name.trim().toLowerCase());
}

export function miniMaxH3Profile(name: string): VideoModelProfile {
    const frames = name.trim().toLowerCase() === "minimax-h3-fl2v";
    return {
        displayName: name, description: frames ? "首尾帧生成视频，图片按首帧、尾帧顺序提交。" : "支持文字及图片、视频、音频参考生成视频。",
        interface: "relay", maxImages: frames ? 2 : 9, maxVideos: frames ? 0 : 3, maxAudios: frames ? 0 : 3,
        resolutions: ["768", "480", "1080", "2K", "4K"], seconds: Array.from({ length: 12 }, (_, i) => String(i + 4)),
        generateAudio: false, inputModes: [frames ? "first_last" : "reference"],
        firstFrameField: frames ? "image_url" : "", lastFrameField: frames ? "last_frame" : "",
        firstFrameRequired: false, lastFrameOptional: true,
    };
}

const sizes: Record<string, string[]> = {
    "16:9": ["864x480", "1376x768", "1920x1088"],
    "9:16": ["480x864", "768x1376", "1088x1920"],
    "1:1": ["640x640", "1024x1024", "1440x1440"],
    "2:3": ["544x800", "832x1248", "1184x1760"],
    "3:2": ["800x544", "1248x832", "1760x1184"],
    "3:4": ["576x736", "896x1184", "1248x1664"],
    "4:3": ["736x576", "1184x896", "1664x1248"],
    "21:9": ["992x416", "1568x672", "2208x960"],
};

// Local channels bypass the gateway's conversion of validated reference fields.
export function miniMaxH3VideoBody(payload: Record<string, unknown>) {
    const ratio = String(payload.aspect_ratio);
    const resolution = String(payload.resolution).replace(/p$/i, "");
    const size = ["2K", "4K"].includes(resolution) ? resolution : sizes[ratio]?.[["480", "768", "1080"].indexOf(resolution)];
    if (!sizes[ratio] || !size) throw new Error("MiniMax H3 不支持所选画面规格");
    const images = [payload.image_url, ...(payload.reference_image_urls as string[] || []), payload.last_frame].filter(Boolean);
    return {
        model: payload.model, prompt: payload.prompt, seconds: Number(payload.seconds), size, aspect_ratio: ratio,
        ...(images.length ? { images } : {}),
        ...(payload.reference_videos ? { reference_videos: payload.reference_videos } : {}),
        ...(payload.audio_urls ? { reference_audios: payload.audio_urls } : {}),
    };
}
