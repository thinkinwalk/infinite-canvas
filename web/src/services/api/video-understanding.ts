import { readFileAsDataUrl } from "@/lib/image-utils";
import { configForFeature, managedModelBinding, modelOptionName, modelRequestHeaders, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { UploadedFile } from "@/services/file-storage";
import { managedFixedHeaders } from "./model-management";
import { workbenchMediaBlob } from "./video-worker";
import type { VideoDraft } from "@/types/video-workbench";

export const VIDEO_ANALYSIS_FEATURE = "viral-recreate.video-analyze";
export const videoAnalysisConfig = (config: AiConfig) => configForFeature(config, VIDEO_ANALYSIS_FEATURE, "text");
export function videoAnalysisAvailable(config: AiConfig) {
    const scoped = videoAnalysisConfig(config);
    const binding = managedModelBinding(scoped, scoped.textModel, "text");
    return scoped.channelMode === "remote" && Boolean(scoped.managed?.enabled && scoped.textModel && binding?.adapter === "text.gemini-video" && binding.operations.includes("video-understand"));
}

export async function requestViralAnalysis(config: AiConfig, video: UploadedFile & { id?: string }, prompt: string, mode: "video" | "frames", frameCount: number, signal: AbortSignal, onSubmitted?: () => void, draft?: VideoDraft) {
    if (mode === "video" && !videoAnalysisAvailable(config)) throw new Error("当前没有可用的视频分析模型，请刷新模型后重试");
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录");
    const scoped = configForFeature(config, mode === "video" ? VIDEO_ANALYSIS_FEATURE : "viral-recreate.analyze", "text");
    const headers = await managedFixedHeaders(scoped, "text", 1, signal);
    if (video.referenceId) {
        const { updateVideoReferenceRetention } = await import("@/services/video-reference-retention");
        await updateVideoReferenceRetention(video.referenceId, "use", signal);
    }
    const blob = await workbenchMediaBlob(video);
    signal.throwIfAborted();
    const dataUrl = await readFileAsDataUrl(new File([blob], "reference-video", { type: video.mimeType || blob.type }));
    const frameTimes = mode === "frames" && draft?.viralFrameSource === `${video.id}:${video.storageKey || video.url}` ? draft.viralFrameTimes || [] : [];
    const transcript = mode === "frames" && draft?.viralUseTranscript && draft?.viralTranscriptSource === `${video.id}:${video.storageKey || video.url}` ? draft.transcript || "" : "";
    signal.throwIfAborted();
    try {
        onSubmitted?.();
        const response = await fetch("/api/v1/video-understanding", {
            method: "POST", signal,
            headers: { ...modelRequestHeaders(scoped, "text"), ...headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" } as Record<string, string>,
            body: JSON.stringify({ model: modelOptionName(scoped.textModel), prompt, recreation: true, mode, frameCount: Math.max(1, frameCount), frameTimes, transcript, video: { mimeType: video.mimeType || blob.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) } }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.code !== 0 || !result.data?.text?.trim()) throw new Error(result?.msg || `视频分析失败（${response.status}），请核对渠道原生视频接口`);
        return result.data.text as string;
    } finally {
        void useUserStore.getState().hydrateUser();
    }
}

export async function requestVideoUnderstanding(config: AiConfig, video: UploadedFile, prompt: string, signal: AbortSignal, onSubmitted?: () => void) {
    return requestViralAnalysis(videoAnalysisConfig(config), video, prompt, "video", 1, signal, onSubmitted);
}
