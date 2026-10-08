import type { UpscaleInput, VideoDraft } from "@/types/video-workbench";

export function upscaleInput(d: VideoDraft): UpscaleInput {
    return { media: d.media.filter((m) => m.role === "reference" && m.kind === "video"), route: d.route, replicateTargetResolution: d.replicateTargetResolution, replicateFps: d.replicateFps, scale: d.scale, fps: d.fps };
}

export function upscaleInputKey(d: UpscaleInput) {
    return JSON.stringify([d.media.map((m) => [m.id, m.storageKey || m.url]), d.route === "replicate" ? [d.route, d.replicateTargetResolution, d.replicateFps] : ["worker", d.scale, d.fps]]);
}

export function upscaleSummary(d: UpscaleInput) {
    return d.route === "replicate" ? `${d.replicateTargetResolution === "4k" ? "4K" : d.replicateTargetResolution} · ${d.replicateFps} fps` : `${d.scale} 倍 · ${d.fps === null ? "保持原帧率" : `${d.fps} fps`}`;
}

export function upscaleError(d: UpscaleInput) {
    if (!d.media.length) return "请先上传原视频";
    if (d.route === "replicate") {
        if (!["720p", "1080p", "4k"].includes(d.replicateTargetResolution)) return "请选择支持的输出分辨率";
        if (!Number.isInteger(d.replicateFps) || d.replicateFps < 15 || d.replicateFps > 60) return "目标帧率应为 15–60 的整数";
    } else {
        if (![2, 4].includes(d.scale)) return "请选择 2 倍或 4 倍增强";
        if (d.fps !== null && (!Number.isInteger(d.fps) || d.fps < 1)) return "目标帧率应为正整数，或留空保持原帧率";
    }
    return "";
}
