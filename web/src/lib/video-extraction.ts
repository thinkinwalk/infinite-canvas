import { emptyVideoDraft, type VideoDraft, type VideoRecord, type VideoTool, type WorkbenchMedia } from "@/types/video-workbench";

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
