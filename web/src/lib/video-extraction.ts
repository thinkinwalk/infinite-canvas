import { emptyVideoDraft, type VideoDraft, type VideoRecord, type VideoTool, type WorkbenchMedia } from "@/types/video-workbench";
import type { VideoExtraction, VideoExtractionClip } from "@/stores/use-video-extraction-store";

export function extractionClipError(start: number, end: number, durationMs?: number) {
    const duration = (durationMs || 0) / 1000;
    if (!Number.isFinite(duration) || duration <= 0) return "视频时长尚未识别，请等待视频载入";
    if (![start, end].every(Number.isFinite) || start < 0 || end > duration || end <= start) return "片段起止时间必须在原视频范围内";
    if (end - start < 1 || end - start > 30) return "请选择 1–30 秒的片段";
    return "";
}

export function clipExtraction(clip: VideoExtractionClip): VideoExtraction {
    return { id: clip.id, createdAt: clip.createdAt, originalBytes: clip.media.bytes, media: clip.media };
}

export const extractionTargets = [
    { key: "viral-recreate", label: "爆款复刻" },
    { key: "content-replace", label: "内容替换" },
    { key: "upscale", label: "视频高清" },
    { key: "subtitle-remove", label: "字幕去除" },
] as const;
export type ExtractionTarget = typeof extractionTargets[number]["key"];

export function extractionTargetError(
    tool: VideoTool,
    state: { hydrated: boolean; storageError: string; busyTools: Partial<Record<VideoTool, boolean>>; records: VideoRecord[] },
) {
    if (!state.hydrated || state.storageError) return "视频工作台尚未恢复或存储异常，请稍后重试";
    if (state.busyTools[tool] || state.records.some((record) => record.tool === tool && ["running", "interrupted"].includes(record.status))) {
        return "请先在目标工具中完成或恢复已有任务";
    }
    return "";
}

export function hasExtractionTargetDraft(tool: ExtractionTarget, draft?: VideoDraft) {
    return Boolean(draft && JSON.stringify(draft) !== JSON.stringify(emptyVideoDraft(tool)));
}

export function extractionDraft(tool: ExtractionTarget, media: WorkbenchMedia): VideoDraft {
    return {
        ...emptyVideoDraft(tool),
        ...(tool === "subtitle-remove" ? { subtitleMode: "manual" as const } : {}),
        media: [{ ...media, role: "reference" }],
    };
}
